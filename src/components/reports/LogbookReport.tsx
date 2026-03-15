/**
 * LogbookReport — 4 sub-tabs: by Customer / Applicator / Field / FAA
 * Entity selector + date range + DataTable
 *
 * Sprint 9: Reporting Engine
 */
import { useEffect, useState, useCallback } from 'react';
import Card from '../ui/Card';
import DataTable, { type Column } from '../ui/DataTable';
import Badge from '../ui/Badge';
import ReportShell from './ReportShell';
import { supabase } from '../../lib/db';
import { useToast } from '../ui/Toast';
import { exportToCSV, fmtDateCSV } from '../../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../../lib/reportPdf';
import type { LogbookRow, FAALogbookRow, ApplicationProduct } from '../../types';

type LogbookTab = 'customer' | 'applicator' | 'field' | 'faa';

interface EntityOption {
  id: string;
  label: string;
}

function formatProducts(products: ApplicationProduct[]): string {
  if (!products || !Array.isArray(products)) return '';
  return products.map((p) => `${p.product_name} (${p.quantity} ${p.unit})`).join(', ');
}

function formatWeather(w: LogbookRow['weather_conditions']): string {
  if (!w) return '';
  const parts: string[] = [];
  if (w.wind_speed != null) parts.push(`Wind: ${w.wind_speed} mph ${w.wind_direction || ''}`);
  if (w.temperature != null) parts.push(`${w.temperature}°F`);
  if (w.humidity != null) parts.push(`${w.humidity}% RH`);
  return parts.join(', ');
}

export default function LogbookReport() {
  const { toast } = useToast();
  const [tab, setTab] = useState<LogbookTab>('customer');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [entityId, setEntityId] = useState('');
  const [entities, setEntities] = useState<EntityOption[]>([]);
  const [data, setData] = useState<LogbookRow[]>([]);
  const [faaData, setFaaData] = useState<FAALogbookRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Load entity options when tab changes
  useEffect(() => {
    setEntityId('');
    setData([]);
    setFaaData([]);
    if (tab === 'faa') return;

    async function loadEntities() {
      if (tab === 'customer') {
        const { data: rows, error } = await supabase.from('customers').select('id, farm_name').order('farm_name').limit(500);
        if (error) { toast('error', 'Failed to load customers'); return; }
        setEntities((rows || []).map((r) => ({ id: r.id, label: r.farm_name })));
      } else if (tab === 'applicator') {
        const { data: rows, error } = await supabase.from('profiles').select('id, full_name, role').in('role', ['applicator', 'admin', 'sales_rep']).eq('is_active', true).order('full_name').limit(200);
        if (error) { toast('error', 'Failed to load applicators'); return; }
        setEntities((rows || []).map((r) => ({ id: r.id, label: r.full_name })));
      } else if (tab === 'field') {
        const { data: rows, error } = await supabase.from('fields').select('id, field_name, customer:customers(farm_name)').eq('is_active', true).order('field_name').limit(500);
        if (error) { toast('error', 'Failed to load fields'); return; }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setEntities(((rows || []) as any[]).map((r) => ({ id: r.id, label: `${r.field_name} — ${r.customer?.farm_name || 'Unknown'}` })));
      }
    }
    loadEntities();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const fetchLogbook = useCallback(async () => {
    setLoading(true);
    const rpcName =
      tab === 'customer' ? 'get_logbook_by_customer' :
      tab === 'applicator' ? 'get_logbook_by_applicator' :
      'get_logbook_by_field';

    const paramKey =
      tab === 'customer' ? 'p_customer_id' :
      tab === 'applicator' ? 'p_applicator_id' :
      'p_field_id';

    const { data: rows, error } = await supabase.rpc(rpcName, {
      [paramKey]: entityId,
      p_start_date: startDate,
      p_end_date: endDate,
    });

    if (error) {
      toast('error', `Failed to load logbook: ${error.message}`);
    } else {
      setData((rows || []) as LogbookRow[]);
    }
    setLoading(false);
  }, [tab, entityId, startDate, endDate, toast]);

  const fetchFAA = useCallback(async () => {
    setLoading(true);
    const { data: rows, error } = await supabase.rpc('get_logbook_faa', {
      p_start_date: startDate,
      p_end_date: endDate,
    });
    if (error) {
      toast('error', `Failed to load FAA logbook: ${error.message}`);
    } else {
      setFaaData((rows || []) as FAALogbookRow[]);
    }
    setLoading(false);
  }, [startDate, endDate, toast]);

  // Fetch report data
  useEffect(() => {
    if (tab === 'faa') {
      if (startDate && endDate) fetchFAA();
    } else {
      if (entityId && startDate && endDate) fetchLogbook();
    }
  }, [tab, entityId, startDate, endDate, fetchFAA, fetchLogbook]);

  const handleDateChange = (s: string, e: string) => {
    setStartDate(s);
    setEndDate(e);
  };

  const currentData = tab === 'faa' ? faaData : data;

  // CSV export
  const handleCSV = () => {
    if (tab === 'faa') {
      exportToCSV(faaData as unknown as Record<string, unknown>[], [
        { key: 'application_date', header: 'Date', format: fmtDateCSV },
        { key: 'record_number', header: 'Record #' },
        { key: 'customer_name', header: 'Customer' },
        { key: 'applicator_name', header: 'Pilot' },
        { key: 'faa_certificate', header: 'FAA Certificate' },
        { key: 'field_name', header: 'Field' },
        { key: 'field_county', header: 'County' },
        { key: 'total_acres', header: 'Acres' },
        { key: 'vehicle_name', header: 'Aircraft' },
        { key: 'vehicle_registration', header: 'N-Number' },
        { key: 'product_data', header: 'Products', format: (v) => formatProducts(v as ApplicationProduct[]) },
      ], `faa_logbook`);
    } else {
      exportToCSV(data as unknown as Record<string, unknown>[], [
        { key: 'application_date', header: 'Date', format: fmtDateCSV },
        { key: 'record_number', header: 'Record #' },
        { key: 'customer_name', header: 'Customer' },
        { key: 'applicator_name', header: 'Applicator' },
        { key: 'field_name', header: 'Field' },
        { key: 'total_acres', header: 'Acres' },
        { key: 'total_volume', header: 'Volume' },
        { key: 'vehicle_name', header: 'Vehicle' },
        { key: 'product_data', header: 'Products', format: (v) => formatProducts(v as ApplicationProduct[]) },
        { key: 'weather_conditions', header: 'Weather', format: (v) => formatWeather(v as LogbookRow['weather_conditions']) },
      ], `logbook_by_${tab}`);
    }
    toast('success', 'Logbook exported to CSV');
  };

  // PDF export
  const handlePDF = async () => {
    const pdfCols: ReportPdfColumn[] = tab === 'faa'
      ? [
          { header: 'Date', key: 'application_date' },
          { header: 'Record #', key: 'record_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Pilot', key: 'applicator_name' },
          { header: 'FAA Cert', key: 'faa_certificate' },
          { header: 'Field', key: 'field_name' },
          { header: 'Acres', key: 'total_acres', align: 'right' },
          { header: 'Aircraft', key: 'vehicle_name' },
          { header: 'N-Number', key: 'vehicle_registration' },
          { header: 'Products', key: 'product_data', format: (v) => formatProducts(v as ApplicationProduct[]) },
        ]
      : [
          { header: 'Date', key: 'application_date' },
          { header: 'Record #', key: 'record_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Applicator', key: 'applicator_name' },
          { header: 'Field', key: 'field_name' },
          { header: 'Acres', key: 'total_acres', align: 'right' },
          { header: 'Volume', key: 'total_volume', align: 'right' },
          { header: 'Vehicle', key: 'vehicle_name' },
          { header: 'Products', key: 'product_data', format: (v) => formatProducts(v as ApplicationProduct[]) },
          { header: 'Weather', key: 'weather_conditions', format: (v) => formatWeather(v as LogbookRow['weather_conditions']) },
        ];

    const title = tab === 'faa' ? 'FAA Aerial Application Logbook' : `Application Logbook — By ${tab.charAt(0).toUpperCase() + tab.slice(1)}`;

    await downloadReportPdf({
      title,
      subtitle: entityId ? entities.find((e) => e.id === entityId)?.label : undefined,
      dateRange: startDate ? { start: startDate, end: endDate } : undefined,
      columns: pdfCols,
      data: currentData as unknown as Record<string, unknown>[],
      orientation: 'landscape',
      footerNote: `${currentData.length} application records`,
    });
    toast('success', 'Logbook PDF generated');
  };

  const tabs: { key: LogbookTab; label: string }[] = [
    { key: 'customer', label: 'By Customer' },
    { key: 'applicator', label: 'By Applicator' },
    { key: 'field', label: 'By Field' },
    { key: 'faa', label: 'FAA Aerial' },
  ];

  // Standard logbook columns
  const logbookCols: Column<LogbookRow>[] = [
    { key: 'application_date', header: 'Date', sortable: true, render: (r) => new Date(r.application_date + 'T00:00:00').toLocaleDateString() },
    { key: 'record_number', header: 'Record #', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.record_number}</span> },
    { key: 'customer_name', header: 'Customer', sortable: true },
    { key: 'applicator_name', header: 'Applicator', sortable: true, render: (r) => r.applicator_name || '-' },
    { key: 'field_name', header: 'Field', sortable: true, render: (r) => r.field_name || '-' },
    { key: 'total_acres', header: 'Acres', sortable: true, render: (r) => r.total_acres?.toLocaleString() || '-' },
    { key: 'total_volume', header: 'Volume', render: (r) => r.total_volume ? `${r.total_volume} ${r.total_volume_unit || ''}` : '-' },
    { key: 'vehicle_name', header: 'Vehicle', render: (r) => r.vehicle_name || '-' },
    { key: 'product_data', header: 'Products', render: (r) => {
      const prods = r.product_data as ApplicationProduct[];
      if (!prods || prods.length === 0) return '-';
      return (
        <div className="space-y-0.5">
          {prods.slice(0, 3).map((p, i) => (
            <div key={i} className="text-xs">
              {p.product_name}
              {p.is_rup && <Badge variant="error" className="ml-1 text-[10px]">RUP</Badge>}
            </div>
          ))}
          {prods.length > 3 && <div className="text-xs text-secondary">+{prods.length - 3} more</div>}
        </div>
      );
    }},
    { key: 'invoice_number', header: 'Invoice', render: (r) => r.invoice_number || <span className="text-secondary">—</span> },
  ];

  // FAA-specific columns
  const faaCols: Column<FAALogbookRow>[] = [
    { key: 'application_date', header: 'Date', sortable: true, render: (r) => new Date(r.application_date + 'T00:00:00').toLocaleDateString() },
    { key: 'record_number', header: 'Record #', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.record_number}</span> },
    { key: 'customer_name', header: 'Customer', sortable: true },
    { key: 'applicator_name', header: 'Pilot', sortable: true },
    { key: 'faa_certificate', header: 'FAA Cert', render: (r) => r.faa_certificate || '-' },
    { key: 'field_name', header: 'Field', sortable: true },
    { key: 'field_county', header: 'County', render: (r) => r.field_county ? `${r.field_county}, ${r.field_state || ''}` : '-' },
    { key: 'total_acres', header: 'Acres', sortable: true, render: (r) => r.total_acres?.toLocaleString() || '-' },
    { key: 'vehicle_name', header: 'Aircraft', render: (r) => r.vehicle_name || '-' },
    { key: 'vehicle_registration', header: 'N-Number', render: (r) => r.vehicle_registration || '-' },
    { key: 'product_data', header: 'Products', render: (r) => {
      const prods = r.product_data as ApplicationProduct[];
      if (!prods || prods.length === 0) return '-';
      return (
        <div className="space-y-0.5">
          {prods.map((p, i) => (
            <div key={i} className="text-xs">
              {p.product_name} — {p.epa_registration || 'No EPA'}
              {p.is_rup && <Badge variant="error" className="ml-1 text-[10px]">RUP</Badge>}
            </div>
          ))}
        </div>
      );
    }},
  ];

  return (
    <div className="space-y-4">
      {/* Sub-tab bar */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === t.key ? 'bg-white text-nav-dark shadow-sm' : 'text-secondary hover:text-nav-dark'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ReportShell
        onDateChange={handleDateChange}
        onExportCSV={currentData.length > 0 ? handleCSV : undefined}
        onExportPDF={currentData.length > 0 ? handlePDF : undefined}
        extraControls={
          tab !== 'faa' ? (
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">
                {tab === 'customer' ? 'Customer' : tab === 'applicator' ? 'Applicator' : 'Field'}
              </label>
              <select
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
                aria-label={`Select ${tab}`}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green min-w-[200px]"
              >
                <option value="">— Select —</option>
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>{e.label}</option>
                ))}
              </select>
            </div>
          ) : undefined
        }
      >
        <Card padding={false}>
          <div className="p-5">
            {tab === 'faa' ? (
              <DataTable
                data={faaData as unknown as Record<string, unknown>[]}
                columns={faaCols as unknown as Column<Record<string, unknown>>[]}
                emptyTitle="No aerial application records"
                emptyDescription={!startDate ? 'Select a date range to view FAA aerial logbook' : undefined}
                loading={loading}
              />
            ) : (
              <DataTable
                data={data as unknown as Record<string, unknown>[]}
                columns={logbookCols as unknown as Column<Record<string, unknown>>[]}
                emptyTitle="No application records"
                emptyDescription={!entityId ? `Select a ${tab} and date range to view logbook` : undefined}
                loading={loading}
              />
            )}
          </div>
        </Card>
      </ReportShell>
    </div>
  );
}
