/** Options dialog shared by Job Detail and the Jobs bulk applicator-sheet actions. */
import { useEffect, useState } from 'react';
import { ClipboardList, Printer, Save } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { sanitizeError, checkMutationResult, supabase } from '../../lib/db';
import {
  APPLICATOR_PRINT_OPTIONS_KEY,
  DEFAULT_APPLICATOR_PRINT_OPTIONS,
  loadApplicatorPrintOptions,
  serializeApplicatorPrintOptions,
  type ApplicatorPrintOptions,
} from '../../lib/applicatorPrintOptions';
import { SHEET_FORMAT_LABELS, type ApplicatorSheetFormat } from '../../lib/applicatorSheetData';

export interface ApplicatorPrintSelection {
  format: ApplicatorSheetFormat;
  options: ApplicatorPrintOptions;
}

interface PrintOptionsDialogProps {
  open: boolean;
  onClose: () => void;
  onPrint: (selection: ApplicatorPrintSelection) => Promise<void> | void;
}

function ToggleSelect({
  label,
  value,
  onChange,
  disabled = false,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-nav-dark">{label}</span>
      <select
        value={value ? 'yes' : 'no'}
        onChange={(event) => onChange(event.target.value === 'yes')}
        disabled={disabled}
        className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-charcoal focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-secondary"
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
      {hint ? <span className="mt-1 block text-xs text-secondary">{hint}</span> : null}
    </label>
  );
}

export default function PrintOptionsDialog({ open, onClose, onPrint }: PrintOptionsDialogProps) {
  const { toast } = useToast();
  const [format, setFormat] = useState<ApplicatorSheetFormat>('original');
  const [options, setOptions] = useState<ApplicatorPrintOptions>({ ...DEFAULT_APPLICATOR_PRINT_OPTIONS });
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setFormat('original');
    setOptions({ ...DEFAULT_APPLICATOR_PRINT_OPTIONS });
    setLoadingDefaults(true);
    void loadApplicatorPrintOptions().then((saved) => {
      if (current) setOptions(saved);
    }).finally(() => {
      if (current) setLoadingDefaults(false);
    });
    return () => { current = false; };
  }, [open]);

  const updateOption = <Key extends keyof ApplicatorPrintOptions>(key: Key, value: ApplicatorPrintOptions[Key]) => {
    setOptions((current) => ({ ...current, [key]: value }));
  };

  const handleSaveDefault = async () => {
    setSavingDefault(true);
    try {
      const result = await supabase
        .from('app_settings')
        .upsert(
          {
            setting_key: APPLICATOR_PRINT_OPTIONS_KEY,
            setting_value: serializeApplicatorPrintOptions(options),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'setting_key' },
        )
        .select();
      checkMutationResult(result, 'Save applicator print options');
      toast('success', 'Applicator print defaults saved');
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setSavingDefault(false);
    }
  };

  const handlePrint = async () => {
    setPrinting(true);
    try {
      await onPrint({ format, options });
    } finally {
      setPrinting(false);
    }
  };

  const busy = loadingDefaults || savingDefault || printing;

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title="Print Applicator Field Sheet"
      size="large"
      footer={(
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="secondary" onClick={handleSaveDefault} loading={savingDefault} disabled={loadingDefaults || printing}>
            <Save className="h-4 w-4" /> Save as default
          </Button>
          <Button onClick={handlePrint} loading={printing} disabled={loadingDefaults || savingDefault}>
            <Printer className="h-4 w-4" /> Print
          </Button>
        </div>
      )}
    >
      <div className="space-y-5">
        <p className="text-sm text-secondary">
          Choose the packet contents for this print. Save as default remembers these options for future sheets; the sheet format stays a per-print choice.
        </p>

        <div>
          <label htmlFor="applicator-sheet-format" className="block text-sm font-medium text-nav-dark">Sheet format</label>
          <select
            id="applicator-sheet-format"
            value={format}
            onChange={(event) => setFormat(event.target.value as ApplicatorSheetFormat)}
            disabled={busy}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-charcoal focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 disabled:bg-gray-50"
          >
            {(['original', 'enhanced', 'custom'] as ApplicatorSheetFormat[]).map((sheetFormat) => (
              <option key={sheetFormat} value={sheetFormat}>{SHEET_FORMAT_LABELS[sheetFormat]}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-secondary">
            Original is compact. Enhanced adds application details. Custom uses the header and column settings configured in Settings.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="block text-sm font-medium text-nav-dark">Map pages</span>
            <select
              value={options.mapPages}
              onChange={(event) => updateOption('mapPages', event.target.value as ApplicatorPrintOptions['mapPages'])}
              disabled={busy}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-charcoal focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 disabled:bg-gray-50"
            >
              <option value="none">None</option>
              <option value="overview">Combined overview only</option>
              <option value="per-field">Per-field pages only</option>
              <option value="both">Both</option>
            </select>
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-nav-dark">Extra blank application-info sections</span>
            <select
              value={options.blankSections}
              onChange={(event) => updateOption('blankSections', Number(event.target.value))}
              disabled={busy}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-charcoal focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 disabled:bg-gray-50"
            >
              {[0, 1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>

          <ToggleSelect
            label="Show previous applications on these fields"
            value={options.includePreviousApplications}
            onChange={(value) => updateOption('includePreviousApplications', value)}
            disabled={busy}
          />

          <label className="block">
            <span className="block text-sm font-medium text-nav-dark">Previous applications per field</span>
            <select
              value={options.previousApplicationsPerField}
              onChange={(event) => updateOption('previousApplicationsPerField', Number(event.target.value))}
              disabled={busy || !options.includePreviousApplications}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-charcoal focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 disabled:cursor-not-allowed disabled:bg-gray-50"
            >
              {[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>

          <ToggleSelect
            label="Show billing-split table"
            value={options.includeBillingSplits}
            onChange={(value) => updateOption('includeBillingSplits', value)}
            disabled={busy}
          />

          <ToggleSelect
            label="Show company banner/header"
            value={options.showBanner}
            onChange={(value) => updateOption('showBanner', value)}
            disabled={busy}
            hint={format === 'custom' ? 'Uses the header configured for the Custom format.' : 'Uses the standard CRX header band.'}
          />
        </div>

        <div className="flex items-start gap-2 rounded-lg bg-green-50 p-3 text-xs text-green-900">
          <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-crx-green" />
          Previous applications and phone numbers are best effort. If access is restricted, the rest of the sheet still prints.
        </div>
      </div>
    </Modal>
  );
}
