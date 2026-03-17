/**
 * ARaging.tsx — AR Aging Report & Customer Statements
 *
 * Uses the get_ar_aging() and get_customer_statement() RPCs
 * to show aging buckets and generate printable customer statements.
 */
import { useEffect, useState , useCallback } from 'react';
import { DollarSign, FileText, Printer, TrendingDown, TrendingUp, ArrowLeft, Zap, FileStack, Mail, Send } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { supabase, checkMutationResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { exportToCSV, fmtCSV } from '../lib/csvExport';
import { downloadStatementPdf, downloadBatchStatements, generateStatementPdf } from '../lib/statementPdf';
import { sendEmail, pdfToBase64, buildEmailHtml } from '../lib/emailService';
import { logActivity } from '../lib/activityLogger';
import ConfirmModal from '../components/ui/ConfirmModal';
import StatementPrintDialog from '../components/statements/StatementPrintDialog';
import FinanceChargePreviewModal from '../components/invoices/FinanceChargePreviewModal';
import { useAuth } from '../contexts/AuthContext';
import { computeSeason } from '../utils/season';
import { localToday, parseLocalDate, localDatePlusDays } from '../lib/dateUtils';
import { SkeletonTable, SkeletonCard } from '../components/ui/Skeleton';
import type { ARAgingRow, CustomerStatementRow, SeasonComparisonRow, DetailedStatementData, StatementOptions } from '../types';

type TabKey = 'aging' | 'statement' | 'season';

export default function ARaging() {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [tab, setTab] = useState<TabKey>('aging');
  const [loading, setLoading] = useState(true);
  const [showFinanceChargePreview, setShowFinanceChargePreview] = useState(false);
  const [showStatementDialog, setShowStatementDialog] = useState(false);
  const [printingStatement, setPrintingStatement] = useState(false);
  const [printCustomerId, setPrintCustomerId] = useState<string | null>(null);
  const [printCustomerName, setPrintCustomerName] = useState('');

  // Batch statement selection
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(new Set());
  const [showBatchStatementDialog, setShowBatchStatementDialog] = useState(false);
  const [batchPrinting, setBatchPrinting] = useState(false);

  // AR Reminder emails
  const [sendingReminders, setSendingReminders] = useState(false);
  // Batch email statements
  const [emailingStatements, setEmailingStatements] = useState(false);

  // Confirm modals
  const [showARReminderConfirm, setShowARReminderConfirm] = useState(false);
  const [showEmailStatementsConfirm, setShowEmailStatementsConfirm] = useState(false);

  // Aging
  const [agingData, setAgingData] = useState<ARAgingRow[]>([]);
  const [asOfDate, setAsOfDate] = useState(localToday());

  // Statement
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState('');
  const [stmtStart, setStmtStart] = useState(() => localDatePlusDays(-90));
  const [stmtEnd, setStmtEnd] = useState(localToday());
  const [statementData, setStatementData] = useState<CustomerStatementRow[]>([]);
  const [stmtCustomerName, setStmtCustomerName] = useState('');

  // Season Comparison
  const currentSeason = computeSeason();
  const [seasonA, setSeasonA] = useState(currentSeason);
  const [seasonB, setSeasonB] = useState(currentSeason - 1);
  const [seasonData, setSeasonData] = useState<SeasonComparisonRow[]>([]);

  const fetchCustomers = async () => {
    const { data, error } = await supabase
      .from('customers')
      .select('id, farm_name')
      .order('farm_name');
    if (error) {
      toast('error', 'Failed to load customers: ' + error.message);
      return;
    }
    setCustomers(data || []);
  };

  const fetchAging = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_ar_aging', {
      p_as_of_date: asOfDate,
    });
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'ar_aging' } });
      toast('error', 'Failed to load AR aging data');
      setLoading(false);
      return;
    }
    setAgingData((data || []) as ARAgingRow[]);
    setLoading(false);
  }, [asOfDate, toast]);

  const fetchSeasonComparison = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_season_comparison', {
      p_season_a: seasonA,
      p_season_b: seasonB,
    });
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'ar_aging' } });
      toast('error', 'Failed to load season comparison');
      setLoading(false);
      return;
    }
    setSeasonData((data || []) as SeasonComparisonRow[]);
    setLoading(false);
  }, [seasonA, seasonB, toast]);

  useEffect(() => {
    fetchCustomers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === 'aging') fetchAging();
    if (tab === 'season') fetchSeasonComparison();
  }, [tab, asOfDate, seasonA, seasonB, fetchAging, fetchSeasonComparison]);

  const fetchStatement = async () => {
    if (!selectedCustomer) {
      toast('error', 'Select a customer first');
      return;
    }
    setLoading(true);
    const cust = customers.find((c) => c.id === selectedCustomer);
    setStmtCustomerName(cust?.farm_name || 'Customer');

    const { data, error } = await supabase.rpc('get_customer_statement', {
      p_customer_id: selectedCustomer,
      p_start_date: stmtStart,
      p_end_date: stmtEnd,
    });
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'ar_aging' } });
      toast('error', 'Failed to load customer statement');
      setLoading(false);
      return;
    }
    setStatementData((data || []) as CustomerStatementRow[]);
    setTab('statement');
    setLoading(false);
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const fmtCents = (cents: number) => fmt(cents / 100);

  // Totals for aging
  const agingTotals = agingData.reduce(
    (acc, r) => ({
      current: acc.current + r.current_amount,
      d30: acc.d30 + r.days_30,
      d60: acc.d60 + r.days_60,
      d90: acc.d90 + r.days_90,
      over90: acc.over90 + r.over_90,
      total: acc.total + r.total_outstanding,
    }),
    { current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 }
  );

  const agingColumns: Column<ARAgingRow>[] = [
    {
      key: 'customer_id' as keyof ARAgingRow,
      header: '',
      className: 'w-10',
      render: (r) => (
        <input
          type="checkbox"
          checked={selectedCustomers.has(r.customer_id)}
          onChange={(e) => {
            e.stopPropagation();
            toggleCustomerSelect(r.customer_id);
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
        />
      ),
    },
    {
      key: 'farm_name',
      header: 'Customer',
      sortable: true,
      render: (r) => (
        <button
          className="font-medium text-crx-green hover:underline text-left"
          onClick={(e) => {
            e.stopPropagation();
            setSelectedCustomer(r.customer_id);
            fetchStatementForCustomer(r.customer_id, r.farm_name);
          }}
        >
          {r.farm_name}
        </button>
      ),
    },
    {
      key: 'current_amount',
      header: 'Current',
      sortable: true,
      render: (r) => <span className="font-mono">{fmt(r.current_amount)}</span>,
    },
    {
      key: 'days_30',
      header: '30 Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.days_30 > 0 ? 'text-yellow-600' : ''}`}>
          {fmt(r.days_30)}
        </span>
      ),
    },
    {
      key: 'days_60',
      header: '60 Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.days_60 > 0 ? 'text-orange-600' : ''}`}>
          {fmt(r.days_60)}
        </span>
      ),
    },
    {
      key: 'days_90',
      header: '90 Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.days_90 > 0 ? 'text-red-500' : ''}`}>
          {fmt(r.days_90)}
        </span>
      ),
    },
    {
      key: 'over_90',
      header: '120+ Days',
      sortable: true,
      render: (r) => (
        <span className={`font-mono ${r.over_90 > 0 ? 'text-red-700 font-semibold' : ''}`}>
          {fmt(r.over_90)}
        </span>
      ),
    },
    {
      key: 'total_outstanding',
      header: 'Total',
      sortable: true,
      render: (r) => <span className="font-mono font-semibold">{fmt(r.total_outstanding)}</span>,
    },
    {
      key: 'invoice_count' as keyof ARAgingRow,
      header: '',
      render: (r) => (
        <button
          className="text-crx-green hover:text-crx-green/70 p-1"
          title="Print Statement"
          onClick={(e) => {
            e.stopPropagation();
            openStatementDialog(r.customer_id, r.farm_name);
          }}
        >
          <Printer className="w-4 h-4" />
        </button>
      ),
    },
  ];

  const stmtColumns: Column<CustomerStatementRow>[] = [
    {
      key: 'transaction_date',
      header: 'Date',
      render: (r) => parseLocalDate(r.transaction_date).toLocaleDateString(),
    },
    {
      key: 'transaction_type',
      header: 'Type',
      render: (r) => (
        <Badge
          variant={
            r.transaction_type === 'invoice'
              ? 'default'
              : r.transaction_type === 'payment'
                ? 'success'
                : 'info'
          }
        >
          {r.transaction_type}
        </Badge>
      ),
    },
    { key: 'reference_number', header: 'Ref #', render: (r) => r.reference_number || '-' },
    { key: 'description', header: 'Description' },
    {
      key: 'amount_cents',
      header: 'Amount',
      render: (r) => (
        <span className={`font-mono ${r.amount_cents < 0 ? 'text-crx-green' : 'text-nav-dark'}`}>
          {r.amount_cents < 0 ? '(' + fmtCents(Math.abs(r.amount_cents)) + ')' : fmtCents(r.amount_cents)}
        </span>
      ),
    },
    {
      key: 'running_balance',
      header: 'Balance',
      render: (r) => <span className="font-mono font-semibold">{fmtCents(r.running_balance)}</span>,
    },
  ];

  const seasonColumns: Column<SeasonComparisonRow>[] = [
    { key: 'metric', header: 'Metric', render: (r) => <span className="font-medium">{r.metric}</span> },
    {
      key: 'season_a_val',
      header: `Season ${seasonA}`,
      render: (r) => (
        <span className="font-mono">
          {r.metric === 'Revenue' || r.metric === 'Profit' ? fmt(r.season_a_val) : r.season_a_val.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'season_b_val',
      header: `Season ${seasonB}`,
      render: (r) => (
        <span className="font-mono">
          {r.metric === 'Revenue' || r.metric === 'Profit' ? fmt(r.season_b_val) : r.season_b_val.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'change_pct',
      header: 'Change',
      render: (r) =>
        r.change_pct !== null ? (
          <span className={`flex items-center gap-1 font-semibold ${r.change_pct >= 0 ? 'text-crx-green' : 'text-red-600'}`}>
            {r.change_pct >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            {r.change_pct >= 0 ? '+' : ''}{r.change_pct}%
          </span>
        ) : (
          <span className="text-secondary">N/A</span>
        ),
    },
  ];

  const fetchStatementForCustomer = async (custId: string, custName: string) => {
    setLoading(true);
    setStmtCustomerName(custName);
    setSelectedCustomer(custId);
    const { data, error } = await supabase.rpc('get_customer_statement', {
      p_customer_id: custId,
      p_start_date: stmtStart,
      p_end_date: stmtEnd,
    });
    if (error) {
      toast('error', 'Failed to load statement');
    }
    setStatementData((data || []) as CustomerStatementRow[]);
    setTab('statement');
    setLoading(false);
  };

  const handleFinanceChargeSuccess = () => {
    fetchAging();
  };

  const openStatementDialog = (custId: string, custName: string) => {
    setPrintCustomerId(custId);
    setPrintCustomerName(custName);
    setShowStatementDialog(true);
  };

  const handlePrintStatement = async (options: StatementOptions) => {
    if (!printCustomerId) return;
    setShowStatementDialog(false);
    await runCriticalAction({
      action: async () => {
        const { data, error } = await supabase.rpc('get_detailed_statement_data', {
          p_customer_id: printCustomerId,
          p_as_of_date: options.as_of_date,
          p_mode: options.mode,
        });
        if (error) throw error;

        const stmtData = data as DetailedStatementData;
        if (!stmtData || !stmtData.transactions || stmtData.transactions.length === 0) {
          toast('info', `No outstanding balance for ${printCustomerName}`);
          return;
        }

        await downloadStatementPdf(stmtData, options);
      },
      toast,
      successMessage: `Statement downloaded for ${printCustomerName}`,
      setLoading: setPrintingStatement,
      sentryTag: 'print_statement',
    });
  };

  // Batch statement selection helpers
  const toggleCustomerSelect = (id: string) => {
    setSelectedCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllCustomers = () => {
    if (selectedCustomers.size === agingData.length && agingData.length > 0) {
      setSelectedCustomers(new Set());
    } else {
      setSelectedCustomers(new Set(agingData.map((r) => r.customer_id)));
    }
  };

  const handleBatchStatements = async (options: StatementOptions) => {
    setShowBatchStatementDialog(false);
    await runCriticalAction({
      action: async () => {
        const stmtDataList: DetailedStatementData[] = [];
        for (const custId of selectedCustomers) {
          const { data, error } = await supabase.rpc('get_detailed_statement_data', {
            p_customer_id: custId,
            p_as_of_date: options.as_of_date,
            p_mode: options.mode,
          });
          if (error) {
            Sentry.captureException(error, { tags: { source: 'batch_statement', customer_id: custId } });
            continue;
          }
          const stmtData = data as DetailedStatementData;
          if (stmtData && stmtData.transactions && stmtData.transactions.length > 0) {
            stmtDataList.push(stmtData);
          }
        }

        if (stmtDataList.length === 0) {
          toast('info', 'No customers had outstanding balances for statements');
          return;
        }

        await downloadBatchStatements(stmtDataList, options);
      },
      toast,
      successMessage: 'Downloaded batch statement(s)',
      setLoading: setBatchPrinting,
      sentryTag: 'batch_print_statements',
    });
  };

  // === A5: Send AR Reminders to all overdue customers ===
  const handleSendARReminders = async () => {
    if (!profile) return;
    setShowARReminderConfirm(false);
    await runCriticalAction({
      action: async () => {
        const { data, error } = await supabase.rpc('get_ar_reminder_candidates');
        if (error) throw error;

        const candidates = (data || []) as Array<{
          customer_id: string;
          farm_name: string;
          email: string;
          total_balance_cents: number;
          max_days_past_due: number;
          invoices: Array<{ invoice_number: string; balance_cents: number; days_past_due: number }>;
        }>;

        if (candidates.length === 0) {
          toast('info', 'No customers with 30+ day overdue invoices');
          return;
        }

        let sent = 0;
        let skipped = 0;
        const fmtCents = (c: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(c / 100);

        for (const cust of candidates) {
          const reminderLevel = cust.max_days_past_due >= 90 ? 90 : cust.max_days_past_due >= 60 ? 60 : 30;

          // Check dedup — skip if already sent today at this level
          const { data: existing } = await supabase
            .from('ar_reminder_tracking')
            .select('id')
            .eq('customer_id', cust.customer_id)
            .eq('reminder_level', reminderLevel)
            .eq('sent_date', localToday())
            .maybeSingle();

          if (existing) {
            skipped++;
            continue;
          }

          const invoiceRows = cust.invoices
            .map((inv) => `<tr>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;">${inv.invoice_number}</td>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${fmtCents(inv.balance_cents)}</td>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${inv.days_past_due} days</td>
            </tr>`)
            .join('');

          const urgencyColor = reminderLevel >= 90 ? '#dc2626' : reminderLevel >= 60 ? '#d97706' : '#2563eb';
          const urgencyLabel = reminderLevel >= 90 ? 'URGENT' : reminderLevel >= 60 ? 'Past Due' : 'Reminder';

          const html = buildEmailHtml(`
            <h2 style="color:#1e293b;margin:0 0 12px;">Account ${urgencyLabel}</h2>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Dear ${cust.farm_name},
            </p>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Our records show an outstanding balance of
              <strong style="color:${urgencyColor};">${fmtCents(cust.total_balance_cents)}</strong>
              on your account. Please see the details below:
            </p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr style="background:#f8fafc;">
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#64748b;">Invoice</th>
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Balance</th>
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Days Past Due</th>
              </tr>
              ${invoiceRows}
              <tr style="background:#f8fafc;">
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:700;">Total</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:700;text-align:right;color:${urgencyColor};">${fmtCents(cust.total_balance_cents)}</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;"></td>
              </tr>
            </table>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Please remit payment at your earliest convenience. If you have already sent payment,
              please disregard this notice.
            </p>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Questions? Contact us at 618-843-0413 or reply to this email.
            </p>
          `);

          try {
            const emailResult = await sendEmail({
              to: cust.email,
              subject: `${urgencyLabel}: Outstanding Balance — Crop RX Solutions`,
              html,
              email_type: 'ar_reminder',
              customer_id: cust.customer_id,
              idempotency_key: `ar-reminder-${cust.customer_id}-${reminderLevel}-${localToday()}`,
            });

            if (emailResult.success) {
              // Track in ar_reminder_tracking for dedup
              const trackResult = await supabase.from('ar_reminder_tracking').insert({
                customer_id: cust.customer_id,
                reminder_level: reminderLevel,
                sent_date: localToday(),
                email_log_id: emailResult.email_log_id || null,
              });
              if (trackResult.error) Sentry.captureException(trackResult.error, { tags: { source: 'mutation', action: 'ar_reminder_tracking_insert' } });
              checkMutationResult(trackResult, 'Insert AR reminder tracking');
              sent++;
            }
          } catch {
            // Skip individual failures, continue with next
            skipped++;
          }
        }

        logActivity('ar_reminders_sent', `Sent ${sent} AR reminder(s) to overdue customers (${skipped} skipped/deduped)`, profile.id, 'system');
        toast('success', `Sent ${sent} AR reminder(s)${skipped > 0 ? `, ${skipped} skipped (already sent today)` : ''}`);
      },
      toast,
      setLoading: setSendingReminders,
      sentryTag: 'send_ar_reminders',
    });
  };

  // === A6: Email batch statements to selected customers ===
  const handleEmailBatchStatements = async (options: StatementOptions) => {
    setShowBatchStatementDialog(false);
    await runCriticalAction({
      action: async () => {
        let sent = 0;
        let noEmail = 0;
        const fmtCents = (c: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(c / 100);

        for (const custId of selectedCustomers) {
          const { data, error } = await supabase.rpc('get_detailed_statement_data', {
            p_customer_id: custId,
            p_as_of_date: options.as_of_date,
            p_mode: options.mode,
          });
          if (error) {
            Sentry.captureException(error, { tags: { source: 'batch_email_statement', customer_id: custId } });
            continue;
          }

          const stmtData = data as DetailedStatementData;
          if (!stmtData || !stmtData.transactions || stmtData.transactions.length === 0) continue;

          const custEmail = stmtData.customer.email;
          if (!custEmail) {
            noEmail++;
            continue;
          }

          // Generate PDF and convert to base64
          const doc = await generateStatementPdf(stmtData, options);
          const base64 = pdfToBase64(doc);

          const html = buildEmailHtml(`
            <h2 style="color:#1e293b;margin:0 0 12px;">Monthly Statement</h2>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Dear ${stmtData.customer.farm_name},
            </p>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Please find your account statement attached. Your current balance is
              <strong>${fmtCents(stmtData.outstanding_balance_cents)}</strong>.
            </p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr>
                <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Account</td>
                <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${stmtData.customer.farm_name}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Statement Date</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${options.as_of_date}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Open Invoices</td>
                <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${stmtData.transactions.length}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Balance Due</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:700;color:${stmtData.outstanding_balance_cents > 0 ? '#dc2626' : '#16a34a'};">${fmtCents(stmtData.outstanding_balance_cents)}</td>
              </tr>
            </table>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Please remit payment at your earliest convenience. Questions? Contact us at 618-843-0413.
            </p>
          `);

          try {
            const emailResult = await sendEmail({
              to: custEmail,
              subject: `Statement of Account — Crop RX Solutions`,
              html,
              email_type: 'statement',
              customer_id: custId,
              idempotency_key: `statement-email-${custId}-${options.as_of_date}-${Date.now()}`,
              attachments: [{
                filename: `Statement-${stmtData.customer.farm_name.replace(/[^a-zA-Z0-9]/g, '_')}-${options.as_of_date}.pdf`,
                content: base64,
              }],
            });
            if (emailResult.success) sent++;
          } catch {
            // Skip individual failures
          }
        }

        if (profile) {
          logActivity('batch_statements_emailed', `Emailed ${sent} statement(s)${noEmail > 0 ? ` (${noEmail} had no email)` : ''}`, profile.id, 'system');
        }
        toast('success', `Emailed ${sent} statement(s)${noEmail > 0 ? ` — ${noEmail} customer(s) had no email on file` : ''}`);
      },
      toast,
      setLoading: setEmailingStatements,
      sentryTag: 'email_batch_statements',
    });
  };

  const seasonOptions = Array.from({ length: 5 }, (_, i) => currentSeason - i);

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold font-heading text-nav-dark">AR Aging & Statements</h2>
        <div className="flex gap-2">
          {selectedCustomers.size > 0 && (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={<FileStack className="w-4 h-4" />}
                onClick={() => setShowBatchStatementDialog(true)}
                loading={batchPrinting}
              >
                Batch Print ({selectedCustomers.size})
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Mail className="w-4 h-4" />}
                onClick={() => setShowEmailStatementsConfirm(true)}
                loading={emailingStatements}
              >
                Email Statements ({selectedCustomers.size})
              </Button>
            </>
          )}
          {profile?.role === 'admin' && (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={<Send className="w-4 h-4" />}
                onClick={() => setShowARReminderConfirm(true)}
                loading={sendingReminders}
              >
                Send AR Reminders
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Zap className="w-4 h-4" />}
                onClick={() => setShowFinanceChargePreview(true)}
              >
                Preview Finance Charges
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {[
          { key: 'aging' as TabKey, label: 'AR Aging' },
          { key: 'statement' as TabKey, label: 'Customer Statement' },
          { key: 'season' as TabKey, label: 'Season Comparison' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === t.key
                ? 'bg-white text-nav-dark shadow-sm'
                : 'text-secondary hover:text-nav-dark'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ========== AR AGING TAB ========== */}
      {tab === 'aging' && (
        <>
          {/* Controls */}
          <Card>
            <div className="flex items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">As of Date</label>
                <input
                  type="date"
                  value={asOfDate}
                  onChange={(e) => setAsOfDate(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <Button variant="secondary" size="sm" onClick={fetchAging}>
                Refresh
              </Button>
              {agingData.length > 0 && (
                <button
                  onClick={toggleAllCustomers}
                  className="text-xs text-crx-green hover:underline ml-2"
                >
                  {selectedCustomers.size === agingData.length ? 'Deselect All' : 'Select All'}
                </button>
              )}
              <div className="ml-auto">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    exportToCSV(
                      agingData as unknown as Record<string, unknown>[],
                      [
                        { key: 'farm_name', header: 'Customer' },
                        { key: 'current_amount', header: 'Current', format: fmtCSV },
                        { key: 'days_30', header: '30 Days', format: fmtCSV },
                        { key: 'days_60', header: '60 Days', format: fmtCSV },
                        { key: 'days_90', header: '90 Days', format: fmtCSV },
                        { key: 'over_90', header: '120+ Days', format: fmtCSV },
                        { key: 'total_outstanding', header: 'Total', format: fmtCSV },
                      ],
                      'ar_aging_report'
                    )
                  }
                >
                  Export CSV
                </Button>
              </div>
            </div>
          </Card>

          {/* Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Card>
              <p className="text-xs text-secondary mb-1">Total Outstanding</p>
              <p className="text-xl font-semibold font-heading text-red-600">{fmt(agingTotals.total)}</p>
            </Card>
            <Card>
              <p className="text-xs text-secondary mb-1">Current (&lt;30 days)</p>
              <p className="text-xl font-semibold font-heading text-nav-dark">{fmt(agingTotals.current)}</p>
            </Card>
            <Card>
              <p className="text-xs text-secondary mb-1">30-89 Days</p>
              <p className="text-xl font-semibold font-heading text-orange-600">
                {fmt(agingTotals.d30 + agingTotals.d60)}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-secondary mb-1">90+ Days</p>
              <p className="text-xl font-semibold font-heading text-red-700">
                {fmt(agingTotals.d90 + agingTotals.over90)}
              </p>
            </Card>
          </div>

          {/* Aging Table */}
          <Card padding={false}>
            <div className="p-5">
              <DataTable<ARAgingRow>
                columns={agingColumns}
                data={agingData}
                loading={loading}
                searchable
                searchPlaceholder="Search customers..."
                searchKeys={['farm_name']}
                emptyTitle="No outstanding receivables"
                emptyDescription="All customer balances are current."
              />
            </div>
          </Card>

          {/* Totals footer row */}
          {agingData.length > 0 && (
            <Card>
              <div className="grid grid-cols-7 gap-2 text-sm">
                <span className="font-semibold">Totals</span>
                <span className="font-mono font-semibold">{fmt(agingTotals.current)}</span>
                <span className="font-mono font-semibold text-yellow-600">{fmt(agingTotals.d30)}</span>
                <span className="font-mono font-semibold text-orange-600">{fmt(agingTotals.d60)}</span>
                <span className="font-mono font-semibold text-red-500">{fmt(agingTotals.d90)}</span>
                <span className="font-mono font-semibold text-red-700">{fmt(agingTotals.over90)}</span>
                <span className="font-mono font-semibold">{fmt(agingTotals.total)}</span>
              </div>
            </Card>
          )}
        </>
      )}

      {/* ========== CUSTOMER STATEMENT TAB ========== */}
      {tab === 'statement' && (
        <>
          <Card>
            <div className="flex flex-wrap items-end gap-4">
              {statementData.length > 0 && (
                <button
                  onClick={() => {
                    setStatementData([]);
                    setTab('aging');
                  }}
                  className="flex items-center gap-1 text-sm text-crx-green hover:underline"
                >
                  <ArrowLeft className="w-4 h-4" /> Back to Aging
                </button>
              )}
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Customer</label>
                <select
                  value={selectedCustomer}
                  onChange={(e) => setSelectedCustomer(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green min-w-[200px]"
                >
                  <option value="">Select customer...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.farm_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">From</label>
                <input
                  type="date"
                  value={stmtStart}
                  onChange={(e) => setStmtStart(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">To</label>
                <input
                  type="date"
                  value={stmtEnd}
                  onChange={(e) => setStmtEnd(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <Button icon={<FileText className="w-4 h-4" />} onClick={fetchStatement}>
                Load Transactions
              </Button>
              {selectedCustomer && (
                <Button
                  variant="secondary"
                  icon={<Printer className="w-4 h-4" />}
                  onClick={() => {
                    const cust = customers.find((c) => c.id === selectedCustomer);
                    openStatementDialog(selectedCustomer, cust?.farm_name || 'Customer');
                  }}
                  loading={printingStatement}
                >
                  Print Statement
                </Button>
              )}
            </div>
          </Card>

          {statementData.length > 0 && (
            <>
              <Card>
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-nav-dark">{stmtCustomerName}</h2>
                    <p className="text-sm text-secondary">
                      Statement period: {parseLocalDate(stmtStart).toLocaleDateString()} –{' '}
                      {parseLocalDate(stmtEnd).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-secondary">Ending Balance</p>
                    <p className="text-xl font-semibold font-heading text-red-600">
                      {statementData.length > 0
                        ? fmtCents(statementData[statementData.length - 1].running_balance)
                        : '$0.00'}
                    </p>
                  </div>
                </div>
              </Card>

              <Card padding={false}>
                <div className="p-5">
                  <DataTable<CustomerStatementRow>
                    columns={stmtColumns}
                    data={statementData}
                    loading={loading}
                    emptyTitle="No transactions found"
                    emptyDescription="No activity in the selected date range."
                  />
                </div>
              </Card>

              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    exportToCSV(
                      statementData as unknown as Record<string, unknown>[],
                      [
                        { key: 'transaction_date', header: 'Date' },
                        { key: 'transaction_type', header: 'Type' },
                        { key: 'reference_number', header: 'Ref #' },
                        { key: 'description', header: 'Description' },
                        { key: 'amount_cents', header: 'Amount (cents)' },
                        { key: 'running_balance', header: 'Balance (cents)' },
                      ],
                      `statement_${stmtCustomerName.replace(/\s+/g, '_')}`
                    )
                  }
                >
                  Export CSV
                </Button>
              </div>
            </>
          )}

          {statementData.length === 0 && !loading && selectedCustomer && (
            <Card>
              <div className="text-center py-8">
                <DollarSign className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                <p className="text-secondary">Select a customer and date range, then click Generate Statement.</p>
              </div>
            </Card>
          )}
        </>
      )}

      {/* ========== SEASON COMPARISON TAB ========== */}
      {tab === 'season' && (
        <>
          <Card>
            <div className="flex items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Season A</label>
                <select
                  value={seasonA}
                  onChange={(e) => setSeasonA(Number(e.target.value))}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {seasonOptions.map((s) => (
                    <option key={s} value={s}>
                      {s - 1}/{s} Season
                    </option>
                  ))}
                </select>
              </div>
              <span className="text-sm text-secondary pb-2">vs</span>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Season B</label>
                <select
                  value={seasonB}
                  onChange={(e) => setSeasonB(Number(e.target.value))}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {seasonOptions.map((s) => (
                    <option key={s} value={s}>
                      {s - 1}/{s} Season
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </Card>

          <Card padding={false}>
            <div className="p-5">
              <DataTable<SeasonComparisonRow>
                columns={seasonColumns}
                data={seasonData}
                loading={loading}
                emptyTitle="No comparison data"
                emptyDescription="Select two seasons to compare."
              />
            </div>
          </Card>
        </>
      )}

      {/* Statement Print Dialog */}
      <StatementPrintDialog
        open={showStatementDialog}
        onClose={() => setShowStatementDialog(false)}
        onGenerate={handlePrintStatement}
        loading={printingStatement}
      />

      {/* Batch Statement Print Dialog */}
      <StatementPrintDialog
        open={showBatchStatementDialog}
        onClose={() => setShowBatchStatementDialog(false)}
        onGenerate={handleBatchStatements}
        loading={batchPrinting}
      />

      {/* Finance Charge Preview Modal */}
      <FinanceChargePreviewModal
        open={showFinanceChargePreview}
        onClose={() => setShowFinanceChargePreview(false)}
        asOfDate={asOfDate}
        onSuccess={handleFinanceChargeSuccess}
      />

      {/* AR Reminder Confirm Modal */}
      <ConfirmModal
        open={showARReminderConfirm}
        onClose={() => setShowARReminderConfirm(false)}
        onConfirm={handleSendARReminders}
        title="Send AR Reminders"
        message="Send AR reminder emails to all customers with 30+ day overdue invoices?"
        confirmLabel="Send Emails"
        variant="info"
        loading={sendingReminders}
      />

      {/* Email Statements Confirm Modal */}
      <ConfirmModal
        open={showEmailStatementsConfirm}
        onClose={() => setShowEmailStatementsConfirm(false)}
        onConfirm={() => {
          setShowEmailStatementsConfirm(false);
          handleEmailBatchStatements({ mode: 'summary', show_shares: true, as_of_date: asOfDate });
        }}
        title="Email Statements"
        message={`Email statements to ${selectedCustomers.size} selected customer(s)?`}
        confirmLabel="Send Emails"
        variant="info"
        loading={emailingStatements}
      />
    </div>
  );
}
