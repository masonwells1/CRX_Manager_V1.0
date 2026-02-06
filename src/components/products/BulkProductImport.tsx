import { useState } from 'react';
import { Upload, CheckCircle, AlertCircle, FileText } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { supabase } from '../../lib/supabase';

interface BulkProductImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface ParsedProduct {
  product_name: string;
  sku?: string;
  category?: string;
  vendor?: string;
  manufacturer?: string;
  container_size?: number;
  unit_size?: string;
  current_cost?: number;
  tier1_price?: number;
  tier2_price?: number;
  tier3_price?: number;
  suggested_rate?: string;
  rate_per_acre?: number;
  rate_unit?: string;
  notes?: string;
}

interface ValidationResult {
  valid: ParsedProduct[];
  invalid: Array<{ row: number; error: string; data: Record<string, string> }>;
}

const FIELD_MAPPINGS: Record<string, string[]> = {
  product_name: ['product_name', 'product', 'name', 'productname', 'item', 'item_name'],
  sku: ['sku', 'item_code', 'product_code', 'code'],
  category: ['category', 'type', 'product_type'],
  vendor: ['vendor', 'supplier', 'distributor'],
  manufacturer: ['manufacturer', 'mfg', 'brand'],
  container_size: ['container_size', 'size', 'container', 'package_size'],
  unit_size: ['unit_size', 'unit', 'uom', 'units'],
  current_cost: ['current_cost', 'cost', 'price', 'unit_cost', 'base_cost'],
  tier1_price: ['tier1_price', 'tier_1_price', 't1_price', 'price_tier1'],
  tier2_price: ['tier2_price', 'tier_2_price', 't2_price', 'price_tier2'],
  tier3_price: ['tier3_price', 'tier_3_price', 't3_price', 'price_tier3'],
  suggested_rate: ['suggested_rate', 'rate', 'application_rate', 'use_rate'],
  rate_per_acre: ['rate_per_acre', 'acre_rate', 'per_acre', 'application_per_acre'],
  rate_unit: ['rate_unit', 'unit', 'rate_uom'],
  notes: ['notes', 'description', 'comments', 'note'],
};

export default function BulkProductImport({ open, onClose, onSuccess }: BulkProductImportProps) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [uploadResults, setUploadResults] = useState<{ success: number; failed: number } | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
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

  const handleParse = async () => {
    if (!file) return;
    setParsing(true);

    try {
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

      if (!Object.values(fieldMapping).includes('product_name')) {
        toast('error', 'Could not find product name column. Ensure your CSV has a "product_name" or "product" column.');
        setParsing(false);
        return;
      }

      const valid: ParsedProduct[] = [];
      const invalid: Array<{ row: number; error: string; data: Record<string, string> }> = [];

      rows.forEach((cols, idx) => {
        const product: Partial<ParsedProduct> = {};
        const rowData: Record<string, string> = {};

        cols.forEach((value, colIdx) => {
          const field = fieldMapping[colIdx];
          if (field) {
            rowData[field] = value;

            if (field === 'product_name' || field === 'sku' || field === 'category' ||
                field === 'vendor' || field === 'manufacturer' || field === 'unit_size' ||
                field === 'suggested_rate' || field === 'rate_unit' || field === 'notes') {
              if (value) product[field] = value;
            } else if (field === 'container_size' || field === 'current_cost' ||
                       field === 'tier1_price' || field === 'tier2_price' ||
                       field === 'tier3_price' || field === 'rate_per_acre') {
              const num = parseFloat(value);
              if (!isNaN(num) && num >= 0) {
                product[field] = num;
              }
            }
          }
        });

        if (!product.product_name) {
          invalid.push({
            row: idx + 2,
            error: 'Missing product name',
            data: rowData,
          });
          return;
        }

        valid.push(product as ParsedProduct);
      });

      setValidation({ valid, invalid });
    } catch (error) {
      toast('error', 'Failed to parse file. Please ensure it is a valid CSV.');
    }
    setParsing(false);
  };

  const handleUpload = async () => {
    if (!validation || validation.valid.length === 0) return;
    setUploading(true);

    let success = 0;
    let failed = 0;

    for (const product of validation.valid) {
      const { error } = await supabase.from('products').insert({
        ...product,
        is_active: true,
      });

      if (error) {
        console.error('Failed to insert product:', error);
        failed++;
      } else {
        success++;
      }
    }

    setUploadResults({ success, failed });
    setUploading(false);

    if (success > 0) {
      toast('success', `Successfully imported ${success} product(s)`);
      onSuccess();
    }
    if (failed > 0) {
      toast('error', `Failed to import ${failed} product(s)`);
    }
  };

  const handleClose = () => {
    setFile(null);
    setValidation(null);
    setUploadResults(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Bulk Product" accent="Import" maxWidth="max-w-3xl">
      <div className="space-y-4">
        <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
          <h4 className="text-sm font-medium text-nav-dark mb-2">How to Import</h4>
          <ol className="text-xs text-secondary space-y-1 list-decimal list-inside">
            <li>Save your Excel file as CSV (File &gt; Save As &gt; CSV)</li>
            <li>Ensure your spreadsheet has a column for product names</li>
            <li>Upload the CSV file below</li>
            <li>Review detected products and import</li>
          </ol>
          <div className="mt-3 p-2 bg-white rounded border border-gray-200">
            <p className="text-xs font-medium text-secondary mb-1">Supported Columns:</p>
            <p className="text-xs text-gray-500 font-mono">
              product_name, sku, category, vendor, manufacturer, container_size, unit_size,
              current_cost, tier1_price, tier2_price, tier3_price, suggested_rate, rate_per_acre,
              rate_unit, notes
            </p>
          </div>
        </div>

        {!validation && !uploadResults && (
          <div>
            <label className="block text-sm font-medium text-secondary mb-2">Select CSV File</label>
            <input
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-crx-green-light file:text-crx-green hover:file:bg-crx-green hover:file:text-white transition-colors cursor-pointer"
            />
            {file && (
              <div className="mt-2 flex items-center gap-2 text-xs text-secondary">
                <FileText className="w-4 h-4" />
                <span>{file.name} ({(file.size / 1024).toFixed(1)} KB)</span>
              </div>
            )}
          </div>
        )}

        {validation && !uploadResults && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 bg-green-50 border border-green-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <span className="text-sm font-medium text-secondary">Valid Products</span>
                </div>
                <p className="text-2xl font-semibold text-green-600">{validation.valid.length}</p>
                <p className="text-xs text-secondary mt-1">Ready to import</p>
              </div>
              <div className="p-4 bg-red-50 border border-red-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle className="w-5 h-5 text-red-600" />
                  <span className="text-sm font-medium text-secondary">Invalid Rows</span>
                </div>
                <p className="text-2xl font-semibold text-red-600">{validation.invalid.length}</p>
                <p className="text-xs text-secondary mt-1">Will be skipped</p>
              </div>
            </div>

            {validation.valid.length > 0 && (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg max-h-48 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-2">Preview (first 5):</p>
                <div className="space-y-2">
                  {validation.valid.slice(0, 5).map((product, idx) => (
                    <div key={idx} className="text-xs bg-white p-2 rounded border border-gray-100">
                      <p className="font-medium text-nav-dark">{product.product_name}</p>
                      {product.sku && <p className="text-gray-500">SKU: {product.sku}</p>}
                      {product.category && <p className="text-gray-500">Category: {product.category}</p>}
                      {product.rate_per_acre && <p className="text-gray-500">Rate/Acre: {product.rate_per_acre} {product.rate_unit || ''}</p>}
                    </div>
                  ))}
                  {validation.valid.length > 5 && (
                    <p className="text-xs text-secondary text-center pt-1">
                      + {validation.valid.length - 5} more products
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
          <div className="p-4 bg-green-50 border border-green-100 rounded-lg text-center">
            <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-2" />
            <h4 className="text-sm font-medium text-nav-dark mb-1">Import Complete</h4>
            <p className="text-xs text-secondary">
              Successfully imported {uploadResults.success} product(s)
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
              Parse File
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
                Import {validation.valid.length} Product(s)
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
