/**
 * ReportShell — reusable wrapper for all report pages.
 * Provides date range pickers, season presets, CSV/PDF export buttons.
 *
 * Sprint 9: Reporting Engine
 */
import { useState, type ReactNode } from 'react';
import { Download, FileText } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';

// Crop season = July 1 to June 30
function getPresetDates(preset: string): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  switch (preset) {
    case 'this_season':
      return month >= 6
        ? { start: `${year}-07-01`, end: `${year + 1}-06-30` }
        : { start: `${year - 1}-07-01`, end: `${year}-06-30` };
    case 'last_season':
      return month >= 6
        ? { start: `${year - 1}-07-01`, end: `${year}-06-30` }
        : { start: `${year - 2}-07-01`, end: `${year - 1}-06-30` };
    case 'ytd':
      // Season runs July 1 to June 30 — YTD starts from current season's July 1
      return month >= 6
        ? { start: `${year}-07-01`, end: now.toISOString().split('T')[0] }
        : { start: `${year - 1}-07-01`, end: now.toISOString().split('T')[0] };
    case 'last30': {
      const d = new Date(now.getTime() - 30 * 86400000);
      return { start: d.toISOString().split('T')[0], end: now.toISOString().split('T')[0] };
    }
    case 'last90': {
      const d = new Date(now.getTime() - 90 * 86400000);
      return { start: d.toISOString().split('T')[0], end: now.toISOString().split('T')[0] };
    }
    default:
      return { start: '', end: '' };
  }
}

export interface ReportShellProps {
  onDateChange: (start: string, end: string) => void;
  onExportCSV?: () => void;
  onExportPDF?: () => void;
  showDateRange?: boolean;
  extraControls?: ReactNode;
  children: ReactNode;
}

export default function ReportShell({
  onDateChange,
  onExportCSV,
  onExportPDF,
  showDateRange = true,
  extraControls,
  children,
}: ReportShellProps) {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const applyPreset = (key: string) => {
    if (key === 'all') {
      setStartDate('');
      setEndDate('');
      onDateChange('', '');
    } else {
      const { start, end } = getPresetDates(key);
      setStartDate(start);
      setEndDate(end);
      onDateChange(start, end);
    }
  };

  const handleStartChange = (v: string) => {
    setStartDate(v);
    onDateChange(v, endDate);
  };

  const handleEndChange = (v: string) => {
    setEndDate(v);
    onDateChange(startDate, v);
  };

  const presets = [
    { key: 'all', label: 'All Time' },
    { key: 'this_season', label: 'This Season' },
    { key: 'last_season', label: 'Last Season' },
    { key: 'ytd', label: 'YTD' },
    { key: 'last30', label: 'Last 30d' },
    { key: 'last90', label: 'Last 90d' },
  ];

  return (
    <div className="space-y-4">
      {showDateRange && (
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => handleStartChange(e.target.value)}
                aria-label="Report start date"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => handleEndChange(e.target.value)}
                aria-label="Report end date"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
            </div>
            <div className="flex gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.key}
                  onClick={() => applyPreset(p.key)}
                  className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 hover:bg-crx-green-tint hover:border-crx-green hover:text-crx-green transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
            {extraControls}
            <div className="ml-auto flex gap-2">
              {onExportCSV && (
                <Button variant="secondary" size="sm" icon={<Download className="w-4 h-4" />} showChevron={false} onClick={onExportCSV}>
                  CSV
                </Button>
              )}
              {onExportPDF && (
                <Button variant="secondary" size="sm" icon={<FileText className="w-4 h-4" />} showChevron={false} onClick={onExportPDF}>
                  PDF
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}
      {children}
    </div>
  );
}
