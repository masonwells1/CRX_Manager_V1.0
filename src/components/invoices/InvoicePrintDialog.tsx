import { useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Printer } from 'lucide-react';
import type { InvoicePrintOptions } from '../../types';

interface InvoicePrintDialogProps {
  open: boolean;
  onClose: () => void;
  invoiceType: string;
  hasShares: boolean;
  onPrint: (options: InvoicePrintOptions) => void;
  loading?: boolean;
}

export default function InvoicePrintDialog({
  open,
  onClose,
  invoiceType,
  hasShares,
  onPrint,
  loading = false,
}: InvoicePrintDialogProps) {
  const isFieldApp = invoiceType === 'field_application';

  const [showShares, setShowShares] = useState(isFieldApp && hasShares);
  const [showPricePerAcre, setShowPricePerAcre] = useState(isFieldApp);
  const [showEpa, setShowEpa] = useState(true);
  // Field-app parity #30: ChemMan "Print" (current) vs "Old Print" (legacy).
  const [format, setFormat] = useState<'current' | 'legacy'>('current');

  const handlePrint = () => {
    onPrint({
      show_shares: showShares,
      show_price_per_acre: showPricePerAcre,
      show_epa_registration: showEpa,
      format,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Print Invoice">
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          Choose the format and which details to include in the PDF.
        </p>

        {/* Format: current vs legacy "Old Print" (field-app parity #30) */}
        <div>
          <div className="text-xs font-medium text-secondary mb-1.5">Format</div>
          <div className="inline-flex rounded-lg border border-gray-200 p-0.5">
            <button
              type="button"
              onClick={() => setFormat('current')}
              aria-pressed={format === 'current'}
              className={`px-3 py-1.5 text-sm rounded-md transition ${format === 'current' ? 'bg-crx-green text-white' : 'text-nav-dark hover:bg-gray-50'}`}
            >
              Current
            </button>
            <button
              type="button"
              onClick={() => setFormat('legacy')}
              aria-pressed={format === 'legacy'}
              className={`px-3 py-1.5 text-sm rounded-md transition ${format === 'legacy' ? 'bg-crx-green text-white' : 'text-nav-dark hover:bg-gray-50'}`}
            >
              Old Print
            </button>
          </div>
          <p className="text-xs text-secondary mt-1">
            {format === 'legacy'
              ? 'The plain, monochrome legacy layout some growers still expect.'
              : 'The modern CRX-branded invoice layout.'}
          </p>
        </div>

        <div className="space-y-3">
          {hasShares && (
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={showShares}
                onChange={(e) => setShowShares(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
              />
              <div>
                <div className="text-sm font-medium text-nav-dark">Show grower shares</div>
                <div className="text-xs text-secondary">Display split percentages, acres, and amounts per grower</div>
              </div>
            </label>
          )}

          {isFieldApp && (
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={showPricePerAcre}
                onChange={(e) => setShowPricePerAcre(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
              />
              <div>
                <div className="text-sm font-medium text-nav-dark">Show price per acre</div>
                <div className="text-xs text-secondary">Display the total cost divided by acres treated</div>
              </div>
            </label>
          )}

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={showEpa}
              onChange={(e) => setShowEpa(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
            />
            <div>
              <div className="text-sm font-medium text-nav-dark">Show EPA registration numbers</div>
              <div className="text-xs text-secondary">Include EPA reg # column in the product table</div>
            </div>
          </label>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            icon={<Printer className="w-4 h-4" />}
            onClick={handlePrint}
            loading={loading}
          >
            Download PDF
          </Button>
        </div>
      </div>
    </Modal>
  );
}
