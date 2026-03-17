import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Save,
  Send,
  ShoppingCart,
  Plus,
  Trash2,
  Search,
  ChevronDown,
  ChevronUp,
  Download,
  AlertTriangle,
  Pencil,
  History,
  RotateCcw,
  Eye,
  EyeOff,
  CheckCircle,
  Copy,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { supabase, assertRpcResult, checkMutationResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { logActivity } from '../lib/activityLogger';
import { notifyLargeOrder, notifyCreditLimitExceeded } from '../lib/notificationTriggers';
import { trackBusinessEvent } from '../lib/metrics';
import { localDatePlusDays } from '../lib/dateUtils';
import { downloadQuotePdf, generateQuotePdf } from '../lib/quotePdf';
import { sendEmail, pdfToBase64, buildEmailHtml } from '../lib/emailService';
import { checkRUPCompliance } from '../lib/rupCompliance';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import CommissionSplitEditor from '../components/ui/CommissionSplitEditor';
import type {
  Quote,
  QuoteSection,
  QuoteItem,
  QuoteVersion,
  QuotePdfTemplate,
  QuoteTemplate,
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
  section_header_notes: string | null;
  needed_by_date: string | null;
  items: LocalItem[];
}

type CalcMode = 'rate_acres' | 'units_direct';

interface LocalItem {
  _key: string;
  id?: string;
  product_id: string;
  sort_order: number;
  notes: string | null;
  price_per_unit: number;
  price_override: number | null;
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
  calc_mode: CalcMode;
  price_unit: string | null;
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
    price_override: null,
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
    calc_mode: 'rate_acres',
    price_unit: null,
  };
}

function makeEmptySection(order: number): LocalSection {
  return {
    _key: nextKey(),
    section_name: `Section ${order}`,
    sort_order: order,
    section_notes: null,
    section_header_notes: null,
    needed_by_date: null,
    items: [],
  };
}

export default function QuoteBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { profile } = useAuth();
  const saveQuoteIdem = useIdempotencyKey('save_quote', profile?.id || '');
  const convertQuoteIdem = useIdempotencyKey('convert_quote_to_order', profile?.id || '');
  const plannedHoldsIdem = useIdempotencyKey('create_planned_holds', profile?.id || '');
  const saveTemplateIdem = useIdempotencyKey('save_quote_template', profile?.id || '');
  const fromTemplateIdem = useIdempotencyKey('create_quote_from_template', profile?.id || '');
  const rolloverIdem = useIdempotencyKey('rollover_quote_to_season', profile?.id || '');
  const createVersionIdem = useIdempotencyKey('create_quote_version', profile?.id || '');
  const restoreVersionIdem = useIdempotencyKey('restore_quote_version', profile?.id || '');
  const isEditing = Boolean(id);

  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  const [_sending, __setSending] = useState(false);
  const [converting, setConverting] = useState(false);
  const [confirmConvertOpen, setConfirmConvertOpen] = useState(false);
  const [recentOrderWarning, setRecentOrderWarning] = useState<string | null>(null);

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
  const [isPlanned, setIsPlanned] = useState(false);
  const [wasPlanned, setWasPlanned] = useState(false);

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
  const [rupWarnings, setRupWarnings] = useState<string[]>([]);
  const [quoteVersions, setQuoteVersions] = useState<QuoteVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<QuoteVersion | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [revising, setRevising] = useState(false);
  const [customerView, setCustomerView] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewPdfUrl, setPreviewPdfUrl] = useState<string | null>(null);
  const [pdfTemplates, setPdfTemplates] = useState<QuotePdfTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [customColumns, setCustomColumns] = useState<string[] | null>(null);
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  // Quote template state
  const [quoteTemplates, setQuoteTemplates] = useState<QuoteTemplate[]>([]);
  const [showSaveTemplateModal, setShowSaveTemplateModal] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [showRolloverModal, setShowRolloverModal] = useState(false);
  const [rolloverSeason, setRolloverSeason] = useState(new Date().getFullYear() + 1);

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

  // Status-based guards
  const currentStatus = status || 'draft';
  const canEdit = ['draft', 'revised'].includes(currentStatus);
  const canSend = ['draft', 'revised'].includes(currentStatus);
  const canConvert = currentStatus === 'sent';

  // Mark dirty whenever user changes form data (after initial load)
  useEffect(() => {
    if (!initialLoadDone.current) return;
    setIsDirty(true);
  }, [customerId, tier, validDays, headerNotes, footerNotes, sections, commissionSplit]);

  // RUP compliance check when customer or products change
  useEffect(() => {
    if (!customerId) { setRupWarnings([]); return; }
    const productIds = sections.flatMap((s) => s.items.map((i) => i.product_id)).filter(Boolean);
    if (!productIds.length) { setRupWarnings([]); return; }
    let cancelled = false;
    checkRUPCompliance(customerId, productIds).then((res) => {
      if (!cancelled) {
        setRupWarnings(res.warnings);
        if (res.warnings.length > 0) {
          logActivity('rup_compliance_warning', `RUP products (${res.rupProductNames.join(', ')}) on quote for customer without valid license`, profile?.id ?? '', 'customer', customerId, customerId);
        }
      }
    });
    return () => { cancelled = true; };
  }, [customerId, sections, profile?.id]);

  const fetchReferenceData = useCallback(async () => {
    const [custRes, prodRes, convRes] = await Promise.all([
      supabase.from('customers').select('*').eq('is_active', true).order('farm_name'),
      supabase.from('products').select('*').eq('is_active', true).order('product_name'),
      supabase.from('unit_conversions').select('*'),
    ]);

    if (custRes.error) {
      Sentry.captureException(custRes.error, { tags: { source: 'fetch', page: 'quote_builder' } });
      toast('error', 'Failed to load customers.');
    }
    if (prodRes.error) {
      Sentry.captureException(prodRes.error, { tags: { source: 'fetch', page: 'quote_builder' } });
      toast('error', 'Failed to load products.');
    }
    if (convRes.error) {
      Sentry.captureException(convRes.error, { tags: { source: 'fetch', page: 'quote_builder' } });
    }

    setCustomers((custRes.data || []) as Customer[]);
    setProducts((prodRes.data || []) as Product[]);
    setUnitConversions((convRes.data || []) as UnitConversion[]);
  }, [toast]);

  const generateQuoteNumber = async () => {
    // Use server-side sequence to prevent race conditions
    const { data, error } = await supabase.rpc('generate_quote_number');
    if (error || !data) {
      // Fallback for backward compatibility
      const year = new Date().getFullYear();
      const { count, error: countError } = await supabase
        .from('quotes')
        .select('*', { count: 'exact', head: true })
        .like('quote_number', `Q-${year}-%`);
      if (countError) {
        toast('error', 'Failed to generate quote number. Please try again.');
        return;
      }
      const next = (count || 0) + 1;
      setQuoteNumber(`Q-${year}-${String(next).padStart(4, '0')}`);
    } else {
      setQuoteNumber(data as string);
    }
  };

  const fetchQuote = useCallback(async (quoteId: string) => {
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
    setIsPlanned(q.is_planned || false);
    setWasPlanned(q.is_planned || false);
    if (q.commission_split) setCommissionSplit(q.commission_split);

    const dbSections = (sectionsRes.data || []) as QuoteSection[];
    const dbItems = (itemsRes.data || []) as QuoteItem[];

    const localSections: LocalSection[] = dbSections.map((s) => ({
      _key: nextKey(),
      id: s.id,
      section_name: s.section_name,
      sort_order: s.sort_order,
      section_notes: s.section_notes,
      section_header_notes: s.section_header_notes,
      needed_by_date: s.needed_by_date || null,
      items: dbItems
        .filter((item) => item.section_id === s.id)
        .map((item) => {
          // Detect price override: if saved price differs from tier price, it was overridden
          const product = item.product as Product | undefined;
          const t1 = product?.tier1_price || 0;
          const tierPrice = q.tier === 2
            ? (product?.tier2_price || t1)
            : q.tier === 3
              ? (product?.tier3_price || t1)
              : t1;
          const savedPrice = item.price_per_unit;
          const isOverridden = product && Math.abs(savedPrice - tierPrice) > 0.001;
          return {
            _key: nextKey(),
            id: item.id,
            product_id: item.product_id,
            sort_order: item.sort_order,
            notes: item.notes,
            price_per_unit: item.price_per_unit,
            price_override: isOverridden ? savedPrice : null,
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
            calc_mode: (item.calc_mode as CalcMode) || 'rate_acres',
            price_unit: item.price_unit || null,
          };
        }),
    }));

    setSections(localSections.length > 0 ? localSections : [makeEmptySection(1)]);

    // Fetch version history for this quote
    const { data: versionsData } = await supabase
      .from('quote_versions')
      .select('*')
      .eq('quote_id', quoteId)
      .order('version_number', { ascending: false });
    setQuoteVersions((versionsData || []) as QuoteVersion[]);

    setLoading(false);
    // Allow a tick for state to settle before tracking changes
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  }, [toast, navigate]);

  useEffect(() => {
    fetchReferenceData();
    // Fetch PDF templates (non-critical, inline to avoid TDZ issue with useCallback ordering)
    supabase.from('quote_pdf_templates').select('*').order('is_default', { ascending: false })
      .then(({ data }) => {
        if (data) {
          setPdfTemplates(data as QuotePdfTemplate[]);
          const defaultTemplate = (data as QuotePdfTemplate[]).find((t) => t.is_default);
          if (defaultTemplate) setSelectedTemplateId(defaultTemplate.id);
        }
      });
    // Fetch quote templates for new quotes
    if (!id) {
      supabase.from('quote_templates').select('*').eq('is_active', true).order('template_name')
        .then(({ data }) => { if (data) setQuoteTemplates(data as QuoteTemplate[]); });
    }
    if (isEditing && id) {
      fetchQuote(id);
    } else {
      generateQuoteNumber().then(() => {
        // Allow a tick for state to settle before tracking changes
        setTimeout(() => { initialLoadDone.current = true; }, 0);
      }).catch(() => { /* non-critical: quote number defaults handled inside generateQuoteNumber */ });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fetchQuote, fetchReferenceData, isEditing]);

  // Auto-set customer from URL query param (e.g., /quotes/new?customer_id=xxx)
  useEffect(() => {
    if (!id && customers.length > 0) {
      const params = new URLSearchParams(location.search);
      const presetCustomerId = params.get('customer_id');
      if (presetCustomerId && !customerId) {
        const cust = customers.find((c) => c.id === presetCustomerId);
        if (cust) {
          setCustomerId(presetCustomerId);
          setTier(cust.assigned_tier);
          if (cust.default_commission_split) {
            setCommissionSplit(cust.default_commission_split);
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, customers.length, location.search]);

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
      // Always fall back to tier1_price (never $0) when a tier price is missing
      const t1 = product.tier1_price || 0;
      if (tierNum === 1) return t1;
      if (tierNum === 2) return product.tier2_price || t1;
      return product.tier3_price || t1;
    },
    []
  );

  const recalcItem = useCallback(
    (item: LocalItem, tierNum: number): LocalItem => {
      const product = item.product || products.find((p) => p.id === item.product_id);
      if (!product) return item;

      const tierPrice = getTierPrice(product, tierNum);
      // Use override price if set, otherwise fall back to tier price
      const pricePerUnit = item.price_override != null ? item.price_override : tierPrice;
      // Fall back to unit_size if inventory_unit is not set on the product
      const inventoryUnitFactorOz = getConversionFactor(product.inventory_unit || product.unit_size);

      if (item.calc_mode === 'units_direct') {
        // User entered total_units_needed directly — skip rate×acres computation
        const totalInventoryUnits = item.total_units_needed || 0;
        const totalPrice = pricePerUnit * totalInventoryUnits;
        const profit = (pricePerUnit - (product.current_cost || 0)) * totalInventoryUnits;
        const netMargin = totalPrice > 0 ? profit / totalPrice : 0;

        // Back-calculate oz/acre and $/acre if acres provided
        const acres = item.acres || 0;
        let ozPerAcre: number | null = item.oz_per_acre;
        let pricePerAcre: number | null = item.price_per_acre;
        if (acres > 0 && inventoryUnitFactorOz > 0) {
          const totalOz = totalInventoryUnits * inventoryUnitFactorOz;
          ozPerAcre = Math.round((totalOz / acres) * 100) / 100;
          pricePerAcre = Math.round((totalPrice / acres) * 100) / 100;
        }

        return {
          ...item,
          price_per_unit: pricePerUnit,
          current_cost: product.current_cost || 0,
          oz_per_acre: ozPerAcre,
          price_per_acre: pricePerAcre,
          total_units_needed: Math.round(totalInventoryUnits * 100) / 100,
          total_price: Math.round(totalPrice * 100) / 100,
          profit: Math.round(profit * 100) / 100,
          net_margin: Math.round(netMargin * 100 * 100) / 100,
        };
      }

      // Default: rate_acres mode
      const actualRate = item.actual_rate || 0;
      const acres = item.acres || 0;

      const rateUnitFactorOz = getConversionFactor(item.rate_unit);
      const rateInOz = actualRate * rateUnitFactorOz;
      const ozPerAcre = rateInOz;

      const totalInventoryUnits = inventoryUnitFactorOz > 0
        ? (acres * rateInOz) / inventoryUnitFactorOz
        : 0;

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
        net_margin: Math.round(netMargin * 100 * 100) / 100,
      };
    },
    [products, getTierPrice, getConversionFactor]
  );

  const recalcAllForTier = (tierNum: number) => {
    setSections((prev) =>
      prev.map((sec) => ({
        ...sec,
        items: sec.items.map((item) => recalcItem({ ...item, price_override: null }, tierNum)),
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
              notes: product.notes || '',
              price_per_unit: pricePerUnit,
              price_override: null,
              current_cost: product.current_cost || 0,
              suggested_rate: product.suggested_rate || null,
              actual_rate: product.rate_per_acre ?? item.actual_rate ?? null,
              rate_unit: product.rate_unit || null,
              unit_size: product.inventory_unit || product.unit_size || null,
              price_unit: product.inventory_unit || null,
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

  const updateSectionField = (key: string, field: keyof LocalSection, value: string | null) => {
    setSections((prev) =>
      prev.map((s) => (s._key === key ? { ...s, [field]: value } : s))
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
        // In units_direct mode, only total_units_needed is required
        if (item.calc_mode === 'units_direct') {
          if ((item.total_units_needed ?? 0) <= 0) {
            const prod = item.product || products.find((p) => p.id === item.product_id);
            toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has no units needed set.`);
            return null;
          }
          continue;
        }
        // rate_acres mode: both rate and acres are required
        if ((item.acres ?? 0) === 0 && (item.actual_rate ?? 0) === 0) {
          const prod = item.product || products.find((p) => p.id === item.product_id);
          toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has no rate or acres set.`);
          return null;
        }
      }
    }

    // S2-1: Validate rate_unit is set for all items with a rate (rate_acres mode only)
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id || item.calc_mode === 'units_direct') continue;
        if ((item.actual_rate ?? 0) > 0 && !item.rate_unit) {
          toast('error', 'Please select a rate unit for all items with a rate');
          return null;
        }
      }
    }

    // S2-2: Validate rate and acres are both set when either is provided (rate_acres mode only)
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id || item.calc_mode === 'units_direct') continue;
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
      is_planned: isPlanned,
      ...(newStatus === 'sent' ? { sent_at: new Date().toISOString() } : {}),
    };

    // Build sections JSON for the atomic RPC
    const sectionsPayload = sections.map((sec) => ({
      section_name: sec.section_name,
      sort_order: sec.sort_order,
      section_notes: sec.section_notes || null,
      section_header_notes: sec.section_header_notes || null,
      needed_by_date: sec.needed_by_date || null,
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
          calc_mode: item.calc_mode || 'rate_acres',
          price_unit: item.price_unit || null,
        })),
    }));

    try {
      const idemKey = saveQuoteIdem.getKey();
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

      saveQuoteIdem.resetKey();
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
      trackBusinessEvent(isEditing ? 'quote_updated' : 'quote_created', {
        message: `Quote ${quoteNumber} ${isEditing ? 'updated' : 'created'}`,
        data: { quoteId: result, quoteNumber, customer: selectedCustomer?.farm_name ?? '' },
      });
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
      // Planned program hold management
      if (isPlanned && profile) {
        const holdIdemKey = plannedHoldsIdem.getKey();
        const { error: holdError } = await supabase.rpc('create_planned_holds', {
          p_quote_id: result,
          p_performed_by: profile.id,
          p_idempotency_key: holdIdemKey,
        });
        if (holdError) toast('error', 'Failed to create inventory holds');
        else toast('success', 'Inventory holds created for planned program');
      } else if (!isPlanned && wasPlanned) {
        // Release holds when toggled off — zero rows is valid (no holds may exist)
        const { error: releaseError } = await supabase.from('inventory_holds')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq('source_id', result)
          .eq('is_active', true);
        if (releaseError) toast('error', 'Failed to release inventory holds: ' + releaseError.message);
        setWasPlanned(false);
      }

      if (!isEditing) navigate(`/quotes/${result}`, { replace: true });
    }
    setSaving(false);
  };

  // Save as template handler
  const handleSaveTemplate = async () => {
    if (!quoteId || !profile) return;
    const tmplIdemKey = saveTemplateIdem.getKey();
    const { error } = await supabase.rpc('save_quote_template', {
      p_quote_id: quoteId,
      p_template_name: templateName.trim(),
      p_description: templateDescription.trim() || null,
      p_performed_by: profile.id,
      p_idempotency_key: tmplIdemKey,
    });
    if (error) { toast('error', 'Failed to save template'); return; }
    toast('success', `Template "${templateName}" saved`);
    setShowSaveTemplateModal(false);
    setTemplateName('');
    setTemplateDescription('');
  };

  // Create from template handler
  const handleSelectTemplate = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const templateId = e.target.value;
    if (!templateId || !customerId || !profile) return;
    const ftIdemKey = fromTemplateIdem.getKey();
    const { data, error } = await supabase.rpc('create_quote_from_template', {
      p_template_id: templateId,
      p_customer_id: customerId,
      p_performed_by: profile.id,
      p_idempotency_key: ftIdemKey,
    });
    if (error) { toast('error', 'Failed to create from template'); return; }
    const result = data as { quote_id: string; quote_number: string };
    navigate(`/quotes/${result.quote_id}`);
  };

  // Seasonal rollover handler
  const handleRollover = async () => {
    if (!quoteId || !profile) return;
    const rollIdemKey = rolloverIdem.getKey();
    const { data, error } = await supabase.rpc('rollover_quote_to_season', {
      p_quote_id: quoteId,
      p_new_season: rolloverSeason,
      p_performed_by: profile.id,
      p_idempotency_key: rollIdemKey,
    });
    if (error) { toast('error', 'Failed to roll over quote'); return; }
    const result = data as { quote_id: string; quote_number: string; season: number };
    toast('success', `Rolled over to season ${result.season} — ${result.quote_number}`);
    navigate(`/quotes/${result.quote_id}`);
  };

  // === GAP FIX #1: Download Quote as PDF ===
  const handleDownloadPdf = async () => {
    await runCriticalAction({
      action: async () => {
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
            section_header_notes: sec.section_header_notes || undefined,
            items: sec.items
              .filter((i) => i.product_id)
              .map((i) => ({
                product_name: i.product?.product_name || '',
                category: i.product?.category || '',
                notes: i.notes || undefined,
                suggested_rate: i.product?.suggested_rate || undefined,
                actual_rate: i.actual_rate || 0,
                rate_unit: i.rate_unit || '',
                acres: i.acres || 0,
                total_units_needed: i.total_units_needed || 0,
                inventory_unit: i.product?.inventory_unit || undefined,
                unit_size: i.product?.unit_size || undefined,
                price_per_unit: i.price_per_unit,
                price_unit: i.price_unit || undefined,
                price_per_acre: i.price_per_acre || undefined,
                total_price: i.total_price,
              })),
          })),
          totals: {
            totalPrice: totals.totalPrice,
            totalCost: totals.totalCost,
            totalProfit: totals.totalProfit,
            avgMargin: totals.totalMarginPct,
          },
        }, customColumns || getTemplateColumns(selectedTemplateId));
      },
      toast,
      successMessage: 'PDF downloaded',
      sentryTag: 'download_quote_pdf',
    });
  };

  // Kept for future email integration
  const _handleSendQuote = async () => {
    __setSending(true);
    const result = await saveQuote('sent');
    if (result) {
      // Create version snapshot via RPC
      if (profile) {
        const sendVerIdemKey = createVersionIdem.getKey();
        const { data: versionData, error: versionError } = await supabase.rpc('create_quote_version', {
          p_quote_id: result,
          p_performed_by: profile.id,
          p_method: 'manual',
          p_idempotency_key: sendVerIdemKey,
        });
        if (versionError) {
          Sentry.captureException(versionError, { tags: { source: 'mutation', action: 'create_quote_version' } });
          toast('error', 'Quote sent but version snapshot failed.');
        } else {
          await logActivity(
            'quote_sent',
            `Quote ${quoteNumber} v${versionData?.version_number || '?'} sent to ${selectedCustomer?.farm_name || 'customer'} (${fmt(totals.totalPrice)})`,
            profile.id,
            'quote',
            result,
            customerId
          );
        }
      }

      setStatus('sent');
      setIsDirty(false);

      // === Email quote PDF to customer if they have an email ===
      if (selectedCustomer?.email && profile) {
        try {
          const pdfData = {
            quote_number: quoteNumber,
            customer_name: selectedCustomer.farm_name || 'Customer',
            customer_email: selectedCustomer.email || undefined,
            customer_phone: selectedCustomer.phone || undefined,
            customer_address: selectedCustomer.billing_address || undefined,
            sales_rep_name: profile.full_name || 'Sales Rep',
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
                  price_unit: i.price_unit || undefined,
                  total_price: i.total_price,
                })),
            })),
            totals: {
              totalPrice: totals.totalPrice,
              totalCost: totals.totalCost,
              totalProfit: totals.totalProfit,
              avgMargin: totals.totalMarginPct,
            },
          };
          const doc = await generateQuotePdf(pdfData, customColumns || getTemplateColumns(selectedTemplateId));
          const base64 = pdfToBase64(doc);
          const html = buildEmailHtml(`
            <h2 style="color:#1e293b;margin:0 0 12px;">Quote ${quoteNumber}</h2>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Hi${selectedCustomer.contact_name ? ` ${selectedCustomer.contact_name}` : ''},
            </p>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Please find your quote from Crop RX Solutions attached.
            </p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr>
                <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Quote Number</td>
                <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;">${quoteNumber}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Total</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;">${fmt(totals.totalPrice)}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Valid For</td>
                <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;">${validDays} days</td>
              </tr>
            </table>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              If you have any questions, please don't hesitate to reach out.
            </p>
          `);

          const emailResult = await sendEmail({
            to: selectedCustomer.email,
            subject: `Quote ${quoteNumber} from Crop RX Solutions`,
            html,
            email_type: 'quote',
            customer_id: customerId,
            idempotency_key: `quote-email-${result}-${Date.now()}`,
            attachments: [{ filename: `Quote-${quoteNumber}.pdf`, content: base64 }],
          });

          if (emailResult.success) {
            toast('success', `Quote sent and emailed to ${selectedCustomer.email}`);
          } else {
            toast('success', 'Quote sent (email delivery failed — check email log)');
          }
        } catch (emailErr) {
          console.warn('Quote email failed:', emailErr);
          toast('success', 'Quote sent (email could not be sent)');
        }
      } else {
        toast('success', 'Quote sent successfully');
      }

      // Refresh version history
      await fetchVersions();
    }
    __setSending(false);
  };

  const handleReviseQuote = async () => {
    if (!quoteId) return;
    setRevising(true);
    const savedId = await saveQuote('revised');
    if (savedId) {
      setStatus('revised');
      setIsDirty(false);
      toast('success', 'Quote is now in revised mode — you can edit and re-send.');
    }
    setRevising(false);
  };

  const handlePreviewQuote = async () => {
    await runCriticalAction({
      action: async () => {
        const pdfData = {
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
                price_unit: i.price_unit || undefined,
                total_price: i.total_price,
              })),
          })),
          totals: {
            totalPrice: totals.totalPrice,
            totalCost: totals.totalCost,
            totalProfit: totals.totalProfit,
            avgMargin: totals.totalMarginPct,
          },
        };
        const doc = await generateQuotePdf(pdfData);
        const blob = doc.output('blob');
        const url = URL.createObjectURL(blob);
        if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl);
        setPreviewPdfUrl(url);
        setShowPreviewModal(true);
      },
      toast,
      sentryTag: 'preview_quote_pdf',
    });
  };

  const handleMarkPresented = async () => {
    if (!quoteId || !profile) return;
    // Save current state first
    const savedId = await saveQuote(status === 'draft' ? 'draft' : status);
    if (!savedId) return;
    // Create version snapshot via RPC
    const presVerIdemKey = createVersionIdem.getKey();
    const { data: versionData, error } = await supabase.rpc('create_quote_version', {
      p_quote_id: savedId,
      p_performed_by: profile.id,
      p_method: 'presented',
      p_idempotency_key: presVerIdemKey,
    });
    if (error) { toast('error', 'Failed to mark as presented'); return; }
    await logActivity(
      'quote_presented',
      `Quote ${quoteNumber} V${versionData?.version_number || '?'} marked as presented to ${selectedCustomer?.farm_name || 'customer'}`,
      profile.id,
      'quote',
      savedId,
      customerId
    );
    toast('success', `Quote marked as presented (V${versionData?.version_number || '?'})`);
    setShowPreviewModal(false);
    if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl);
    setPreviewPdfUrl(null);
    setStatus('sent');
    setIsDirty(false);
    fetchVersions();
  };

  const AVAILABLE_PDF_COLUMNS = [
    { key: 'product', label: 'Product' },
    { key: 'category', label: 'Category' },
    { key: 'notes', label: 'Notes' },
    { key: 'sug_rate', label: 'Sug. Rate' },
    { key: 'actual_rate', label: 'Actual Rate' },
    { key: 'rate_unit', label: 'Unit' },
    { key: 'acres', label: 'Acres' },
    { key: 'qty', label: 'Qty' },
    { key: 'unit_size', label: 'Container' },
    { key: 'price_unit', label: 'Price/Unit' },
    { key: 'price_per_acre', label: '$/Acre' },
    { key: 'total_price', label: 'Total' },
  ] as const;

  const getTemplateColumns = (templateId: string | null): string[] => {
    const t = pdfTemplates.find((p) => p.id === templateId);
    return t ? (t.columns as string[]) : ['product', 'actual_rate', 'acres', 'qty', 'price_unit', 'total_price'];
  };

  const fetchVersions = useCallback(async () => {
    if (!quoteId) return;
    const { data } = await supabase
      .from('quote_versions')
      .select('*')
      .eq('quote_id', quoteId)
      .order('version_number', { ascending: false });
    setQuoteVersions((data || []) as QuoteVersion[]);
  }, [quoteId]);

  const handleRestoreVersion = async (versionId: string) => {
    if (!quoteId || !profile) return;
    const restoreIdemKey = restoreVersionIdem.getKey();
    const { error } = await supabase.rpc('restore_quote_version', {
      p_quote_id: quoteId,
      p_version_id: versionId,
      p_performed_by: profile.id,
      p_idempotency_key: restoreIdemKey,
    });
    if (error) { toast('error', 'Failed to restore version'); return; }
    toast('success', `Restored from V${selectedVersion?.version_number || '?'}`);
    setConfirmRestore(null);
    setSelectedVersion(null);
    // Reload quote data
    window.location.reload();
  };

  const handleConvertToOrder = async () => {
    // Duplicate order warning: check for recent orders for same customer
    if (customerId) {
      try {
        const sevenDaysAgo = localDatePlusDays(-7);
        const { data: recentOrders } = await supabase
          .from('orders')
          .select('order_number, order_date')
          .eq('customer_id', customerId)
          .gte('order_date', sevenDaysAgo)
          .order('order_date', { ascending: false })
          .limit(1);
        if (recentOrders && recentOrders.length > 0) {
          const recent = recentOrders[0];
          const daysAgo = Math.ceil((Date.now() - new Date(recent.order_date + 'T00:00:00').getTime()) / 86400000);
          setRecentOrderWarning(`This customer already has order ${recent.order_number} from ${daysAgo} day(s) ago. Convert this quote to another order?`);
          return;
        }
      } catch { /* ignore — don't block conversion if check fails */ }
    }

    executeConvertToOrder();
  };

  const executeConvertToOrder = async () => {
    setRecentOrderWarning(null);
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
      const idemKey = convertQuoteIdem.getKey();
      const { data, error } = await supabase.rpc('convert_quote_to_order', {
        p_quote_id: savedId,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });

      if (error) throw error;

      convertQuoteIdem.resetKey();
      const result = assertRpcResult<{ status: string; order_id?: string; order_number?: string; warnings?: string[] }>(data, 'convert_quote_to_order');
      toast('success', `Order ${result.order_number || ''} created`);

      // Show inventory warnings (non-blocking — order was still created)
      if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach((w) => toast('warning', `Inventory: ${w}`));
      }
      trackBusinessEvent('quote_converted_to_order', {
        message: `Quote converted → Order ${result.order_number || ''}`,
        data: { orderId: result.order_id ?? '', orderNumber: result.order_number ?? '', quoteId: savedId },
      });
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
      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'convert_quote_to_order' } });
      // Bug #30 fix: Extract error message from Supabase RPC error objects
      const errObj = error as Record<string, unknown> | null;
      const errMsg = (error instanceof Error ? error.message : null)
        || (errObj && typeof errObj.message === 'string' ? errObj.message : null)
        || (errObj && typeof errObj.details === 'string' ? errObj.details : null)
        || (errObj && typeof errObj.hint === 'string' ? errObj.hint : null)
        || 'Failed to create order';
      toast('error', errMsg);
      // Bug #29 fix: Revert quote status since conversion failed
      // Use the status BEFORE conversion (was 'accepted' from saveQuote, revert to previous)
      const revertTo = status === 'accepted' ? 'sent' : (status || 'sent');
      try {
        const revertResult = await supabase.from('quotes').update({ status: revertTo }).eq('id', savedId).select();
        checkMutationResult(revertResult, 'Revert quote status');
        setStatus(revertTo);
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
      <Breadcrumbs items={[
        { label: 'Quotes', href: '/quotes' },
        { label: isEditing ? (quoteNumber || 'Quote') : 'New Quote' },
      ]} />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
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
          <label className="flex items-center gap-2 text-sm ml-4">
            <input
              type="checkbox"
              checked={isPlanned}
              onChange={(e) => setIsPlanned(e.target.checked)}
              className="rounded border-gray-300 text-crx-green focus:ring-crx-green"
              disabled={!canEdit && isEditing}
            />
            <span className="font-medium">Planned Program</span>
          </label>
          {isPlanned && (
            <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded-full">
              Planned
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            icon={<Save className="w-4 h-4" />}
            showChevron={false}
            onClick={handleSaveDraft}
            loading={saving}
            disabled={!canEdit && isEditing}
          >
            Save Draft
          </Button>
          <button
            onClick={() => setCustomerView(!customerView)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
              customerView
                ? 'bg-crx-green text-white border-crx-green'
                : 'border-gray-200 text-secondary hover:border-crx-green hover:text-crx-green'
            }`}
          >
            {customerView ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            Customer View
          </button>
          <Button
            variant="secondary"
            icon={<Download className="w-4 h-4" />}
            showChevron={false}
            onClick={handleDownloadPdf}
          >
            Download PDF
          </Button>
          {quoteId && (
            <>
              <button
                onClick={() => setShowSaveTemplateModal(true)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                <Copy className="w-4 h-4" />
                Save as Template
              </button>
              <button
                onClick={() => setShowRolloverModal(true)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                <RotateCcw className="w-4 h-4" />
                Roll Over to New Season
              </button>
            </>
          )}
          {canSend && (
            <Button
              variant="primary"
              icon={<Eye className="w-4 h-4" />}
              onClick={handlePreviewQuote}
            >
              Preview Quote
            </Button>
          )}
          {isEditing && canConvert && (
            <Button
              variant="primary"
              icon={<ShoppingCart className="w-4 h-4" />}
              onClick={() => setConfirmConvertOpen(true)}
              loading={converting}
            >
              Convert to Order
            </Button>
          )}
          {isEditing && currentStatus === 'sent' && (
            <Button
              variant="secondary"
              icon={<Pencil className="w-4 h-4" />}
              showChevron={false}
              onClick={handleReviseQuote}
              loading={revising}
            >
              Revise Quote
            </Button>
          )}
          {isEditing && quoteVersions.length > 0 && (
            <Button
              variant="ghost"
              icon={<History className="w-4 h-4" />}
              showChevron={false}
              onClick={() => setShowVersionHistory(!showVersionHistory)}
            >
              Versions ({quoteVersions.length})
            </Button>
          )}
        </div>
      </div>

      {isEditing && !canEdit && currentStatus !== 'sent' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-sm">
          This quote is in <strong>{currentStatus}</strong> status and cannot be edited.
        </div>
      )}

      {isEditing && currentStatus === 'sent' && !canEdit && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-800 text-sm flex items-center justify-between">
          <span>This quote has been sent. Click <strong>Revise Quote</strong> to make changes, then re-send.</span>
        </div>
      )}

      {customerView && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-50 border border-crx-green/20 rounded-lg text-sm text-crx-green font-medium">
          <EyeOff className="w-4 h-4" />
          Customer View — cost, profit, and margin columns hidden
        </div>
      )}

      {showVersionHistory && quoteVersions.length > 0 && (
        <Card>
          <CardHeader title="Version" accent="History" />
          {/* Version list */}
          <div className="divide-y divide-gray-100">
            {quoteVersions.map((v) => {
              const itemCount = v.snapshot_data?.sections?.reduce(
                (sum, s) => sum + (s.items?.length || 0), 0
              ) || 0;
              const totalPrice = v.snapshot_data?.quote?.total_price || 0;
              const isSelected = selectedVersion?.id === v.id;
              return (
                <div
                  key={v.id}
                  className={`py-3 px-3 flex items-center justify-between cursor-pointer transition-colors ${isSelected ? 'bg-crx-green/10 border-l-4 border-crx-green' : 'hover:bg-gray-50'}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setSelectedVersion(isSelected ? null : v);
                    setCompareMode(false);
                    setConfirmRestore(null);
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedVersion(isSelected ? null : v); setCompareMode(false); setConfirmRestore(null); } }}
                >
                  <div>
                    <span className="font-medium text-nav-dark">v{v.version_number}</span>
                    <span className="text-secondary text-sm ml-3">
                      {new Date(v.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="text-sm text-secondary">
                    {itemCount} item{itemCount !== 1 ? 's' : ''} &middot;{' '}
                    {fmt(totalPrice)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected version details */}
          {selectedVersion && !compareMode && (
            <div className="border-t border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-nav-dark">V{selectedVersion.version_number} Snapshot</h4>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Eye className="w-3.5 h-3.5" />}
                    showChevron={false}
                    onClick={() => setCompareMode(true)}
                  >
                    Compare
                  </Button>
                  {canEdit && (
                    <>
                      {confirmRestore === selectedVersion.id ? (
                        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1">
                          <span className="text-sm text-amber-800">Restore V{selectedVersion.version_number}?</span>
                          <Button
                            size="sm"
                            icon={<CheckCircle className="w-3.5 h-3.5" />}
                            showChevron={false}
                            onClick={() => handleRestoreVersion(selectedVersion.id)}
                          >
                            Yes
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            showChevron={false}
                            onClick={() => setConfirmRestore(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<RotateCcw className="w-3.5 h-3.5" />}
                          showChevron={false}
                          onClick={() => setConfirmRestore(selectedVersion.id)}
                        >
                          Restore
                        </Button>
                      )}
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    showChevron={false}
                    onClick={() => { setSelectedVersion(null); setConfirmRestore(null); }}
                  >
                    Close
                  </Button>
                </div>
              </div>
              <div className="text-sm text-secondary mb-3">
                Total: {fmt(selectedVersion.snapshot_data?.quote?.total_price || 0)}
                {' '}&middot;{' '}
                Margin: {(selectedVersion.snapshot_data?.quote?.total_margin_pct || 0).toFixed(1)}%
              </div>
              {selectedVersion.snapshot_data?.sections?.map((sec, si) => (
                <div key={si} className="mb-3">
                  <div className="flex items-center gap-2">
                    <h5 className="text-sm font-medium text-nav-dark mb-1">{sec.section_name}</h5>
                    {sec.needed_by_date && <span className="text-xs text-amber-600 mb-1">Needed by: {sec.needed_by_date}</span>}
                  </div>
                  {sec.section_header_notes && <p className="text-xs text-secondary italic mb-1">{sec.section_header_notes}</p>}
                  {sec.section_notes && <p className="text-xs text-secondary mb-1">{sec.section_notes}</p>}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-200 text-secondary">
                          <th className="text-left py-1 pr-2">Product</th>
                          <th className="text-right py-1 px-2">Rate</th>
                          <th className="text-right py-1 px-2">Acres</th>
                          <th className="text-right py-1 px-2">Units</th>
                          <th className="text-right py-1 px-2">Price/Unit</th>
                          <th className="text-right py-1 pl-2">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sec.items?.map((item, ii) => (
                          <tr key={ii} className="border-b border-gray-100">
                            <td className="py-1 pr-2 text-nav-dark">{item.product_name}</td>
                            <td className="py-1 px-2 text-right text-secondary">
                              {item.actual_rate ? `${item.actual_rate} ${item.rate_unit || ''}` : '-'}
                            </td>
                            <td className="py-1 px-2 text-right text-secondary">{item.acres ?? '-'}</td>
                            <td className="py-1 px-2 text-right text-secondary">{item.total_units_needed ?? '-'}</td>
                            <td className="py-1 px-2 text-right text-secondary">{fmt(item.price_per_unit)}</td>
                            <td className="py-1 pl-2 text-right font-medium text-nav-dark">{fmt(item.total_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Compare mode: show differences between selected version and current quote */}
          {selectedVersion && compareMode && (
            <div className="border-t border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-nav-dark">
                  Comparing V{selectedVersion.version_number} vs Current
                </h4>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<EyeOff className="w-3.5 h-3.5" />}
                    showChevron={false}
                    onClick={() => setCompareMode(false)}
                  >
                    Exit Compare
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    showChevron={false}
                    onClick={() => { setSelectedVersion(null); setCompareMode(false); setConfirmRestore(null); }}
                  >
                    Close
                  </Button>
                </div>
              </div>
              {/* Price comparison summary */}
              {(() => {
                const vTotal = selectedVersion.snapshot_data?.quote?.total_price || 0;
                const cTotal = totals.totalPrice;
                const diff = cTotal - vTotal;
                return (
                  <div className={`rounded-lg p-3 mb-3 text-sm ${diff > 0 ? 'bg-green-50 text-green-800' : diff < 0 ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-secondary'}`}>
                    V{selectedVersion.version_number} Total: {fmt(vTotal)} &rarr; Current: {fmt(cTotal)}
                    {diff !== 0 && (
                      <span className="ml-2 font-medium">
                        ({diff > 0 ? '+' : ''}{fmt(diff)})
                      </span>
                    )}
                  </div>
                );
              })()}
              {/* Item-level comparison */}
              {(() => {
                const versionItems = (selectedVersion.snapshot_data?.sections || []).flatMap(
                  s => (s.items || []).map(i => ({ ...i, section: s.section_name }))
                );
                const currentItems = sections.flatMap(
                  s => s.items.filter(i => i.product_id).map(i => ({
                    product_id: i.product_id,
                    product_name: i.product?.product_name || '',
                    price_per_unit: i.price_per_unit,
                    total_price: i.total_price,
                    total_units_needed: i.total_units_needed,
                    section: s.section_name,
                  }))
                );
                const vMap = new Map(versionItems.map(i => [i.product_id, i]));
                const cMap = new Map(currentItems.map(i => [i.product_id, i]));
                const allProductIds = new Set([...vMap.keys(), ...cMap.keys()]);

                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-200 text-secondary">
                          <th className="text-left py-1 pr-2">Product</th>
                          <th className="text-right py-1 px-2">V{selectedVersion.version_number} Price</th>
                          <th className="text-right py-1 px-2">Current Price</th>
                          <th className="text-right py-1 px-2">V{selectedVersion.version_number} Total</th>
                          <th className="text-right py-1 pl-2">Current Total</th>
                          <th className="text-right py-1 pl-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from(allProductIds).map((pid) => {
                          const vItem = vMap.get(pid);
                          const cItem = cMap.get(pid);
                          const isAdded = !vItem && cItem;
                          const isRemoved = vItem && !cItem;
                          const priceChanged = vItem && cItem && Math.abs(vItem.price_per_unit - cItem.price_per_unit) > 0.001;
                          const bgClass = isAdded ? 'bg-green-50' : isRemoved ? 'bg-red-50' : priceChanged ? 'bg-amber-50' : '';
                          return (
                            <tr key={pid} className={`border-b border-gray-100 ${bgClass}`}>
                              <td className="py-1 pr-2 text-nav-dark">{vItem?.product_name || cItem?.product_name || ''}</td>
                              <td className="py-1 px-2 text-right text-secondary">{vItem ? fmt(vItem.price_per_unit) : '-'}</td>
                              <td className="py-1 px-2 text-right text-secondary">{cItem ? fmt(cItem.price_per_unit) : '-'}</td>
                              <td className="py-1 px-2 text-right text-secondary">{vItem ? fmt(vItem.total_price) : '-'}</td>
                              <td className="py-1 pl-2 text-right text-secondary">{cItem ? fmt(cItem.total_price) : '-'}</td>
                              <td className="py-1 pl-2 text-right">
                                {isAdded && <Badge variant="success">Added</Badge>}
                                {isRemoved && <Badge variant="error">Removed</Badge>}
                                {priceChanged && <Badge variant="warning">Changed</Badge>}
                                {!isAdded && !isRemoved && !priceChanged && <span className="text-secondary">-</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          )}
        </Card>
      )}

      {!id && quoteTemplates.length > 0 && (
        <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
          <label className="text-sm font-medium">Start from Template:</label>
          <select
            onChange={handleSelectTemplate}
            defaultValue=""
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5"
          >
            <option value="">Blank Quote</option>
            {quoteTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.template_name}</option>
            ))}
          </select>
          {!customerId && (
            <span className="text-xs text-secondary">Select a customer first to use a template</span>
          )}
        </div>
      )}

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

      {rupWarnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              {rupWarnings.map((w, i) => <p key={i}>{w}</p>)}
            </div>
          </div>
        </div>
      )}

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
                  {isPlanned && (
                    <div className="flex items-center gap-2 ml-2">
                      <label className="text-xs text-secondary whitespace-nowrap">Needed By:</label>
                      <input
                        type="date"
                        value={sec.needed_by_date || ''}
                        onChange={(e) => updateSectionField(sec._key, 'needed_by_date', e.target.value || null)}
                        className="text-sm border border-gray-200 rounded px-2 py-1"
                      />
                    </div>
                  )}
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
              <>
              {/* Section Header Notes — above items table */}
              <div className="px-5 pb-2">
                <textarea
                  value={sec.section_header_notes || ''}
                  onChange={(e) => updateSectionField(sec._key, 'section_header_notes', e.target.value || null)}
                  rows={2}
                  placeholder="Section notes for grower (shown above products on PDF)..."
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
                />
              </div>
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
                        {!customerView && <th className="px-3 py-3 font-medium">Cost</th>}
                        <th className="px-3 py-3 font-medium">Sug. Rate</th>
                        <th className="px-3 py-3 font-medium">Actual Rate</th>
                        <th className="px-3 py-3 font-medium">Unit</th>
                        <th className="px-3 py-3 font-medium">Acres</th>
                        <th className="px-3 py-3 font-medium">Oz/Acre</th>
                        <th className="px-3 py-3 font-medium">$/Acre</th>
                        <th className="px-3 py-3 font-medium">Units Needed</th>
                        <th className="px-3 py-3 font-medium">Total</th>
                        <th className="px-3 py-3 font-medium min-w-[140px]">Notes</th>
                        {!customerView && <th className="px-3 py-3 font-medium">Profit</th>}
                        {!customerView && <th className="px-3 py-3 font-medium">Margin</th>}
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
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  value={item.price_per_unit || ''}
                                  onChange={(e) => {
                                    const val = e.target.value ? parseFloat(e.target.value) : 0;
                                    const tierPrice = prod ? getTierPrice(prod, tier) : 0;
                                    const isOverride = Math.abs(val - tierPrice) > 0.001;
                                    updateItem(sec._key, item._key, {
                                      price_override: isOverride ? val : null,
                                      price_per_unit: val,
                                    });
                                  }}
                                  aria-label="Price per unit"
                                  className={`w-20 px-2 py-1 text-sm font-mono border rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green ${
                                    item.price_override != null
                                      ? 'border-amber-400 bg-amber-50'
                                      : 'border-gray-200'
                                  }`}
                                  step="any"
                                  min={0}
                                />
                                {item.price_override != null && (
                                  <button
                                    onClick={() =>
                                      updateItem(sec._key, item._key, {
                                        price_override: null,
                                      })
                                    }
                                    title={`Reset to tier ${tier} price: ${fmt(prod ? getTierPrice(prod, tier) : 0)}`}
                                    className="p-0.5 rounded text-amber-500 hover:text-amber-700 hover:bg-amber-100 transition-colors"
                                  >
                                    <RotateCcw className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                              <select
                                value={item.price_unit || ''}
                                onChange={(e) =>
                                  updateItem(sec._key, item._key, {
                                    price_unit: e.target.value || null,
                                  })
                                }
                                aria-label="Price unit"
                                className="w-20 px-1 py-0.5 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green mt-0.5"
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
                                      per {uc.unit}
                                    </option>
                                  ))}
                              </select>
                            </td>
                            {!customerView && (
                              <td className="px-3 py-2 font-mono text-secondary">
                                {fmt(item.current_cost)}
                              </td>
                            )}
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
                                    calc_mode: 'rate_acres',
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
                                    calc_mode: item.calc_mode === 'units_direct'
                                      ? 'units_direct' // keep units_direct if typing acres alongside units
                                      : 'rate_acres',
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
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                value={item.total_units_needed ?? ''}
                                onChange={(e) =>
                                  updateItem(sec._key, item._key, {
                                    total_units_needed: e.target.value
                                      ? parseFloat(e.target.value)
                                      : null,
                                    calc_mode: 'units_direct',
                                  })
                                }
                                aria-label="Units needed"
                                className={`w-20 px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green font-mono ${
                                  item.calc_mode === 'units_direct'
                                    ? 'border-crx-green bg-crx-green-tint'
                                    : 'border-gray-200'
                                }`}
                                step="any"
                                min={0}
                              />
                            </td>
                            <td className="px-3 py-2 font-mono font-medium text-nav-dark">
                              {fmt(item.total_price)}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1">
                                <textarea
                                  value={item.notes || ''}
                                  onChange={(e) => updateItem(sec._key, item._key, { notes: e.target.value || null })}
                                  rows={1}
                                  placeholder="Product notes..."
                                  className="w-full text-xs border border-gray-200 rounded px-2 py-1 focus:ring-1 focus:ring-crx-green/20 resize-none"
                                />
                                {prod?.notes && item.notes !== prod.notes && (
                                  <button
                                    onClick={() => updateItem(sec._key, item._key, { notes: prod?.notes || '' })}
                                    title="Reset to default"
                                    className="text-xs text-crx-green hover:underline whitespace-nowrap"
                                  >
                                    Reset
                                  </button>
                                )}
                              </div>
                            </td>
                            {!customerView && (
                              <td className="px-3 py-2 font-mono text-emerald-600">
                                {fmt(item.profit)}
                              </td>
                            )}
                            {!customerView && (
                              <td className="px-3 py-2 font-mono text-secondary">
                                {pct(item.net_margin)}
                              </td>
                            )}
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
              </>
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
        <div className={`grid grid-cols-2 ${customerView ? 'sm:grid-cols-1' : 'sm:grid-cols-4'} gap-4`}>
          <div>
            <p className="text-xs text-secondary uppercase tracking-wide mb-1">
              Total Price
            </p>
            <p className="text-xl font-semibold font-heading text-nav-dark font-mono">
              {fmt(totals.totalPrice)}
            </p>
          </div>
          {!customerView && (
            <div>
              <p className="text-xs text-secondary uppercase tracking-wide mb-1">
                Total Cost
              </p>
              <p className="text-xl font-semibold font-heading text-secondary font-mono">
                {fmt(totals.totalCost)}
              </p>
            </div>
          )}
          {!customerView && (
            <div>
              <p className="text-xs text-secondary uppercase tracking-wide mb-1">
                Total Profit
              </p>
              <p className="text-xl font-semibold font-heading text-emerald-600 font-mono">
                {fmt(totals.totalProfit)}
              </p>
            </div>
          )}
          {!customerView && (
            <div>
              <p className="text-xs text-secondary uppercase tracking-wide mb-1">
                Overall Margin
              </p>
              <p className="text-xl font-semibold font-heading text-crx-green font-mono">
                {totals.totalMarginPct.toFixed(1)}%
              </p>
            </div>
          )}
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

      {/* Recent order duplicate warning */}
      <ConfirmModal
        open={!!recentOrderWarning}
        onClose={() => setRecentOrderWarning(null)}
        onConfirm={executeConvertToOrder}
        title="Duplicate Order Warning"
        message={recentOrderWarning || ''}
        confirmLabel="Convert Anyway"
        variant="warning"
        loading={converting}
      />

      <Modal
        open={showPreviewModal}
        onClose={() => { setShowPreviewModal(false); if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl); }}
        title="Quote"
        accent="Preview"
      >
        {/* PDF Column Template Picker */}
        <div className="flex items-center gap-3 mb-3">
          <select
            value={selectedTemplateId || ''}
            onChange={(e) => { setSelectedTemplateId(e.target.value); setCustomColumns(null); }}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5"
          >
            {pdfTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.template_name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowColumnPicker(!showColumnPicker)}
            className="text-sm text-crx-green hover:underline"
          >
            {showColumnPicker ? 'Hide Columns' : 'Customize Columns'}
          </button>
        </div>
        {showColumnPicker && (
          <div className="flex flex-wrap gap-2 mb-3 p-3 bg-gray-50 rounded-lg">
            {AVAILABLE_PDF_COLUMNS.map((col) => {
              const activeColumns = customColumns || getTemplateColumns(selectedTemplateId);
              const isActive = activeColumns.includes(col.key);
              return (
                <label key={col.key} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={() => {
                      const cols = [...activeColumns];
                      if (isActive) cols.splice(cols.indexOf(col.key), 1);
                      else cols.push(col.key);
                      setCustomColumns(cols);
                    }}
                  />
                  {col.label}
                </label>
              );
            })}
          </div>
        )}
        <div className="h-[60vh]">
          <iframe src={previewPdfUrl || ''} className="w-full h-full border rounded-lg" title="Quote PDF Preview" />
        </div>
        <div className="flex justify-end gap-3 mt-4 pt-4 border-t">
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
            icon={<CheckCircle className="w-4 h-4" />}
            onClick={handleMarkPresented}
            disabled={status !== 'draft' && status !== 'revised'}
          >
            Mark as Presented
          </Button>
          <button
            disabled
            title="Coming Soon"
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-400 rounded-lg cursor-not-allowed text-sm"
          >
            <Send className="w-4 h-4" />
            Email to Grower
          </button>
        </div>
      </Modal>

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />

      {showSaveTemplateModal && (
        <Modal open={showSaveTemplateModal} onClose={() => setShowSaveTemplateModal(false)} title="Save as Template">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Template Name</label>
              <input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g., 2026 Soybean Program"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description (optional)</label>
              <textarea
                value={templateDescription}
                onChange={(e) => setTemplateDescription(e.target.value)}
                placeholder="When to use this template..."
                rows={2}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowSaveTemplateModal(false)}
                className="px-4 py-2 text-sm border rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveTemplate}
                disabled={!templateName.trim()}
                className="px-4 py-2 text-sm bg-crx-green text-white rounded-lg disabled:opacity-50"
              >
                Save Template
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showRolloverModal && (
        <Modal open={showRolloverModal} onClose={() => setShowRolloverModal(false)} title="Roll Over to New Season">
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              Creates a new draft quote with the same products and program structure,
              but with updated pricing from current product prices.
              Need dates will be reset.
            </p>
            <div>
              <label className="block text-sm font-medium mb-1">Target Season</label>
              <input
                type="number"
                value={rolloverSeason}
                onChange={(e) => setRolloverSeason(parseInt(e.target.value))}
                className="w-32 px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowRolloverModal(false)}
                className="px-4 py-2 text-sm border rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleRollover}
                className="px-4 py-2 text-sm bg-crx-green text-white rounded-lg"
              >
                Roll Over
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
