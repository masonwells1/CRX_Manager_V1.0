import { useRef, useState } from 'react';
import { Upload, CheckCircle, AlertCircle, FileText, Sparkles } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { supabase, assertRpcResult } from '../../lib/db';
import { useAuth } from '../../contexts/AuthContext';
import { useBelowCostApproval } from '../../contexts/BelowCostApprovalContext';
import { isBelowCostApprovalHandledError, withBelowCostReason } from '../../lib/belowCostApproval';
import { processDocumentWithOCR, isCSVFile, isOCRSupported } from '../../lib/documentOCR';
import { generateIdempotencyKey } from '../../lib/idempotency';
import { Sentry } from '../../lib/sentry';
import { logActivity } from '../../lib/activityLogger';
import type { Json } from '../../types/supabase';
import { resolveExactProductIdentity } from '../../lib/productIdentityResolver';

interface BulkQuoteImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface ParsedQuoteItem {
  quote_number: string;
  customer_farm_name: string;
  section_name?: string;
  product_name: string;
  acres?: number;
  price_per_unit?: number;
  oz_per_acre?: number;
  actual_rate?: number;
  rate_unit?: string;
  notes?: string;
  tier?: number;
  status?: string;
  valid_days?: number;
  header_notes?: string;
  footer_notes?: string;
}

interface ValidationResult {
  valid: ParsedQuoteItem[];
  invalid: Array<{ row: number; error: string; data: Record<string, string> }>;
}

type InvalidQuoteRow = ValidationResult['invalid'][number];

interface ValidQuoteRow {
  row: number;
  item: ParsedQuoteItem;
  data: Record<string, string>;
}

const FIELD_MAPPINGS: Record<string, string[]> = {
  quote_number: ['quote_number', 'quote_num', 'quote_id', 'quote', 'quote#'],
  customer_farm_name: ['customer_farm_name', 'customer', 'farm_name', 'farm', 'customer_name'],
  section_name: ['section_name', 'section', 'category', 'group'],
  product_name: ['product_name', 'product', 'product_code', 'item', 'sku'],
  acres: ['acres', 'acre', 'acreage'],
  price_per_unit: ['price_per_unit', 'price', 'unit_price', 'cost'],
  oz_per_acre: ['oz_per_acre', 'oz/acre', 'oz_acre', 'ounces_per_acre'],
  actual_rate: ['actual_rate', 'rate', 'application_rate'],
  rate_unit: ['rate_unit', 'unit', 'rate_uom'],
  notes: ['notes', 'note', 'item_notes', 'comments'],
  tier: ['tier', 'price_tier', 'pricing_tier'],
  status: ['status', 'quote_status'],
  valid_days: ['valid_days', 'validity', 'expiry_days'],
  header_notes: ['header_notes', 'header', 'quote_header'],
  footer_notes: ['footer_notes', 'footer', 'quote_footer'],
};

const IMPORTABLE_QUOTE_STATUSES = new Set(['draft']);

const normalizeQuoteNumber = (quoteNumber?: string | null): string =>
  quoteNumber?.trim().toUpperCase() ?? '';

const escapeIlikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, (match) => `\\${match}`);

const normalizeUnitName = (unit?: string | null): string =>
  unit?.toLowerCase().trim() ?? '';

const toMoneyCents = (value: number | null | undefined): bigint =>
  BigInt(Math.round((value ?? 0) * 100));

const centsToDollars = (cents: bigint): number => Number(cents) / 100;

const multiplyCentsByQuantity = (unitCents: bigint, quantity: number): bigint =>
  BigInt(Math.round(Number(unitCents) * quantity));

const stableStringify = (value: unknown): string => {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
};

const payloadFingerprint = (value: unknown): string => {
  let hash = 2166136261;
  const serialized = stableStringify(value);
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const importRowFingerprint = (quoteNumber: string, items: ParsedQuoteItem[]): string =>
  payloadFingerprint({
    quote_number: quoteNumber,
    items: items.map((item) => ({
      quote_number: normalizeQuoteNumber(item.quote_number),
      customer_farm_name: item.customer_farm_name.trim(),
      section_name: item.section_name?.trim() || null,
      product_name: item.product_name.trim(),
      acres: item.acres ?? null,
      price_per_unit: item.price_per_unit ?? null,
      oz_per_acre: item.oz_per_acre ?? null,
      actual_rate: item.actual_rate ?? null,
      rate_unit: normalizeUnitName(item.rate_unit) || null,
      notes: item.notes ?? null,
      tier: item.tier ?? null,
      status: item.status ?? null,
      valid_days: item.valid_days ?? null,
      header_notes: item.header_notes ?? null,
      footer_notes: item.footer_notes ?? null,
    })),
  });

const rejectPartiallyInvalidQuoteGroups = (
  candidates: ValidQuoteRow[],
  invalid: InvalidQuoteRow[]
): ValidationResult => {
  const blockedQuoteNumbers = new Set(
    invalid
      .map((row) => normalizeQuoteNumber(row.data.quote_number))
      .filter(Boolean)
  );

  if (blockedQuoteNumbers.size === 0) {
    return {
      valid: candidates.map(({ item }) => ({
        ...item,
        quote_number: normalizeQuoteNumber(item.quote_number),
      })),
      invalid,
    };
  }

  const valid: ParsedQuoteItem[] = [];
  const normalizedInvalid = [...invalid];

  candidates.forEach(({ row, item, data }) => {
    if (blockedQuoteNumbers.has(normalizeQuoteNumber(item.quote_number))) {
      normalizedInvalid.push({
        row,
        error: `Quote ${item.quote_number} has another invalid row; fix all rows for this quote before importing.`,
        data,
      });
      return;
    }

    valid.push({
      ...item,
      quote_number: normalizeQuoteNumber(item.quote_number),
    });
  });

  return { valid, invalid: normalizedInvalid };
};

export default function BulkQuoteImport({ open, onClose, onSuccess }: BulkQuoteImportProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [uploadResults, setUploadResults] = useState<{ success: number; failed: number; details: string[] } | null>(null);
  const importIdempotencyKeysRef = useRef(new Map<string, string>());

  const importIdempotencyScope = (quoteNumber: string, payloadScope: string): string =>
    `${profile?.id ?? 'unknown'}:${normalizeQuoteNumber(quoteNumber)}:${payloadScope}`;

  const hasImportIdempotencyKey = (quoteNumber: string, payloadScope: string): boolean =>
    importIdempotencyKeysRef.current.has(importIdempotencyScope(quoteNumber, payloadScope));

  const getImportIdempotencyKey = (quoteNumber: string, payloadScope: string): string => {
    const scope = importIdempotencyScope(quoteNumber, payloadScope);
    const cached = importIdempotencyKeysRef.current.get(scope);
    if (cached) return cached;
    const key = generateIdempotencyKey('save_quote_bulk_import', scope);
    importIdempotencyKeysRef.current.set(scope, key);
    return key;
  };

  const clearImportIdempotencyKey = (quoteNumber: string, payloadScope: string): void => {
    importIdempotencyKeysRef.current.delete(importIdempotencyScope(quoteNumber, payloadScope));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (selectedFile.size > 10 * 1024 * 1024) {
        toast('error', 'File too large. Maximum size is 10MB.');
        e.target.value = '';
        return;
      }
      const isCSV = isCSVFile(selectedFile);
      const isOCR = isOCRSupported(selectedFile);
      if (!isCSV && !isOCR) {
        toast('error', 'Invalid file type. Please upload a CSV, PDF, or image file.');
        e.target.value = '';
        return;
      }
      setFile(selectedFile);
      setValidation(null);
      setUploadResults(null);
    }
  };

  const detectFieldMapping = (header: string): string | null => {
    const normalized = header.toLowerCase().trim().replace(/\s+/g, '_');
    for (const [field, aliases] of Object.entries(FIELD_MAPPINGS)) {
      if (aliases.includes(normalized)) {
        return field;
      }
    }
    return null;
  };

  const parseCSV = (text: string): { headers: string[]; rows: string[][] } => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return { headers: [], rows: [] };

    const headers = lines[0].split(',').map((h) => h.trim());
    const rows: string[][] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      if (cols.length > 0 && cols[0]) {
        rows.push(cols);
      }
    }

    return { headers, rows };
  };

  const parseWithVisionOCR = async (file: File): Promise<{ valid: ParsedQuoteItem[]; invalid: Array<{ row: number; error: string; data: Record<string, string> }> }> => {
    const result = await processDocumentWithOCR(file, 'quote_list');

    if (!result.success || !result.parsed_data) {
      toast('error', result.error || 'OCR processing failed. Try a clearer image or CSV instead.');
      return { valid: [], invalid: [] };
    }

    const data = result.parsed_data as {
      items?: Array<{
        quote_number?: string;
        customer_name?: string;
        product_name?: string;
        acres?: number;
        price?: number;
        rate?: number;
      }>;
    };

    if (!data.items || data.items.length === 0) {
      toast('error', 'No quote items found in document.');
      return { valid: [], invalid: [] };
    }

    const candidates: ValidQuoteRow[] = [];
    const invalid: InvalidQuoteRow[] = [];

    data.items.forEach((item, idx) => {
      if (!item.quote_number || !item.customer_name || !item.product_name) {
        invalid.push({
          row: idx + 1,
          error: 'Missing required fields (quote_number, customer_name, or product_name)',
          data: { ...item } as unknown as Record<string, string>,
        });
        return;
      }
      candidates.push({
        row: idx + 1,
        data: { ...item } as unknown as Record<string, string>,
        item: {
          quote_number: item.quote_number,
          customer_farm_name: item.customer_name,
          product_name: item.product_name,
          acres: item.acres,
          price_per_unit: item.price,
          actual_rate: item.rate,
        },
      });
    });

    return rejectPartiallyInvalidQuoteGroups(candidates, invalid);
  };

  const handleParse = async () => {
    if (!file) return;
    setParsing(true);

    try {
      // Route: CSV → client-side parser, PDF/Image → Vision OCR
      if (!isCSVFile(file)) {
        const ocrResult = await parseWithVisionOCR(file);
        setValidation(ocrResult);
        setParsing(false);
        return;
      }

      const text = await file.text();
      const { headers, rows } = parseCSV(text);

      if (rows.length === 0) {
        toast('error', 'No valid data found in file');
        setParsing(false);
        return;
      }

      const fieldMapping: Record<number, string> = {};
      headers.forEach((header, idx) => {
        const field = detectFieldMapping(header);
        if (field) {
          fieldMapping[idx] = field;
        }
      });

      const requiredFields = ['quote_number', 'customer_farm_name', 'product_name'];
      const missingFields = requiredFields.filter(
        (field) => !Object.values(fieldMapping).includes(field)
      );

      if (missingFields.length > 0) {
        toast('error', `Missing required columns: ${missingFields.join(', ')}`);
        setParsing(false);
        return;
      }

      const validRows: ValidQuoteRow[] = [];
      const invalid: InvalidQuoteRow[] = [];

      rows.forEach((cols, idx) => {
        const item: Partial<ParsedQuoteItem> = {};
        const rowData: Record<string, string> = {};

        cols.forEach((value, colIdx) => {
          const field = fieldMapping[colIdx];
          if (field) {
            rowData[field] = value;

            if (
              field === 'quote_number' ||
              field === 'customer_farm_name' ||
              field === 'section_name' ||
              field === 'product_name' ||
              field === 'rate_unit' ||
              field === 'notes' ||
              field === 'status' ||
              field === 'header_notes' ||
              field === 'footer_notes'
            ) {
              if (value) item[field] = value;
            } else if (
              field === 'acres' ||
              field === 'price_per_unit' ||
              field === 'oz_per_acre' ||
              field === 'actual_rate'
            ) {
              const num = parseFloat(value);
              if (!isNaN(num)) {
                item[field] = num;
              }
            } else if (field === 'tier') {
              const tier = parseInt(value);
              if ([1, 2, 3].includes(tier)) {
                item[field] = tier;
              }
            } else if (field === 'valid_days') {
              const days = parseInt(value);
              if (!isNaN(days) && days > 0) {
                item[field] = days;
              }
            }
          }
        });

        const normalizedStatus = item.status?.toLowerCase().trim();
        if (normalizedStatus) item.status = normalizedStatus;

        if (!item.quote_number || !item.customer_farm_name || !item.product_name) {
          invalid.push({
            row: idx + 2,
            error: 'Missing required fields (quote_number, customer_farm_name, or product_name)',
            data: rowData,
          });
          return;
        }

        if (item.status && !IMPORTABLE_QUOTE_STATUSES.has(item.status)) {
          invalid.push({
            row: idx + 2,
            error: 'Unsupported status. Bulk quote imports may only create draft quotes.',
            data: rowData,
          });
          return;
        }

        validRows.push({ row: idx + 2, item: item as ParsedQuoteItem, data: rowData });
      });

      setValidation(rejectPartiallyInvalidQuoteGroups(validRows, invalid));
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        extra: { context: 'BulkQuoteImport.parseCSVFile' },
      });
      toast('error', 'Failed to parse file. Please ensure it is a valid CSV.');
    }
    setParsing(false);
  };

  const handleUpload = async () => {
    if (!validation || validation.valid.length === 0 || !profile) return;
    setUploading(true);

    const details: string[] = [];
    let successCount = 0;
    let failCount = 0;

    try {
      const [custRes, prodRes, convRes] = await Promise.all([
        supabase.from('customers').select('id, farm_name'),
        supabase.from('products').select('id, product_name, sku, current_cost, inventory_unit, unit_size, is_active').eq('is_active', true),
        supabase.from('unit_conversions').select('*'),
      ]);

      if (custRes.error || prodRes.error || convRes.error) {
        const errMsg = custRes.error?.message || prodRes.error?.message || convRes.error?.message;
        toast('error', `Failed to load reference data: ${errMsg}`);
        setUploading(false);
        return;
      }

      const customers = custRes.data;
      const products = prodRes.data;
      const unitConversions = convRes.data || [];

      if (!customers || !products) {
        toast('error', 'Failed to load reference data');
        setUploading(false);
        return;
      }

      const customerMap = new Map(
        customers.map((c) => [c.farm_name.toLowerCase().trim(), c.id])
      );
      const productDetailsById = new Map(products.map((p) => [p.id, p]));

      const quoteGroups = new Map<string, ParsedQuoteItem[]>();
      validation.valid.forEach((item) => {
        const key = normalizeQuoteNumber(item.quote_number);
        if (!quoteGroups.has(key)) {
          quoteGroups.set(key, []);
        }
        quoteGroups.get(key)!.push(item);
      });

      for (const [quoteNumber, items] of quoteGroups) {
        try {
          const firstItem = items[0];
          const customerMatches = items.map((item) => ({
            name: item.customer_farm_name,
            id: customerMap.get(item.customer_farm_name.toLowerCase().trim()),
          }));
          const missingCustomers = Array.from(new Set(
            customerMatches
              .filter((customer) => !customer.id)
              .map((customer) => customer.name)
          )).sort((a, b) => a.localeCompare(b));
          if (missingCustomers.length > 0) {
            details.push(`Quote ${quoteNumber}: Customer(s) not found - ${missingCustomers.join(', ')}`);
            failCount++;
            continue;
          }

          const customerIds = Array.from(new Set(customerMatches.map((customer) => customer.id!)));
          if (customerIds.length > 1) {
            const customerNames = Array.from(new Set(customerMatches.map((customer) => customer.name)))
              .sort((a, b) => a.localeCompare(b));
            details.push(`Quote ${quoteNumber}: Rows reference multiple customers - ${customerNames.join(', ')}`);
            failCount++;
            continue;
          }
          const customerId = customerIds[0];

          const productByItem = new Map<ParsedQuoteItem, (typeof products)[number]>();
          const missingProducts: string[] = [];
          const ambiguousProducts: string[] = [];
          for (const item of items) {
            const resolution = resolveExactProductIdentity(item.product_name, products);
            if (resolution.status === 'unique') productByItem.set(item, resolution.product);
            else if (resolution.status === 'ambiguous') ambiguousProducts.push(item.product_name);
            else missingProducts.push(item.product_name);
          }
          if (missingProducts.length > 0) {
            details.push(`Quote ${quoteNumber}: Product(s) not found - ${[...new Set(missingProducts)].sort().join(', ')}`);
            failCount++;
            continue;
          }
          if (ambiguousProducts.length > 0) {
            details.push(`Quote ${quoteNumber}: Product(s) ambiguous - ${[...new Set(ambiguousProducts)].sort().join(', ')}. Use a unique SKU.`);
            failCount++;
            continue;
          }

          const idemPayloadScope = importRowFingerprint(quoteNumber, items);
          if (!hasImportIdempotencyKey(quoteNumber, idemPayloadScope)) {
            const existingQuoteResult = await supabase
              .from('quotes')
              .select('quote_number')
              .ilike('quote_number', escapeIlikePattern(quoteNumber));
            if (existingQuoteResult.error) {
              Sentry.captureException(new Error(`Failed to check existing quote numbers: ${existingQuoteResult.error.message}`), {
                extra: { context: 'BulkQuoteImport existing quote check', quoteNumber },
              });
              details.push(`Quote ${quoteNumber}: Failed to check existing quote numbers - ${existingQuoteResult.error.message}`);
              failCount++;
              continue;
            }

            const existingQuoteNumbers = (existingQuoteResult.data || [])
              .map((quote: { quote_number?: string | null }) => quote.quote_number)
              .filter((value): value is string => Boolean(value));
            if (existingQuoteNumbers.length > 0) {
              const caseVariants = existingQuoteNumbers.filter((value) => value !== quoteNumber);
              const suffix = caseVariants.length > 0
                ? ` Existing case variant(s): ${caseVariants.join(', ')}.`
                : '';
              details.push(`Quote ${quoteNumber}: Quote number already exists.${suffix}`);
              failCount++;
              continue;
            }
          }

          const sectionGroups = new Map<string, ParsedQuoteItem[]>();
          items.forEach((item) => {
            const sectionName = item.section_name || 'Default';
            if (!sectionGroups.has(sectionName)) {
              sectionGroups.set(sectionName, []);
            }
            sectionGroups.get(sectionName)!.push(item);
          });

          let totalPriceCents = 0n;
          let totalCostCents = 0n;
          let totalProfitCents = 0n;

          const sectionsPayload = Array.from(sectionGroups.entries()).map(([sectionName, sectionItems], sectionIndex) => {
            const sectionItemsPayload = sectionItems
              .map((item, itemIndex) => {
              const productId = productByItem.get(item)!.id;
              const product = productDetailsById.get(productId);
              const inventoryUnit = product?.inventory_unit || product?.unit_size;
              const hasPriceOverride = typeof item.price_per_unit === 'number';
              const pricePerUnitCents = toMoneyCents(hasPriceOverride ? item.price_per_unit! : 0);
              const currentCostCents = toMoneyCents(product?.current_cost);
              const price_per_unit = centsToDollars(pricePerUnitCents);
              const current_cost = centsToDollars(currentCostCents);
              const acres = item.acres || 0;
              const hasActualRate = typeof item.actual_rate === 'number';
              const hasOzPerAcre = typeof item.oz_per_acre === 'number';
              if (hasActualRate && !normalizeUnitName(item.rate_unit)) {
                throw new Error(`Rate unit is required when actual_rate is supplied for product ${item.product_name}`);
              }
              const actualRate = hasActualRate ? item.actual_rate! : hasOzPerAcre ? item.oz_per_acre! : null;
              const rateUnit = hasActualRate ? item.rate_unit! : hasOzPerAcre ? 'oz' : null;
              const rateConv = rateUnit
                ? unitConversions.find((c: { unit: string; factor_oz: number }) => normalizeUnitName(c.unit) === normalizeUnitName(rateUnit))
                : null;
              if (actualRate !== null && (!rateConv || rateConv.factor_oz <= 0)) {
                throw new Error(`Unsupported rate unit "${rateUnit || 'blank'}" for product ${item.product_name}`);
              }
              const oz_per_acre = actualRate !== null ? actualRate * rateConv!.factor_oz : 0;

              const conv = inventoryUnit
                ? unitConversions.find((c: { unit: string; factor_oz: number }) => normalizeUnitName(c.unit) === normalizeUnitName(inventoryUnit))
                : null;
              if (acres > 0 && oz_per_acre > 0 && (!conv || conv.factor_oz <= 0)) {
                throw new Error(`Unsupported inventory unit "${inventoryUnit || 'blank'}" for product ${item.product_name}`);
              }
              const conversionFactor = conv?.factor_oz ?? 1;
              const total_units_needed = acres && oz_per_acre ? (acres * oz_per_acre) / conversionFactor : 0;
              const lineTotalPriceCents = multiplyCentsByQuantity(pricePerUnitCents, total_units_needed);
              const lineTotalCostCents = multiplyCentsByQuantity(currentCostCents, total_units_needed);
              const profitCents = lineTotalPriceCents - lineTotalCostCents;
              const total_price = centsToDollars(lineTotalPriceCents);
              const profit = centsToDollars(profitCents);
              const net_margin = total_price > 0 ? (profit / total_price) * 100 : 0;

              totalPriceCents += lineTotalPriceCents;
              totalCostCents += lineTotalCostCents;
              totalProfitCents += profitCents;

              return {
                product_id: productId,
                sort_order: itemIndex,
                price_per_unit,
                price_override: hasPriceOverride ? price_per_unit : null,
                current_cost,
                suggested_rate: null,
                actual_rate: actualRate,
                rate_unit: rateUnit,
                oz_per_acre: oz_per_acre || null,
                acres: acres || null,
                total_units_needed: total_units_needed || null,
                price_per_acre: acres > 0 ? total_price / acres : null,
                total_price,
                profit,
                net_margin,
                calc_mode: 'rate_acres',
                price_unit: null,
                unit_size: null,
                notes: item.notes || null,
              };
            });

            return {
              section_name: sectionName,
              sort_order: sectionIndex,
              section_notes: null,
              section_header_notes: null,
              needed_by_date: null,
              field_id: null,
              items: sectionItemsPayload,
            };
          });

          const itemsCreated = sectionsPayload.reduce((sum, section) => sum + section.items.length, 0);

          if (itemsCreated > 0) {
            const validDays = firstItem.valid_days || 15;
            const totalPrice = centsToDollars(totalPriceCents);
            const totalCost = centsToDollars(totalCostCents);
            const totalProfit = centsToDollars(totalProfitCents);
            const quotePayload = {
              quote_number: quoteNumber,
              customer_id: customerId,
              created_by: profile.id,
              tier: firstItem.tier || 1,
              status: 'draft',
              total_price: totalPrice,
              total_cost: totalCost,
              total_profit: totalProfit,
              total_margin_pct: totalPrice > 0 ? (totalProfit / totalPrice) * 100 : 0,
              valid_days: validDays,
              expires_at: new Date(Date.now() + validDays * 24 * 60 * 60 * 1000).toISOString(),
              header_notes: firstItem.header_notes || null,
              footer_notes: firstItem.footer_notes || null,
              is_planned: false,
            };

            const idemKey = getImportIdempotencyKey(quoteNumber, idemPayloadScope);
            const { data, error } = await runWithBelowCostApproval((reason) => supabase.rpc('save_quote', withBelowCostReason('save_quote', {
              p_quote_id: null as unknown as string,
              p_quote_payload: quotePayload as Json,
              p_sections: sectionsPayload as Json,
              p_performed_by: profile.id,
              p_idempotency_key: idemKey,
            }, reason)));

            if (error) {
              details.push(`Quote ${quoteNumber}: Failed to create quote - ${error.message}`);
              failCount++;
              continue;
            }

            const result = assertRpcResult<{ quote_id: string }>(data, 'save_quote');
            clearImportIdempotencyKey(quoteNumber, idemPayloadScope);
            try {
              await logActivity({
                event: 'quote_bulk_imported',
                description: `Bulk imported quote ${quoteNumber} with ${itemsCreated} item(s)`,
                performedBy: profile.id,
                entityType: 'quote',
                entityId: result.quote_id,
                customerId,
              });
            } catch (logError) {
              Sentry.captureException(logError instanceof Error ? logError : new Error(String(logError)), {
                extra: { context: 'BulkQuoteImport.logActivity', quoteNumber, quoteId: result.quote_id },
              });
            }
            details.push(`Quote ${quoteNumber}: Created with ${itemsCreated} items`);
            successCount++;
          } else {
            details.push(`Quote ${quoteNumber}: No items could be created`);
            failCount++;
          }
        } catch (error) {
          if (!isBelowCostApprovalHandledError(error)) {
            Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
              extra: { context: 'BulkQuoteImport.createQuote', quoteNumber },
            });
          }
          details.push(`Quote ${quoteNumber}: ${isBelowCostApprovalHandledError(error) ? 'Below-cost save cancelled or requires an admin' : error instanceof Error ? error.message : 'Unexpected error'}`);
          failCount++;
        }
      }

      setUploadResults({ success: successCount, failed: failCount, details });

      if (successCount > 0) {
        toast('success', `Successfully imported ${successCount} quote(s)`);
        onSuccess();
      }
      if (failCount > 0) {
        toast('error', `Failed to import ${failCount} quote(s)`);
      }
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        extra: { context: 'BulkQuoteImport.import' },
      });
      toast('error', 'Import failed');
    }
    setUploading(false);
  };

  const handleClose = () => {
    setFile(null);
    setValidation(null);
    setUploadResults(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Bulk Quote" accent="Import" maxWidth="max-w-4xl">
      <div className="space-y-4">
        <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
          <h4 className="text-sm font-medium text-nav-dark mb-2 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-600" />
            How to Import Quotes
          </h4>
          <ol className="text-xs text-secondary space-y-1 list-decimal list-inside mb-3">
            <li>Upload a CSV, PDF quote document, or photo of a quote sheet</li>
            <li>Multiple rows with the same quote_number will be grouped into one quote</li>
            <li>Customers and products must already exist in the system</li>
            <li>PDF/image files are processed with Google Vision OCR</li>
          </ol>
          <div className="p-3 bg-white rounded border border-gray-200">
            <p className="text-xs font-medium text-secondary mb-2">Required Columns:</p>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="text-xs">
                <span className="font-mono text-red-600">quote_number</span>
                <p className="text-gray-500">Unique quote ID</p>
              </div>
              <div className="text-xs">
                <span className="font-mono text-red-600">customer_farm_name</span>
                <p className="text-gray-500">Must match existing customer</p>
              </div>
              <div className="text-xs">
                <span className="font-mono text-red-600">product_name</span>
                <p className="text-gray-500">Must match existing product</p>
              </div>
            </div>
            <p className="text-xs font-medium text-secondary mb-2">Optional Columns:</p>
            <p className="text-xs text-gray-500 font-mono">
              section_name, acres, price_per_unit, oz_per_acre, actual_rate, rate_unit, notes, tier (1-3),
              status (draft), valid_days, header_notes, footer_notes
            </p>
          </div>
        </div>

        {!validation && !uploadResults && (
          <div>
            <label className="block text-sm font-medium text-secondary mb-2">Select File</label>
            <input
              type="file"
              accept=".csv,.pdf,.jpg,.jpeg,.png,.webp,image/*"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-crx-green-light file:text-crx-green hover:file:bg-crx-green hover:file:text-white transition-colors cursor-pointer"
            />
            {file && (
              <div className="mt-2 flex items-center gap-2 text-xs text-secondary">
                <FileText className="w-4 h-4" />
                <span>
                  {file.name} ({(file.size / 1024).toFixed(1)} KB)
                </span>
                {!isCSVFile(file) && <span className="text-blue-600">(Vision OCR)</span>}
              </div>
            )}
          </div>
        )}

        {validation && !uploadResults && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="p-4 bg-green-50 border border-green-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <span className="text-sm font-medium text-secondary">Valid Items</span>
                </div>
                <p className="text-2xl font-semibold text-green-600">{validation.valid.length}</p>
              </div>
              <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <FileText className="w-5 h-5 text-blue-600" />
                  <span className="text-sm font-medium text-secondary">Unique Quotes</span>
                </div>
                <p className="text-2xl font-semibold text-blue-600">
                  {new Set(validation.valid.map((v) => v.quote_number)).size}
                </p>
              </div>
              <div className="p-4 bg-red-50 border border-red-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle className="w-5 h-5 text-red-600" />
                  <span className="text-sm font-medium text-secondary">Invalid Rows</span>
                </div>
                <p className="text-2xl font-semibold text-red-600">{validation.invalid.length}</p>
              </div>
            </div>

            {validation.valid.length > 0 && (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg max-h-48 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-2">Preview (first 10 items):</p>
                <div className="space-y-2">
                  {validation.valid.slice(0, 10).map((item, idx) => (
                    <div key={idx} className="text-xs bg-white p-2 rounded border border-gray-100">
                      <p className="font-medium text-nav-dark">
                        Quote: {item.quote_number} | Customer: {item.customer_farm_name}
                      </p>
                      <p className="text-gray-500">
                        Product: {item.product_name}
                        {item.acres && ` | ${item.acres} acres`}
                        {item.section_name && ` | Section: ${item.section_name}`}
                      </p>
                    </div>
                  ))}
                  {validation.valid.length > 10 && (
                    <p className="text-xs text-secondary text-center pt-1">
                      + {validation.valid.length - 10} more items
                    </p>
                  )}
                </div>
              </div>
            )}

            {validation.invalid.length > 0 && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-lg max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-1">Invalid Rows:</p>
                <div className="space-y-1">
                  {validation.invalid.map((inv, idx) => (
                    <p key={idx} className="text-xs text-secondary">
                      Row {inv.row}: {inv.error}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {uploadResults && (
          <div className="space-y-3">
            <div className="p-4 bg-green-50 border border-green-100 rounded-lg text-center">
              <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-2" />
              <h4 className="text-sm font-medium text-nav-dark mb-1">Import Complete</h4>
              <p className="text-xs text-secondary">
                Successfully imported {uploadResults.success} quote(s)
                {uploadResults.failed > 0 && `, ${uploadResults.failed} failed`}
              </p>
            </div>
            {uploadResults.details.length > 0 && (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg max-h-48 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-2">Details:</p>
                <div className="space-y-1">
                  {uploadResults.details.map((detail, idx) => (
                    <p key={idx} className="text-xs text-secondary">
                      {detail}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose}>
            {uploadResults ? 'Close' : 'Cancel'}
          </Button>
          {!validation && !uploadResults && (
            <Button
              icon={<Upload className="w-4 h-4" />}
              onClick={handleParse}
              disabled={!file || parsing}
              loading={parsing}
            >
              {file && !isCSVFile(file) ? (parsing ? 'Processing with Vision OCR...' : 'Process with Vision OCR') : 'Parse File'}
            </Button>
          )}
          {validation && !uploadResults && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setFile(null);
                  setValidation(null);
                }}
              >
                Choose Different File
              </Button>
              <Button
                onClick={handleUpload}
                disabled={validation.valid.length === 0 || uploading}
                loading={uploading}
              >
                Import {new Set(validation.valid.map((v) => v.quote_number)).size} Quote(s)
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
