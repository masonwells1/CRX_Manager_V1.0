import { useState } from 'react';
import { Upload, CheckCircle, AlertCircle, FileText, Sparkles } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { processDocumentWithOCR, isCSVFile, isOCRSupported } from '../../lib/documentOCR';
import { Sentry } from '../../lib/sentry';

interface BulkCustomerImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface ParsedCustomer {
  farm_name: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  billing_address?: string;
  assigned_tier?: number;
  total_acres?: number;
  corn_acres?: number;
  soybean_acres?: number;
  other_acres?: number;
  payment_terms?: string;
  notes?: string;
}

interface ValidationResult {
  valid: ParsedCustomer[];
  invalid: Array<{ row: number; error: string; data: Record<string, string> }>;
}

const FIELD_MAPPINGS: Record<string, string[]> = {
  farm_name: ['farm_name', 'farm', 'farm_name', 'customer', 'customer_name', 'business_name'],
  contact_name: ['contact_name', 'contact', 'name', 'owner', 'primary_contact'],
  phone: ['phone', 'phone_number', 'telephone', 'mobile', 'cell'],
  email: ['email', 'email_address', 'e-mail'],
  billing_address: ['billing_address', 'address', 'billing', 'mailing_address', 'street_address'],
  assigned_tier: ['assigned_tier', 'tier', 'price_tier', 'pricing_tier', 'customer_tier'],
  total_acres: ['total_acres', 'acres', 'farm_acres', 'total_farm_acres'],
  corn_acres: ['corn_acres', 'corn', 'acres_corn'],
  soybean_acres: ['soybean_acres', 'soybeans', 'soybean', 'acres_soybeans'],
  other_acres: ['other_acres', 'other', 'misc_acres'],
  payment_terms: ['payment_terms', 'terms', 'payment', 'net_terms'],
  notes: ['notes', 'comments', 'note', 'description'],
};

export default function BulkCustomerImport({ open, onClose, onSuccess }: BulkCustomerImportProps) {
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

  const detectFieldMapping = (header: string): string | null => {
    const normalized = header.toLowerCase().trim().replace(/\s+/g, '_');
    for (const [field, aliases] of Object.entries(FIELD_MAPPINGS)) {
      if (aliases.includes(normalized)) {
        return field;
      }
    }
    return null;
  };

  const MAX_ROWS = 500;

  /** Parse a single CSV line respecting quoted fields (handles commas inside quotes) */
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    result.push(current.trim());
    return result;
  };

  const parseCSV = (text: string): { headers: string[]; rows: string[][] } => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return { headers: [], rows: [] };

    const headers = parseCSVLine(lines[0]);
    const rows: string[][] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.length > 0 && cols[0]) {
        rows.push(cols);
      }
    }

    return { headers, rows };
  };

  const parseWithVisionOCR = async (file: File): Promise<{ valid: ParsedCustomer[]; invalid: Array<{ row: number; error: string; data: Record<string, string> }> }> => {
    const result = await processDocumentWithOCR(file, 'customer_list');

    if (!result.success || !result.parsed_data) {
      toast('error', result.error || 'OCR processing failed. Try a clearer image or CSV instead.');
      return { valid: [], invalid: [] };
    }

    const data = result.parsed_data as {
      items?: Array<{
        farm_name: string;
        contact_name?: string;
        phone?: string;
        email?: string;
        address?: string;
        tier?: number;
      }>;
    };

    if (!data.items || data.items.length === 0) {
      toast('error', 'No customers found in document.');
      return { valid: [], invalid: [] };
    }

    const valid: ParsedCustomer[] = [];
    const invalid: Array<{ row: number; error: string; data: Record<string, string> }> = [];

    data.items.forEach((item, idx) => {
      if (!item.farm_name) {
        invalid.push({ row: idx + 1, error: 'Missing farm name', data: { ...item } as unknown as Record<string, string> });
        return;
      }
      valid.push({
        farm_name: item.farm_name,
        contact_name: item.contact_name,
        phone: item.phone,
        email: item.email,
        billing_address: item.address,
        assigned_tier: item.tier && [1, 2, 3].includes(item.tier) ? item.tier : 1,
      });
    });

    return { valid, invalid };
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

      if (rows.length > MAX_ROWS) {
        toast('error', `File has ${rows.length} rows. Maximum is ${MAX_ROWS}. Please split your file into smaller batches.`);
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

      if (!Object.values(fieldMapping).includes('farm_name')) {
        toast('error', 'Could not find farm name column. Ensure your CSV has a "farm_name" or "farm" column.');
        setParsing(false);
        return;
      }

      const valid: ParsedCustomer[] = [];
      const invalid: Array<{ row: number; error: string; data: Record<string, string> }> = [];

      rows.forEach((cols, idx) => {
        const customer: Partial<ParsedCustomer> = {};
        const rowData: Record<string, string> = {};

        cols.forEach((value, colIdx) => {
          const field = fieldMapping[colIdx];
          if (field) {
            rowData[field] = value;

            if (field === 'farm_name' || field === 'contact_name' || field === 'phone' ||
                field === 'email' || field === 'billing_address' || field === 'payment_terms' ||
                field === 'notes') {
              if (value) customer[field] = value;
            } else if (field === 'total_acres' || field === 'corn_acres' ||
                       field === 'soybean_acres' || field === 'other_acres') {
              const num = parseFloat(value);
              if (!isNaN(num) && num >= 0) {
                customer[field] = num;
              }
            } else if (field === 'assigned_tier') {
              const tier = parseInt(value);
              if ([1, 2, 3].includes(tier)) {
                customer[field] = tier;
              }
            }
          }
        });

        if (!customer.farm_name) {
          invalid.push({
            row: idx + 2,
            error: 'Missing farm name',
            data: rowData,
          });
          return;
        }

        // Validate email format if provided
        if (customer.email) {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(customer.email)) {
            invalid.push({
              row: idx + 2,
              error: `Invalid email: ${customer.email}`,
              data: rowData,
            });
            return;
          }
        }

        // Set default tier if not provided
        if (!customer.assigned_tier) {
          customer.assigned_tier = 1;
        }

        valid.push(customer as ParsedCustomer);
      });

      setValidation({ valid, invalid });
    } catch {
      toast('error', 'Failed to parse file. Please ensure it is a valid CSV.');
    }
    setParsing(false);
  };

  const handleUpload = async () => {
    if (!validation || validation.valid.length === 0) return;
    setUploading(true);

    let success = 0;
    let failed = 0;

    for (const customer of validation.valid) {
      const customerResult = await supabase.from('customers').insert({
        ...customer,
        is_active: true,
      }).select();

      if (customerResult.error) {
        Sentry.captureException(customerResult.error instanceof Error ? customerResult.error : new Error(String(customerResult.error)), { extra: { context: 'Failed to insert customer' } });
        failed++;
      } else {
        try { checkMutationResult(customerResult, 'Insert customer'); } catch (e) { Sentry.captureException(e instanceof Error ? e : new Error(String(e))); failed++; continue; }
        success++;
      }
    }

    setUploadResults({ success, failed });
    setUploading(false);

    if (success > 0) {
      toast('success', `Successfully imported ${success} customer(s)`);
      onSuccess();
    }
    if (failed > 0) {
      toast('error', `Failed to import ${failed} customer(s)`);
    }
  };

  const handleClose = () => {
    setFile(null);
    setValidation(null);
    setUploadResults(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Bulk Customer" accent="Import" maxWidth="max-w-3xl">
      <div className="space-y-4">
        <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
          <h4 className="text-sm font-medium text-nav-dark mb-2 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-600" />
            How to Import
          </h4>
          <ol className="text-xs text-secondary space-y-1 list-decimal list-inside">
            <li>Upload a CSV, PDF customer list, or photo of a customer sheet</li>
            <li>Ensure your file has farm/customer names</li>
            <li>PDF/image files are processed with Google Vision OCR</li>
            <li>Review detected customers and import</li>
          </ol>
          <div className="mt-3 p-2 bg-white rounded border border-gray-200">
            <p className="text-xs font-medium text-secondary mb-1">Supported Columns:</p>
            <p className="text-xs text-gray-500 font-mono">
              farm_name (required), contact_name, phone, email, billing_address, assigned_tier (1-3),
              total_acres, corn_acres, soybean_acres, other_acres, payment_terms, notes
            </p>
            <p className="text-xs text-green-600 mt-2">
              💡 <span className="font-medium">Tip:</span> Tier defaults to 1 if not specified. Valid tiers are 1, 2, or 3.
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
                <span>{file.name} ({(file.size / 1024).toFixed(1)} KB)</span>
                {!isCSVFile(file) && <span className="text-blue-600">(Vision OCR)</span>}
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
                  <span className="text-sm font-medium text-secondary">Valid Customers</span>
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
                  {validation.valid.slice(0, 5).map((customer, idx) => (
                    <div key={idx} className="text-xs bg-white p-2 rounded border border-gray-100">
                      <p className="font-medium text-nav-dark">{customer.farm_name}</p>
                      {customer.contact_name && <p className="text-gray-500">Contact: {customer.contact_name}</p>}
                      {customer.phone && <p className="text-gray-500">Phone: {customer.phone}</p>}
                      {customer.email && <p className="text-gray-500">Email: {customer.email}</p>}
                      <p className="text-gray-500">Tier: {customer.assigned_tier}</p>
                      {customer.total_acres && <p className="text-gray-500">Acres: {customer.total_acres.toLocaleString()}</p>}
                    </div>
                  ))}
                  {validation.valid.length > 5 && (
                    <p className="text-xs text-secondary text-center pt-1">
                      + {validation.valid.length - 5} more customers
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
              Successfully imported {uploadResults.success} customer(s)
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
                Import {validation.valid.length} Customer(s)
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
