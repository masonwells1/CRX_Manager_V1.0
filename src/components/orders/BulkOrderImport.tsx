import { useState } from 'react';
import { Upload, CheckCircle, AlertCircle, FileText } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { supabase } from '../../lib/db';

interface BulkOrderImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface ParsedOrderItem {
  product_name: string;
  quantity: number;
  price_per_unit: number;
  unit_cost?: number;
  unit_size?: string;
  notes?: string;
}

interface ParsedOrder {
  order_number: string;
  customer_name: string;
  order_date: string;
  status?: string;
  notes?: string;
  items: ParsedOrderItem[];
}

interface ValidationResult {
  valid: ParsedOrder[];
  invalid: Array<{ row: number; error: string; data: Record<string, string> }>;
}

const ORDER_FIELD_MAPPINGS: Record<string, string[]> = {
  order_number: ['order_number', 'order_no', 'order#', 'invoice_number', 'invoice_no', 'invoice#'],
  customer_name: ['customer_name', 'customer', 'farm_name', 'farm', 'buyer'],
  order_date: ['order_date', 'date', 'invoice_date', 'sale_date'],
  status: ['status', 'order_status'],
  notes: ['notes', 'comments', 'memo', 'description'],
};

const ITEM_FIELD_MAPPINGS: Record<string, string[]> = {
  product_name: ['product_name', 'product', 'item', 'description', 'item_description'],
  quantity: ['quantity', 'qty', 'amount', 'units', 'total_units'],
  price_per_unit: ['price_per_unit', 'unit_price', 'price', 'rate', 'unit_rate'],
  unit_cost: ['unit_cost', 'cost', 'cost_per_unit'],
  unit_size: ['unit_size', 'size', 'package_size'],
  item_notes: ['item_notes', 'item_comment', 'line_notes'],
};

export default function BulkOrderImport({ open, onClose, onSuccess }: BulkOrderImportProps) {
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

  const detectFieldMapping = (header: string, mappings: Record<string, string[]>): string | null => {
    const normalized = header.toLowerCase().trim().replace(/\s+/g, '_');
    for (const [field, aliases] of Object.entries(mappings)) {
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
    const rows = lines.slice(1).map((line) =>
      line.split(',').map((cell) => cell.trim().replace(/^["']|["']$/g, ''))
    );

    return { headers, rows };
  };

  const handleParse = async () => {
    if (!file) return;

    setParsing(true);
    const text = await file.text();
    const { headers, rows } = parseCSV(text);

    if (headers.length === 0 || rows.length === 0) {
      toast({ title: 'Invalid CSV file', variant: 'error' });
      setParsing(false);
      return;
    }

    const orderFieldMap: Record<string, number> = {};
    const itemFieldMap: Record<string, number> = {};

    headers.forEach((header, idx) => {
      const orderField = detectFieldMapping(header, ORDER_FIELD_MAPPINGS);
      if (orderField) {
        orderFieldMap[orderField] = idx;
      }
      const itemField = detectFieldMapping(header, ITEM_FIELD_MAPPINGS);
      if (itemField) {
        itemFieldMap[itemField] = idx;
      }
    });

    const requiredOrderFields = ['order_number', 'customer_name'];
    const missingOrderFields = requiredOrderFields.filter((f) => !(f in orderFieldMap));

    const requiredItemFields = ['product_name', 'quantity', 'price_per_unit'];
    const missingItemFields = requiredItemFields.filter((f) => !(f in itemFieldMap));

    if (missingOrderFields.length > 0 || missingItemFields.length > 0) {
      toast({
        title: 'Missing required columns',
        description: `Required: ${[...missingOrderFields, ...missingItemFields].join(', ')}`,
        variant: 'error',
      });
      setParsing(false);
      return;
    }

    const ordersMap = new Map<string, ParsedOrder>();
    const invalid: Array<{ row: number; error: string; data: Record<string, string> }> = [];

    rows.forEach((row, idx) => {
      const rowData: Record<string, string> = {};
      headers.forEach((h, i) => {
        rowData[h] = row[i];
      });

      try {
        const orderNumber = row[orderFieldMap.order_number];
        const customerName = row[orderFieldMap.customer_name];
        const productName = row[itemFieldMap.product_name];
        const quantity = parseFloat(row[itemFieldMap.quantity]);
        const pricePerUnit = parseFloat(row[itemFieldMap.price_per_unit]);

        if (!orderNumber || !customerName || !productName || isNaN(quantity) || isNaN(pricePerUnit)) {
          invalid.push({
            row: idx + 2,
            error: 'Missing or invalid required fields',
            data: rowData,
          });
          return;
        }

        if (!ordersMap.has(orderNumber)) {
          ordersMap.set(orderNumber, {
            order_number: orderNumber,
            customer_name: customerName,
            order_date: orderFieldMap.order_date !== undefined
              ? row[orderFieldMap.order_date]
              : new Date().toISOString().split('T')[0],
            status: orderFieldMap.status !== undefined ? row[orderFieldMap.status] : 'confirmed',
            notes: orderFieldMap.notes !== undefined ? row[orderFieldMap.notes] : undefined,
            items: [],
          });
        }

        const order = ordersMap.get(orderNumber)!;
        order.items.push({
          product_name: productName,
          quantity,
          price_per_unit: pricePerUnit,
          unit_cost: itemFieldMap.unit_cost !== undefined
            ? parseFloat(row[itemFieldMap.unit_cost]) || 0
            : 0,
          unit_size: itemFieldMap.unit_size !== undefined ? row[itemFieldMap.unit_size] : undefined,
          notes: itemFieldMap.item_notes !== undefined ? row[itemFieldMap.item_notes] : undefined,
        });
      } catch (error) {
        invalid.push({
          row: idx + 2,
          error: 'Error parsing row',
          data: rowData,
        });
      }
    });

    const valid = Array.from(ordersMap.values());

    setValidation({ valid, invalid });
    setParsing(false);
  };

  const handleUpload = async () => {
    if (!validation || validation.valid.length === 0) return;

    setUploading(true);
    let successCount = 0;
    let failedCount = 0;

    for (const order of validation.valid) {
      try {
        const { data: customer } = await supabase
          .from('customers')
          .select('id')
          .ilike('farm_name', order.customer_name)
          .maybeSingle();

        if (!customer) {
          failedCount++;
          continue;
        }

        const totalPrice = order.items.reduce(
          (sum, item) => sum + item.quantity * item.price_per_unit,
          0
        );
        const totalCost = order.items.reduce(
          (sum, item) => sum + item.quantity * (item.unit_cost || 0),
          0
        );
        const totalProfit = totalPrice - totalCost;
        const totalMarginPct = totalPrice > 0 ? (totalProfit / totalPrice) * 100 : 0;

        const { data: orderData, error: orderError } = await supabase
          .from('orders')
          .insert({
            order_number: order.order_number,
            customer_id: customer.id,
            status: order.status || 'confirmed',
            total_price: totalPrice,
            total_cost: totalCost,
            total_profit: totalProfit,
            total_margin_pct: totalMarginPct,
            order_date: order.order_date,
            notes: order.notes,
          })
          .select()
          .single();

        if (orderError) throw orderError;

        const orderItems = await Promise.all(
          order.items.map(async (item, idx) => {
            const { data: product } = await supabase
              .from('products')
              .select('id')
              .ilike('product_name', item.product_name)
              .maybeSingle();

            return {
              order_id: orderData.id,
              product_id: product?.id || null,
              product_name: item.product_name,
              price_per_unit: item.price_per_unit,
              unit_cost: item.unit_cost || 0,
              total_units_needed: item.quantity,
              unit_size: item.unit_size,
              notes: item.notes,
              sort_order: idx + 1,
              quantity_delivered: 0,
            };
          })
        );

        const { error: itemsError } = await supabase.from('order_items').insert(orderItems);

        if (itemsError) throw itemsError;

        successCount++;
      } catch (error) {
        console.error('Error importing order:', error);
        failedCount++;
      }
    }

    setUploadResults({ success: successCount, failed: failedCount });
    setUploading(false);

    if (successCount > 0) {
      toast({
        title: `Imported ${successCount} order${successCount !== 1 ? 's' : ''}`,
        variant: 'success',
      });
      onSuccess();
    }
  };

  const handleClose = () => {
    setFile(null);
    setValidation(null);
    setUploadResults(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Import Orders" size="lg">
      <div className="space-y-4">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <FileText className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-900">
              <p className="font-medium mb-2">CSV Format Requirements:</p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>Required: order_number, customer_name, product_name, quantity, price_per_unit</li>
                <li>Optional: order_date, status, unit_cost, unit_size, notes</li>
                <li>Multiple items per order: Use same order_number on multiple rows</li>
                <li>Customer names must match existing customers in the system</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
          <Upload className="w-12 h-12 text-gray-400 mx-auto mb-3" />
          <input
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="hidden"
            id="order-csv-upload"
          />
          <label
            htmlFor="order-csv-upload"
            className="cursor-pointer text-sm text-gray-600 hover:text-gray-900"
          >
            {file ? (
              <span className="text-crx-green font-medium">{file.name}</span>
            ) : (
              <span>
                Click to upload or drag and drop
                <br />
                <span className="text-xs text-gray-500">CSV files only</span>
              </span>
            )}
          </label>
        </div>

        {file && !validation && (
          <Button onClick={handleParse} disabled={parsing} className="w-full">
            {parsing ? 'Parsing...' : 'Parse CSV'}
          </Button>
        )}

        {validation && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center gap-2 text-green-700">
                  <CheckCircle className="w-5 h-5" />
                  <span className="font-medium">
                    {validation.valid.length} Valid Order{validation.valid.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              {validation.invalid.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-center gap-2 text-red-700">
                    <AlertCircle className="w-5 h-5" />
                    <span className="font-medium">
                      {validation.invalid.length} Invalid Row{validation.invalid.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {validation.invalid.length > 0 && (
              <div className="max-h-40 overflow-y-auto bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-xs font-medium text-red-900 mb-2">Errors:</p>
                <ul className="text-xs text-red-800 space-y-1">
                  {validation.invalid.map((inv, idx) => (
                    <li key={idx}>
                      Row {inv.row}: {inv.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!uploadResults && validation.valid.length > 0 && (
              <Button onClick={handleUpload} disabled={uploading} className="w-full">
                {uploading ? 'Importing...' : `Import ${validation.valid.length} Order${validation.valid.length !== 1 ? 's' : ''}`}
              </Button>
            )}

            {uploadResults && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <p className="text-sm font-medium text-nav-dark mb-2">Import Complete</p>
                <div className="text-sm text-secondary space-y-1">
                  <p>Successfully imported: {uploadResults.success}</p>
                  {uploadResults.failed > 0 && (
                    <p className="text-red-600">Failed: {uploadResults.failed}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
