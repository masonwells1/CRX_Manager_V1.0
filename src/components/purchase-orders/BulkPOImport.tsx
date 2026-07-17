import { useState, useEffect, useRef } from 'react';
import { Upload, CheckCircle, AlertCircle, ChevronDown, ChevronRight, Trash2, Search, Sparkles } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { supabase, assertRpcResult } from '../../lib/db';
import { processDocumentWithOCR, isOCRSupported } from '../../lib/documentOCR';
import { Sentry } from '../../lib/sentry';
import { formatUSD as fmt } from '../../lib/money';
import type { Product } from '../../types';
import {
  purchaseOrderCentsToDollars,
  purchaseOrderLineTotalCents,
  purchaseOrderUnitCostCents,
} from '../../lib/purchaseOrderMoney';
import {
  buildBulkPOIntentKey,
  buildBulkPODocumentClaimKey,
  buildBulkPOIdempotencyKey,
  bulkPOImportFailureGuidance,
  ensurePendingBulkPOIntent,
  getPendingBulkPOIntent,
  loadPendingBulkPOIntents,
  markBulkPOIntentImported,
  normalizeBulkPOInvoiceDate,
  savePendingBulkPOIntents,
  trimBulkPOIdentityBoundary,
  type PendingBulkPOIntents,
} from '../../lib/bulkPOImportRetry';

// ---------- interfaces ----------

interface ParsedPOItem {
  extracted_name: string;
  matched_product: Product | null;
  match_confidence: number;
  quantity_ordered: number;
  unit_cost: number;
  unit_size: string;
  notes: string;
}

interface ParsedPO {
  source_file: string;
  source_index: number;
  source_size: number;
  source_last_modified: number;
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  items: ParsedPOItem[];
  raw_text: string;
  parse_errors: string[];
  expanded: boolean;
}

interface BulkPOImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

// ---------- helpers ----------

function buildParsedPOIntentKey(po: ParsedPO): string | null {
  return buildBulkPOIntentKey({
    vendorName: po.vendor_name,
    invoiceNumber: po.invoice_number,
    invoiceDate: po.invoice_date,
    items: po.items.map((item) => ({
      productId: item.matched_product?.id ?? null,
      quantityOrdered: item.quantity_ordered,
      unitCostCents: purchaseOrderUnitCostCents(item.unit_cost),
      unitSize: item.unit_size,
      notes: item.notes,
    })),
  });
}

function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;
  if (str1.includes(str2) || str2.includes(str1)) return 0.85;
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  return matches / longer.length;
}

function fuzzyMatchProductWithScore(
  extractedName: string,
  products: Product[],
): { product: Product | null; score: number } {
  const normalizedSearch = extractedName.toLowerCase().replace(/[^a-z0-9]/g, '');
  let bestMatch: Product | null = null;
  let bestScore = 0;

  for (const product of products) {
    if (!product.is_active) continue;
    const normalizedProductName = product.product_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizedProductName === normalizedSearch) return { product, score: 1 };
    const score = calculateSimilarity(normalizedSearch, normalizedProductName);
    if (score > bestScore && score > 0.5) {
      bestScore = score;
      bestMatch = product;
    }
  }

  return { product: bestScore >= 0.7 ? bestMatch : null, score: bestScore };
}

// ---------- Vision OCR parsing ----------

async function parseWithVisionOCR(
  file: File,
  filename: string,
  sourceIndex: number,
  products: Product[],
): Promise<ParsedPO> {
  const result = await processDocumentWithOCR(file, 'purchase_order');

  if (!result.success || !result.parsed_data) {
    return {
      source_file: filename,
      source_index: sourceIndex,
      source_size: file.size,
      source_last_modified: file.lastModified,
      vendor_name: '',
      invoice_number: '',
      invoice_date: '',
      items: [],
      raw_text: result.raw_text || '',
      parse_errors: [result.error || 'OCR processing failed'],
      expanded: true,
    };
  }

  const data = result.parsed_data as {
    vendor_name?: string;
    invoice_number?: string;
    invoice_date?: string;
    items?: Array<{
      product_name: string;
      quantity: number;
      unit_cost: number;
      unit_size?: string;
    }>;
  };

  const parse_errors: string[] = [];
  if (!data.vendor_name) parse_errors.push('Could not detect vendor name');
  if (!data.invoice_number) parse_errors.push('Could not detect invoice/PO number');
  if (!data.items || data.items.length === 0) parse_errors.push('No line items found');
  if (result.warning) parse_errors.push(result.warning);

  // Map OCR items to ParsedPOItem with local fuzzy matching against product catalog
  const items: ParsedPOItem[] = (data.items || []).map((ocrItem) => {
    const { product, score } = fuzzyMatchProductWithScore(ocrItem.product_name, products);
    return {
      extracted_name: ocrItem.product_name,
      matched_product: product,
      match_confidence: score,
      quantity_ordered: ocrItem.quantity || 0,
      unit_cost: ocrItem.unit_cost || 0,
      unit_size: ocrItem.unit_size || '',
      notes: '',
    };
  });

  return {
    source_file: filename,
    source_index: sourceIndex,
    source_size: file.size,
    source_last_modified: file.lastModified,
    vendor_name: data.vendor_name || '',
    invoice_number: data.invoice_number || '',
    // Do not invent today's date when OCR misses it. A time-dependent fallback
    // would change the durable duplicate-protection key on a later re-import.
    invoice_date: data.invoice_date || '',
    items,
    raw_text: result.raw_text,
    parse_errors,
    expanded: true,
  };
}

// ---------- component ----------

export default function BulkPOImport({ open, onClose, onSuccess }: BulkPOImportProps) {
  const { toast } = useToast();
  const { profile } = useAuth();

  const [files, setFiles] = useState<File[]>([]);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [parsedPOs, setParsedPOs] = useState<ParsedPO[] | null>(null);
  const [uploadResults, setUploadResults] = useState<{
    imported: number;
    skipped: number;
    failed: number;
  } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [showRawText, setShowRawText] = useState<number | null>(null);
  const pendingIntentsRef = useRef<PendingBulkPOIntents>({});
  const pendingProfileRef = useRef<string | null>(null);
  const refreshNeededRef = useRef(false);

  // Product search state
  const [productSearchOpen, setProductSearchOpen] = useState<{ poIdx: number; itemIdx: number } | null>(null);
  const [productQuery, setProductQuery] = useState('');

  useEffect(() => {
    if (open) fetchProducts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!profile?.id || pendingProfileRef.current === profile.id) return;
    pendingIntentsRef.current = loadPendingBulkPOIntents(localStorage, profile.id);
    pendingProfileRef.current = profile.id;
  }, [profile?.id]);

  const fetchProducts = async () => {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('product_name');
    if (error) {
      toast('error', 'Failed to load products');
      return;
    }
    const prods = (data || []) as Product[];
    setProducts(prods);
    setVendors([...new Set(prods.map((p) => p.vendor).filter(Boolean))] as string[]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    const valid: File[] = [];
    for (const f of selected) {
      if (f.size > 10 * 1024 * 1024) {
        toast('error', `${f.name} is too large. Maximum 10MB per file.`);
        continue;
      }
      if (!isOCRSupported(f)) {
        toast('error', `${f.name} is not a supported file type. Upload PDF or image files.`);
        continue;
      }
      valid.push(f);
    }
    if (valid.length > 0) {
      setFiles(valid);
      setParsedPOs(null);
      setUploadResults(null);
    }
    e.target.value = '';
  };

  const handleParse = async () => {
    if (files.length === 0) return;
    setParsing(true);
    try {
      const results: ParsedPO[] = [];
      for (const [sourceIndex, file] of files.entries()) {
        try {
          const parsed = await parseWithVisionOCR(file, file.name, sourceIndex, products);
          results.push(parsed);
        } catch (err) {
          Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: `Error parsing ${file.name}` } });
          results.push({
            source_file: file.name,
            source_index: sourceIndex,
            source_size: file.size,
            source_last_modified: file.lastModified,
            vendor_name: '',
            invoice_number: '',
            invoice_date: '',
            items: [],
            raw_text: '',
            parse_errors: [`Failed to process: ${err instanceof Error ? err.message : 'Unknown error'}`],
            expanded: true,
          });
        }
      }
      if (results.every((r) => r.items.length === 0)) {
        toast('error', 'Could not extract any line items from the uploaded files.');
      }
      setParsedPOs(results);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'Parse error' } });
      toast('error', 'Error processing files');
    } finally {
      setParsing(false);
    }
  };

  // ---------- review edit handlers ----------

  const updatePOField = (poIdx: number, field: 'vendor_name' | 'invoice_number' | 'invoice_date', value: string) => {
    setParsedPOs((prev) => {
      if (!prev) return prev;
      const copy = [...prev];
      copy[poIdx] = { ...copy[poIdx], [field]: value };
      return copy;
    });
  };

  const updateItemField = (
    poIdx: number,
    itemIdx: number,
    field: 'quantity_ordered' | 'unit_cost' | 'unit_size' | 'notes',
    value: string | number,
  ) => {
    setParsedPOs((prev) => {
      if (!prev) return prev;
      const copy = [...prev];
      const items = [...copy[poIdx].items];
      items[itemIdx] = { ...items[itemIdx], [field]: value };
      copy[poIdx] = { ...copy[poIdx], items };
      return copy;
    });
  };

  const assignProduct = (poIdx: number, itemIdx: number, product: Product) => {
    setParsedPOs((prev) => {
      if (!prev) return prev;
      const copy = [...prev];
      const items = [...copy[poIdx].items];
      items[itemIdx] = {
        ...items[itemIdx],
        matched_product: product,
        match_confidence: 1,
        unit_cost: items[itemIdx].unit_cost || product.current_cost || 0,
        unit_size: items[itemIdx].unit_size || product.unit_size || '',
      };
      copy[poIdx] = { ...copy[poIdx], items };
      return copy;
    });
    setProductSearchOpen(null);
    setProductQuery('');
  };

  const removeItem = (poIdx: number, itemIdx: number) => {
    setParsedPOs((prev) => {
      if (!prev) return prev;
      const copy = [...prev];
      const items = copy[poIdx].items.filter((_, i) => i !== itemIdx);
      copy[poIdx] = { ...copy[poIdx], items };
      return copy;
    });
  };

  const removePO = (poIdx: number) => {
    setParsedPOs((prev) => {
      if (!prev) return prev;
      return prev.filter((_, i) => i !== poIdx);
    });
  };

  const toggleExpanded = (poIdx: number) => {
    setParsedPOs((prev) => {
      if (!prev) return prev;
      const copy = [...prev];
      copy[poIdx] = { ...copy[poIdx], expanded: !copy[poIdx].expanded };
      return copy;
    });
  };

  // ---------- import ----------

  const handleImport = async () => {
    if (!parsedPOs || !profile) return;

    const importable = parsedPOs.filter((po) =>
      po.items.some((item) => item.matched_product && item.quantity_ordered > 0),
    );

    if (importable.length === 0) {
      toast('error', 'No POs have items with matched products to import');
      return;
    }

    setUploading(true);
    let newSuccessCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let unclassifiedFailureCount = 0;

    for (const po of importable) {
      try {
        const validItems = po.items.filter((i) => i.matched_product && i.quantity_ordered > 0);
        if (validItems.length === 0) {
          failedCount++;
          continue;
        }

        const intentKey = buildParsedPOIntentKey(po);
        if (!intentKey) {
          const missingField = !po.vendor_name.trim() ? 'vendor name' : 'vendor invoice number';
          toast('error', `${po.source_file}: enter the ${missingField} before importing.`);
          failedCount++;
          continue;
        }
        const deterministicIdempotencyKey = await buildBulkPOIdempotencyKey(profile.id, intentKey);
        const documentClaimKey = await buildBulkPODocumentClaimKey(intentKey);
        const existingPendingIntent = getPendingBulkPOIntent(pendingIntentsRef.current, intentKey);
        const previouslyImportedPoId = existingPendingIntent?.status === 'imported'
          ? existingPendingIntent.poId
          : undefined;
        const pendingIntent = ensurePendingBulkPOIntent(
          pendingIntentsRef.current,
          intentKey,
          () => deterministicIdempotencyKey,
        );
        savePendingBulkPOIntents(localStorage, profile.id, pendingIntentsRef.current);

        const noteParts = [`Imported from PDF: ${po.source_file}`];
        if (po.invoice_number) noteParts.push(`Vendor ref: ${po.invoice_number}`);
        if (po.invoice_date) noteParts.push(`Vendor date: ${po.invoice_date}`);

        const itemsPayload = validItems.map((item) => {
          const unitCostCents = purchaseOrderUnitCostCents(item.unit_cost);
          return {
            product_id: item.matched_product!.id,
            product_name: item.matched_product!.product_name,
            quantity_ordered: item.quantity_ordered,
            // OCR may return extra decimal places. Send one canonical whole-cent
            // value in both representations so the database never sees a raw,
            // fractional-cent dollar amount that disagrees with our cents math.
            unit_cost: purchaseOrderCentsToDollars(unitCostCents),
            unit_cost_cents: unitCostCents,
            unit_size: item.unit_size || null,
            quantity_received: 0,
            notes: item.notes || null,
          };
        });
        const { data: poData, error: poError } = await supabase.rpc('save_purchase_order', {
          // Postgres uses NULL to select the create path; generated RPC types
          // cannot express nullability for a uuid parameter without a default.
          p_po_id: null as unknown as string,
          p_po_payload: {
            // The database allocates the number inside the same transaction
            // that inserts the PO, closing MAX+1 races between employees.
            po_number: null,
            // buildParsedPOIntentKey rejects an empty vendor before this RPC.
            vendor: trimBulkPOIdentityBoundary(po.vendor_name),
            status: 'draft',
            submitted_date: null,
            expected_delivery_date: null,
            notes: noteParts.join('. '),
            bulk_import_intent_key: documentClaimKey,
            // The database independently recomputes the stable claim from
            // vendor + reference and fingerprints the reviewed date/lines.
            bulk_import_vendor_reference: trimBulkPOIdentityBoundary(po.invoice_number),
            bulk_import_invoice_date: normalizeBulkPOInvoiceDate(po.invoice_date),
          },
          p_items: itemsPayload,
          p_performed_by: profile.id,
          p_idempotency_key: pendingIntent.idempotencyKey,
        });

        if (poError || !poData) throw poError;
        const savedPO = assertRpcResult<{
          po_id: string;
          status?: 'saved' | 'already_imported';
          po_number?: string;
        }>(poData, 'save_purchase_order');
        if (!savedPO.po_number) {
          throw new Error('Purchase order save did not return its allocated PO number');
        }
        markBulkPOIntentImported(
          pendingIntentsRef.current,
          intentKey,
          savedPO.po_id,
          Date.now(),
          savedPO.po_number,
        );
        savePendingBulkPOIntents(localStorage, profile.id, pendingIntentsRef.current);

        const samePOReplay = Boolean(
          previouslyImportedPoId && previouslyImportedPoId === savedPO.po_id,
        );
        if (savedPO.status === 'already_imported' || samePOReplay) {
          skippedCount++;
          // The server may report an exact idempotency replay as "saved". A
          // matching browser marker proves it is the same PO, while a different
          // returned ID means an intentionally deleted PO was recreated.
          refreshNeededRef.current = true;
        } else {
          newSuccessCount++;
        }
      } catch (error) {
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'Error importing PO' } });
        const guidance = bulkPOImportFailureGuidance(error);
        if (guidance) {
          toast('error', `${po.source_file}: ${guidance}`);
        } else {
          unclassifiedFailureCount++;
        }
        failedCount++;
      }
    }

    setUploadResults(failedCount === 0
      ? { imported: newSuccessCount, skipped: skippedCount, failed: 0 }
      : null);
    setUploading(false);

    if (newSuccessCount > 0) {
      refreshNeededRef.current = true;
      toast('success', `Imported ${newSuccessCount} purchase order${newSuccessCount !== 1 ? 's' : ''}`);
      if (failedCount === 0) {
        refreshNeededRef.current = false;
        onSuccess();
      }
    }
    if (skippedCount > 0) {
      toast('info', `Skipped ${skippedCount} document${skippedCount !== 1 ? 's' : ''} already imported.`);
    }
    if (unclassifiedFailureCount > 0) {
      toast('error', `${unclassifiedFailureCount} purchase order${unclassifiedFailureCount !== 1 ? 's' : ''} failed. Review and retry; successful imports will be skipped.`);
    }
  };

  const handleClose = () => {
    setFiles([]);
    setParsedPOs(null);
    setUploadResults(null);
    setProductSearchOpen(null);
    setProductQuery('');
    if (refreshNeededRef.current) {
      refreshNeededRef.current = false;
      onSuccess();
    } else {
      onClose();
    }
  };

  const reset = () => {
    setFiles([]);
    setParsedPOs(null);
    setUploadResults(null);
  };

  // ---------- derived stats ----------

  const totalMatched = parsedPOs?.reduce((sum, po) => sum + po.items.filter((i) => i.matched_product).length, 0) ?? 0;
  const totalUnmatched = parsedPOs?.reduce((sum, po) => sum + po.items.filter((i) => !i.matched_product).length, 0) ?? 0;
  const importablePOs = parsedPOs?.filter((po) => {
    const intentKey = buildParsedPOIntentKey(po);
    // Persisted browser state is only a hint. The server owns duplicate
    // detection because an admin may have deleted the original PO since this
    // marker was written, intentionally making the document importable again.
    return intentKey !== null;
  }).length ?? 0;

  const filteredProducts = products.filter((p) => {
    if (!productQuery.trim()) return true;
    const q = productQuery.toLowerCase();
    return (
      p.product_name.toLowerCase().includes(q) ||
      (p.sku && p.sku.toLowerCase().includes(q)) ||
      (p.vendor && p.vendor.toLowerCase().includes(q))
    );
  });

  // ---------- render ----------

  return (
    <Modal open={open} onClose={handleClose} title="Import POs from Documents" size="large">
      <div className="space-y-4" style={{ maxWidth: '900px' }}>
        {/* Instructions */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-900">
              <p className="font-medium mb-1">Upload vendor invoices — PDF or photo</p>
              <ul className="list-disc list-inside space-y-0.5 text-xs">
                <li>Upload PDFs or photos (JPEG, PNG) of vendor invoices</li>
                <li>Google Vision OCR extracts vendor, invoice number, date, and line items</li>
                <li>Products are auto-matched to your catalog — review and correct before importing</li>
                <li>Each document creates a draft Purchase Order</li>
              </ul>
            </div>
          </div>
        </div>

        {/* State 1: File Selection */}
        {!parsedPOs && !uploadResults && (
          <>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
              <Upload className="w-12 h-12 text-gray-400 mx-auto mb-3" />
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp,image/*"
                multiple
                onChange={handleFileChange}
                className="hidden"
                id="po-pdf-upload"
              />
              <label htmlFor="po-pdf-upload" className="cursor-pointer text-sm text-gray-600 hover:text-gray-900">
                {files.length > 0 ? (
                  <span className="text-crx-green font-medium">
                    {files.length} file{files.length !== 1 ? 's' : ''} selected:{' '}
                    {files.map((f) => f.name).join(', ')}
                  </span>
                ) : (
                  <span>
                    Click to upload or drag and drop
                    <br />
                    <span className="text-xs text-gray-500">PDF or image files (max 10MB each)</span>
                  </span>
                )}
              </label>
            </div>

            {files.length > 0 && (
              <Button onClick={handleParse} disabled={parsing} className="w-full">
                {parsing ? 'Processing with Vision OCR...' : `Process ${files.length} file${files.length !== 1 ? 's' : ''} with Vision OCR`}
              </Button>
            )}
          </>
        )}

        {/* State 2: Review & Edit */}
        {parsedPOs && !uploadResults && (
          <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 bg-green-50 border border-green-100 rounded-lg text-center">
                <CheckCircle className="w-5 h-5 text-green-600 mx-auto mb-1" />
                <p className="text-xl font-semibold text-green-600">{parsedPOs.length}</p>
                <p className="text-xs text-green-700">PO{parsedPOs.length !== 1 ? 's' : ''} parsed</p>
              </div>
              <div className="p-3 bg-green-50 border border-green-100 rounded-lg text-center">
                <CheckCircle className="w-5 h-5 text-green-600 mx-auto mb-1" />
                <p className="text-xl font-semibold text-green-600">{totalMatched}</p>
                <p className="text-xs text-green-700">Items matched</p>
              </div>
              <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg text-center">
                <AlertCircle className="w-5 h-5 text-amber-600 mx-auto mb-1" />
                <p className="text-xl font-semibold text-amber-600">{totalUnmatched}</p>
                <p className="text-xs text-amber-700">Need review</p>
              </div>
            </div>

            {/* Parsed POs accordion */}
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {parsedPOs.map((po, poIdx) => {
                const poTotal = purchaseOrderCentsToDollars(po.items.reduce(
                  (sum, item) => sum + purchaseOrderLineTotalCents(item.quantity_ordered, item.unit_cost),
                  0,
                ));
                const hasErrors = po.parse_errors.length > 0;
                const hasItems = po.items.length > 0;
                const intentKey = buildParsedPOIntentKey(po);
                const importedIntent = intentKey
                  ? getPendingBulkPOIntent(pendingIntentsRef.current, intentKey)
                  : undefined;
                const alreadyImported = importedIntent?.status === 'imported';

                return (
                  <div key={poIdx} className="border border-gray-200 rounded-lg overflow-hidden">
                    {/* PO header */}
                    <div
                      className="p-4 bg-gray-50 flex items-center gap-3 cursor-pointer hover:bg-gray-100 transition-colors"
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleExpanded(poIdx)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(poIdx); } }}
                    >
                      {po.expanded ? (
                        <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-nav-dark truncate">{po.source_file}</p>
                        <p className="text-xs text-secondary">
                          {po.vendor_name || 'No vendor'} &middot;{' '}
                          {po.invoice_number || 'No ref #'} &middot;{' '}
                          {po.items.length} item{po.items.length !== 1 ? 's' : ''} &middot;{' '}
                          {fmt(poTotal)}
                        </p>
                      </div>
                      {alreadyImported && (
                        <Badge variant="info">Previously imported</Badge>
                      )}
                      {!alreadyImported && hasErrors && !hasItems && (
                        <Badge variant="error">Parse Failed</Badge>
                      )}
                      {!alreadyImported && hasErrors && hasItems && (
                        <Badge variant="warning">Partial</Badge>
                      )}
                      {!alreadyImported && !hasErrors && hasItems && (
                        <Badge variant="success">Ready</Badge>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removePO(poIdx);
                        }}
                        className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Remove this PO"
                        aria-label="Remove this PO"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Expanded content */}
                    {po.expanded && (
                      <div className="p-4 space-y-3">
                        {alreadyImported && (
                          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900">
                            Previously imported as {importedIntent.poNumber || 'a purchase order'}. Import will verify the live PO; if an admin deleted it, the document can be imported again.
                          </div>
                        )}
                        {/* Parse errors */}
                        {po.parse_errors.length > 0 && (
                          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                            <div className="flex items-center justify-between mb-1">
                              <p className="text-xs font-medium text-amber-800">Parse warnings:</p>
                              <button
                                onClick={() => setShowRawText(showRawText === poIdx ? null : poIdx)}
                                className="text-xs text-amber-700 underline hover:text-amber-900"
                              >
                                {showRawText === poIdx ? 'Hide raw text' : 'Show raw text (debug)'}
                              </button>
                            </div>
                            <ul className="text-xs text-amber-700 space-y-0.5">
                              {po.parse_errors.map((err, i) => (
                                <li key={i}>&bull; {err}</li>
                              ))}
                            </ul>
                            {showRawText === poIdx && po.raw_text && (
                              <pre className="mt-2 p-2 bg-white border border-amber-200 rounded text-xs text-gray-600 overflow-auto max-h-48 whitespace-pre-wrap font-mono">
                                {po.raw_text || '(no text extracted — PDF may be a scanned image)'}
                              </pre>
                            )}
                            {showRawText === poIdx && !po.raw_text && (
                              <p className="mt-2 text-xs text-red-600 font-medium">
                                No text could be extracted. This PDF is likely a scanned image. Use the Blend Tickets OCR feature or a text-based PDF export from your vendor.
                              </p>
                            )}
                          </div>
                        )}

                        {/* Editable PO header fields */}
                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-secondary mb-1">Vendor</label>
                            <input
                              type="text"
                              value={po.vendor_name}
                              onChange={(e) => updatePOField(poIdx, 'vendor_name', e.target.value)}
                              list={`vendor-list-${poIdx}`}
                              placeholder="Vendor name..."
                              className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                            />
                            <datalist id={`vendor-list-${poIdx}`}>
                              {vendors.map((v) => (
                                <option key={v} value={v} />
                              ))}
                            </datalist>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-secondary mb-1">Invoice / PO Ref</label>
                            <input
                              type="text"
                              value={po.invoice_number}
                              onChange={(e) => updatePOField(poIdx, 'invoice_number', e.target.value)}
                              placeholder="Reference #..."
                              className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-secondary mb-1">Date</label>
                            <input
                              type="text"
                              value={po.invoice_date}
                              onChange={(e) => updatePOField(poIdx, 'invoice_date', e.target.value)}
                              placeholder="MM/DD/YYYY"
                              className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                            />
                          </div>
                        </div>

                        {/* Line items table */}
                        {po.items.length > 0 ? (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-gray-100 text-left text-xs text-secondary uppercase tracking-wide">
                                  <th className="px-3 py-2 font-medium">Extracted Name</th>
                                  <th className="px-3 py-2 font-medium">Matched Product</th>
                                  <th className="px-3 py-2 font-medium w-20">Conf.</th>
                                  <th className="px-3 py-2 font-medium w-24">Qty</th>
                                  <th className="px-3 py-2 font-medium w-28">Unit Cost</th>
                                  <th className="px-3 py-2 font-medium w-20">Size</th>
                                  <th className="px-3 py-2 font-medium w-28">Total</th>
                                  <th className="px-3 py-2 font-medium w-8" />
                                </tr>
                              </thead>
                              <tbody>
                                {po.items.map((item, itemIdx) => (
                                  <tr key={itemIdx} className="border-b border-gray-50 hover:bg-crx-green-tint transition-colors">
                                    <td className="px-3 py-2">
                                      <span className="text-xs text-secondary">{item.extracted_name}</span>
                                    </td>
                                    <td className="px-3 py-2">
                                      {item.matched_product ? (
                                        <button
                                          onClick={() => {
                                            setProductSearchOpen({ poIdx, itemIdx });
                                            setProductQuery('');
                                          }}
                                          className="text-left"
                                        >
                                          <p className="text-sm font-medium text-nav-dark hover:text-crx-green transition-colors">
                                            {item.matched_product.product_name}
                                          </p>
                                          {item.matched_product.sku && (
                                            <p className="text-xs text-gray-400">{item.matched_product.sku}</p>
                                          )}
                                        </button>
                                      ) : (
                                        <button
                                          onClick={() => {
                                            setProductSearchOpen({ poIdx, itemIdx });
                                            setProductQuery(item.extracted_name);
                                          }}
                                          className="text-sm text-red-500 hover:text-red-700 font-medium flex items-center gap-1"
                                        >
                                          <Search className="w-3 h-3" />
                                          Select Product
                                        </button>
                                      )}
                                    </td>
                                    <td className="px-3 py-2">
                                      {item.match_confidence >= 0.85 ? (
                                        <Badge variant="success">High</Badge>
                                      ) : item.match_confidence >= 0.7 ? (
                                        <Badge variant="warning">Med</Badge>
                                      ) : item.matched_product ? (
                                        <Badge variant="default">Manual</Badge>
                                      ) : (
                                        <Badge variant="error">None</Badge>
                                      )}
                                    </td>
                                    <td className="px-3 py-2">
                                      <input
                                        type="number"
                                        value={item.quantity_ordered || ''}
                                        onChange={(e) =>
                                          updateItemField(poIdx, itemIdx, 'quantity_ordered', parseFloat(e.target.value) || 0)
                                        }
                                        min="0"
                                        className="w-full px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                                      />
                                    </td>
                                    <td className="px-3 py-2">
                                      <input
                                        type="number"
                                        value={item.unit_cost || ''}
                                        onChange={(e) =>
                                          updateItemField(poIdx, itemIdx, 'unit_cost', parseFloat(e.target.value) || 0)
                                        }
                                        min="0"
                                        step="0.01"
                                        className="w-full px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                                      />
                                    </td>
                                    <td className="px-3 py-2">
                                      <input
                                        type="text"
                                        value={item.unit_size}
                                        onChange={(e) => updateItemField(poIdx, itemIdx, 'unit_size', e.target.value)}
                                        className="w-full px-2 py-1 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                                        placeholder="GL"
                                      />
                                    </td>
                                    <td className="px-3 py-2 font-mono text-sm text-nav-dark">
                                      {fmt(purchaseOrderCentsToDollars(
                                        purchaseOrderLineTotalCents(item.quantity_ordered, item.unit_cost),
                                      ))}
                                    </td>
                                    <td className="px-3 py-2">
                                      <button
                                        onClick={() => removeItem(poIdx, itemIdx)}
                                        className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                        aria-label="Remove item"
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr className="border-t border-gray-200">
                                  <td colSpan={6} className="px-3 py-2 text-right text-xs font-medium text-secondary">
                                    PO Total
                                  </td>
                                  <td className="px-3 py-2 font-mono text-sm font-semibold text-nav-dark">
                                    {fmt(poTotal)}
                                  </td>
                                  <td />
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        ) : (
                          <p className="text-sm text-secondary text-center py-4">
                            No items could be extracted from this PDF.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Action buttons */}
            <div className="flex justify-between items-center pt-2">
              <Button variant="secondary" onClick={reset}>
                Choose Different Files
              </Button>
              <Button onClick={handleImport} disabled={uploading || importablePOs === 0}>
                {uploading
                  ? 'Importing...'
                  : `Import ${importablePOs} PO${importablePOs !== 1 ? 's' : ''} (${totalMatched} items)`}
              </Button>
            </div>
          </div>
        )}

        {/* State 3: Results */}
        {uploadResults && (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
              <CheckCircle className="w-10 h-10 text-green-600 mx-auto mb-3" />
              <p className="text-lg font-semibold text-green-800">Import Complete</p>
              <div className="text-sm text-green-700 mt-2 space-y-1">
                <p>Successfully imported: {uploadResults.imported} purchase order{uploadResults.imported !== 1 ? 's' : ''}</p>
                {uploadResults.skipped > 0 && (
                  <p>Already imported and skipped: {uploadResults.skipped}</p>
                )}
                {uploadResults.failed > 0 && (
                  <p className="text-red-600">Failed: {uploadResults.failed}</p>
                )}
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleClose}>Close</Button>
            </div>
          </div>
        )}
      </div>

      {/* Product Search Modal */}
      {productSearchOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
            <div className="p-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold font-heading text-nav-dark">
                Select <span className="split-heading-accent">Product</span>
              </h3>
              {parsedPOs && (
                <p className="text-xs text-secondary mt-1">
                  Matching: &ldquo;{parsedPOs[productSearchOpen.poIdx]?.items[productSearchOpen.itemIdx]?.extracted_name}&rdquo;
                </p>
              )}
            </div>
            <div className="p-5">
              <input
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green mb-3"
                placeholder="Search by name, SKU, or vendor..."
                // eslint-disable-next-line jsx-a11y/no-autofocus -- search input in just-opened picker; user expects to type immediately
                autoFocus
              />
              <div className="max-h-64 overflow-y-auto divide-y divide-gray-50">
                {filteredProducts.length === 0 ? (
                  <p className="text-sm text-secondary py-4 text-center">No products found</p>
                ) : (
                  filteredProducts.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => assignProduct(productSearchOpen.poIdx, productSearchOpen.itemIdx, p)}
                      className="w-full text-left px-3 py-2.5 hover:bg-crx-green-tint transition-colors flex items-center justify-between"
                    >
                      <div>
                        <p className="font-medium text-nav-dark text-sm">{p.product_name}</p>
                        <p className="text-xs text-gray-400">
                          {[p.sku, p.vendor].filter(Boolean).join(' / ')}
                        </p>
                      </div>
                      <span className="font-mono text-sm text-secondary">{fmt(p.current_cost || 0)}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="p-5 border-t border-gray-100 flex justify-end">
              <Button
                variant="secondary"
                onClick={() => {
                  setProductSearchOpen(null);
                  setProductQuery('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
