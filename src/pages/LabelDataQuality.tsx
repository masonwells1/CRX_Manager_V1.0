import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseZap,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Square,
} from 'lucide-react';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import ConfirmModal from '../components/ui/ConfirmModal';
import DataTable, { type Column } from '../components/ui/DataTable';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { usePageMeta } from '../hooks/usePageMeta';
import { logActivity } from '../lib/activityLogger';
import { assertRpcResult, checkMutationResult, supabase, supabaseUntyped } from '../lib/db';
import {
  buildFindingsForRegistration,
  buildLookupErrorFindings,
  buildMissingEpaFinding,
  classifyRegistrationNumber,
  groupProductsByRegistration,
  trustedAvailableSignalWord,
  type EpaDataQualityFinding,
  type EpaDataQualityFindingType,
  type EpaDataQualityProduct,
} from '../lib/epaDataQualityReport';
import {
  EPA_EDGE_RATE_LIMIT_COUNT,
  EPA_REQUEST_INTERVAL_MS,
  waitForEpaRequestSlot,
} from '../lib/epaRequestThrottle';
import { Sentry } from '../lib/sentry';
import type { EpaLookupResult, LabelCoverageReport } from '../types';

const CACHE_KEY = 'crx-label-data-quality-run-v1';

type DisplayFindingType = EpaDataQualityFindingType | 'OK';
type FindingFilter = DisplayFindingType | 'ALL';

const PESTICIDE_CATEGORIES = ['Herbicide', 'Fungicide', 'Insecticide', 'Seed Treatment'];

interface EpaResultSummary {
  found: boolean;
  productName: string | null;
  status: string | null;
  isCancelled: boolean;
}

type QualityRow = Record<string, unknown> & {
  id: string;
  productName: string;
  registrationNumber: string;
  epaProductName: string;
  product: EpaDataQualityProduct;
  epa: EpaResultSummary | null;
  findings: EpaDataQualityFinding[];
};

interface CachedRun {
  version: 1;
  checkedAt: string;
  rows: QualityRow[];
}

interface EditorState {
  input: string;
  verifying: boolean;
  saving: boolean;
  verifiedNumber: string | null;
  verifiedResult: EpaLookupResult | null;
  error: string | null;
}

const EMPTY_EDITOR: EditorState = {
  input: '',
  verifying: false,
  saving: false,
  verifiedNumber: null,
  verifiedResult: null,
  error: null,
};

const FILTERS: FindingFilter[] = [
  'ALL',
  'NAME_MISMATCH',
  'DISTRIBUTOR_NAME_DIFF',
  'CANCELLED',
  'NOT_FOUND',
  'RUP_DISAGREE',
  'SIGNAL_WORD_AVAILABLE',
  'MISSING_EPA',
  'OK',
  'UNSUPPORTED_REGNUM',
  'NEEDS_MANUAL',
  'LOOKUP_ERROR',
];

const FIXABLE_FINDINGS = new Set<EpaDataQualityFindingType>([
  'NAME_MISMATCH',
  'CANCELLED',
  'NOT_FOUND',
  'UNSUPPORTED_REGNUM',
  'MISSING_EPA',
]);

const VALID_FINDING_TYPES = new Set<EpaDataQualityFindingType>([
  'NAME_MISMATCH',
  'DISTRIBUTOR_NAME_DIFF',
  'CANCELLED',
  'RUP_DISAGREE',
  'UNSUPPORTED_REGNUM',
  'NOT_FOUND',
  'SIGNAL_WORD_AVAILABLE',
  'MISSING_EPA',
  'NEEDS_MANUAL',
  'LOOKUP_ERROR',
]);

// These findings are only valid when EPA returned a matched record. Findings
// such as NOT_FOUND and LOOKUP_ERROR intentionally describe the opposite case.
const FINDINGS_REQUIRING_FOUND_EPA = new Set<EpaDataQualityFindingType>([
  'NAME_MISMATCH',
  'DISTRIBUTOR_NAME_DIFF',
  'CANCELLED',
  'RUP_DISAGREE',
  'SIGNAL_WORD_AVAILABLE',
  'NEEDS_MANUAL',
]);

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error
      && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'Unknown error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEpaLookupResult(value: unknown): value is EpaLookupResult {
  if (!isRecord(value)) return false;
  const nullableString = (field: unknown) => field === null || typeof field === 'string';
  return typeof value.found === 'boolean'
    && (value.regType === 'section3' || value.regType === 'distributor')
    && nullableString(value.eparegno)
    && nullableString(value.productname)
    && (value.signalWordCanonical === null
      || value.signalWordCanonical === 'Danger'
      || value.signalWordCanonical === 'Warning'
      || value.signalWordCanonical === 'Caution')
    && typeof value.needsManual === 'boolean'
    && nullableString(value.manufacturer)
    && (value.rupYn === null || value.rupYn === 'Yes' || value.rupYn === 'No')
    && nullableString(value.productStatus)
    && typeof value.isCancelled === 'boolean'
    && Array.isArray(value.activeIngredients)
    && nullableString(value.latestLabelPdfUrl)
    && Array.isArray(value.labelPdfs);
}

function isCachedFinding(value: unknown): value is EpaDataQualityFinding {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  return VALID_FINDING_TYPES.has(value.type as EpaDataQualityFindingType)
    && typeof value.registrationNumber === 'string'
    && typeof value.productId === 'string'
    && typeof value.productName === 'string'
    && typeof value.message === 'string';
}

function isCachedEpaSummary(value: unknown): value is EpaResultSummary | null {
  if (value === null) return true;
  return isRecord(value)
    && typeof value.found === 'boolean'
    && (value.productName === null || typeof value.productName === 'string')
    && (value.status === null || typeof value.status === 'string')
    && typeof value.isCancelled === 'boolean';
}

function isCachedRun(value: unknown): value is CachedRun {
  if (!isRecord(value) || value.version !== 1 || typeof value.checkedAt !== 'string'
      || !Array.isArray(value.rows)) {
    return false;
  }

  return value.rows.every((row) => {
    const epa = isRecord(row) ? row.epa : undefined;
    if (!isRecord(row) || typeof row.id !== 'string'
        || typeof row.productName !== 'string'
        || typeof row.registrationNumber !== 'string'
        || typeof row.epaProductName !== 'string'
        || !isRecord(row.product)
        || !Array.isArray(row.findings)
        || !row.findings.every(isCachedFinding)
        || !isCachedEpaSummary(epa)) {
      return false;
    }
    const product = row.product;
    const hasConsistentFindings = row.findings.every((finding) => (
      finding.registrationNumber === product.epa_registration
    ));
    const hasEpaFindingWithoutMatchedEpa = row.findings.some((finding) => (
      FINDINGS_REQUIRING_FOUND_EPA.has(finding.type) && epa?.found !== true
    ));
    return typeof product.id === 'string'
      && typeof product.product_name === 'string'
      && typeof product.epa_registration === 'string'
      && (product.epaRegistrationDb === undefined
        || (typeof product.epaRegistrationDb === 'string'
          && product.epaRegistrationDb.trim() === product.epa_registration))
      && typeof product.is_rup === 'boolean'
      && (product.signal_word === null || typeof product.signal_word === 'string')
      && hasConsistentFindings
      && !hasEpaFindingWithoutMatchedEpa;
  });
}

function readCachedRun(): CachedRun | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCachedRun(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedRun(rows: QualityRow[], checkedAt: string): void {
  const cache: CachedRun = { version: 1, checkedAt, rows };
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Session storage is a convenience only; the live results remain on screen.
  }
}

function clearCachedRun(): void {
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // A blocked session cache must not block a live EPA check.
  }
}

function summarizeEpaResult(result: EpaLookupResult | null): EpaResultSummary | null {
  if (!result) return null;
  return {
    found: result.found,
    productName: result.productname,
    status: result.productStatus,
    isCancelled: result.isCancelled,
  };
}

function rowsForRegistration(
  products: EpaDataQualityProduct[],
  findings: EpaDataQualityFinding[],
  result: EpaLookupResult | null,
): QualityRow[] {
  const epa = summarizeEpaResult(result);
  return products.map((product) => ({
    id: product.id,
    productName: product.product_name,
    registrationNumber: product.epa_registration,
    epaProductName: epa?.productName ?? '',
    product,
    epa,
    findings: findings.filter((finding) => finding.productId === product.id),
  }));
}

function rowForMissingEpa(product: EpaDataQualityProduct): QualityRow {
  return {
    id: product.id,
    productName: product.product_name,
    registrationNumber: '',
    epaProductName: '',
    product,
    epa: null,
    findings: [buildMissingEpaFinding(product)],
  };
}

function findingTypes(row: QualityRow): DisplayFindingType[] {
  return row.findings.length > 0 ? row.findings.map((finding) => finding.type) : ['OK'];
}

function findingLabel(type: FindingFilter): string {
  const labels: Record<FindingFilter, string> = {
    ALL: 'All',
    NAME_MISMATCH: 'Name mismatch',
    DISTRIBUTOR_NAME_DIFF: 'Distributor name differs',
    CANCELLED: 'Cancelled',
    NOT_FOUND: 'Not found',
    RUP_DISAGREE: 'RUP differs',
    SIGNAL_WORD_AVAILABLE: 'Signal word available',
    MISSING_EPA: 'Missing EPA number',
    OK: 'OK',
    UNSUPPORTED_REGNUM: 'Unsupported number',
    NEEDS_MANUAL: 'Manual review',
    LOOKUP_ERROR: 'Lookup error',
  };
  return labels[type];
}

function findingVariant(type: DisplayFindingType): BadgeVariant {
  switch (type) {
    case 'OK':
      return 'success';
    case 'NAME_MISMATCH':
    case 'CANCELLED':
    case 'NOT_FOUND':
    case 'MISSING_EPA':
      return 'error';
    case 'RUP_DISAGREE':
    case 'UNSUPPORTED_REGNUM':
    case 'NEEDS_MANUAL':
      return 'warning';
    case 'DISTRIBUTOR_NAME_DIFF':
    case 'SIGNAL_WORD_AVAILABLE':
      return 'info';
    case 'LOOKUP_ERROR':
      return 'default';
  }
}

function isFixable(row: QualityRow): boolean {
  return row.findings.some((finding) => FIXABLE_FINDINGS.has(finding.type));
}

function signalWordForRow(row: QualityRow): 'Danger' | 'Warning' | 'Caution' | null {
  return row.epa?.found ? trustedAvailableSignalWord(row.findings) : null;
}

function CoverageStat({ label, value, total }: { label: string; value: number; total: number }) {
  const percentage = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-secondary">{label}</p>
      <p className="mt-1 text-xl font-semibold text-nav-dark">
        {value.toLocaleString()}
        <span className="ml-1 text-sm font-normal text-secondary">({percentage}%)</span>
      </p>
    </div>
  );
}

export default function LabelDataQuality() {
  usePageMeta();
  const { toast } = useToast();
  const { profile } = useAuth();
  const initialCache = useMemo(readCachedRun, []);
  const [products, setProducts] = useState<EpaDataQualityProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [coverage, setCoverage] = useState<LabelCoverageReport | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(true);
  const [rows, setRows] = useState<QualityRow[]>(initialCache?.rows ?? []);
  const [lastChecked, setLastChecked] = useState<string | null>(initialCache?.checkedAt ?? null);
  const [filter, setFilter] = useState<FindingFilter>('ALL');
  const [running, setRunning] = useState(false);
  const [resultsAreLive, setResultsAreLive] = useState(false);
  const [applyingSignalWords, setApplyingSignalWords] = useState(false);
  const [batchSignalConfirmOpen, setBatchSignalConfirmOpen] = useState(false);
  const [batchSignalFailures, setBatchSignalFailures] = useState<string[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [editors, setEditors] = useState<Record<string, EditorState>>({});
  const cancelRequestedRef = useRef(false);
  const runSequenceRef = useRef(0);

  const loadProducts = useCallback(async () => {
    setProductsLoading(true);
    try {
      const [registeredResponse, missingResponse] = await Promise.all([
        supabase
          .from('products')
          .select('id, product_name, epa_registration, is_rup, signal_word, category')
          .eq('is_active', true)
          .not('epa_registration', 'is', null)
          .order('product_name'),
        supabase
          .from('products')
          .select('id, product_name, epa_registration, is_rup, signal_word, category')
          .eq('is_active', true)
          .in('category', PESTICIDE_CATEGORIES)
          .or('epa_registration.is.null,epa_registration.eq.')
          .order('product_name'),
      ]);
      if (registeredResponse.error) throw registeredResponse.error;
      if (missingResponse.error) throw missingResponse.error;

      const loadedWithRegistration = (registeredResponse.data ?? []).flatMap((product): EpaDataQualityProduct[] => {
        const registration = product.epa_registration?.trim();
        if (!registration) return [];
        return [{
          id: product.id,
          product_name: product.product_name,
          epa_registration: registration,
          epaRegistrationDb: product.epa_registration ?? '',
          is_rup: product.is_rup,
          signal_word: product.signal_word,
          category: product.category,
        }];
      });
      const missingPesticides = (missingResponse.data ?? []).flatMap((product): EpaDataQualityProduct[] => {
        if (product.epa_registration?.trim()) return [];
        return [{
          id: product.id,
          product_name: product.product_name,
          epa_registration: '',
          epaRegistrationDb: '',
          is_rup: product.is_rup,
          signal_word: product.signal_word,
          category: product.category,
        }];
      });
      setProducts([...loadedWithRegistration, ...missingPesticides]
        .sort((left, right) => left.product_name.localeCompare(right.product_name)));
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(errorMessage(error)), {
        tags: { page: 'label_data_quality', action: 'load_products' },
      });
      toast('error', `Products failed to load: ${errorMessage(error)}`);
    } finally {
      setProductsLoading(false);
    }
  }, [toast]);

  const loadCoverage = useCallback(async () => {
    setCoverageLoading(true);
    try {
      const { data, error } = await supabaseUntyped.rpc('get_label_coverage_report');
      if (error) throw error;
      setCoverage(assertRpcResult<LabelCoverageReport>(data, 'get_label_coverage_report'));
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(errorMessage(error)), {
        tags: { page: 'label_data_quality', action: 'load_coverage' },
      });
      toast('error', `Coverage report failed: ${errorMessage(error)}`);
    } finally {
      setCoverageLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadProducts();
    void loadCoverage();
    return () => {
      cancelRequestedRef.current = true;
      runSequenceRef.current += 1;
    };
  }, [loadCoverage, loadProducts]);

  const missingEpaRows = useMemo(() => products
    .filter((product) => !product.epa_registration.trim())
    .map(rowForMissingEpa), [products]);

  const allRows = useMemo(() => [...rows, ...missingEpaRows]
    .sort((left, right) => left.product.product_name.localeCompare(right.product.product_name)),
  [missingEpaRows, rows]);

  const signalWordRows = useMemo(
    () => allRows.filter((row) => signalWordForRow(row) !== null),
    [allRows],
  );

  const scannableProductCount = useMemo(
    () => products.filter((product) => product.epa_registration.trim()).length,
    [products],
  );

  const updateEditor = useCallback((productId: string, update: Partial<EditorState>) => {
    setEditors((current) => ({
      ...current,
      [productId]: { ...(current[productId] ?? EMPTY_EDITOR), ...update },
    }));
  }, []);

  const updateLocalSignalWord = useCallback((productId: string, signalWord: 'Danger' | 'Warning' | 'Caution') => {
    setProducts((current) => current.map((product) => (
      product.id === productId ? { ...product, signal_word: signalWord } : product
    )));
    setRows((current) => {
      const next = current.map((row) => row.id === productId ? {
        ...row,
        product: { ...row.product, signal_word: signalWord },
        findings: row.findings.filter((finding) => finding.type !== 'SIGNAL_WORD_AVAILABLE'),
      } : row);
      if (lastChecked) writeCachedRun(next, lastChecked);
      return next;
    });
  }, [lastChecked]);

  const handleApplySignalWord = useCallback(async (row: QualityRow) => {
    if (!resultsAreLive) {
      toast('info', 'Re-run the EPA check to apply signal words from live EPA data.');
      return;
    }
    const signalWord = signalWordForRow(row);
    if (!signalWord || running || applyingSignalWords) return;
    if (!profile?.id) {
      toast('error', 'Your user profile is not available. Refresh the page before applying a signal word.');
      return;
    }

    setApplyingSignalWords(true);
    try {
      const mutation = await supabase
        .from('products')
        .update({ signal_word: signalWord })
        .eq('id', row.product.id)
        .eq('epa_registration', row.product.epaRegistrationDb || row.product.epa_registration)
        .is('signal_word', null)
        .select();
      if (mutation.error) throw mutation.error;
      if (!mutation.data || mutation.data.length === 0) {
        toast('info', `${row.product.product_name} changed since the last EPA check. Re-run the check before applying a signal word.`);
        return;
      }
      await logActivity({
        event: 'product_signal_word_applied',
        description: `Applied EPA signal word ${signalWord} to ${row.product.product_name} (${row.product.id}).`,
        performedBy: profile.id,
        entityType: 'product',
        entityId: row.product.id,
      });
      updateLocalSignalWord(row.product.id, signalWord);
      toast('success', `Applied EPA signal word ${signalWord} to ${row.product.product_name}.`);
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(errorMessage(error)), {
        tags: { page: 'label_data_quality', action: 'apply_signal_word' },
        extra: { productId: row.product.id, signalWord },
      });
      toast('error', `Signal word could not be applied: ${errorMessage(error)}`);
    } finally {
      setApplyingSignalWords(false);
    }
  }, [applyingSignalWords, profile?.id, resultsAreLive, running, toast, updateLocalSignalWord]);

  const handleBatchApplySignalWords = useCallback(async () => {
    if (!resultsAreLive) {
      toast('info', 'Re-run the EPA check to apply signal words from live EPA data.');
      return;
    }
    if (running || applyingSignalWords) return;
    if (!profile?.id) {
      toast('error', 'Your user profile is not available. Refresh the page before applying signal words.');
      return;
    }

    const eligibleRows = allRows.flatMap((row) => {
      const signalWord = signalWordForRow(row);
      return signalWord ? [{ row, signalWord }] : [];
    });
    if (eligibleRows.length === 0) {
      setBatchSignalConfirmOpen(false);
      return;
    }

    setBatchSignalConfirmOpen(false);
    setApplyingSignalWords(true);
    setBatchSignalFailures([]);
    let applied = 0;
    let skipped = 0;
    const failures: string[] = [];

    for (const { row, signalWord } of eligibleRows) {
      try {
        const mutation = await supabase
          .from('products')
          .update({ signal_word: signalWord })
          .eq('id', row.product.id)
          .eq('epa_registration', row.product.epaRegistrationDb || row.product.epa_registration)
          .is('signal_word', null)
          .select();
        if (mutation.error) throw mutation.error;
        if (!mutation.data || mutation.data.length === 0) {
          skipped += 1;
          continue;
        }
        await logActivity({
          event: 'product_signal_word_applied',
          description: `Applied EPA signal word ${signalWord} to ${row.product.product_name} (${row.product.id}).`,
          performedBy: profile.id,
          entityType: 'product',
          entityId: row.product.id,
        });
        updateLocalSignalWord(row.product.id, signalWord);
        applied += 1;
      } catch (error) {
        const message = errorMessage(error);
        failures.push(`${row.product.product_name}: ${message}`);
        Sentry.captureException(error instanceof Error ? error : new Error(message), {
          tags: { page: 'label_data_quality', action: 'batch_apply_signal_word' },
          extra: { productId: row.product.id, signalWord },
        });
      }
    }

    setBatchSignalFailures(failures);
    setApplyingSignalWords(false);
    toast(
      failures.length > 0 ? 'warning' : applied > 0 ? 'success' : 'info',
      `Applied signal word to ${applied} product${applied === 1 ? '' : 's'}${skipped > 0 ? ` · ${skipped} skipped (changed since the last check — re-run)` : ''}${failures.length > 0 ? ` · ${failures.length} failed — see details.` : '.'}`,
    );
  }, [allRows, applyingSignalWords, profile?.id, resultsAreLive, running, toast, updateLocalSignalWord]);

  const handleRun = useCallback(async () => {
    if (running || productsLoading) return;
    const groups = groupProductsByRegistration(products);
    const registrations = [...groups.keys()];
    if (registrations.length === 0) {
      toast('warning', 'No active products have an EPA registration number to check.');
      return;
    }

    const sequence = runSequenceRef.current + 1;
    runSequenceRef.current = sequence;
    cancelRequestedRef.current = false;
    setRunning(true);
    setResultsAreLive(false);
    setRows([]);
    setEditors({});
    setLastChecked(null);
    setProgress({ done: 0, total: registrations.length });
    clearCachedRun();

    const accumulated: QualityRow[] = [];
    let lookupErrors = 0;

    for (let index = 0; index < registrations.length; index += 1) {
      if (cancelRequestedRef.current || runSequenceRef.current !== sequence) break;
      const registrationNumber = registrations[index];
      const groupedProducts = groups.get(registrationNumber) ?? [];
      const classification = classifyRegistrationNumber(registrationNumber);
      let result: EpaLookupResult | null = null;
      let findings: EpaDataQualityFinding[];

      if (!classification.supported) {
        findings = buildFindingsForRegistration(
          registrationNumber,
          classification,
          groupedProducts,
          null,
        );
      } else {
        try {
          const slotReady = await waitForEpaRequestSlot(
            () => cancelRequestedRef.current || runSequenceRef.current !== sequence,
          );
          if (!slotReady) break;
          const response = await supabase.functions.invoke<EpaLookupResult>('epa-lookup', {
            body: { regNumber: classification.normalized },
          });
          if (response.error) throw response.error;
          if (!isEpaLookupResult(response.data)) {
            throw new Error('EPA lookup returned an invalid response.');
          }
          result = response.data;
          findings = buildFindingsForRegistration(
            registrationNumber,
            classification,
            groupedProducts,
            result,
          );
        } catch (error) {
          lookupErrors += 1;
          findings = buildLookupErrorFindings(
            registrationNumber,
            groupedProducts,
            errorMessage(error),
          );
        }
      }

      accumulated.push(...rowsForRegistration(groupedProducts, findings, result));
      accumulated.sort((left, right) => left.product.product_name.localeCompare(right.product.product_name));
      if (runSequenceRef.current === sequence) {
        setRows([...accumulated]);
        setProgress({ done: index + 1, total: registrations.length });
      }
    }

    if (runSequenceRef.current !== sequence) return;
    const cancelled = cancelRequestedRef.current;
    if (cancelled) {
      toast('info', `EPA check cancelled after ${accumulated.length.toLocaleString()} product(s).`);
    } else {
      const checkedAt = new Date().toISOString();
      setLastChecked(checkedAt);
      writeCachedRun(accumulated, checkedAt);
      setResultsAreLive(true);
      if (lookupErrors > 0) {
        toast('warning', `EPA check finished with ${lookupErrors} lookup error(s). Other products were still checked.`);
      } else {
        toast('success', `EPA check finished for ${accumulated.length.toLocaleString()} product(s).`);
      }
    }
    setRunning(false);
  }, [products, productsLoading, running, toast]);

  const handleVerify = useCallback(async (row: QualityRow) => {
    const editor = editors[row.id] ?? EMPTY_EDITOR;
    const registrationNumber = editor.input.trim();
    if (!registrationNumber || editor.verifying || running) return;

    const classification = classifyRegistrationNumber(registrationNumber);
    if (!classification.supported) {
      updateEditor(row.id, {
        verifiedNumber: null,
        verifiedResult: null,
        error: 'Enter a supported EPA number such as 100-123 or 100-123-456.',
      });
      return;
    }

    updateEditor(row.id, {
      verifying: true,
      verifiedNumber: null,
      verifiedResult: null,
      error: null,
    });
    try {
      const slotReady = await waitForEpaRequestSlot(() => false);
      if (!slotReady) return;
      const { data, error } = await supabase.functions.invoke<EpaLookupResult>('epa-lookup', {
        body: { regNumber: classification.normalized },
      });
      if (error) throw error;
      if (!isEpaLookupResult(data)) {
        throw new Error('EPA lookup returned an invalid response.');
      }
      if (!data.found || !data.productname || data.eparegno?.trim() !== classification.normalized) {
        updateEditor(row.id, {
          verifiedNumber: null,
          verifiedResult: null,
          error: `EPA did not find ${classification.normalized}. Nothing can be saved.`,
        });
        return;
      }

      setEditors((current) => {
        const latest = current[row.id] ?? EMPTY_EDITOR;
        if (latest.input.trim() !== registrationNumber) return current;
        return {
          ...current,
          [row.id]: {
            ...latest,
            verifiedNumber: classification.normalized,
            verifiedResult: data,
            error: null,
          },
        };
      });
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(errorMessage(error)), {
        tags: { page: 'label_data_quality', action: 'verify_registration' },
        extra: { productId: row.id },
      });
      updateEditor(row.id, {
        verifiedNumber: null,
        verifiedResult: null,
        error: `Verification failed: ${errorMessage(error)}`,
      });
    } finally {
      updateEditor(row.id, { verifying: false });
    }
  }, [editors, running, updateEditor]);

  const handleSave = useCallback(async (row: QualityRow) => {
    const editor = editors[row.id] ?? EMPTY_EDITOR;
    const registrationNumber = editor.input.trim();
    const verifiedResult = editor.verifiedResult;
    const canSave = registrationNumber.length > 0
      && editor.verifiedNumber === registrationNumber
      && verifiedResult?.found === true
      && typeof verifiedResult.productname === 'string'
      && verifiedResult.eparegno?.trim() === registrationNumber;
    if (!canSave || editor.saving || running) return;
    if (!profile?.id) {
      toast('error', 'Your user profile is not available. Refresh the page before saving.');
      return;
    }

    updateEditor(row.id, { saving: true, error: null });
    try {
      const mutation = await supabase
        .from('products')
        .update({ epa_registration: registrationNumber, signal_word: null })
        .eq('id', row.product.id)
        .select();
      checkMutationResult(mutation, 'update_product_epa_registration');

      const hadRegistration = row.product.epa_registration.trim().length > 0;
      void logActivity({
        event: hadRegistration ? 'product_epa_registration_corrected' : 'product_epa_registration_set',
        description: hadRegistration
          ? `Corrected EPA registration for ${row.product.product_name} (${row.product.id}) from ${row.product.epa_registration} to ${registrationNumber}; verified EPA product: ${verifiedResult.productname}.`
          : `Set EPA registration for ${row.product.product_name} (${row.product.id}) to ${registrationNumber}; verified EPA product: ${verifiedResult.productname}.`,
        performedBy: profile.id,
        entityType: 'product',
        entityId: row.product.id,
      });

      const correctedProduct: EpaDataQualityProduct = {
        ...row.product,
        epa_registration: registrationNumber,
        epaRegistrationDb: registrationNumber,
        signal_word: null,
      };
      const classification = classifyRegistrationNumber(registrationNumber);
      const findings = buildFindingsForRegistration(
        registrationNumber,
        classification,
        [correctedProduct],
        verifiedResult,
      );
      const correctedRow = rowsForRegistration([correctedProduct], findings, verifiedResult)[0];

      setRows((current) => {
        const next = current.some((item) => item.id === row.id)
          ? current.map((item) => item.id === row.id ? correctedRow : item)
          : [...current, correctedRow];
        if (lastChecked) writeCachedRun(next, lastChecked);
        return next;
      });
      setProducts((current) => current.map((product) => (
        product.id === row.id ? correctedProduct : product
      )));
      setEditors((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      toast('success', `${row.product.product_name} now uses verified EPA registration ${registrationNumber}.`);
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(errorMessage(error)), {
        tags: { page: 'label_data_quality', action: 'save_registration' },
        extra: { productId: row.id },
      });
      updateEditor(row.id, { error: `Save failed: ${errorMessage(error)}` });
    } finally {
      updateEditor(row.id, { saving: false });
    }
  }, [editors, lastChecked, profile?.id, running, toast, updateEditor]);

  const filteredRows = useMemo(() => (
    filter === 'ALL' ? allRows : allRows.filter((row) => findingTypes(row).includes(filter))
  ), [allRows, filter]);

  const columns: Column<QualityRow>[] = [
    {
      key: 'productName',
      header: 'Our product',
      sortable: true,
      render: (row) => (
        <div>
          <p className="font-medium text-nav-dark">{row.product.product_name}</p>
          <p className="mt-0.5 font-mono text-xs text-secondary">
            {row.product.epa_registration || 'No EPA registration saved'}
          </p>
        </div>
      ),
    },
    {
      key: 'epaProduct',
      header: 'EPA says this number is',
      render: (row) => {
        if (!row.epa) {
          return row.findings.some((finding) => finding.type === 'MISSING_EPA')
            ? <span className="text-secondary">No EPA number saved</span>
            : <span className="text-secondary">Not lookupable / lookup failed</span>;
        }
        if (!row.epa.found) return <span className="font-medium text-red-700">No EPA match</span>;
        return (
          <div>
            <p className="font-medium text-nav-dark">{row.epa.productName ?? 'Unnamed EPA product'}</p>
            <p className="mt-0.5 text-xs text-secondary">
              {row.epa.status ?? 'Status not provided'}
              {row.epa.isCancelled ? ' · Cancelled' : ''}
            </p>
          </div>
        );
      },
    },
    {
      key: 'findings',
      header: 'Finding',
      render: (row) => (
        <div className="flex max-w-xs flex-wrap gap-1.5">
          {findingTypes(row).map((type) => (
            <Badge key={type} variant={findingVariant(type)}>{findingLabel(type)}</Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'correction',
      header: 'EPA registration',
      className: 'min-w-[330px]',
      render: (row) => {
        if (!isFixable(row)) {
          return <span className="text-xs text-secondary">No registration correction needed</span>;
        }
        const editor = editors[row.id] ?? EMPTY_EDITOR;
        const normalizedInput = editor.input.trim();
        const verified = editor.verifiedResult;
        const canSave = normalizedInput.length > 0
          && editor.verifiedNumber === normalizedInput
          && verified?.found === true
          && typeof verified.productname === 'string'
          && verified.eparegno?.trim() === normalizedInput;

        return (
          <div className="space-y-2">
            <div className="flex items-end gap-2">
              <Input
                aria-label={`Corrected EPA registration for ${row.product.product_name}`}
                value={editor.input}
                onChange={(event) => updateEditor(row.id, {
                  input: event.target.value,
                  verifiedNumber: null,
                  verifiedResult: null,
                  error: null,
                })}
                disabled={running || editor.verifying || editor.saving}
                placeholder="e.g. 264-849"
                className="py-2"
              />
              <Button
                size="sm"
                variant="secondary"
                showChevron={false}
                icon={<Search className="h-4 w-4" />}
                loading={editor.verifying}
                disabled={!normalizedInput || running || editor.saving}
                onClick={() => void handleVerify(row)}
              >
                Verify
              </Button>
              <Button
                size="sm"
                showChevron={false}
                icon={<Save className="h-4 w-4" />}
                loading={editor.saving}
                disabled={!canSave || running || editor.verifying}
                onClick={() => void handleSave(row)}
              >
                Save
              </Button>
            </div>
            {verified && canSave && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-900">
                <span className="font-semibold">Verified EPA product:</span> {verified.productname}
                {' · '}{verified.productStatus ?? 'Status not provided'}
              </div>
            )}
            {editor.error && <p className="text-xs text-red-700">{editor.error}</p>}
          </div>
        );
      },
    },
    {
      key: 'signalWord',
      header: 'EPA signal word',
      className: 'min-w-[180px]',
      render: (row) => {
        const signalWord = signalWordForRow(row);
        if (!signalWord) return <span className="text-xs text-secondary">No safe EPA fill available</span>;
        return (
          <Button
            size="sm"
            variant="secondary"
            showChevron={false}
            disabled={!resultsAreLive || running || applyingSignalWords}
            onClick={() => void handleApplySignalWord(row)}
          >
            Apply “{signalWord}”
          </Button>
        );
      },
    },
  ];

  const issueCount = allRows.filter((row) => findingTypes(row).some((type) => (
    type === 'NAME_MISMATCH'
    || type === 'CANCELLED'
    || type === 'NOT_FOUND'
    || type === 'UNSUPPORTED_REGNUM'
    || type === 'MISSING_EPA'
  ))).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2">
            <DatabaseZap className="h-6 w-6 text-crx-green" />
            <h1 className="text-2xl font-bold text-nav-dark">Label Data Quality</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-secondary">
            Check saved EPA registration numbers against the live EPA database before relying on downstream label data.
          </p>
          {lastChecked && (
            <p className="mt-2 text-xs text-secondary">
              Last checked this session: {new Date(lastChecked).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {running && (
            <Button
              variant="secondary"
              showChevron={false}
              icon={<Square className="h-3.5 w-3.5 fill-current" />}
              onClick={() => { cancelRequestedRef.current = true; }}
            >
              Cancel
            </Button>
          )}
          <Button
            showChevron={false}
            icon={<RefreshCw className="h-4 w-4" />}
            loading={running}
            disabled={productsLoading || scannableProductCount === 0 || applyingSignalWords}
            onClick={() => void handleRun()}
          >
            {lastChecked ? 'Run EPA check again' : 'Run EPA check'}
          </Button>
        </div>
      </div>

      <Card>
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-crx-green" />
          <h2 className="font-semibold text-nav-dark">Label field coverage</h2>
        </div>
        {coverageLoading && !coverage ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-20 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        ) : coverage ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <CoverageStat label="Active products" value={coverage.total_active_products} total={coverage.total_active_products} />
            <CoverageStat label="EPA registration" value={coverage.epa_registration} total={coverage.total_active_products} />
            <CoverageStat label="Signal word" value={coverage.signal_word} total={coverage.total_active_products} />
            <CoverageStat label="REI hours" value={coverage.rei_hours} total={coverage.total_active_products} />
            <CoverageStat label="PHI days" value={coverage.phi_days} total={coverage.total_active_products} />
            <CoverageStat label="Max label rate" value={coverage.max_label_rate} total={coverage.total_active_products} />
          </div>
        ) : (
          <p className="text-sm text-secondary">Coverage is unavailable right now.</p>
        )}
      </Card>

      {running && (
        <Card>
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-nav-dark">Checking distinct EPA registration numbers…</span>
            <span className="text-secondary">{progress.done} / {progress.total}</span>
          </div>
          <progress
            aria-label="EPA check progress"
            className="mt-3 h-3 w-full overflow-hidden rounded-full accent-crx-green"
            max={Math.max(progress.total, 1)}
            value={progress.done}
          />
          <p className="mt-2 text-xs text-secondary">
            Requests are spaced at least {EPA_REQUEST_INTERVAL_MS} ms apart and pause at
            {' '}{EPA_EDGE_RATE_LIMIT_COUNT} per minute to protect the shared EPA lookup service.
          </p>
        </Card>
      )}

      {allRows.length > 0 ? (
        <Card>
          <div className="mb-4 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
            <div>
              <h2 className="font-semibold text-nav-dark">EPA registration results</h2>
              <p className="text-sm text-secondary">
                {allRows.length.toLocaleString()} products shown · {issueCount.toLocaleString()} actionable EPA registration issue{issueCount === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                showChevron={false}
                disabled={!resultsAreLive || running || applyingSignalWords || signalWordRows.length === 0}
                onClick={() => setBatchSignalConfirmOpen(true)}
              >
                Apply all {signalWordRows.length} EPA signal word{signalWordRows.length === 1 ? '' : 's'}
              </Button>
              {!resultsAreLive && signalWordRows.length > 0 && (
                <span className="text-xs text-secondary">Re-run the EPA check to apply signal words.</span>
              )}
              <div className="flex items-center gap-2 text-xs text-secondary">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                Save unlocks only after the entered number resolves to an EPA product.
              </div>
            </div>
          </div>
          {batchSignalFailures.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">Signal-word batch details</p>
              <ul className="mt-1 list-inside list-disc text-xs">
                {batchSignalFailures.map((failure) => <li key={failure}>{failure}</li>)}
              </ul>
            </div>
          )}
          <DataTable
            data={filteredRows}
            columns={columns}
            searchable
            searchPlaceholder="Search EPA quality results"
            searchKeys={['productName', 'registrationNumber', 'epaProductName']}
            emptyTitle="No products match this finding"
            filters={(
              <select
                aria-label="Filter by finding type"
                value={filter}
                onChange={(event) => setFilter(event.target.value as FindingFilter)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-nav-dark focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
              >
                {FILTERS.map((type) => (
                  <option key={type} value={type}>{findingLabel(type)}</option>
                ))}
              </select>
            )}
          />
        </Card>
      ) : !running && !productsLoading ? (
        <Card className="py-12 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-amber-500" />
          <h2 className="mt-3 font-semibold text-nav-dark">No EPA check results yet</h2>
          <p className="mt-1 text-sm text-secondary">Run the check to compare each saved registration with EPA.</p>
        </Card>
      ) : null}

      <ConfirmModal
        open={batchSignalConfirmOpen}
        onClose={() => setBatchSignalConfirmOpen(false)}
        onConfirm={() => void handleBatchApplySignalWords()}
        title="Apply EPA signal words"
        message={`Apply EPA signal words to ${signalWordRows.length} product${signalWordRows.length === 1 ? '' : 's'}? These values come straight from each product's matched EPA record.`}
        confirmLabel={`Apply to ${signalWordRows.length} product${signalWordRows.length === 1 ? '' : 's'}`}
        variant="info"
        loading={applyingSignalWords}
      />
    </div>
  );
}
