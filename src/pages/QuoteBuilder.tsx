import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Send,
  ShoppingCart,
  Plus,
  Trash2,
  Search,
  ChevronDown,
  ChevronUp,
  Download,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { supabase, assertRpcResult, checkMutationResult } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';
import { logActivity } from '../lib/activityLogger';
import { notifyLargeOrder, notifyCreditLimitExceeded } from '../lib/notificationTriggers';
import { downloadQuotePdf } from '../lib/quotePdf';
import CommissionSplitEditor from '../components/ui/CommissionSplitEditor';
import type {
  Quote,
  QuoteSection,
  QuoteItem,
  Product,
  Customer,
  UnitConversion,
  CommissionSplit,
  QuoteStatus,
} from '../types';

interface LocalSection {
  _key: string;
  id?: string;
  section_name: string;
  sort_order: number;
  section_notes: string | null;
  items: LocalItem[];
}

interface LocalItem {
  _key: string;
  id?: string;
  product_id: string;
  sort_order: number;
  notes: string | null;
  price_per_unit: number;
  current_cost: number;
  suggested_rate: string | null;
  actual_rate: number | null;
  rate_unit: string | null;
  oz_per_acre: number | null;
  price_per_acre: number | null;
  acres: number | null;
  total_units_needed: number | null;
  unit_size: string | null;
  profit: number;
  total_price: number;
  net_margin: number;
  product?: Product;
}

let keyCounter = 0;
function nextKey() {
  return `_k${++keyCounter}`;
}

function makeEmptyItem(): LocalItem {
  return {
    _key: nextKey(),
    product_id: '',
    sort_order: 1,
    notes: null,
    price_per_unit: 0,
    current_cost: 0,
    suggested_rate: null,
    actual_rate: null,
    rate_unit: null,
    oz_per_acre: null,
    price_per_acre: null,
    acres: null,
    total_units_needed: null,
    unit_size: null,
    profit: 0,
    total_price: 0,
    net_margin: 0,
  };
}

function makeEmptySection(order: number): LocalSection {
  return {
    _key: nextKey(),
    section_name: `Section ${order}`,
    sort_order: order,
    section_notes: null,
    items: [],
  };
}

export default function QuoteBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const isEditing = Boolean(id);

  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [converting, setConverting] = useState(false);
  const [confirmSendOpen, setConfirmSendOpen] = useState(false);
  const [confirmConvertOpen, setConfirmConvertOpen] = useState(false);

  const [customerId, setCustomerId] = useState('');
  const [tier, setTier] = useState(1);
  const [validDays, setValidDays] = useState(15);
  const [headerNotes, setHeaderNotes] = useState('');
  const [footerNotes, setFooterNotes] = useState('');
  const [commissionSplit, setCommissionSplit] = useState<CommissionSplit>({
    splits: [{ recipient: '', percentage: 100 }],
  });
  const [quoteNumber, setQuoteNumber] = useState('');
  const [status, setStatus] = useState<QuoteStatus>('draft');
  const [quoteId, setQuoteId] = useState<string | null>(id || null);

  const [sections, setSections] = useState<LocalSection[]>([makeEmptySection(1)]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);

  const [productSearchOpen, setProductSearchOpen] = useState<{
    sectionKey: string;
    itemKey: string;
  } | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

  // Mark dirty whenever user changes form data (after initial load)
  useEffect(() => {
    if (!initialLoadDone.current) return;
    setIsDirty(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, tier, validDays, headerNotes, footerNotes, sections, commissionSplit]);

  useEffect(() => {
    fetchReferenceData();
    if (isEditing && id) {
      fetchQuote(id);
    } else {
      generateQuoteNumber().then(() => {
        // Allow a tick for state to settle before tracking changes
        setTimeout(() => { initialLoadDone.current = true; }, 0);
      }).catch(() => { /* non-critical: quote number defaults handled inside generateQuoteNumber */ });
    }
  }, [id]);

  const fetchReferenceData = async () => {
    const [custRes, prodRes, convRes] = await Promise.all([
      supabase.from('customers').select('*').eq('is_active', true).order('farm_name'),
      supabase.from('products').select('*').eq('is_active', true).order('product_name'),
      supabase.from('unit_conversions').select('*'),
    ]);
    setCustomers((custRes.data || []) as Customer[]);
    setProducts((prodRes.data || []) as Product[]);
    setUnitConversions((convRes.data || []) as UnitConversion[]);
  };

  const generateQuoteNumber = async () => {
    // Use server-side sequence to prevent race conditions
    const { data, error } = await supabase.rpc('generate_quote_number');
    if (error || !data) {
      // Fallback for backward compatibility
      const year = new Date().getFullYear();
      const { count } = await supabase
        .from('quotes')
        .select('*', { count: 'exact', head: true })
        .like('quote_number', `Q-${year}-%`);
      const next = (count || 0) + 1;
      setQuoteNumber(`Q-${year}-${String(next).padStart(4, '0')}`);
    } else {
      setQuoteNumber(data as string);
    }
  };

  const fetchQuote = async (quoteId: string) => {
    const [quoteRes, sectionsRes, itemsRes] = await Promise.all([
      supabase.from('quotes').select('*, customer:customers(*)').eq('id', quoteId).maybeSingle(),
      supabase.from('quote_sections').select('*').eq('quote_id', quoteId).order('sort_order'),
      supabase
        .from('quote_items')
        .select('*, product:products(*)')
        .eq('quote_id', quoteId)
        .order('sort_order'),
    ]);

    if (!quoteRes.data) {
      toast('error', 'Quote not found');
      navigate('/quotes');
      return;
    }

    const q = quoteRes.data as Quote;
    setQuoteId(q.id);
    setQuoteNumber(q.quote_number);
    setCustomerId(q.customer_id);
    setTier(q.tier);
    setValidDays(q.valid_days);
    setHeaderNotes(q.header_notes || '');
    setFooterNotes(q.footer_notes || '');
    setStatus(q.status);
    if (q.commission_split) setCommissionSplit(q.commission_split);

    const dbSections = (sectionsRes.data || []) as QuoteSection[];
    const dbItems = (itemsRes.data || []) as QuoteItem[];

    const localSections: LocalSection[] = dbSections.map((s) => ({
      _key: nextKey(),
      id: s.id,
      section_name: s.section_name,
      sort_order: s.sort_order,
      section_notes: s.section_notes,
      items: dbItems
        .filter((item) => item.section_id === s.id)
        .map((item) => ({
          _key: nextKey(),
          id: item.id,
          product_id: item.product_id,
          sort_order: item.sort_order,
          notes: item.notes,
          price_per_unit: item.price_per_unit,
          current_cost: item.current_cost,
          suggested_rate: item.suggested_rate,
          actual_rate: item.actual_rate,
          rate_unit: item.rate_unit,
          oz_per_acre: item.oz_per_acre,
          price_per_acre: item.price_per_acre,
          acres: item.acres,
          total_units_needed: item.total_units_needed,
          unit_size: item.unit_size,
          profit: item.profit,
          total_price: item.total_price,
          net_margin: item.net_margin,
          product: item.product,
        })),
    }));

    setSections(localSections.length > 0 ? localSections : [makeEmptySection(1)]);
    setLoading(false);
    // Allow a tick for state to settle before tracking changes
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  };

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId]
  );

  const handleCustomerChange = (cId: string) => {
    setCustomerId(cId);
    const cust = customers.find((c) => c.id === cId);
    if (cust) {
      setTier(cust.assigned_tier);
      if (cust.default_commission_split) {
        setCommissionSplit(cust.default_commission_split);
      }
      recalcAllForTier(cust.assigned_tier);
    }
  };

  const getConversionFactor = useCallback(
    (unit: string | null): number => {
      if (!unit) return 1;
      const conv = unitConversions.find(
        (c) => c.unit.toLowerCase() === unit.toLowerCase()
      );
      return conv ? conv.factor_oz : 1;
    },
    [unitConversions]
  );

  const getTierPrice = useCallback(
    (product: Product, tierNum: number): number => {
      if (tierNum === 1) return product.tier1_price || 0;
      if (tierNum === 2) return product.tier2_price || 0;
      return product.tier3_price || 0;
    },
    []
  );

  const recalcItem = useCallback(
    (item: LocalItem, tierNum: number): LocalItem => {
      const product = item.product || products.find((p) => p.id === item.product_id);
      if (!product) return item;

      const pricePerUnit = getTierPrice(product, tierNum);
      const actualRate = item.actual_rate || 0;
      const acres = item.acres || 0;

      // Convert application rate to oz using the rate_unit's conversion factor
      const rateUnitFactorOz = getConversionFactor(item.rate_unit);
      const rateInOz = actualRate * rateUnitFactorOz;
      const ozPerAcre = rateInOz;

      // Convert oz to inventory units using the product's inventory_unit factor
      const inventoryUnitFactorOz = getConversionFactor(product.inventory_unit);
      const totalInventoryUnits = inventoryUnitFactorOz > 0
        ? (acres * rateInOz) / inventoryUnitFactorOz
        : 0;

      // Price is per inventory unit
      const pricePerAcre = inventoryUnitFactorOz > 0
        ? pricePerUnit * (rateInOz / inventoryUnitFactorOz)
        : 0;
      const totalPrice = pricePerUnit * totalInventoryUnits;
      const profit = (pricePerUnit - (product.current_cost || 0)) * totalInventoryUnits;
      const netMargin = totalPrice > 0 ? profit / totalPrice : 0;

      return {
        ...item,
        price_per_unit: pricePerUnit,
        current_cost: product.current_cost || 0,
        oz_per_acre: Math.round(ozPerAcre * 100) / 100,
        price_per_acre: Math.round(pricePerAcre * 100) / 100,
        total_units_needed: Math.round(totalInventoryUnits * 100) / 100,
        total_price: Math.round(totalPrice * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        net_margin: Math.round(netMargin * 100 * 100) / 100, // Store as percentage (e.g. 20.00 = 20%)
      };
    },
    [products, getTierPrice, getConversionFactor]
  );

  const recalcAllForTier = (tierNum: number) => {
    setSections((prev) =>
      prev.map((sec) => ({
        ...sec,
        items: sec.items.map((item) => recalcItem(item, tierNum)),
      }))
    );
  };

  const updateItem = (
    sectionKey: string,
    itemKey: string,
    updates: Partial<LocalItem>
  ) => {
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        return {
          ...sec,
          items: sec.items.map((item) => {
            if (item._key !== itemKey) return item;
            const merged = { ...item, ...updates };
            return recalcItem(merged, tier);
          }),
        };
      })
    );
  };

  const assignProduct = (sectionKey: string, itemKey: string, product: Product) => {
    const pricePerUnit = getTierPrice(product, tier);
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        return {
          ...sec,
          items: sec.items.map((item) => {
            if (item._key !== itemKey) return item;
            const updated: LocalItem = {
              ...item,
              product_id: product.id,
              product,
              price_per_unit: pricePerUnit,
              current_cost: product.current_cost || 0,
              suggested_rate: product.suggested_rate || null,
              rate_unit: product.rate_unit || null,
              unit_size: product.inventory_unit || product.unit_size || null,
            };
            return recalcItem(updated, tier);
          }),
        };
      })
    );
    setProductSearchOpen(null);
    setProductQuery('');
  };

  const addSection = () => {
    setSections((prev) => [...prev, makeEmptySection(prev.length + 1)]);
  };

  const removeSection = (key: string) => {
    setSections((prev) => {
      const filtered = prev.filter((s) => s._key !== key);
      return filtered.map((s, i) => ({ ...s, sort_order: i + 1 }));
    });
  };

  const updateSectionName = (key: string, name: string) => {
    setSections((prev) =>
      prev.map((s) => (s._key === key ? { ...s, section_name: name } : s))
    );
  };

  const addItem = (sectionKey: string) => {
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        const newItem = makeEmptyItem();
        newItem.sort_order = sec.items.length + 1;
        return { ...sec, items: [...sec.items, newItem] };
      })
    );
  };

  const removeItem = (sectionKey: string, itemKey: string) => {
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        const filtered = sec.items.filter((i) => i._key !== itemKey);
        return {
          ...sec,
          items: filtered.map((i, idx) => ({ ...i, sort_order: idx + 1 })),
        };
      })
    );
  };

  const toggleSectionCollapse = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const totals = useMemo(() => {
    let totalPrice = 0;
    let totalCost = 0;
    let totalProfit = 0;
    sections.forEach((sec) => {
      sec.items.forEach((item) => {
        totalPrice += item.total_price;
        totalCost += item.current_cost * (item.total_units_needed || 0);
        totalProfit += item.profit;
      });
    });
    const totalMarginPct = totalPrice > 0 ? (totalProfit / totalPrice) * 100 : 0;
    return {
      totalPrice: Math.round(totalPrice * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
      totalMarginPct: Math.round(totalMarginPct * 100) / 100,
    };
  }, [sections]);

  const saveQuote = async (newStatus?: QuoteStatus): Promise<string | null> => {
    if (!customerId) {
      toast('error', 'Please select a customer');
      return null;
    }
    if (!profile) return null;

    // Validation: warn about empty sections
    const emptySections = sections.filter((sec) => sec.items.length === 0 || sec.items.every((i) => !i.product_id));
    if (emptySections.length > 0) {
      toast('error', `Section "${emptySections[0].section_name}" has no products. Add items or remove the section.`);
      return null;
    }

    // Validation: warn about items with zero quantity or price
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id) continue;
        if ((item.acres ?? 0) === 0 && (item.actual_rate ?? 0) === 0) {
          const prod = item.product || products.find((p) => p.id === item.product_id);
          toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has no rate or acres set.`);
          return null;
        }
      }
    }

    // S2-1: Validate rate_unit is set for all items with a rate
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id) continue;
        if ((item.actual_rate ?? 0) > 0 && !item.rate_unit) {
          toast('error', 'Please select a rate unit for all items with a rate');
          return null;
        }
      }
    }

    // S2-2: Validate rate and acres are both set when either is provided
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id) continue;
        const hasRate = (item.actual_rate ?? 0) > 0;
        const hasAcres = (item.acres ?? 0) > 0;
        if (hasRate && !hasAcres) {
          const prod = item.product || products.find((p) => p.id === item.product_id);
          toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has a rate but no acres. Both are required.`);
          return null;
        }
        if (hasAcres && !hasRate) {
          const prod = item.product || products.find((p) => p.id === item.product_id);
          toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has acres but no rate. Both are required.`);
          return null;
        }
      }
    }

    // S2-3: Validate commission splits sum to 100%
    if (commissionSplit.splits.length > 0) {
      const splitTotal = commissionSplit.splits.reduce((sum, s) => sum + (s.percentage || 0), 0);
      if (Math.abs(splitTotal - 100) > 0.01) {
        toast('error', `Commission splits must total 100% (currently ${splitTotal.toFixed(1)}%)`);
        return null;
      }
    }

    const quotePayload = {
      quote_number: quoteNumber,
      customer_id: customerId,
      created_by: profile.id,
      tier,
      status: newStatus || status,
      commission_split: commissionSplit,
      total_price: totals.totalPrice,
      total_cost: totals.totalCost,
      total_profit: totals.totalProfit,
      total_margin_pct: totals.totalMarginPct,
      valid_days: validDays,
      expires_at: new Date(
        Date.now() + validDays * 24 * 60 * 60 * 1000
      ).toISOString(),
      header_notes: headerNotes || null,
      footer_notes: footerNotes || null,
      ...(newStatus === 'sent' ? { sent_at: new Date().toISOString() } : {}),
    };

    // Build sections JSON for the atomic RPC
    const sectionsPayload = sections.map((sec) => ({
      section_name: sec.section_name,
      sort_order: sec.sort_order,
      section_notes: sec.section_notes || null,
      items: sec.items
        .filter((item) => item.product_id)
        .map((item) => ({
          product_id: item.product_id,
          sort_order: item.sort_order,
          notes: item.notes || null,
          price_per_unit: item.price_per_unit,
          current_cost: item.current_cost,
          suggested_rate: item.suggested_rate,
          actual_rate: item.actual_rate,
          rate_unit: item.rate_unit,
          oz_per_acre: item.oz_per_acre,
          price_per_acre: item.price_per_acre,
          acres: item.acres,
          total_units_needed: item.total_units_needed,
          unit_size: item.unit_size,
          profit: item.profit,
          total_price: item.total_price,
          net_margin: item.net_margin,
        })),
    }));

    try {
      const idemKey = generateIdempotencyKey('save_quote', profile.id);
      const { data, error } = await supabase.rpc('save_quote', {
        p_quote_id: (quoteId && isEditing) ? quoteId : null,
        p_quote_payload: quotePayload,
        p_sections: sectionsPayload,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });

      if (error) {
        toast('error', error.message || 'Failed to save quote');
        return null;
      }

      const savedQuoteId = data?.quote_id || quoteId;
      if (!quoteId || !isEditing) {
        setQuoteId(savedQuoteId);
      }
      return savedQuoteId;
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to save quote');
      return null;
    }
  };

  const handleSaveDraft = async () => {
    setSaving(true);
    const result = await saveQuote('draft');
    if (result) {
      setIsDirty(false);
      toast('success', 'Quote saved as draft');
      // === GAP FIX #5: Log activity for quote created/updated ===
      if (profile) {
        await logActivity(
          isEditing ? 'quote_updated' : 'quote_created',
          `Quote ${quoteNumber} ${isEditing ? 'updated' : 'created'} for ${selectedCustomer?.farm_name || 'customer'} (${fmt(totals.totalPrice)})`,
          profile.id,
          'quote',
          result,
          customerId
        );
      }
      if (!isEditing) navigate(`/quotes/${result}`, { replace: true });
    }
    setSaving(false);
  };

  // === GAP FIX #1: Download Quote as PDF ===
  const handleDownloadPdf = async () => {
    try {
    await downloadQuotePdf({
      quote_number: quoteNumber,
      customer_name: selectedCustomer?.farm_name || 'Customer',
      customer_email: selectedCustomer?.email || undefined,
      customer_phone: selectedCustomer?.phone || undefined,
      customer_address: selectedCustomer?.billing_address || undefined,
      sales_rep_name: profile?.full_name || 'Sales Rep',
      created_at: new Date().toISOString(),
      expires_at: undefined,
      valid_days: validDays,
      tier,
      header_notes: headerNotes || undefined,
      footer_notes: footerNotes || undefined,
      sections: sections.map((sec) => ({
        section_name: sec.section_name,
        section_notes: sec.section_notes || undefined,
        items: sec.items
          .filter((i) => i.product_id)
          .map((i) => ({
            product_name: i.product?.product_name || '',
            actual_rate: i.actual_rate || 0,
            rate_unit: i.rate_unit || '',
            acres: i.acres || 0,
            total_units_needed: i.total_units_needed || 0,
            price_per_unit: i.price_per_unit,
            total_price: i.total_price,
          })),
      })),
      totals: {
        totalPrice: totals.totalPrice,
        totalCost: totals.totalCost,
        totalProfit: totals.totalProfit,
        avgMargin: totals.totalMarginPct,
      },
    });
    toast('success', 'PDF downloaded');
    } catch (err: unknown) {
      console.error('PDF generation error:', err);
      toast('error', err instanceof Error ? err.message : 'Failed to generate PDF');
    }
  };

  const handleSendQuote = async () => {
    setSending(true);
    setConfirmSendOpen(false);
    const result = await saveQuote('sent');
    if (result) {
      // === GAP FIX #6: Create a quote version snapshot ===
      if (profile) {
        const { count } = await supabase
          .from('quote_versions')
          .select('*', { count: 'exact', head: true })
          .eq('quote_id', result);
        const versionNum = (count || 0) + 1;

        const snapshotData = {
          quote_number: quoteNumber,
          customer_id: customerId,
          customer_name: selectedCustomer?.farm_name || '',
          tier,
          valid_days: validDays,
          header_notes: headerNotes,
          footer_notes: footerNotes,
          commission_split: commissionSplit,
          totals,
          sections: sections.map((sec) => ({
            section_name: sec.section_name,
            sort_order: sec.sort_order,
            section_notes: sec.section_notes,
            items: sec.items
              .filter((i) => i.product_id)
              .map((i) => ({
                product_id: i.product_id,
                product_name: i.product?.product_name || '',
                price_per_unit: i.price_per_unit,
                current_cost: i.current_cost,
                actual_rate: i.actual_rate,
                rate_unit: i.rate_unit,
                acres: i.acres,
                total_units_needed: i.total_units_needed,
                total_price: i.total_price,
                profit: i.profit,
                net_margin: i.net_margin,
              })),
          })),
        };

        await supabase.from('quote_versions').insert({
          quote_id: result,
          version_number: versionNum,
          sent_by: profile.id,
          sent_at: new Date().toISOString(),
          sent_method: 'manual',
          snapshot_data: snapshotData,
          notes: `Version ${versionNum} sent`,
        });

        // === GAP FIX #5: Log activity for quote sent ===
        await logActivity(
          'quote_sent',
          `Quote ${quoteNumber} v${versionNum} sent to ${selectedCustomer?.farm_name || 'customer'} (${fmt(totals.totalPrice)})`,
          profile.id,
          'quote',
          result,
          customerId
        );
      }

      setStatus('sent');
      setIsDirty(false);
      toast('success', 'Quote sent successfully');
    }
    setSending(false);
  };

  const handleConvertToOrder = async () => {
    setConverting(true);
    setConfirmConvertOpen(false);

    // Save the quote first (sets status to 'accepted')
    const savedId = await saveQuote('accepted');
    if (!savedId) {
      setConverting(false);
      return;
    }

    try {
      // Atomic RPC: order creation + items + inventory prebooking + commissions
      const idemKey = generateIdempotencyKey('convert_quote_to_order', profile!.id);
      const { data, error } = await supabase.rpc('convert_quote_to_order', {
        p_quote_id: savedId,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });

      if (error) throw error;

      const result = assertRpcResult<{ status: string; order_id?: string; order_number?: string }>(data, 'convert_quote_to_order');
      toast('success', `Order ${result.order_number || ''} created`);
      notifyLargeOrder(result.order_id!, result.order_number || '', selectedCustomer?.farm_name || 'customer', totals.totalPrice);

      // Phase 3.3: Credit limit check — warn (not block) if exceeded
      if (customerId) {
        try {
          const { data: creditCheck } = await supabase.rpc('check_customer_credit_limit', {
            p_customer_id: customerId,
          });
          const cl = creditCheck as { exceeded?: boolean; farm_name?: string; outstanding_ar?: number; credit_limit?: number } | null;
          if (cl && cl.exceeded) {
            const fmtCl = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
            toast('warning', `Credit limit warning: ${selectedCustomer?.farm_name || 'Customer'} outstanding AR ${fmtCl(cl.outstanding_ar ?? 0)} exceeds limit ${fmtCl(cl.credit_limit ?? 0)}`);
            notifyCreditLimitExceeded(selectedCustomer?.farm_name || 'Customer', cl.outstanding_ar ?? 0, cl.credit_limit ?? 0, customerId);
          }
        } catch {
          // Non-blocking — credit limit check should not prevent navigation
        }
      }

      // Bug #31 fix: Clear dirty state before navigate to prevent unsaved changes dialog
      setIsDirty(false);
      navigate(`/orders/${result.order_id}`);
    } catch (error: unknown) {
      console.error('Error converting to order:', error);
      // Bug #30 fix: Extract error message from Supabase RPC error objects
      const errObj = error as Record<string, unknown> | null;
      const errMsg = (error instanceof Error ? error.message : null)
        || (errObj && typeof errObj.message === 'string' ? errObj.message : null)
        || (errObj && typeof errObj.details === 'string' ? errObj.details : null)
        || (errObj && typeof errObj.hint === 'string' ? errObj.hint : null)
        || 'Failed to create order';
      toast('error', errMsg);
      // Bug #29 fix: Revert quote status to 'sent' since conversion failed
      try {
        const revertResult = await supabase.from('quotes').update({ status: 'sent' }).eq('id', savedId).select();
        checkMutationResult(revertResult, 'Revert quote status');
        setStatus('sent');
      } catch {
        // Best effort — status revert failed
      }
    }
    setConverting(false);
  };

  const filteredProducts = useMemo(() => {
    if (!productQuery.trim()) return products;
    const q = productQuery.toLowerCase();
    return products.filter(
      (p) =>
        p.product_name.toLowerCase().includes(q) ||
        (p.sku && p.sku.toLowerCase().includes(q)) ||
        (p.category && p.category.toLowerCase().includes(q)) ||
        (p.vendor && p.vendor.toLowerCase().includes(q))
    );
  }, [products, productQuery]);

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(n);

  const pct = (n: number) => `${n.toFixed(1)}%`; // net_margin is already stored as percentage

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-10 bg-gray-200 rounded w-48" />
        <div className="h-64 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-200 rounded" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/quotes')}
            className="p-2 rounded-lg hover:bg-white hover:shadow-sm transition-all text-secondary"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-2xl font-semibold font-heading text-nav-dark">
            Quote <span className="split-heading-accent">Builder</span>
          </h1>
          {quoteNumber && (
            <span className="text-sm text-secondary font-mono">{quoteNumber}</span>
          )}
          {isEditing && (
            <Badge variant={statusToBadgeVariant[status] || 'default'}>
              {status}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            icon={<Save className="w-4 h-4" />}
            showChevron={false}
            onClick={handleSaveDraft}
            loading={saving}
          >
            Save Draft
          </Button>
          <Button
            variant="secondary"
            icon={<Download className="w-4 h-4" />}
            showChevron={false}
            onClick={handleDownloadPdf}
          >
            Download PDF
          </Button>
          <Button
            variant="primary"
            icon={<Send className="w-4 h-4" />}
            onClick={() => setConfirmSendOpen(true)}
            loading={sending}
          >
            Send Quote
          </Button>
          {isEditing && (
            <Button
              variant="primary"
              icon={<ShoppingCart className="w-4 h-4" />}
              onClick={() => setConfirmConvertOpen(true)}
              loading={converting}
            >
              Convert to Order
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader title="Quote" accent="Details" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">
              Customer
            </label>
            <select
              value={customerId}
              onChange={(e) => handleCustomerChange(e.target.value)}
              className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Select a customer...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.farm_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">
              Pricing Tier
            </label>
            <select
              value={tier}
              onChange={(e) => {
                const t = parseInt(e.target.value);
                setTier(t);
                recalcAllForTier(t);
              }}
              className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value={1}>Tier 1</option>
              <option value={2}>Tier 2</option>
              <option value={3}>Tier 3</option>
            </select>
          </div>
          <Input
            label="Valid Days"
            type="number"
            value={validDays}
            onChange={(e) => setValidDays(parseInt(e.target.value) || 15)}
            min={0}
          />
          <div className="sm:col-span-2 lg:col-span-4">
            <CommissionSplitEditor
              value={commissionSplit}
              onChange={setCommissionSplit}
            />
          </div>
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium text-secondary mb-1">
            Header Notes
          </label>
          <textarea
            value={headerNotes}
            onChange={(e) => setHeaderNotes(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            placeholder="Notes visible at the top of the quote..."
          />
        </div>
      </Card>

      {sections.map((sec) => {
        const isCollapsed = collapsedSections.has(sec._key);
        const sectionTotal = sec.items.reduce((s, i) => s + i.total_price, 0);

        return (
          <Card key={sec._key} padding={false}>
            <div className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1">
                  <button
                    onClick={() => toggleSectionCollapse(sec._key)}
                    className="p-1 rounded hover:bg-gray-100 text-secondary"
                  >
                    {isCollapsed ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronUp className="w-4 h-4" />
                    )}
                  </button>
                  <span className="text-xs font-mono text-gray-400 w-6">
                    {sec.sort_order}
                  </span>
                  <input
                    value={sec.section_name}
                    onChange={(e) => updateSectionName(sec._key, e.target.value)}
                    className="text-sm font-semibold font-heading text-nav-dark bg-transparent border-none outline-none focus:ring-0 flex-1"
                    placeholder="Section name"
                  />
                  <span className="text-sm font-mono text-secondary">
                    {fmt(sectionTotal)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Plus className="w-3 h-3" />}
                    showChevron={false}
                    onClick={() => addItem(sec._key)}
                  >
                    Add Item
                  </Button>
                  {sections.length > 1 && (
                    <button
                      onClick={() => removeSection(sec._key)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {!isCollapsed && (
              <div className="overflow-x-auto">
                {sec.items.length === 0 ? (
                  <div className="px-5 pb-5">
                    <p className="text-sm text-secondary">
                      No items in this section.{' '}
                      <button
                        onClick={() => addItem(sec._key)}
                        className="text-crx-green hover:underline font-medium"
                      >
                        Add one
                      </button>
                    </p>
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-t border-gray-100 text-left text-xs text-secondary uppercase tracking-wide">
                        <th className="px-5 py-3 font-medium w-8">#</th>
                        <th className="px-3 py-3 font-medium min-w-[200px]">Product</th>
                        <th className="px-3 py-3 font-medium">Price/Unit</th>
                        <th className="px-3 py-3 font-medium">Cost</th>
                        <th className="px-3 py-3 font-medium">Sug. Rate</th>
                        <th className="px-3 py-3 font-medium">Actual Rate</th>
                        <th className="px-3 py-3 font-medium">Unit</th>
                        <th className="px-3 py-3 font-medium">Acres</th>
                        <th className="px-3 py-3 font-medium">Oz/Acre</th>
                        <th className="px-3 py-3 font-medium">$/Acre</th>
                        <th className="px-3 py-3 font-medium">Units Needed</th>
                        <th className="px-3 py-3 font-medium">Total</th>
                        <th className="px-3 py-3 font-medium">Profit</th>
                        <th className="px-3 py-3 font-medium">Margin</th>
                        <th className="px-3 py-3 font-medium w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {sec.items.map((item) => {
                        const prod =
                          item.product ||
                          products.find((p) => p.id === item.product_id);
                        return (
                          <tr
                            key={item._key}
                            className="border-t border-gray-50 hover:bg-crx-green-tint transition-colors"
                          >
                            <td className="px-5 py-2 font-mono text-gray-400 text-xs">
                              {item.sort_order}
                            </td>
                            <td className="px-3 py-2">
                              {prod ? (
                                <button
                                  onClick={() => {
                                    setProductSearchOpen({
                                      sectionKey: sec._key,
                                      itemKey: item._key,
                                    });
                                    setProductQuery('');
                                  }}
                                  className="text-left"
                                >
                                  <p className="font-medium text-nav-dark truncate max-w-[200px]">
                                    {prod.product_name}
                                  </p>
                                  {prod.sku && (
                                    <p className="text-xs text-gray-400">
                                      {prod.sku}
                                    </p>
                                  )}
                                </button>
                              ) : (
                                <button
                                  onClick={() => {
                                    setProductSearchOpen({
                                      sectionKey: sec._key,
                                      itemKey: item._key,
                                    });
                                    setProductQuery('');
                                  }}
                                  className="text-crx-green hover:underline font-medium flex items-center gap-1"
                                >
                                  <Search className="w-3 h-3" />
                                  Select Product
                                </button>
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono">
                              {fmt(item.price_per_unit)}
                            </td>
                            <td className="px-3 py-2 font-mono text-secondary">
                              {fmt(item.current_cost)}
                            </td>
                            <td className="px-3 py-2 text-secondary">
                              {item.suggested_rate || '-'}
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                value={item.actual_rate ?? ''}
                                onChange={(e) =>
                                  updateItem(sec._key, item._key, {
                                    actual_rate: e.target.value
                                      ? parseFloat(e.target.value)
                                      : null,
                                  })
                                }
                                aria-label="Actual rate"
                                className="w-20 px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                                step="any"
                                min={0}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <select
                                value={item.rate_unit || ''}
                                onChange={(e) =>
                                  updateItem(sec._key, item._key, {
                                    rate_unit: e.target.value || null,
                                  })
                                }
                                aria-label="Rate unit"
                                className="w-20 px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                              >
                                <option value="">--</option>
                                {unitConversions
                                  .filter((uc) => {
                                    const form = prod?.product_form;
                                    if (!form) return true;
                                    return uc.unit_type === form || uc.unit_type === 'both';
                                  })
                                  .map((uc) => (
                                    <option key={uc.id} value={uc.unit}>
                                      {uc.unit}
                                    </option>
                                  ))}
                              </select>
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                value={item.acres ?? ''}
                                onChange={(e) =>
                                  updateItem(sec._key, item._key, {
                                    acres: e.target.value
                                      ? parseFloat(e.target.value)
                                      : null,
                                  })
                                }
                                aria-label="Acres"
                                className="w-20 px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                                step="any"
                                min={0}
                              />
                            </td>
                            <td className="px-3 py-2 font-mono text-secondary">
                              {item.oz_per_acre != null
                                ? item.oz_per_acre.toFixed(2)
                                : '-'}
                            </td>
                            <td className="px-3 py-2 font-mono text-secondary">
                              {item.price_per_acre != null
                                ? fmt(item.price_per_acre)
                                : '-'}
                            </td>
                            <td className="px-3 py-2 font-mono text-secondary">
                              {item.total_units_needed != null
                                ? item.total_units_needed.toFixed(2)
                                : '-'}
                            </td>
                            <td className="px-3 py-2 font-mono font-medium text-nav-dark">
                              {fmt(item.total_price)}
                            </td>
                            <td className="px-3 py-2 font-mono text-emerald-600">
                              {fmt(item.profit)}
                            </td>
                            <td className="px-3 py-2 font-mono text-secondary">
                              {pct(item.net_margin)}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                onClick={() => removeItem(sec._key, item._key)}
                                className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </Card>
        );
      })}

      <div className="flex justify-center">
        <Button
          variant="secondary"
          icon={<Plus className="w-4 h-4" />}
          showChevron={false}
          onClick={addSection}
        >
          Add Section
        </Button>
      </div>

      <Card>
        <div>
          <label className="block text-sm font-medium text-secondary mb-1">
            Footer Notes
          </label>
          <textarea
            value={footerNotes}
            onChange={(e) => setFooterNotes(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            placeholder="Notes visible at the bottom of the quote (terms, disclaimers, etc.)..."
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Quote" accent="Totals" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-secondary uppercase tracking-wide mb-1">
              Total Price
            </p>
            <p className="text-xl font-semibold font-heading text-nav-dark font-mono">
              {fmt(totals.totalPrice)}
            </p>
          </div>
          <div>
            <p className="text-xs text-secondary uppercase tracking-wide mb-1">
              Total Cost
            </p>
            <p className="text-xl font-semibold font-heading text-secondary font-mono">
              {fmt(totals.totalCost)}
            </p>
          </div>
          <div>
            <p className="text-xs text-secondary uppercase tracking-wide mb-1">
              Total Profit
            </p>
            <p className="text-xl font-semibold font-heading text-emerald-600 font-mono">
              {fmt(totals.totalProfit)}
            </p>
          </div>
          <div>
            <p className="text-xs text-secondary uppercase tracking-wide mb-1">
              Overall Margin
            </p>
            <p className="text-xl font-semibold font-heading text-crx-green font-mono">
              {totals.totalMarginPct.toFixed(1)}%
            </p>
          </div>
        </div>
      </Card>

      <Modal
        open={productSearchOpen !== null}
        onClose={() => {
          setProductSearchOpen(null);
          setProductQuery('');
        }}
        title="Select"
        accent="Product"
        maxWidth="max-w-2xl"
      >
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              placeholder="Search by name, SKU, category, or vendor..."
              autoFocus
            />
          </div>
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {filteredProducts.length === 0 ? (
              <p className="text-sm text-secondary py-4 text-center">
                No products found
              </p>
            ) : (
              filteredProducts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    if (productSearchOpen) {
                      assignProduct(
                        productSearchOpen.sectionKey,
                        productSearchOpen.itemKey,
                        p
                      );
                    }
                  }}
                  className="w-full text-left px-3 py-2.5 hover:bg-crx-green-tint transition-colors flex items-center justify-between"
                >
                  <div>
                    <p className="font-medium text-nav-dark text-sm">
                      {p.product_name}
                    </p>
                    <p className="text-xs text-gray-400">
                      {[p.sku, p.category, p.vendor].filter(Boolean).join(' / ')}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm text-nav-dark">
                      {fmt(getTierPrice(p, tier))}
                    </p>
                    <p className="text-xs text-gray-400">
                      T{tier} price
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </Modal>

      <Modal
        open={confirmSendOpen}
        onClose={() => setConfirmSendOpen(false)}
        title="Send"
        accent="Quote"
      >
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            This will mark the quote as sent and record the sent date. The customer
            ({selectedCustomer?.farm_name || 'selected customer'}) will see the quote
            with {sections.reduce((s, sec) => s + sec.items.filter((i) => i.product_id).length, 0)} line
            items totaling {fmt(totals.totalPrice)}.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              showChevron={false}
              onClick={() => setConfirmSendOpen(false)}
            >
              Cancel
            </Button>
            <Button
              icon={<Send className="w-4 h-4" />}
              onClick={handleSendQuote}
              loading={sending}
            >
              Confirm Send
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={confirmConvertOpen}
        onClose={() => setConfirmConvertOpen(false)}
        title="Convert to"
        accent="Order"
      >
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            This will accept the quote and create a new order for{' '}
            {selectedCustomer?.farm_name || 'the customer'} with all line items. The
            quote status will be updated to accepted.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              showChevron={false}
              onClick={() => setConfirmConvertOpen(false)}
            >
              Cancel
            </Button>
            <Button
              icon={<ShoppingCart className="w-4 h-4" />}
              onClick={handleConvertToOrder}
              loading={converting}
            >
              Create Order
            </Button>
          </div>
        </div>
      </Modal>

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
