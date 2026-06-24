import { Check, RotateCcw, Eye, EyeOff, Link2 } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import {
  JOB_COLUMN_REGISTRY,
  defaultJobListSettings,
  toggleColumn,
  type JobListSettings,
  type JobColumnId,
} from './jobListColumns';

interface ListSettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** The user's current (merged) settings. */
  settings: JobListSettings;
  /** Called with a NEW settings object whenever the user changes something.
   *  The parent applies it immediately (criterion #2) and persists it. */
  onChange: (next: JobListSettings) => void;
  /** True while a save round-trip is in flight (disables controls subtly). */
  saving?: boolean;
}

/**
 * Field-app parity #8: the ChemMan "List Settings" panel. Per-user on/off
 * toggles for every job-list column, plus a "Show Completed Jobs" visibility
 * toggle. Changes apply immediately and persist per user. Columns shared with
 * the field-application invoice list are flagged so the user knows the toggle
 * carries over.
 */
export default function ListSettingsModal({
  open,
  onClose,
  settings,
  onChange,
  saving = false,
}: ListSettingsModalProps) {
  const visible = new Set<JobColumnId>(settings.visibleColumns);
  const visibleCount = JOB_COLUMN_REGISTRY.filter((c) => visible.has(c.id)).length;

  const handleToggle = (id: JobColumnId) => {
    onChange(toggleColumn(settings, id));
  };

  const handleShowCompleted = () => {
    onChange({ ...settings, showCompleted: !settings.showCompleted });
  };

  const handleReset = () => {
    onChange(defaultJobListSettings());
  };

  return (
    <Modal open={open} onClose={onClose} title="List" accent="Settings" size="large">
      <div className="space-y-5">
        <p className="text-sm text-secondary">
          Choose which columns show on your job list. These settings are saved to your account, so
          your layout stays the same next time you open this page. Columns marked
          <span className="inline-flex items-center gap-0.5 mx-1 align-middle text-crx-green">
            <Link2 className="w-3 h-3" /> shared
          </span>
          also apply to the Field Invoices list.
        </p>

        {/* Show Completed Jobs — a visibility toggle, not a column. */}
        <button
          type="button"
          onClick={handleShowCompleted}
          aria-pressed={settings.showCompleted}
          disabled={saving}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${
            settings.showCompleted ? 'border-crx-green bg-crx-green/5' : 'border-gray-200 hover:bg-gray-50'
          } disabled:opacity-60`}
        >
          {settings.showCompleted ? (
            <Eye className="w-4 h-4 text-crx-green flex-shrink-0" aria-hidden="true" />
          ) : (
            <EyeOff className="w-4 h-4 text-secondary flex-shrink-0" aria-hidden="true" />
          )}
          <span className="text-sm font-medium text-nav-dark flex-1">Show Completed Jobs</span>
          <span className="text-xs text-secondary">
            {settings.showCompleted ? 'Showing' : 'Hidden'}
          </span>
          {settings.showCompleted && <Check className="w-4 h-4 text-crx-green" aria-hidden="true" />}
        </button>

        {/* Column toggles. */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-secondary">Columns</span>
            <span className="text-xs text-secondary">{visibleCount} of {JOB_COLUMN_REGISTRY.length} shown</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-80 overflow-y-auto pr-1">
            {JOB_COLUMN_REGISTRY.map((col) => {
              const on = visible.has(col.id);
              return (
                <button
                  key={col.id}
                  type="button"
                  onClick={() => handleToggle(col.id)}
                  aria-pressed={on}
                  disabled={saving}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors ${
                    on ? 'border-crx-green bg-crx-green/5' : 'border-gray-200 hover:bg-gray-50'
                  } disabled:opacity-60`}
                >
                  <span
                    className={`flex items-center justify-center w-4 h-4 rounded border flex-shrink-0 ${
                      on ? 'bg-crx-green border-crx-green' : 'bg-white border-gray-300'
                    }`}
                    aria-hidden="true"
                  >
                    {on && <Check className="w-3 h-3 text-white" />}
                  </span>
                  <span className="text-sm text-nav-dark flex-1 min-w-0 truncate">{col.label}</span>
                  {col.shared && (
                    <span
                      className="inline-flex items-center gap-0.5 text-[10px] font-medium text-crx-green"
                      title="Also applies to the Field Invoices list"
                    >
                      <Link2 className="w-3 h-3" aria-hidden="true" />
                      shared
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-gray-100">
          <Button
            variant="ghost"
            icon={<RotateCcw className="w-4 h-4" />}
            onClick={handleReset}
            disabled={saving}
            showChevron={false}
          >
            Reset to defaults
          </Button>
          <Button onClick={onClose} showChevron={false}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
