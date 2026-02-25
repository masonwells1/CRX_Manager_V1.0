import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { CommissionSplit } from '../../types';

const RECIPIENTS = [
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

  // Track which rows are using "Other" (custom text)
  const [otherFlags, setOtherFlags] = useState<boolean[]>(
    splits.map((s) => s.recipient !== '' && !RECIPIENTS.includes(s.recipient))
  );

  const updateSplit = (index: number, field: 'recipient' | 'percentage', val: string | number) => {
    const updated = splits.map((s, i) => {
      if (i !== index) return s;
      if (field === 'percentage') {
        return { ...s, percentage: typeof val === 'string' ? parseFloat(val) || 0 : val };
      }
      return { ...s, recipient: String(val) };
    });
    onChange({ splits: updated });
  };

  const handleRecipientSelect = (index: number, selected: string) => {
    if (selected === '__other__') {
      setOtherFlags((prev) => {
        const next = [...prev];
        next[index] = true;
        return next;
      });
      updateSplit(index, 'recipient', '');
    } else {
      setOtherFlags((prev) => {
        const next = [...prev];
        next[index] = false;
        return next;
      });
      updateSplit(index, 'recipient', selected);
    }
  };

  const addSplit = () => {
    onChange({ splits: [...splits, { recipient: '', percentage: 0 }] });
    setOtherFlags((prev) => [...prev, false]);
  };

  const removeSplit = (index: number) => {
    onChange({ splits: splits.filter((_, i) => i !== index) });
    setOtherFlags((prev) => prev.filter((_, i) => i !== index));
  };

  const selectClass =
    'flex-1 px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green transition-colors duration-150';
  const inputClass =
    'flex-1 px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green transition-colors duration-150';

  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-secondary mb-1">
          {label}
        </label>
      )}
      <div className="space-y-2">
        {splits.map((split, i) => {
          const isOther = otherFlags[i];
          return (
            <div key={i} className="flex items-center gap-2">
              {isOther ? (
                <div className="flex-1 flex items-center gap-2">
                  <input
                    type="text"
                    value={split.recipient}
                    onChange={(e) => updateSplit(i, 'recipient', e.target.value)}
                    placeholder="Enter recipient name"
                    className={inputClass}
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => handleRecipientSelect(i, '')}
                    className="text-xs text-secondary hover:text-nav-dark whitespace-nowrap"
                  >
                    Back
                  </button>
                </div>
              ) : (
                <select
                  value={split.recipient}
                  onChange={(e) => handleRecipientSelect(i, e.target.value)}
                  className={selectClass}
                >
                  <option value="">Select recipient...</option>
                  {RECIPIENTS.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  <option value="__other__">Other...</option>
                </select>
              )}
              <div className="relative w-24">
                <input
                  type="number"
                  value={split.percentage || ''}
                  onChange={(e) => updateSplit(i, 'percentage', e.target.value)}
                  placeholder="0"
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
