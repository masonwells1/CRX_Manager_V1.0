import { useState, useEffect } from 'react';
import { Upload, CheckCircle, AlertCircle, FileText, ChevronDown, ChevronRight, Trash2, Search } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/db';
import { logActivity } from '../../lib/activityLogger';
import { fuzzyMatchProduct } from '../../lib/ocrParser';
import type { Product } from '../../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

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

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

// ---------- PDF extraction ----------

async function extractTextFromPDF(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(' ');
    fullText += pageText + '\n';
  }
  return fullText;
}

// ---------- PDF parsing ----------

function extractDate(text: string): string {
  // Try labelled date first
  const labelledPatterns = [
    /(?:Invoice|PO|Order|Ship)\s*Date\s*:?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /Date\s*:?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/,
    /(\w+\s+\d{1,2},?\s+\d{4})/i,
  ];
  for (const pattern of labelledPatterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return new Date().toISOString().split('T')[0];
}

function extractVendor(lines: string[]): string {
  // Check for labelled vendor lines
  for (const line of lines.slice(0, 25)) {
    const labelMatch = line.match(/(?:vendor|supplier|from|sold\s+by|ship(?:ped)?\s+from)\s*:?\s+(.+)/i);
    if (labelMatch && labelMatch[1].trim().length > 2) return labelMatch[1].trim();
  }
  // Look for company-like name in the first 15 lines
  for (const line of lines.slice(0, 15)) {
    const trimmed = line.trim();
    if (
      trimmed.length > 4 &&
      trimmed.length < 80 &&
      /(?:LLC|INC|CORP|LTD|CO\.|COMPANY|CHEMICAL|SUPPLY|SOLUTIONS|INDUSTRIES)/i.test(trimmed) &&
      !/invoice|purchase|order|date|bill\s+to|ship\s+to|page|total/i.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return '';
}

function extractInvoiceNumber(text: string): string {
  const patterns = [
    /(?:Invoice|Inv)\s*#?\s*:?\s*([A-Z0-9][\w\-]+)/i,
    /(?:PO|P\.?O\.?)\s*#?\s*:?\s*([A-Z0-9][\w\-]+)/i,
    /(?:Order|Ref(?:erence)?)\s*#?\s*:?\s*([A-Z0-9][\w\-]+)/i,
    /(?:Document|Doc)\s*#?\s*:?\s*([A-Z0-9][\w\-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function extractLineItems(text: string, lines: string[]): ParsedPOItem[] {
  const items: ParsedPOItem[] = [];

  // Strategy 1: Look for the specific CRX vendor invoice pattern used in BulkOrderImport
  // Pattern: date product_name (optional EPA) quantity GL $cost GL $total
  const crxPattern =
    /(\d{2}\/\d{2}\/\d{4})\s+([A-Za-z0-9\s.\-()]+?)\s+(?:(\d+-\d+(?:-\d+)?))?\s*([\d,]+\.?\d*)\s*GL\s*\$?([\d,]+\.?\d*)\s*(?:GL)?\s*\$?([\d,]+\.?\d*)/g;
  let match;
  while ((match = crxPattern.exec(text)) !== null) {
    const [, , productName, epaReg, quantity, cost] = match;
    const cleanQty = parseFloat(quantity.replace(/,/g, ''));
    const cleanCost = parseFloat(cost.replace(/,/g, ''));
    if (!isNaN(cleanQty) && !isNaN(cleanCost) && cleanQty > 0) {
      items.push({
        extracted_name: productName.trim(),
        matched_product: null,
        match_confidence: 0,
        quantity_ordered: cleanQty,
        unit_cost: cleanCost,
        unit_size: 'GL',
        notes: epaReg ? `EPA Reg: ${epaReg}` : '',
      });
    }
  }

  if (items.length > 0) return items;

  // Strategy 2: Generic tabular parsing
  // Look for lines that have a product description followed by numeric values
  // Common patterns: "Product Name  10  25.50  255.00" or "Product Name  10 GL  $25.50  $255.00"
  const unitPatterns = /\b(GL|GAL|GALLON|LB|LBS|OZ|QT|QUART|PT|PINT|CASE|EA|EACH|TON|BAG|JUG|DRUM|TOTE)\b/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;

    // Skip header-like lines
    if (/^\s*(product|item|description|qty|quantity|price|amount|total|unit|#)\s/i.test(trimmed)) continue;
    if (/^\s*(sub\s*total|grand\s*total|tax|freight|shipping|discount|balance|due)\s/i.test(trimmed)) continue;

    // Match: text portion followed by at least a quantity and a price
    // Pattern: ProductName ... Qty [Unit] UnitPrice [LineTotal]
    const lineMatch = trimmed.match(
      /^(.{4,60}?)\s{2,}([\d,]+\.?\d*)\s*(?:([A-Za-z]{1,6})\s+)?\$?\s*([\d,]+\.?\d{2})\s*(?:\$?\s*[\d,]+\.?\d{2})?$/,
    );

    if (lineMatch) {
      const [, name, qty, unit, price] = lineMatch;
      const cleanQty = parseFloat(qty.replace(/,/g, ''));
      const cleanPrice = parseFloat(price.replace(/,/g, ''));
      if (
        !isNaN(cleanQty) &&
        !isNaN(cleanPrice) &&
        cleanQty > 0 &&
        cleanPrice > 0 &&
        name.trim().length > 2
      ) {
        items.push({
          extracted_name: name.trim(),
          matched_product: null,
          match_confidence: 0,
          quantity_ordered: cleanQty,
          unit_cost: cleanPrice,
          unit_size: unit || '',
          notes: '',
        });
      }
    }
  }

  if (items.length > 0) return items;

  // Strategy 3: Very loose fallback - look for any line with a dollar amount preceded by text and a number
  const loosePattern = /^(.{4,}?)\s+([\d,]+\.?\d*)\s+\$?([\d,]+\.\d{2})/;
  for (const line of lines) {
    const m = line.trim().match(loosePattern);
    if (m) {
      const name = m[1].trim();
      const qty = parseFloat(m[2].replace(/,/g, ''));
      const price = parseFloat(m[3].replace(/,/g, ''));
      if (
        !isNaN(qty) && !isNaN(price) && qty > 0 && price > 0 &&
        name.length > 2 &&
        !/total|sub|tax|freight|shipping|discount|balance|due/i.test(name)
      ) {
        items.push({
          extracted_name: name,
          matched_product: null,
          match_confidence: 0,
          quantity_ordered: qty,
          unit_cost: price,
          unit_size: '',
          notes: '',
        });
      }
    }
  }

  return items;
}

function parsePDFForPO(text: string, filename: string, products: Product[]): ParsedPO {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l);
  const parse_errors: string[] = [];

  const vendor_name = extractVendor(lines);
  if (!vendor_name) parse_errors.push('Could not detect vendor name');

  const invoice_number = extractInvoiceNumber(text);
  if (!invoice_number) parse_errors.push('Could not detect invoice/PO number');

  const invoice_date = extractDate(text);

  const rawItems = extractLineItems(text, lines);
  if (rawItems.length === 0) parse_errors.push('No line items found');

  // Fuzzy match each item against product catalog
  const items = rawItems.map((item) => {
    const { product, score } = fuzzyMatchProductWithScore(item.extracted_name, products);
    return { ...item, matched_product: product, match_confidence: score };
  });

  return {
    source_file: filename,
    vendor_name,
    invoice_number,
    invoice_date,
    items,
    raw_text: text,
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
  const [uploadResults, setUploadResults] = useState<{ success: number; failed: number } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);

  // Product search state
  const [productSearchOpen, setProductSearchOpen] = useState<{ poIdx: number; itemIdx: number } | null>(null);
  const [productQuery, setProductQuery] = useState('');

  useEffect(() => {
    if (open) fetchProducts();
  }, [open]);

  const fetchProducts = async () => {
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('product_name');
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
      if (!f.name.toLowerCase().endsWith('.pdf') && f.type !== 'application/pdf') {
        toast('error', `${f.name} is not a PDF file.`);
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
      for (const file of files) {
        try {
          const text = await extractTextFromPDF(file);
          const parsed = parsePDFForPO(text, file.name, products);
          results.push(parsed);
        } catch (err) {
          console.error(`Error parsing ${file.name}:`, err);
          results.push({
            source_file: file.name,
            vendor_name: '',
            invoice_number: '',
            invoice_date: new Date().toISOString().split('T')[0],
            items: [],
            raw_text: '',
            parse_errors: [`Failed to read PDF: ${err instanceof Error ? err.message : 'Unknown error'}`],
            expanded: true,
          });
        }
      }
      if (results.every((r) => r.items.length === 0)) {
        toast('error', 'Could not extract any line items from the uploaded PDFs.');
      }
      setParsedPOs(results);
    } catch (err) {
      console.error('Parse error:', err);
      toast('error', 'Error parsing PDF files');
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
    let successCount = 0;
    let failedCount = 0;

    for (const po of importable) {
      try {
        const validItems = po.items.filter((i) => i.matched_product && i.quantity_ordered > 0);
        if (validItems.length === 0) {
          failedCount++;
          continue;
        }

        // Generate PO number
        const year = new Date().getFullYear();
        const { count } = await supabase
          .from('purchase_orders')
          .select('*', { count: 'exact', head: true })
          .like('po_number', `PO-${year}-%`);
        const poNumber = `PO-${year}-${String((count || 0) + 1).padStart(4, '0')}`;

        const totalCost = validItems.reduce((sum, i) => sum + i.quantity_ordered * i.unit_cost, 0);

        const noteParts = [`Imported from PDF: ${po.source_file}`];
        if (po.invoice_number) noteParts.push(`Vendor ref: ${po.invoice_number}`);
        if (po.invoice_date) noteParts.push(`Vendor date: ${po.invoice_date}`);

        const { data: poData, error: poError } = await supabase
          .from('purchase_orders')
          .insert({
            po_number: poNumber,
            vendor: po.vendor_name.trim() || 'Unknown Vendor',
            status: 'draft',
            submitted_date: null,
            expected_delivery_date: null,
            total_cost: totalCost,
            notes: noteParts.join('. '),
            created_by: profile.id,
          })
          .select('id')
          .maybeSingle();

        if (poError || !poData) throw poError;

        const itemInserts = validItems.map((item) => ({
          purchase_order_id: poData.id,
          product_id: item.matched_product!.id,
          quantity_ordered: item.quantity_ordered,
          unit_cost: item.unit_cost,
          unit_size: item.unit_size || null,
          quantity_received: 0,
          notes: item.notes || null,
        }));

        const { error: itemError } = await supabase
          .from('purchase_order_items')
          .insert(itemInserts);

        if (itemError) throw itemError;

        await logActivity(
          'po_created',
          `PO ${poNumber} imported from PDF (vendor: ${po.vendor_name || 'Unknown'})`,
          profile.id,
          'purchase_order',
          poData.id,
        );

        successCount++;
      } catch (error) {
        console.error('Error importing PO:', error);
        failedCount++;
      }
    }

    setUploadResults({ success: successCount, failed: failedCount });
    setUploading(false);

    if (successCount > 0) {
      toast('success', `Imported ${successCount} purchase order${successCount !== 1 ? 's' : ''}`);
      onSuccess();
    }
  };

  const handleClose = () => {
    setFiles([]);
    setParsedPOs(null);
    setUploadResults(null);
    setProductSearchOpen(null);
    setProductQuery('');
    onClose();
  };

  const reset = () => {
    setFiles([]);
    setParsedPOs(null);
    setUploadResults(null);
  };

  // ---------- derived stats ----------

  const totalMatched = parsedPOs?.reduce((sum, po) => sum + po.items.filter((i) => i.matched_product).length, 0) ?? 0;
  const totalUnmatched = parsedPOs?.reduce((sum, po) => sum + po.items.filter((i) => !i.matched_product).length, 0) ?? 0;
  const totalItems = totalMatched + totalUnmatched;
  const importablePOs = parsedPOs?.filter((po) => po.items.some((i) => i.matched_product && i.quantity_ordered > 0)).length ?? 0;

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
    <Modal open={open} onClose={handleClose} title="Import POs from PDF" size="large">
      <div className="space-y-4" style={{ maxWidth: '900px' }}>
        {/* Instructions */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <FileText className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-900">
              <p className="font-medium mb-1">Upload vendor PDF invoices</p>
              <ul className="list-disc list-inside space-y-0.5 text-xs">
                <li>Upload one or more PDF invoices from vendors</li>
                <li>System extracts vendor, invoice number, date, and line items</li>
                <li>Products are auto-matched to your catalog - review and correct before importing</li>
                <li>Each PDF creates a draft Purchase Order</li>
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
                accept=".pdf"
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
                    <span className="text-xs text-gray-500">PDF files (max 10MB each)</span>
                  </span>
                )}
              </label>
            </div>

            {files.length > 0 && (
              <Button onClick={handleParse} disabled={parsing} className="w-full">
                {parsing ? 'Parsing PDFs...' : `Parse ${files.length} PDF${files.length !== 1 ? 's' : ''}`}
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
                const poTotal = po.items.reduce((s, i) => s + i.quantity_ordered * i.unit_cost, 0);
                const hasErrors = po.parse_errors.length > 0;
                const hasItems = po.items.length > 0;

                return (
                  <div key={poIdx} className="border border-gray-200 rounded-lg overflow-hidden">
                    {/* PO header */}
                    <div
                      className="p-4 bg-gray-50 flex items-center gap-3 cursor-pointer hover:bg-gray-100 transition-colors"
                      onClick={() => toggleExpanded(poIdx)}
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
                      {hasErrors && !hasItems && (
                        <Badge variant="error">Parse Failed</Badge>
                      )}
                      {hasErrors && hasItems && (
                        <Badge variant="warning">Partial</Badge>
                      )}
                      {!hasErrors && hasItems && (
                        <Badge variant="success">Ready</Badge>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removePO(poIdx);
                        }}
                        className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Remove this PO"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Expanded content */}
                    {po.expanded && (
                      <div className="p-4 space-y-3">
                        {/* Parse errors */}
                        {po.parse_errors.length > 0 && (
                          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                            <p className="text-xs font-medium text-amber-800 mb-1">Parse warnings:</p>
                            <ul className="text-xs text-amber-700 space-y-0.5">
                              {po.parse_errors.map((err, i) => (
                                <li key={i}>&bull; {err}</li>
                              ))}
                            </ul>
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
                                  <th className="px-3 py-2 font-medium">PDF Name</th>
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
                                      {fmt(item.quantity_ordered * item.unit_cost)}
                                    </td>
                                    <td className="px-3 py-2">
                                      <button
                                        onClick={() => removeItem(poIdx, itemIdx)}
                                        className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
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
                <p>Successfully imported: {uploadResults.success} purchase order{uploadResults.success !== 1 ? 's' : ''}</p>
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
