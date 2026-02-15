import { useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { FileText } from 'lucide-react';
import type { StatementOptions } from '../../types';

interface StatementPrintDialogProps {
  open: boolean;
  onClose: () => void;
  onGenerate: (options: StatementOptions) => void;
  loading?: boolean;
  defaultDate?: string;
}

export default function StatementPrintDialog({
  open,
  onClose,
  onGenerate,
  loading = false,
  defaultDate,
}: StatementPrintDialogProps) {
  const today = defaultDate || new Date().toISOString().split('T')[0];

  const [mode, setMode] = useState<'summary' | 'detailed'>('summary');
  const [showShares, setShowShares] = useState(true);
  const [asOfDate, setAsOfDate] = useState(today);

  const handleGenerate = () => {
    onGenerate({
      mode,
      show_shares: showShares,
      as_of_date: asOfDate,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Generate Statement">
      <div className="space-y-5">
        <p className="text-sm text-secondary">
          Choose statement format and options.
        </p>

        {/* Mode selector */}
        <div>
          <label className="text-sm font-medium text-nav-dark block mb-2">Statement Type</label>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMode('summary')}
              className={`p-3 rounded-lg border-2 text-left transition-colors ${
                mode === 'summary'
                  ? 'border-crx-green bg-crx-green/5'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="text-sm font-semibold text-nav-dark">Summary</div>
              <div className="text-xs text-secondary mt-1">
                One line per invoice with transaction #, date, description, and amount
              </div>
            </button>
            <button
              onClick={() => setMode('detailed')}
              className={`p-3 rounded-lg border-2 text-left transition-colors ${
                mode === 'detailed'
                  ? 'border-crx-green bg-crx-green/5'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="text-sm font-semibold text-nav-dark">Detailed</div>
              <div className="text-xs text-secondary mt-1">
                Full product tables, EPA info, rates, and shares embedded per invoice
              </div>
            </button>
          </div>
        </div>

        {/* Date picker */}
        <div>
          <label className="text-sm font-medium text-nav-dark block mb-1">Statement As-of Date</label>
          <input
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
          />
          <p className="text-xs text-secondary mt-1">
            Only invoices on or before this date will be included
          </p>
        </div>

        {/* Show shares toggle */}
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={showShares}
            onChange={(e) => setShowShares(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
          />
          <div>
            <div className="text-sm font-medium text-nav-dark">Show grower shares</div>
            <div className="text-xs text-secondary">
              Display split percentages per grower on invoices with multiple parties
            </div>
          </div>
        </label>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            icon={<FileText className="w-4 h-4" />}
            onClick={handleGenerate}
            loading={loading}
          >
            Generate {mode === 'detailed' ? 'Detailed' : 'Summary'} Statement
          </Button>
        </div>
      </div>
    </Modal>
  );
}
