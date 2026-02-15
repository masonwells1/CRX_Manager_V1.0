/**
 * YearEndSummaryDialog — Season selector + options for generating Year-End Summary PDFs
 *
 * Sprint 17: Year-End Customer Summary
 */
import { useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { FileText } from 'lucide-react';
import type { YearEndSummaryOptions } from '../../lib/yearEndSummaryPdf';

interface YearEndSummaryDialogProps {
  open: boolean;
  onClose: () => void;
  onGenerate: (season: number, options: YearEndSummaryOptions) => void;
  loading?: boolean;
  /** Customer name to display in the title (omit for batch mode) */
  customerName?: string;
  /** If true, show batch mode messaging */
  batchMode?: boolean;
  batchCount?: number;
}

function getCurrentSeason() {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
}

export default function YearEndSummaryDialog({
  open,
  onClose,
  onGenerate,
  loading = false,
  customerName,
  batchMode = false,
  batchCount,
}: YearEndSummaryDialogProps) {
  const currentSeason = getCurrentSeason();
  const [season, setSeason] = useState(currentSeason);
  const [showProductDetail, setShowProductDetail] = useState(true);
  const [showShares, setShowShares] = useState(true);
  const [showYoY, setShowYoY] = useState(true);

  const seasonOptions = Array.from({ length: 5 }, (_, i) => currentSeason - i);

  const handleGenerate = () => {
    onGenerate(season, {
      show_product_detail: showProductDetail,
      show_shares: showShares,
      show_yoy_comparison: showYoY,
    });
  };

  const title = batchMode
    ? 'Generate Year-End Summaries'
    : customerName
      ? `Season Summary — ${customerName}`
      : 'Generate Season Summary';

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-5">
        <p className="text-sm text-secondary">
          {batchMode
            ? `Generate season summary PDFs for ${batchCount ?? 'all'} customer(s). Each customer gets a separate PDF download.`
            : 'Generate a comprehensive season summary with financials, product usage, acreage, and invoice history.'}
        </p>

        {/* Season selector */}
        <div>
          <label className="text-sm font-medium text-nav-dark block mb-1">Season</label>
          <select
            value={season}
            onChange={(e) => setSeason(Number(e.target.value))}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
          >
            {seasonOptions.map((s) => (
              <option key={s} value={s}>
                {s} (Jul {s - 1} – Jun {s})
              </option>
            ))}
          </select>
        </div>

        {/* Options */}
        <div className="space-y-3">
          <label className="text-sm font-medium text-nav-dark block">Include Sections</label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={showProductDetail}
              onChange={(e) => setShowProductDetail(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
            />
            <div>
              <div className="text-sm font-medium text-nav-dark">Product usage detail</div>
              <div className="text-xs text-secondary">
                Products grouped by category with EPA, rates, and applied amounts
              </div>
            </div>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={showShares}
              onChange={(e) => setShowShares(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
            />
            <div>
              <div className="text-sm font-medium text-nav-dark">Grower shares</div>
              <div className="text-xs text-secondary">
                Display split details and per-acre pricing on shared invoices
              </div>
            </div>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={showYoY}
              onChange={(e) => setShowYoY(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
            />
            <div>
              <div className="text-sm font-medium text-nav-dark">Year-over-year comparison</div>
              <div className="text-xs text-secondary">
                Compare totals, acres, and invoice counts with the prior season
              </div>
            </div>
          </label>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            icon={<FileText className="w-4 h-4" />}
            onClick={handleGenerate}
            loading={loading}
          >
            {batchMode ? `Generate ${batchCount ?? 'All'} Summaries` : 'Generate Summary'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
