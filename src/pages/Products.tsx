import { useEffect, useState, useMemo , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload, FileUp, Download, FileText, Trash2, Eye, EyeOff, ChevronDown } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import EditableDataTable, { type EditableColumn } from '../components/ui/EditableDataTable';
import Badge from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import BulkPricingImport from '../components/products/BulkPricingImport';
import BulkProductImport from '../components/products/BulkProductImport';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, checkMutationResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { logActivity } from '../lib/activityLogger';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtCSV } from '../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { SkeletonTable } from '../components/ui/Skeleton';
import HelpTip from '../components/ui/HelpTip';
import type { Product } from '../types';

export default function Products() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [bulkProductImportOpen, setBulkProductImportOpen] = useState(false);
  const [deactivateModalOpen, setDeactivateModalOpen] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showSensitive, setShowSensitive] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const canBulkAction = role === 'admin' || role === 'sales_rep';

  const fetchProducts = useCallback(async () => {
    // Paginate so the master catalog never silently truncates as the catalog grows.
    // PostgREST caps a single response (default 1000), so we page through with .range().
    const PAGE_SIZE = 1000;
    const all: Product[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('product_name')
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        Sentry.captureException(error);
        toast('error', 'Failed to load products. Please try again.');
        setLoading(false);
        return;
      }
      const batch = (data || []) as Product[];
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    const prods = all;
    setProducts(prods);

    const cats = [...new Set(prods.map((p) => p.category).filter(Boolean))] as string[];
    const vends = [...new Set(prods.map((p) => p.vendor).filter(Boolean))] as string[];
    setCategories(cats.sort());
    setVendors(vends.sort());
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const filtered = products.filter((p) => {
    if (categoryFilter && p.category !== categoryFilter) return false;
    if (vendorFilter && p.vendor !== vendorFilter) return false;
    return true;
  });

  const isAdmin = role === 'admin';

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: filtered,
      getId: (p) => p.id,
      isSelectable: (p) => p.is_active,
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<Product>(selected, toggleSelect, (p) => p.id, (p) => p.is_active),
    [selected, toggleSelect]
  );

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const handleExportCSV = () => {
    const fmtMargin = (v: unknown) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : '';
    const baseCols = [
      { key: 'product_name', header: 'Product Name' },
      { key: 'sku', header: 'SKU' },
      { key: 'category', header: 'Category' },
      { key: 'vendor', header: 'Vendor' },
    ];
    const showCostMargin = isAdmin && showSensitive;
    const priceCols = showCostMargin
      ? [
          { key: 'current_cost', header: 'Cost', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier1_price', header: 'T1 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier1_margin', header: 'T1 Margin %', format: fmtMargin },
          { key: 'tier2_price', header: 'T2 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier2_margin', header: 'T2 Margin %', format: fmtMargin },
          { key: 'tier3_price', header: 'T3 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier3_margin', header: 'T3 Margin %', format: fmtMargin },
        ]
      : [
          { key: 'tier1_price', header: 'T1 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier2_price', header: 'T2 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier3_price', header: 'T3 Price', format: (v: unknown) => fmtCSV(v as number) },
        ];
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      ...baseCols,
      ...priceCols,
      { key: 'is_active', header: 'Status', format: (v: unknown) => v ? 'Active' : 'Inactive' },
    ], 'products');
    toast('success', `Exported ${selectedRows.length} product(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const fmtMarginPdf = (v: unknown) => v != null ? String(v) : '';
      // Preprocess data with synthetic margin strings (reportPdf format only gets value, not row)
      const pdfData = selectedRows.map((p) => ({
        ...p,
        _t1_margin_str: p.tier1_margin != null ? `${(p.tier1_margin * 100).toFixed(1)}%` : '',
        _t2_margin_str: p.tier2_margin != null ? `${(p.tier2_margin * 100).toFixed(1)}%` : '',
        _t3_margin_str: p.tier3_margin != null ? `${(p.tier3_margin * 100).toFixed(1)}%` : '',
      }));
      const basePdfCols: ReportPdfColumn[] = [
        { header: 'Product', key: 'product_name' },
        { header: 'SKU', key: 'sku', format: (v) => String(v || '-') },
        { header: 'Category', key: 'category', format: (v) => String(v || '-') },
      ];
      const showCostMarginPdf = isAdmin && showSensitive;
      const pricePdfCols: ReportPdfColumn[] = showCostMarginPdf
        ? [
            { header: 'Cost', key: 'current_cost', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T1 Margin', key: '_t1_margin_str', align: 'right', format: fmtMarginPdf },
            { header: 'T2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T2 Margin', key: '_t2_margin_str', align: 'right', format: fmtMarginPdf },
            { header: 'T3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T3 Margin', key: '_t3_margin_str', align: 'right', format: fmtMarginPdf },
          ]
        : [
            { header: 'T1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
          ];
      await downloadReportPdf({
        title: 'Products',
        subtitle: `${selectedRows.length} product(s) selected`,
        columns: [...basePdfCols, ...pricePdfCols, { header: 'Status', key: 'is_active', format: (v) => v ? 'Active' : 'Inactive' }],
        data: pdfData as unknown as Record<string, unknown>[],
        orientation: showCostMarginPdf ? 'landscape' : 'portrait',
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} product(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  // --- Download All (filtered) ---
  const handleDownloadAllCSV = (includeCost: boolean) => {
    const fmtMargin = (v: unknown) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : '';
    const baseCols = [
      { key: 'product_name', header: 'Product Name' },
      { key: 'sku', header: 'SKU' },
      { key: 'category', header: 'Category' },
      { key: 'vendor', header: 'Vendor' },
      { key: 'container_size', header: 'Container Size' },
      { key: 'unit_size', header: 'Unit' },
    ];
    const priceCols = includeCost
      ? [
          { key: 'current_cost', header: 'Cost', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier1_price', header: 'T1 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier1_margin', header: 'T1 Margin %', format: fmtMargin },
          { key: 'tier2_price', header: 'T2 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier2_margin', header: 'T2 Margin %', format: fmtMargin },
          { key: 'tier3_price', header: 'T3 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier3_margin', header: 'T3 Margin %', format: fmtMargin },
        ]
      : [
          { key: 'tier1_price', header: 'Tier 1 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier2_price', header: 'Tier 2 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier3_price', header: 'Tier 3 Price', format: (v: unknown) => fmtCSV(v as number) },
        ];
    const filename = includeCost ? 'product-price-sheet-internal' : 'product-sales-sheet';
    exportToCSV(filtered as unknown as Record<string, unknown>[], [...baseCols, ...priceCols], filename);
    toast('success', `Exported ${filtered.length} product(s) to CSV`);
    setExportMenuOpen(false);
  };

  const handleDownloadAllPDF = async (includeCost: boolean) => {
    setExporting(true);
    setExportMenuOpen(false);
    try {
      const fmtMarginPdf = (v: unknown) => v != null ? String(v) : '';
      const pdfData = filtered.map((p) => ({
        ...p,
        _t1_margin_str: p.tier1_margin != null ? `${(p.tier1_margin * 100).toFixed(1)}%` : '',
        _t2_margin_str: p.tier2_margin != null ? `${(p.tier2_margin * 100).toFixed(1)}%` : '',
        _t3_margin_str: p.tier3_margin != null ? `${(p.tier3_margin * 100).toFixed(1)}%` : '',
      }));
      const basePdfCols: ReportPdfColumn[] = [
        { header: 'Product', key: 'product_name' },
        { header: 'SKU', key: 'sku', format: (v) => String(v || '-') },
        { header: 'Category', key: 'category', format: (v) => String(v || '-') },
        { header: 'Size', key: 'container_size', format: (v) => v != null ? String(v) : '-' },
        { header: 'Unit', key: 'unit_size', format: (v) => String(v || '-') },
      ];
      const pricePdfCols: ReportPdfColumn[] = includeCost
        ? [
            { header: 'Cost', key: 'current_cost', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T1 Margin', key: '_t1_margin_str', align: 'right', format: fmtMarginPdf },
            { header: 'T2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T2 Margin', key: '_t2_margin_str', align: 'right', format: fmtMarginPdf },
            { header: 'T3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T3 Margin', key: '_t3_margin_str', align: 'right', format: fmtMarginPdf },
          ]
        : [
            { header: 'Tier 1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'Tier 2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'Tier 3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
          ];
      const title = includeCost ? 'Product & Pricing — Internal' : 'Product Sales Sheet';
      await downloadReportPdf({
        title,
        subtitle: `${filtered.length} active product(s) — ${new Date().toLocaleDateString()}`,
        columns: [...basePdfCols, ...pricePdfCols],
        data: pdfData as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded ${includeCost ? 'internal' : 'sales'} price sheet PDF`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleDeactivate = async () => {
    const ids = selectedRows.map((p) => p.id);

    // H22: Block deactivation if any selected product has open PO lines
    const { data: openPoLines } = await supabase
      .from('purchase_order_items')
      .select('id, product_id, purchase_order:purchase_orders!inner(status)')
      .in('product_id', ids)
      .in('purchase_order.status', ['draft', 'submitted', 'partially_received'])
      .limit(1);
    if (openPoLines && openPoLines.length > 0) {
      toast('error', 'Cannot deactivate: one or more selected products have open purchase order lines. Receive or cancel those POs first.');
      setDeactivateModalOpen(false);
      return;
    }

    await runCriticalAction({
      action: async () => {
        const result = await supabase
          .from('products')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .in('id', ids)
          .select();
        checkMutationResult(result, 'Deactivate products');
      },
      toast,
      setLoading: setDeactivating,
      successMessage: `Deactivated ${ids.length} product(s)`,
      sentryTag: 'deactivate_products',
      onSuccess: () => {
        clearSelection();
        fetchProducts();
        setDeactivateModalOpen(false);
      },
    });
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'deactivate', label: 'Deactivate', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeactivateModalOpen(true), variant: 'danger' as const },
  ];

  const categoryOptions = categories.map((c) => ({ value: c, label: c }));
  const vendorOptions = vendors.map((v) => ({ value: v, label: v }));

  /** Build an editRender for a tier column that shows margin input + computed price preview */
  const createTierEditRender = (tierNum: 1 | 2 | 3) => {
    const marginKey = `tier${tierNum}_margin` as keyof Product & string;
    const priceKey = `tier${tierNum}_price` as keyof Product & string;

    return (
      row: Product,
      getCellValue: (colKey: string) => unknown,
      setCellValue: (colKey: string, value: unknown) => void
    ) => {
      const cost = Number(getCellValue('current_cost')) || 0;
      const marginRaw = getCellValue(marginKey);
      const margin = marginRaw != null ? Number(marginRaw) : null;

      if (!showSensitive || cost <= 0) {
        // No margin editing when sensitive is hidden or no cost — fall back to direct price input
        const price = getCellValue(priceKey);
        return (
          <input
            type="number"
            value={price != null ? String(price) : ''}
            min={0}
            step="0.01"
            onChange={(e) => {
              const raw = e.target.value;
              setCellValue(priceKey, raw === '' ? null : parseFloat(raw));
            }}
            className="w-full px-2 py-1 text-sm text-right font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
          />
        );
      }

      // Compute price from margin for live preview
      const computedPrice =
        margin != null && margin > 0 && margin < 1
          ? Math.round((cost / (1 - margin)) * 100) / 100
          : null;

      return (
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={margin != null ? String(Math.round(margin * 10000) / 100) : ''}
              min={0}
              max={99.9}
              step="0.1"
              placeholder="—"
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  setCellValue(marginKey, null);
                } else {
                  const pct = parseFloat(raw);
                  const decimal = pct / 100;
                  setCellValue(marginKey, decimal);
                  // Compute and set price for live preview + save
                  if (decimal > 0 && decimal < 1 && cost > 0) {
                    setCellValue(priceKey, Math.round((cost / (1 - decimal)) * 100) / 100);
                  }
                }
              }}
              className="w-16 px-1 py-1 text-sm text-right font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
            />
            <span className="text-xs text-gray-400">%</span>
          </div>
          {computedPrice != null ? (
            <div className="text-xs font-mono text-gray-500">{fmt(computedPrice)}</div>
          ) : (
            // No valid margin — allow direct price edit
            <input
              type="number"
              value={getCellValue(priceKey) != null ? String(getCellValue(priceKey)) : ''}
              min={0}
              step="0.01"
              onChange={(e) => {
                const raw = e.target.value;
                setCellValue(priceKey, raw === '' ? null : parseFloat(raw));
              }}
              className="w-full px-1 py-1 text-xs font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
            />
          )}
          {computedPrice != null && (
            <div className="text-[10px] text-crx-green">auto from margin</div>
          )}
        </div>
      );
    };
  };

  const handleBulkSave = async (changes: Map<string, Record<string, unknown>>) => {
    try {
      // Log cost history for pricing changes
      for (const [productId, fields] of changes) {
        const original = products.find((p) => p.id === productId);
        if (!original || !profile) continue;

        const pricingChanged =
          ('current_cost' in fields && Number(fields.current_cost) !== Number(original.current_cost)) ||
          ('tier1_price' in fields && Number(fields.tier1_price) !== Number(original.tier1_price)) ||
          ('tier2_price' in fields && Number(fields.tier2_price) !== Number(original.tier2_price)) ||
          ('tier3_price' in fields && Number(fields.tier3_price) !== Number(original.tier3_price));

        if (pricingChanged) {
          const costResult = await supabase.from('cost_history').insert({
            product_id: productId,
            changed_by: profile.id,
            old_cost: original.current_cost,
            new_cost: 'current_cost' in fields ? fields.current_cost : original.current_cost,
            old_tier1_price: original.tier1_price,
            new_tier1_price: 'tier1_price' in fields ? fields.tier1_price : original.tier1_price,
            old_tier2_price: original.tier2_price,
            new_tier2_price: 'tier2_price' in fields ? fields.tier2_price : original.tier2_price,
            old_tier3_price: original.tier3_price,
            new_tier3_price: 'tier3_price' in fields ? fields.tier3_price : original.tier3_price,
            change_note: 'Updated via inline bulk edit',
          }).select();
          if (costResult.error) Sentry.captureException(costResult.error);
          checkMutationResult(costResult, 'Insert cost history for inline bulk edit');
        }

        // Update product
        const updateResult = await supabase
          .from('products')
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq('id', productId)
          .select();
        checkMutationResult(updateResult, 'Update product');
      }

      toast('success', `Updated ${changes.size} product(s)`);
      if (profile) {
        logActivity({ event: 'products_bulk_updated', description: `${changes.size} product(s) updated via inline edit`, performedBy: profile.id, entityType: 'product' });
      }
      fetchProducts();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
      throw err; // re-throw so EditableDataTable stays in edit mode
    }
  };

  const dataColumns: EditableColumn<Product>[] = [
    {
      key: 'product_name',
      header: 'Product Name',
      sortable: true,
      editable: isAdmin,
      editType: 'text',
      render: (row) => (
        <div className="max-w-xs">
          <p className="font-medium text-nav-dark truncate">{row.product_name}</p>
          {row.sku && <p className="text-xs text-gray-400">{row.sku}</p>}
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      sortable: true,
      editable: isAdmin,
      editType: 'select',
      editOptions: categoryOptions,
    },
    {
      key: 'vendor',
      header: 'Vendor',
      sortable: true,
      editable: isAdmin,
      editType: 'select',
      editOptions: vendorOptions,
    },
    ...(isAdmin && showSensitive
      ? [
          {
            key: 'current_cost',
            header: 'Cost',
            sortable: true,
            editable: true,
            editType: 'number' as const,
            editMin: 0,
            editStep: '0.01',
            render: (row: Product) => (
              <span className="font-mono text-sm">
                {row.current_cost != null ? `$${Number(row.current_cost).toFixed(2)}` : '-'}
              </span>
            ),
          } satisfies EditableColumn<Product>,
        ]
      : []),
    {
      key: 'tier1_price',
      header: 'T1 Price',
      sortable: true,
      editable: isAdmin,
      editRender: isAdmin ? createTierEditRender(1) : undefined,
      render: (row) => (
        <div>
          <span className="font-mono text-sm">
            {row.tier1_price != null ? `$${Number(row.tier1_price).toFixed(2)}` : '-'}
          </span>
          {isAdmin && showSensitive && row.tier1_margin != null && (
            <div className="text-[11px] text-gray-400">{(row.tier1_margin * 100).toFixed(1)}% net</div>
          )}
        </div>
      ),
    },
    {
      key: 'tier2_price',
      header: 'T2 Price',
      sortable: true,
      editable: isAdmin,
      editRender: isAdmin ? createTierEditRender(2) : undefined,
      render: (row) => (
        <div>
          <span className="font-mono text-sm">
            {row.tier2_price != null ? `$${Number(row.tier2_price).toFixed(2)}` : '-'}
          </span>
          {isAdmin && showSensitive && row.tier2_margin != null && (
            <div className="text-[11px] text-gray-400">{(row.tier2_margin * 100).toFixed(1)}% net</div>
          )}
        </div>
      ),
    },
    {
      key: 'tier3_price',
      header: 'T3 Price',
      sortable: true,
      editable: isAdmin,
      editRender: isAdmin ? createTierEditRender(3) : undefined,
      render: (row) => (
        <div>
          <span className="font-mono text-sm">
            {row.tier3_price != null ? `$${Number(row.tier3_price).toFixed(2)}` : '-'}
          </span>
          {isAdmin && showSensitive && row.tier3_margin != null && (
            <div className="text-[11px] text-gray-400">{(row.tier3_margin * 100).toFixed(1)}% net</div>
          )}
        </div>
      ),
    },
    {
      key: 'is_active',
      header: 'Status',
      editable: isAdmin,
      editType: 'toggle',
      render: (row) => (
        <Badge variant={row.is_active ? 'success' : 'default'}>
          {row.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
  ];

  const columns: EditableColumn<Product>[] = canBulkAction
    ? [checkboxCol as unknown as EditableColumn<Product>, ...dataColumns]
    : dataColumns;

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex-1 flex items-center gap-3">
          <h2 className="text-xl font-semibold font-heading text-nav-dark">
            Products
            <HelpTip text="Your product master list. Set tier pricing (1/2/3) for customer-specific pricing, mark products as RUP for compliance tracking, and manage unit sizes. Edit inline by clicking any editable cell." className="ml-1" />
          </h2>
          {canBulkAction && (
            <BulkActionBar
              selectedCount={selectedCount}
              actions={bulkActions}
              onDeselectAll={clearSelection}
            />
          )}
        </div>
        <div className="flex gap-2">
          {/* Download All dropdown */}
          <div className="relative">
            <Button
              variant="secondary"
              icon={<Download className="w-4 h-4" />}
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={exporting || filtered.length === 0}
            >
              {exporting ? 'Exporting...' : 'Download'} <ChevronDown className="w-3 h-3 ml-1 inline" />
            </Button>
            {exportMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" role="presentation" onClick={() => setExportMenuOpen(false)} onKeyDown={() => setExportMenuOpen(false)} />
                <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
                  <p className="px-3 py-1.5 text-xs font-semibold text-secondary uppercase tracking-wide">PDF</p>
                  <button onClick={() => handleDownloadAllPDF(false)} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-gray-400" /> Sales Sheet (prices only)
                  </button>
                  {isAdmin && (
                    <button onClick={() => handleDownloadAllPDF(true)} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                      <FileText className="w-4 h-4 text-gray-400" /> Internal (cost + margin)
                    </button>
                  )}
                  <div className="border-t border-gray-100 my-1" />
                  <p className="px-3 py-1.5 text-xs font-semibold text-secondary uppercase tracking-wide">CSV</p>
                  <button onClick={() => handleDownloadAllCSV(false)} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <Download className="w-4 h-4 text-gray-400" /> Sales Sheet (prices only)
                  </button>
                  {isAdmin && (
                    <button onClick={() => handleDownloadAllCSV(true)} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                      <Download className="w-4 h-4 text-gray-400" /> Internal (cost + margin)
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          {isAdmin && (
            <>
              <Button
                variant="secondary"
                icon={<FileUp className="w-4 h-4" />}
                onClick={() => setBulkProductImportOpen(true)}
              >
                Import Products
              </Button>
              <Button
                variant="secondary"
                icon={<Upload className="w-4 h-4" />}
                onClick={() => setBulkImportOpen(true)}
              >
                Update Pricing
              </Button>
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/products/new')}>
                Add Product
              </Button>
            </>
          )}
        </div>
      </div>

      <Card padding={false}>
        <div className="p-5">
          <EditableDataTable<Product>
            data={filtered}
            columns={columns}
            rowKey="id"
            searchable
            searchPlaceholder="Search products..."
            searchKeys={['product_name', 'sku', 'category', 'vendor']}
            onRowClick={(row) => navigate(`/products/${row.id}`)}
            emptyTitle="No products yet"
            emptyDescription="Add your first product to get started"
            emptyAction={
              isAdmin ? (
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/products/new')}>
                  Add Product
                </Button>
              ) : undefined
            }
            loading={loading}
            canEdit={isAdmin}
            onSave={handleBulkSave}
            headerActions={isAdmin ? (
              <Button
                variant="secondary"
                size="sm"
                icon={showSensitive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                onClick={() => setShowSensitive((v) => !v)}
              >
                {showSensitive ? 'Hide' : 'Margins'}
              </Button>
            ) : undefined}
            filters={
              <>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  aria-label="Filter by category"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Categories</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select
                  value={vendorFilter}
                  onChange={(e) => setVendorFilter(e.target.value)}
                  aria-label="Filter by vendor"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Vendors</option>
                  {vendors.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
                {canBulkAction && filtered.length > 0 && (
                  <button
                    onClick={toggleAll}
                    className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </>
            }
          />
        </div>
      </Card>

      <BulkPricingImport
        open={bulkImportOpen}
        onClose={() => setBulkImportOpen(false)}
        onSuccess={() => {
          fetchProducts();
          setBulkImportOpen(false);
        }}
      />

      <BulkProductImport
        open={bulkProductImportOpen}
        onClose={() => setBulkProductImportOpen(false)}
        onSuccess={() => {
          fetchProducts();
          setBulkProductImportOpen(false);
        }}
      />

      <BulkDeleteConfirmModal
        open={deactivateModalOpen}
        onClose={() => setDeactivateModalOpen(false)}
        count={selectedCount}
        entityName="product"
        actionWord="deactivate"
        onConfirm={handleDeactivate}
        loading={deactivating}
      />
    </div>
  );
}
