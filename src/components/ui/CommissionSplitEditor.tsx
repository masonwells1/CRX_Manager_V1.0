import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { supabase, assertRpcResult } from '../../lib/db';
import type { CommissionSplit } from '../../types';

// Fallback only — the live list comes from list_commission_recipients(),
// which returns every active commission-eligible profile the database-side
// validator will accept.
const FALLBACK_RECIPIENTS = [
  'Mason Wells',
  'Chance Tuttle',
  'CMCTW LLC',
  'Crop Rx Solutions',
];

interface CommissionSplitEditorProps {
  value: CommissionSplit;
  onChange: (value: CommissionSplit) => void;
  label?: string;
}

export default function CommissionSplitEditor({
  value,
  onChange,
  label = 'Commission Split',
}: CommissionSplitEditorProps) {
  const splits = value.splits;
  const total = splits.reduce((sum, s) => sum + (s.percentage || 0), 0);
  const isValid = Math.abs(total - 100) < 0.01;

  const [recipients, setRecipients] = useState<string[]>(FALLBACK_RECIPIENTS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('list_commission_recipients');
        if (error) throw error;
        const rows = assertRpcResult<{ full_name: string | null }[]>(
          data,
          'list_commission_recipients'
        );
        if (cancelled || !Array.isArray(rows)) return;
        const names = rows
          .map((r) => r.full_name)
          .filter((n): n is string => typeof n === 'string' && n.trim() !== '');
        if (names.length > 0) setRecipients(names);
      } catch {
        // Keep the fallback list — the dropdown must still work if the RPC
        // is unavailable (e.g. migration not yet applied).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSplit = (index: number, field: 'recipient' | 'percentage', val: string | number) => {
    const updated = splits.map((s, i) => {
      if (i !== index) return s;
      if (field === 'percentage') {
        return { ...s, percentage: typeof val === 'string' ? parseFloat(val) || 0 : val };
      }
      return { ...s, [field]: String(val) };
    });
    onChange({ splits: updated });
  };

  const addSplit = () => {
    onChange({ splits: [...splits, { recipient: '', percentage: 0 }] });
  };

  const removeSplit = (index: number) => {
    onChange({ splits: splits.filter((_, i) => i !== index) });
  };

  const selectClass =
    'flex-1 px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green transition-colors duration-150';

  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-secondary mb-1">
          {label}
        </label>
      )}
      <div className="space-y-2">
        {splits.map((split, i) => {
          // A stored value outside the known list (legacy data) still needs to
          // display; it stays selectable so the row isn't silently blanked.
          const isLegacy = split.recipient !== '' && !recipients.includes(split.recipient);
          return (
            <div key={i} className="flex items-center gap-2">
              <select
                value={split.recipient}
                onChange={(e) => updateSplit(i, 'recipient', e.target.value)}
                aria-label={`Recipient for split ${i + 1}`}
                className={selectClass}
              >
                <option value="">Select recipient...</option>
                {recipients.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {isLegacy && (
                  <option value={split.recipient}>{split.recipient}</option>
                )}
              </select>
              <div className="relative w-24">
                <input
                  type="number"
                  value={split.percentage || ''}
                  onChange={(e) => updateSplit(i, 'percentage', e.target.value)}
                  placeholder="0"
                  aria-label={`Commission percentage for split ${i + 1}`}
                  min="0"
                  max="100"
                  step="any"
                  className="w-full px-3 py-2 pr-7 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green transition-colors duration-150"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
              </div>
              {splits.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeSplit(i)}
                  aria-label={`Remove split ${i + 1}`}
                  className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          );
        })}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={addSplit}
            className="inline-flex items-center gap-1 text-xs font-medium text-crx-green hover:text-crx-green/80 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Recipient
          </button>
          <span
            className={`text-xs font-medium ${
              splits.length === 0
                ? 'text-gray-400'
                : isValid
                  ? 'text-emerald-600'
                  : 'text-amber-600'
            }`}
          >
            Total: {total.toFixed(1)}%
            {splits.length > 0 && !isValid && ' (should be 100%)'}
          </span>
        </div>
      </div>
    </div>
  );
}
