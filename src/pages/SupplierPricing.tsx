import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  FileSpreadsheet,
  FileText,
  Link2,
  PencilLine,
  RefreshCw,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Card, { CardHeader } from '../components/ui/Card';
import ConfirmModal from '../components/ui/ConfirmModal';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import PageHeader from '../components/ui/PageHeader';
import Select from '../components/ui/Select';
import Tabs from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { localToday } from '../lib/dateUtils';
import { sanitizeError } from '../lib/errorSanitizer';
import {
  approveSupplierPriceImport,
  correctSupplierPriceObservation,
  formatSupplierCents,
  getSupplierPriceImport,
  getSupplierPricingWorkspace,
  getSupplierQuoteSheet,
  rejectSupplierPriceImport,
  reviewVendorAlias,
  stageSupplierPriceImport,
  stageVendorAlias,
  uploadSupplierSourcePdf,
  upsertProductSupplierLink,
  type SupplierImportReview,
  type SupplierImportReviewRow,
  type SupplierPricingWorkspace,
} from '../lib/supplierPricing';
import {
  generateSupplierQuoteWorkbook,
  MAX_SUPPLIER_QUOTE_BYTES,
  parseSupplierQuoteWorkbook,
} from '../lib/supplierPricingWorkbook';

const today = () => localToday();

const blankLink = {
  productId: '',
  vendorId: '',
  supplierSku: '',
  supplierProductName: '',
  supplierUom: '',
  supplierPackDescription: '',
  inventoryUnitsPerSupplierUnit: '',
  conversionUnit: '',
  comparisonStatus: 'pending' as 'pending' | 'comparable' | 'not_comparable',
  comparisonNote: '',
  isPreferred: false,
};

const blankQuickQuote = {
  linkId: '',
  newCost: '',
  effectiveDate: today(),
  priceKind: 'quote' as 'list' | 'quote' | 'contract' | 'promo' | 'manual',
  priceUnit: '',
  packageQuantity: '1',
};

function eligibleReviewRow(status: string): boolean {
  return status === 'new' || status === 'changed' || status === 'cannot_compare';
}

export default function SupplierPricing() {
  const { profile, role } = useAuth();
  const { toast } = useToast();
  const isAdmin = role === 'admin';
  const [activeTab, setActiveTab] = useState('quotes');
  const [workspace, setWorkspace] = useState<SupplierPricingWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedVendorId, setSelectedVendorId] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [documentDate, setDocumentDate] = useState(today());
  const [sourcePdf, setSourcePdf] = useState<File | null>(null);
  const [uploadedPdfPath, setUploadedPdfPath] = useState<string | null>(null);
  const [review, setReview] = useState<SupplierImportReview | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [correctionRow, setCorrectionRow] = useState<SupplierImportReviewRow | null>(null);
  const [correctionCost, setCorrectionCost] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [quickQuote, setQuickQuote] = useState(blankQuickQuote);
  const [linkForm, setLinkForm] = useState(blankLink);
  const [aliasText, setAliasText] = useState('');
  const [aliasVendorId, setAliasVendorId] = useState('');
  const [aliasReviewIntent, setAliasReviewIntent] = useState<string | null>(null);
  const workbookInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const stageImportIdem = useIdempotencyKey('stage_supplier_price_import', profile?.id || '');
  const approveImportIdem = useIdempotencyKey('approve_supplier_price_import', profile?.id || '');
  const rejectImportIdem = useIdempotencyKey('reject_supplier_price_import', profile?.id || '');
  const linkIdem = useIdempotencyKey('upsert_product_supplier_link', profile?.id || '');
  const aliasStageIdem = useIdempotencyKey('stage_vendor_alias', profile?.id || '');
  const aliasReviewIdem = useIdempotencyKey('review_vendor_alias', profile?.id || '');
  const correctionIdem = useIdempotencyKey('correct_supplier_price_observation', profile?.id || '');

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getSupplierPricingWorkspace();
      setWorkspace(result);
      setSelectedVendorId((current) => current || result.vendors[0]?.id || '');
      setSelectedProductId((current) => current || result.products[0]?.id || '');
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    if (!review) {
      setSelectedRowIds(new Set());
      return;
    }
    setSelectedRowIds(new Set(
      review.rows.filter((row) => eligibleReviewRow(row.row_status)).map((row) => row.id),
    ));
  }, [review]);

  const vendorOptions = useMemo(
    () => (workspace?.vendors ?? []).map((vendor) => ({ value: vendor.id, label: vendor.name })),
    [workspace],
  );
  const productOptions = useMemo(
    () => (workspace?.products ?? []).map((product) => ({
      value: product.id,
      label: product.sku ? `${product.product_name} (${product.sku})` : product.product_name,
    })),
    [workspace],
  );
  const vendorLinks = useMemo(
    () => (workspace?.links ?? []).filter((link) => (
      link.vendor_id === selectedVendorId && link.is_active && link.is_reusable
    )),
    [selectedVendorId, workspace],
  );
  const selectedEvidence = useMemo(
    () => workspace?.evidence.find((item) => item.product_id === selectedProductId) ?? null,
    [selectedProductId, workspace],
  );
  const linkProduct = useMemo(
    () => workspace?.products.find((product) => product.id === linkForm.productId) ?? null,
    [linkForm.productId, workspace],
  );

  const attachPdf = (file: File | null) => {
    stageImportIdem.resetKey();
    setSourcePdf(file);
    setUploadedPdfPath(null);
  };

  const ensurePdfStored = async (): Promise<string | null> => {
    if (!sourcePdf || !profile) return null;
    if (uploadedPdfPath) return uploadedPdfPath;
    const path = await uploadSupplierSourcePdf(sourcePdf, profile.id);
    setUploadedPdfPath(path);
    return path;
  };

  const handleExport = async () => {
    if (!selectedVendorId) {
      toast('error', 'Choose a supplier first.');
      return;
    }
    setBusy(true);
    try {
      const quote = await getSupplierQuoteSheet(selectedVendorId);
      if (quote.rows.length === 0) {
        throw new Error('This supplier has no confirmed reusable Product links yet.');
      }
      const blob = await generateSupplierQuoteWorkbook(quote);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `crx-${quote.vendor_name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-quote-${today()}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast('success', `Exported ${quote.rows.length} prefilled supplier quote row(s).`);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const handleWorkbookUpload = async (file: File) => {
    if (!profile) return;
    if (!file.name.toLowerCase().endsWith('.xlsx') || file.size > MAX_SUPPLIER_QUOTE_BYTES) {
      toast('error', 'Choose a CRX .xlsx supplier quote sheet no larger than 10 MB.');
      return;
    }
    setBusy(true);
    try {
      const parsed = await parseSupplierQuoteWorkbook(await file.arrayBuffer());
      const sourcePath = await ensurePdfStored();
      const result = await stageSupplierPriceImport({
        vendorId: parsed.vendorId,
        documentDate,
        ingestionMethod: 'quote_sheet',
        formatVersion: parsed.formatVersion,
        sourceDocumentPath: sourcePath,
        sourceDocumentName: sourcePdf?.name ?? null,
        sourceDocumentMime: sourcePdf ? 'application/pdf' : null,
        rows: parsed.rows,
        performedBy: profile.id,
        idempotencyKey: stageImportIdem.getKey(),
      });
      stageImportIdem.resetKey();
      setSelectedVendorId(parsed.vendorId);
      setReview(result);
      toast('success', `Staged ${result.row_count} manual quote row(s) for review.`);
      await loadWorkspace();
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
      if (workbookInputRef.current) workbookInputRef.current.value = '';
    }
  };

  const handleQuickQuote = async () => {
    if (!profile || !selectedVendorId || !quickQuote.linkId || !quickQuote.newCost.trim()) {
      toast('error', 'Supplier, linked Product, and quoted cost are required.');
      return;
    }
    setBusy(true);
    try {
      const sourcePath = await ensurePdfStored();
      const result = await stageSupplierPriceImport({
        vendorId: selectedVendorId,
        documentDate,
        ingestionMethod: 'quick_quote',
        formatVersion: 'crx-supplier-quick-quote-phase1b-v1',
        sourceDocumentPath: sourcePath,
        sourceDocumentName: sourcePdf?.name ?? null,
        sourceDocumentMime: sourcePdf ? 'application/pdf' : null,
        rows: [{
          product_supplier_link_id: quickQuote.linkId,
          new_cost: quickQuote.newCost,
          effective_date: quickQuote.effectiveDate,
          price_kind: quickQuote.priceKind,
          price_unit: quickQuote.priceUnit,
          package_quantity: quickQuote.packageQuantity,
          has_formula: false,
          formula_cells: [],
        }],
        performedBy: profile.id,
        idempotencyKey: stageImportIdem.getKey(),
      });
      stageImportIdem.resetKey();
      setReview(result);
      toast('success', 'Quick quote staged for review. No sell price was changed.');
      await loadWorkspace();
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async () => {
    if (!profile || !review) return;
    setBusy(true);
    try {
      const result = await approveSupplierPriceImport({
        importId: review.id,
        rowIds: [...selectedRowIds],
        performedBy: profile.id,
        idempotencyKey: approveImportIdem.getKey(),
      });
      approveImportIdem.resetKey();
      setReview(result);
      setApproveOpen(false);
      toast('success', result.summary || `${result.approved_count ?? 0} supplier observation(s) approved.`);
      await loadWorkspace();
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!profile || !review) return;
    if (!rejectReason.trim()) {
      toast('error', 'A rejection reason is required.');
      return;
    }
    setBusy(true);
    try {
      const result = await rejectSupplierPriceImport({
        importId: review.id,
        reason: rejectReason.trim(),
        performedBy: profile.id,
        idempotencyKey: rejectImportIdem.getKey(),
      });
      rejectImportIdem.resetKey();
      setReview(result);
      setRejectOpen(false);
      setRejectReason('');
      toast('success', result.summary || 'Import rejected. No supplier observations were changed.');
      await loadWorkspace();
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const openCorrection = (row: SupplierImportReviewRow) => {
    correctionIdem.resetKey();
    setCorrectionRow(row);
    setCorrectionCost('');
    setCorrectionReason('');
  };

  const handleCorrection = async () => {
    if (!profile || !isAdmin || !correctionRow?.observation_id) return;
    if (!correctionCost.trim() || !correctionReason.trim()) {
      toast('error', 'A corrected cost and a reason are both required.');
      return;
    }
    setBusy(true);
    try {
      const result = await correctSupplierPriceObservation({
        observationId: correctionRow.observation_id,
        correctedCost: correctionCost.trim(),
        reason: correctionReason.trim(),
        performedBy: profile.id,
        idempotencyKey: correctionIdem.getKey(),
      });
      correctionIdem.resetKey();
      setCorrectionRow(null);
      toast('success', result.summary || 'Correction recorded. The prior quote is superseded.');
      if (review) setReview(await getSupplierPriceImport(review.id));
      await loadWorkspace();
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const openImport = async (importId: string) => {
    setBusy(true);
    try {
      setReview(await getSupplierPriceImport(importId));
      setActiveTab('quotes');
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const handleLinkSave = async () => {
    if (!profile || !isAdmin) return;
    setBusy(true);
    try {
      await upsertProductSupplierLink({
        ...linkForm,
        performedBy: profile.id,
        idempotencyKey: linkIdem.getKey(),
      });
      linkIdem.resetKey();
      setLinkForm(blankLink);
      toast('success', 'Confirmed supplier link saved.');
      await loadWorkspace();
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const handleAliasStage = async () => {
    if (!profile || !aliasText.trim() || !aliasVendorId) return;
    setBusy(true);
    try {
      await stageVendorAlias({
        aliasRaw: aliasText,
        aliasDisplay: aliasText,
        proposedVendorId: aliasVendorId,
        source: 'manual',
        performedBy: profile.id,
        idempotencyKey: aliasStageIdem.getKey(),
      });
      aliasStageIdem.resetKey();
      setAliasText('');
      toast('success', 'Vendor alias staged for review.');
      await loadWorkspace();
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const handleAliasReview = async (aliasId: string, vendorId: string | null, decision: 'approved' | 'rejected') => {
    if (!profile) return;
    const intent = `${aliasId}:${decision}`;
    if (aliasReviewIntent !== intent) {
      aliasReviewIdem.resetKey();
      setAliasReviewIntent(intent);
    }
    setBusy(true);
    try {
      await reviewVendorAlias({
        aliasId,
        vendorId,
        decision,
        reviewNote: 'Reviewed in Supplier Pricing Phase 1b',
        performedBy: profile.id,
        idempotencyKey: aliasReviewIdem.getKey(),
      });
      aliasReviewIdem.resetKey();
      setAliasReviewIntent(null);
      toast('success', `Vendor alias ${decision}.`);
      await loadWorkspace();
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const quotesTab = (
    <div className="mt-5 space-y-5">
      <Card>
        <CardHeader title="Supplier" accent="quote sheet" />
        <div className="grid gap-4 md:grid-cols-3">
          <Select
            label="Supplier"
            value={selectedVendorId}
            onChange={(event) => {
              stageImportIdem.resetKey();
              setSelectedVendorId(event.target.value);
              setQuickQuote(blankQuickQuote);
            }}
            options={vendorOptions}
            placeholder="Choose supplier"
          />
          <Input
            label="Quote document date"
            type="date"
            value={documentDate}
            onChange={(event) => {
              stageImportIdem.resetKey();
              setDocumentDate(event.target.value);
            }}
          />
          <div>
            <p className="mb-1 text-sm font-medium text-secondary">Optional source PDF</p>
            <input
              ref={pdfInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(event) => attachPdf(event.target.files?.[0] ?? null)}
            />
            <Button
              type="button"
              variant="secondary"
              icon={<FileText className="h-4 w-4" />}
              onClick={() => pdfInputRef.current?.click()}
            >
              {sourcePdf ? sourcePdf.name : 'Attach PDF for audit'}
            </Button>
            <p className="mt-1 text-xs text-secondary">Stored for audit only. CRX never parses this PDF.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            icon={<Download className="h-4 w-4" />}
            loading={busy}
            onClick={handleExport}
          >
            Download prefilled .xlsx
          </Button>
          {isAdmin && (
            <>
              <input
                ref={workbookInputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleWorkbookUpload(file);
                }}
              />
              <Button
                type="button"
                variant="secondary"
                icon={<Upload className="h-4 w-4" />}
                loading={busy}
                onClick={() => workbookInputRef.current?.click()}
              >
                Upload completed .xlsx
              </Button>
            </>
          )}
        </div>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader title="Quick" accent="quote" />
          <div className="grid gap-4 md:grid-cols-3">
            <Select
              label="Linked Product"
              value={quickQuote.linkId}
              onChange={(event) => {
                stageImportIdem.resetKey();
                const link = vendorLinks.find((item) => item.id === event.target.value);
                setQuickQuote((current) => ({
                  ...current,
                  linkId: event.target.value,
                  priceUnit: link?.supplier_uom ?? '',
                }));
              }}
              options={vendorLinks.map((link) => ({
                value: link.id,
                label: `${link.product_name} — ${link.supplier_sku || 'no supplier SKU'}`,
              }))}
              placeholder="Choose linked Product"
            />
            <Input
              label="Quoted cost (dollars)"
              inputMode="decimal"
              placeholder="125.50"
              value={quickQuote.newCost}
              onChange={(event) => {
                stageImportIdem.resetKey();
                setQuickQuote((current) => ({ ...current, newCost: event.target.value }));
              }}
            />
            <Input
              label="Effective date"
              type="date"
              value={quickQuote.effectiveDate}
              onChange={(event) => {
                stageImportIdem.resetKey();
                setQuickQuote((current) => ({ ...current, effectiveDate: event.target.value }));
              }}
            />
            <Select
              label="Price type"
              value={quickQuote.priceKind}
              onChange={(event) => {
                stageImportIdem.resetKey();
                setQuickQuote((current) => ({
                  ...current,
                  priceKind: event.target.value as typeof current.priceKind,
                }));
              }}
              options={['list', 'quote', 'contract', 'promo', 'manual'].map((value) => ({ value, label: value }))}
            />
            <Input
              label="Supplier price unit"
              value={quickQuote.priceUnit}
              onChange={(event) => {
                stageImportIdem.resetKey();
                setQuickQuote((current) => ({ ...current, priceUnit: event.target.value }));
              }}
            />
            <Input
              label="Package quantity"
              inputMode="decimal"
              value={quickQuote.packageQuantity}
              onChange={(event) => {
                stageImportIdem.resetKey();
                setQuickQuote((current) => ({ ...current, packageQuantity: event.target.value }));
              }}
            />
          </div>
          <Button className="mt-4" type="button" loading={busy} onClick={handleQuickQuote}>
            Stage quick quote
          </Button>
        </Card>
      )}

      {review && (
        <Card>
          <CardHeader
            title="Staged import"
            accent="review"
            action={<Badge variant={statusToBadgeVariant[review.status]}>{review.status.replace(/_/g, ' ')}</Badge>}
          />
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm font-semibold text-blue-900">
            You are adding {selectedRowIds.size} supplier observations. You are changing ZERO sell prices.
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-gray-200 text-xs uppercase text-secondary">
                <tr>
                  <th className="px-2 py-2">Use</th>
                  <th className="px-2 py-2">Product</th>
                  <th className="px-2 py-2">Supplier item</th>
                  <th className="px-2 py-2">Cost</th>
                  <th className="px-2 py-2">Effective</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {review.rows.map((row) => {
                  const eligible = eligibleReviewRow(row.row_status);
                  return (
                    <tr key={row.id} className="border-b border-gray-100">
                      <td className="px-2 py-2">
                        <input
                          aria-label={`Select row ${row.row_number}`}
                          type="checkbox"
                          checked={selectedRowIds.has(row.id)}
                          disabled={!eligible || review.status !== 'needs_review'}
                          onChange={(event) => setSelectedRowIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(row.id); else next.delete(row.id);
                            return next;
                          })}
                        />
                      </td>
                      <td className="px-2 py-2 font-medium">{row.product_name || 'Unmatched Product'}</td>
                      <td className="px-2 py-2">{row.supplier_product_name || row.supplier_sku || '—'}</td>
                      <td className="px-2 py-2 tabular-nums">{formatSupplierCents(row.cost_cents)}</td>
                      <td className="px-2 py-2">{row.effective_from || '—'}</td>
                      <td className="px-2 py-2">
                        <Badge variant={eligible ? 'info' : row.row_status === 'approved' ? 'success' : 'warning'}>
                          {row.row_status.replace(/_/g, ' ')}
                        </Badge>
                        {row.validation_errors.length > 0 && (
                          <p className="mt-1 text-xs text-red-700">{row.validation_errors.join(', ')}</p>
                        )}
                        {isAdmin && row.row_status === 'approved' && row.observation_id && (
                          <Button
                            className="mt-1"
                            size="sm"
                            type="button"
                            variant="ghost"
                            icon={<PencilLine className="h-3.5 w-3.5" />}
                            onClick={() => openCorrection(row)}
                          >
                            Correct this quote
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {isAdmin && review.status === 'needs_review' && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                icon={<ShieldCheck className="h-4 w-4" />}
                disabled={selectedRowIds.size === 0}
                onClick={() => setApproveOpen(true)}
              >
                Approve selected observations
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => { rejectImportIdem.resetKey(); setRejectReason(''); setRejectOpen(true); }}
              >
                Reject import
              </Button>
            </div>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title="Recent" accent="imports" />
        <div className="space-y-2">
          {(workspace?.imports ?? []).map((item) => (
            <button
              key={item.id}
              type="button"
              className="flex w-full items-center justify-between rounded-lg border border-gray-200 p-3 text-left hover:bg-gray-50"
              onClick={() => void openImport(item.id)}
            >
              <span>
                <span className="block font-medium text-nav-dark">{item.vendor_name}</span>
                <span className="text-xs text-secondary">{item.document_date} · {item.row_count} row(s)</span>
              </span>
              <Badge variant={statusToBadgeVariant[item.status]}>{item.status.replace(/_/g, ' ')}</Badge>
            </button>
          ))}
          {!loading && (workspace?.imports.length ?? 0) === 0 && (
            <p className="text-sm text-secondary">No supplier quote imports have been staged.</p>
          )}
        </div>
      </Card>
    </div>
  );

  const comparisonTab = (
    <div className="mt-5 space-y-5">
      <Card>
        <CardHeader title="Supplier" accent="comparison" />
        <Select
          label="Product"
          value={selectedProductId}
          onChange={(event) => setSelectedProductId(event.target.value)}
          options={productOptions}
          placeholder="Choose Product"
        />
      </Card>
      <Card>
        {selectedEvidence ? (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <div><p className="text-xs text-secondary">Best comparable supplier</p><p className="font-semibold">{selectedEvidence.best_supplier || 'Cannot compare'}</p></div>
              <div><p className="text-xs text-secondary">Replacement cost</p><p className="font-semibold tabular-nums">{formatSupplierCents(selectedEvidence.replacement_cost_cents)}</p></div>
              <div><p className="text-xs text-secondary">Latest comparable date</p><p className="font-semibold">{selectedEvidence.replacement_cost_as_of || '—'}</p></div>
            </div>
            <div className="space-y-2">
              {selectedEvidence.suppliers.map((supplier) => (
                <div key={supplier.product_supplier_link_id} className="grid gap-2 rounded-lg border border-gray-200 p-3 sm:grid-cols-4">
                  <span className="font-medium">{supplier.vendor_name}</span>
                  <span className="tabular-nums">Package: {formatSupplierCents(supplier.quoted_package_cost_cents)}</span>
                  <span className="tabular-nums">Normalized: {formatSupplierCents(supplier.normalized_cost_cents)}</span>
                  <Badge variant={supplier.comparison_status === 'comparable' ? 'success' : 'warning'}>
                    {supplier.comparison_status === 'comparable' ? 'Comparable' : 'Cannot compare'}
                  </Badge>
                </div>
              ))}
              {selectedEvidence.suppliers.length === 0 && <p className="text-sm text-secondary">No approved supplier evidence yet.</p>}
            </div>
          </>
        ) : <p className="text-sm text-secondary">Choose a Product to compare supplier evidence.</p>}
      </Card>
    </div>
  );

  const linksTab = (
    <div className="mt-5 space-y-5">
      {isAdmin && (
        <Card>
          <CardHeader title="Confirm Product" accent="supplier link" />
          <div className="grid gap-4 md:grid-cols-3">
            <Select label="Product" value={linkForm.productId} onChange={(event) => { const product = workspace?.products.find((item) => item.id === event.target.value); linkIdem.resetKey(); setLinkForm((current) => ({ ...current, productId: event.target.value, conversionUnit: product?.inventory_unit ?? '' })); }} options={productOptions} placeholder="Choose Product" />
            <Select label="Supplier" value={linkForm.vendorId} onChange={(event) => { linkIdem.resetKey(); setLinkForm((current) => ({ ...current, vendorId: event.target.value })); }} options={vendorOptions} placeholder="Choose supplier" />
            <Input label="Supplier SKU" value={linkForm.supplierSku} onChange={(event) => { linkIdem.resetKey(); setLinkForm((current) => ({ ...current, supplierSku: event.target.value })); }} />
            <Input label="Supplier Product name" value={linkForm.supplierProductName} onChange={(event) => { linkIdem.resetKey(); setLinkForm((current) => ({ ...current, supplierProductName: event.target.value })); }} />
            <Input label="Supplier price unit" value={linkForm.supplierUom} onChange={(event) => { linkIdem.resetKey(); setLinkForm((current) => ({ ...current, supplierUom: event.target.value })); }} />
            <Input label="Supplier pack description" value={linkForm.supplierPackDescription} onChange={(event) => { linkIdem.resetKey(); setLinkForm((current) => ({ ...current, supplierPackDescription: event.target.value })); }} />
            <Input label="Inventory units per supplier unit" inputMode="decimal" value={linkForm.inventoryUnitsPerSupplierUnit} onChange={(event) => { linkIdem.resetKey(); setLinkForm((current) => ({ ...current, inventoryUnitsPerSupplierUnit: event.target.value })); }} />
            <Input label="Inventory conversion unit" value={linkForm.conversionUnit} readOnly placeholder="Select a product" />
            <Select label="Comparison status" value={linkForm.comparisonStatus} onChange={(event) => { linkIdem.resetKey(); setLinkForm((current) => ({ ...current, comparisonStatus: event.target.value as typeof current.comparisonStatus })); }} options={[{ value: 'pending', label: 'Pending' }, { value: 'comparable', label: 'Comparable' }, { value: 'not_comparable', label: 'Cannot compare' }]} />
            <Input label="Comparison note" value={linkForm.comparisonNote} onChange={(event) => { linkIdem.resetKey(); setLinkForm((current) => ({ ...current, comparisonNote: event.target.value })); }} />
            <label className="flex items-center gap-2 self-end pb-3 text-sm font-medium text-secondary"><input type="checkbox" checked={linkForm.isPreferred} onChange={(event) => { linkIdem.resetKey(); setLinkForm((current) => ({ ...current, isPreferred: event.target.checked })); }} />Preferred supplier</label>
          </div>
          <p className="mt-3 text-xs text-secondary">Direction: supplier package cost ÷ inventory units per supplier unit = normalized cost per {linkProduct?.inventory_unit || 'product inventory unit'}. The conversion unit is locked to the product.</p>
          <Button className="mt-4" type="button" icon={<Link2 className="h-4 w-4" />} loading={busy} onClick={handleLinkSave}>Save confirmed link</Button>
        </Card>
      )}
      <Card>
        <CardHeader title="Current" accent="links" />
        <div className="space-y-2">
          {(workspace?.links ?? []).map((link) => (
            <div key={link.id} className="grid gap-2 rounded-lg border border-gray-200 p-3 md:grid-cols-4">
              <span className="font-medium">{link.product_name}</span>
              <span>{link.vendor_name} · {link.supplier_sku || 'no SKU'}</span>
              <span>{link.inventory_units_per_supplier_unit ?? '—'} {link.conversion_unit || ''}</span>
              <Badge variant={link.comparison_status === 'comparable' ? 'success' : 'warning'}>{link.comparison_status.replace(/_/g, ' ')}</Badge>
            </div>
          ))}
          {!loading && (workspace?.links.length ?? 0) === 0 && <p className="text-sm text-secondary">No Product/supplier links yet.</p>}
        </div>
      </Card>
    </div>
  );

  const aliasesTab = (
    <div className="mt-5 space-y-5">
      {isAdmin && (
        <Card>
          <CardHeader title="Stage vendor" accent="alias" />
          <div className="grid gap-4 md:grid-cols-2">
            <Input label="Alias spelling" value={aliasText} onChange={(event) => { aliasStageIdem.resetKey(); setAliasText(event.target.value); }} />
            <Select label="Proposed canonical vendor" value={aliasVendorId} onChange={(event) => { aliasStageIdem.resetKey(); setAliasVendorId(event.target.value); }} options={vendorOptions} placeholder="Choose canonical vendor" />
          </div>
          <Button className="mt-4" type="button" loading={busy} onClick={handleAliasStage}>Stage for review</Button>
        </Card>
      )}
      <Card>
        <CardHeader title="Alias" accent="review queue" />
        <div className="space-y-2">
          {(workspace?.aliases ?? []).map((alias) => (
            <div key={alias.id} className="flex flex-col gap-3 rounded-lg border border-gray-200 p-3 sm:flex-row sm:items-center sm:justify-between">
              <span><span className="font-medium">{alias.alias_display}</span><span className="ml-2 text-xs text-secondary">{alias.alias_normalized}</span></span>
              <div className="flex items-center gap-2">
                <Badge variant={statusToBadgeVariant[alias.review_status]}>{alias.review_status}</Badge>
                {isAdmin && alias.review_status === 'pending' && (
                  <>
                    <Button size="sm" type="button" loading={busy && aliasReviewIntent === `${alias.id}:approved`} onClick={() => void handleAliasReview(alias.id, alias.proposed_vendor_id, 'approved')}>Approve</Button>
                    <Button size="sm" type="button" variant="secondary" loading={busy && aliasReviewIntent === `${alias.id}:rejected`} onClick={() => void handleAliasReview(alias.id, null, 'rejected')}>Reject</Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Supplier"
        accent="Pricing"
        subtitle="Manual supplier evidence only. Review observations before approval; sell prices never change here."
        actions={<Button type="button" variant="secondary" icon={<RefreshCw className="h-4 w-4" />} loading={loading} onClick={() => void loadWorkspace()}>Refresh</Button>}
      />
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>No OCR or AI extraction:</strong> staff transcribe supplier PDFs into the protected .xlsx sheet. PDFs are retained only as audit evidence.
      </div>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        ariaLabel="Supplier pricing sections"
        tabs={[
          { key: 'quotes', label: <span className="inline-flex items-center gap-2"><FileSpreadsheet className="h-4 w-4" />Quote review</span>, content: quotesTab },
          { key: 'comparison', label: 'Comparison', content: comparisonTab },
          { key: 'links', label: 'Product links', content: linksTab, count: workspace?.links.length },
          { key: 'aliases', label: 'Vendor aliases', content: aliasesTab, count: workspace?.aliases.filter((alias) => alias.review_status === 'pending').length },
        ]}
      />
      <ConfirmModal
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        onConfirm={handleApprove}
        title="Approve supplier observations?"
        message={`You are adding ${selectedRowIds.size} supplier observations. You are changing ZERO sell prices.`}
        confirmLabel="Approve observations"
        variant="info"
        loading={busy}
      />
      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        closeDisabled={busy}
        title="Reject"
        accent="supplier import"
        footer={(
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => setRejectOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={busy}
              disabled={!rejectReason.trim()}
              onClick={handleReject}
            >
              Reject import
            </Button>
          </div>
        )}
      >
        <p className="text-sm text-secondary">
          This closes the import without approving any rows. No supplier observations are created and
          no sell price changes. Rows keep their statuses for the audit trail; nothing is deleted.
        </p>
        <div className="mt-4">
          <Input
            label="Reason for rejecting"
            placeholder="All rows were duplicates of the June quote sheet"
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
          />
        </div>
      </Modal>
      <Modal
        open={correctionRow !== null}
        onClose={() => setCorrectionRow(null)}
        closeDisabled={busy}
        title="Correct"
        accent="supplier quote"
        maxWidth="max-w-2xl"
        footer={(
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => setCorrectionRow(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              loading={busy}
              disabled={!correctionCost.trim() || !correctionReason.trim()}
              onClick={handleCorrection}
            >
              Record correction
            </Button>
          </div>
        )}
      >
        <p className="text-sm text-secondary">
          This appends a new, corrected supplier observation and supersedes the original. Nothing is
          edited or deleted, and no sell price changes.
        </p>
        <p className="mt-2 text-sm text-nav-dark">
          Correcting <span className="font-medium">{correctionRow?.product_name || 'this quote'}</span>
          {correctionRow ? ` (was ${formatSupplierCents(correctionRow.cost_cents)})` : ''}.
        </p>
        <div className="mt-4 grid gap-4">
          <Input
            label="Corrected cost (dollars)"
            inputMode="decimal"
            placeholder="125.50"
            value={correctionCost}
            onChange={(event) => setCorrectionCost(event.target.value)}
          />
          <Input
            label="Reason for correction"
            placeholder="Transcription typo — supplier quoted $125.50"
            value={correctionReason}
            onChange={(event) => setCorrectionReason(event.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
}
