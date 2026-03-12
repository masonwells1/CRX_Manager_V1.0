import { useState } from 'react';
import { Upload, CheckCircle, XCircle, AlertCircle, Sparkles } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { supabase, checkMutationResult } from '../../lib/db';
import { processDocumentWithOCR, isCSVFile, isOCRSupported } from '../../lib/documentOCR';

interface BulkPricingImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface ParsedRow {
  sku: string;
  cost?: number;
  tier1_price?: number;
  tier2_price?: number;
  tier3_price?: number;
}

interface ValidationResult {
  valid: ParsedRow[];
  invalid: Array<{ row: number; sku: string; error: string }>;
  notFound: string[];
}

export default function BulkPricingImport({ open, onClose, onSuccess }: BulkPricingImportProps) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [uploadResults, setUploadResults] = useState<{ success: number; failed: number } | null>(null);

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

  const parseCSV = (text: string): ParsedRow[] => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const skuIdx = headers.findIndex((h) => h === 'sku');
    const costIdx = headers.findIndex((h) => h === 'cost' || h === 'current_cost');
    const t1Idx = headers.findIndex((h) => h === 'tier1_price' || h === 'tier_1_price' || h === 't1');
    const t2Idx = headers.findIndex((h) => h === 'tier2_price' || h === 'tier_2_price' || h === 't2');
    const t3Idx = headers.findIndex((h) => h === 'tier3_price' || h === 'tier_3_price' || h === 't3');

    if (skuIdx === -1) return [];

    const rows: ParsedRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      if (cols.length < 2 || !cols[skuIdx]) continue;

      const row: ParsedRow = { sku: cols[skuIdx] };
      if (costIdx !== -1 && cols[costIdx]) row.cost = parseFloat(cols[costIdx]);
      if (t1Idx !== -1 && cols[t1Idx]) row.tier1_price = parseFloat(cols[t1Idx]);
      if (t2Idx !== -1 && cols[t2Idx]) row.tier2_price = parseFloat(cols[t2Idx]);
      if (t3Idx !== -1 && cols[t3Idx]) row.tier3_price = parseFloat(cols[t3Idx]);

      rows.push(row);
    }
    return rows;
  };

  const parseWithVisionOCR = async (file: File): Promise<ParsedRow[]> => {
    const result = await processDocumentWithOCR(file, 'price_list');

    if (!result.success || !result.parsed_data) {
      toast('error', result.error || 'OCR processing failed. Try a clearer image or CSV instead.');
      return [];
    }

    const data = result.parsed_data as {
      vendor_name?: string;
      items?: Array<{
        sku?: string;
        product_name?: string;
        cost?: number;
        tier1_price?: number;
        tier2_price?: number;
        tier3_price?: number;
      }>;
    };

    if (!data.items || data.items.length === 0) {
      toast('error', 'No pricing items found in document.');
      return [];
    }

    // Map OCR items — use SKU if available, otherwise product_name as SKU fallback
    return data.items
      .filter((item) => item.sku || item.product_name)
      .map((item) => ({
        sku: item.sku || item.product_name || '',
        cost: item.cost,
        tier1_price: item.tier1_price,
        tier2_price: item.tier2_price,
        tier3_price: item.tier3_price,
      }));
  };

  const handleParse = async () => {
    if (!file) return;
    setParsing(true);

    try {
      let parsed: ParsedRow[];

      if (isCSVFile(file)) {
        const text = await file.text();
        parsed = parseCSV(text);
      } else {
        parsed = await parseWithVisionOCR(file);
      }

      if (parsed.length === 0) {
        toast('error', 'No valid data found. Ensure file has SKU/product and at least one price column.');
        setParsing(false);
        return;
      }

      const skus = parsed.map((p) => p.sku);
      const { data: products, error: prodError } = await supabase
        .from('products')
        .select('id, sku, product_name')
        .or(`sku.in.(${skus.map(s => `"${s}"`).join(',')}),product_name.in.(${skus.map(s => `"${s}"`).join(',')})`);

      if (prodError) {
        toast('error', 'Failed to look up products');
        setParsing(false);
        return;
      }

      const foundSkus = new Set((products || []).flatMap((p) => [p.sku, p.product_name].filter(Boolean)));
      const valid: ParsedRow[] = [];
      const invalid: Array<{ row: number; sku: string; error: string }> = [];
      const notFound: string[] = [];

      parsed.forEach((row, idx) => {
        if (!foundSkus.has(row.sku)) {
          notFound.push(row.sku);
          return;
        }

        const hasPrice = row.cost !== undefined || row.tier1_price !== undefined ||
          row.tier2_price !== undefined || row.tier3_price !== undefined;

        if (!hasPrice) {
          invalid.push({ row: idx + 2, sku: row.sku, error: 'No pricing data provided' });
          return;
        }

        const hasInvalidPrice =
          (row.cost !== undefined && (isNaN(row.cost) || row.cost < 0)) ||
          (row.tier1_price !== undefined && (isNaN(row.tier1_price) || row.tier1_price < 0)) ||
          (row.tier2_price !== undefined && (isNaN(row.tier2_price) || row.tier2_price < 0)) ||
          (row.tier3_price !== undefined && (isNaN(row.tier3_price) || row.tier3_price < 0));

        if (hasInvalidPrice) {
          invalid.push({ row: idx + 2, sku: row.sku, error: 'Invalid price value (must be >= 0)' });
          return;
        }

        valid.push(row);
      });

      setValidation({ valid, invalid, notFound });
    } catch {
      toast('error', 'Failed to process file');
    }
    setParsing(false);
  };

  const handleUpload = async () => {
    if (!validation || validation.valid.length === 0) return;
    setUploading(true);

    let success = 0;
    let failed = 0;

    for (const row of validation.valid) {
      const { data: product, error: lookupError } = await supabase
        .from('products')
        .select('id, sku, current_cost, tier1_price, tier2_price, tier3_price')
        .eq('sku', row.sku)
        .maybeSingle();

      if (lookupError) {
        console.error('Failed to look up product:', lookupError.message);
        failed++;
        continue;
      }

      if (!product) {
        failed++;
        continue;
      }

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (row.cost !== undefined) updates.current_cost = row.cost;
      if (row.tier1_price !== undefined) updates.tier1_price = row.tier1_price;
      if (row.tier2_price !== undefined) updates.tier2_price = row.tier2_price;
      if (row.tier3_price !== undefined) updates.tier3_price = row.tier3_price;

      try {
        const result = await supabase
          .from('products')
          .update(updates)
          .eq('id', product.id)
          .select();
        checkMutationResult(result, 'Update product pricing');
        success++;

        if (row.cost !== undefined && row.cost !== product.current_cost) {
          const { error: histErr } = await supabase.from('cost_history').insert({
            product_id: product.id,
            changed_by: profile?.id,
            old_cost: product.current_cost,
            new_cost: row.cost,
            old_tier1_price: product.tier1_price,
            new_tier1_price: row.tier1_price ?? product.tier1_price,
            old_tier2_price: product.tier2_price,
            new_tier2_price: row.tier2_price ?? product.tier2_price,
            old_tier3_price: product.tier3_price,
            new_tier3_price: row.tier3_price ?? product.tier3_price,
            change_note: 'Bulk pricing update',
          });
          if (histErr) console.error('Cost history audit failed:', histErr);
        }
      } catch {
        failed++;
      }
    }

    setUploadResults({ success, failed });
    setUploading(false);

    if (success > 0) {
      toast('success', `Updated ${success} product(s)`);
      onSuccess();
    }
    if (failed > 0) {
      toast('error', `Failed to update ${failed} product(s)`);
    }
  };

  const handleClose = () => {
    setFile(null);
    setValidation(null);
    setUploadResults(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Bulk Pricing" accent="Import" maxWidth="max-w-2xl">
      <div className="space-y-4">
        <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
          <h4 className="text-sm font-medium text-nav-dark mb-2 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-600" />
            CSV or PDF/Image Upload
          </h4>
          <p className="text-xs text-secondary mb-2">
            Upload a CSV, PDF price list, or photo. Products matched by SKU or name.
          </p>
          <code className="block text-xs bg-white p-2 rounded border border-gray-200 font-mono">
            sku,cost,tier1_price,tier2_price,tier3_price
          </code>
          <p className="text-xs text-secondary mt-2">
            PDF/image files are processed with Google Vision OCR for automatic extraction.
          </p>
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
              <p className="text-xs text-secondary mt-2">
                Selected: {file.name} ({(file.size / 1024).toFixed(1)} KB)
                {!isCSVFile(file) && <span className="ml-1 text-blue-600">(Vision OCR)</span>}
              </p>
            )}
          </div>
        )}

        {validation && !uploadResults && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 bg-green-50 border border-green-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                  <span className="text-xs font-medium text-secondary">Valid</span>
                </div>
                <p className="text-xl font-semibold text-green-600">{validation.valid.length}</p>
              </div>
              <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle className="w-4 h-4 text-amber-600" />
                  <span className="text-xs font-medium text-secondary">Not Found</span>
                </div>
                <p className="text-xl font-semibold text-amber-600">{validation.notFound.length}</p>
              </div>
              <div className="p-3 bg-red-50 border border-red-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <XCircle className="w-4 h-4 text-red-600" />
                  <span className="text-xs font-medium text-secondary">Invalid</span>
                </div>
                <p className="text-xl font-semibold text-red-600">{validation.invalid.length}</p>
              </div>
            </div>

            {validation.notFound.length > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-1">SKUs Not Found:</p>
                <p className="text-xs text-secondary">{validation.notFound.join(', ')}</p>
              </div>
            )}

            {validation.invalid.length > 0 && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-lg max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-1">Invalid Rows:</p>
                <div className="space-y-1">
                  {validation.invalid.map((inv, idx) => (
                    <p key={idx} className="text-xs text-secondary">
                      Row {inv.row} ({inv.sku}): {inv.error}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {uploadResults && (
          <div className="p-4 bg-green-50 border border-green-100 rounded-lg text-center">
            <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-2" />
            <h4 className="text-sm font-medium text-nav-dark mb-1">Upload Complete</h4>
            <p className="text-xs text-secondary">
              Successfully updated {uploadResults.success} product(s)
              {uploadResults.failed > 0 && `, ${uploadResults.failed} failed`}
            </p>
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
                Update {validation.valid.length} Product(s)
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
