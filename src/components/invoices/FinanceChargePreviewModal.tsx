/**
 * FinanceChargePreviewModal — Preview & selectively generate finance charges
 *
 * Sprint 13: Finance Charge Intelligence
 *
 * Shows a DataTable of preview results from preview_finance_charges() RPC,
 * with per-customer checkbox selection. Users can generate charges for
 * selected customers or all at once.
 */
import { useState, useEffect, useCallback } from 'react';
import { parseLocalDate } from '../../lib/dateUtils';
import { Zap, CheckSquare, Square } from 'lucide-react';
import { logActivity } from '../../lib/activityLogger';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { sanitizeError, supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import type { FinanceChargePreview } from '../../types';
import { formatCents as fmtCents } from '../../lib/money';

interface FinanceChargePreviewModalProps {
  open: boolean;
  onClose: () => void;
  asOfDate: string;
  onSuccess: () => void;
}


export default function FinanceChargePreviewModal({
  open,
  onClose,
  asOfDate,
  onSuccess,
}: FinanceChargePreviewModalProps) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const financeChargeIdem = useIdempotencyKey('generate_finance_charges', profile?.id || '');
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [previews, setPreviews] = useState<FinanceChargePreview[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('preview_finance_charges', {
        p_as_of_date: asOfDate,
      });
      if (error) throw error;
      const rows = assertRpcResult<FinanceChargePreview[]>(data, 'preview_finance_charges');
      setPreviews(rows);
      // Select all by default
      setSelected(new Set(rows.map((r) => r.customer_id)));
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'FinanceChargePreviewModal.fetchPreview' } });
      toast('error', sanitizeError(err));
    }
    setLoading(false);
  }, [asOfDate, toast]);

  useEffect(() => {
    if (open) {
      fetchPreview();
    } else {
      setPreviews([]);
      setSelected(new Set());
    }
  }, [open, asOfDate, fetchPreview]);

  const toggleSelect = (customerId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) {
        next.delete(customerId);
      } else {
        next.add(customerId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === previews.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(previews.map((r) => r.customer_id)));
    }
  };

  const totalSelectedCharge = previews
    .filter((p) => selected.has(p.customer_id))
    .reduce((sum, p) => sum + p.charge_amount_cents, 0);

  const handleGenerate = async (customerIds?: string[]) => {
    if (!profile) {
      toast('error', 'Cannot generate finance charges — profile not loaded. Please refresh.');
      return;
    }
    setGenerating(true);
    try {
      const idemKey = financeChargeIdem.getKey();
      const params = {
        p_as_of_date: asOfDate,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
        ...(customerIds ? { p_customer_ids: customerIds } : {}),
      };
      const { data, error } = await supabase.rpc('generate_finance_charges', params);
      if (error) throw error;
      financeChargeIdem.resetKey();
      const result = assertRpcResult<{ charges_generated: number; details: unknown[] }>(data, 'generate_finance_charges');
      if (result.charges_generated === 0) {
        toast('info', 'No finance charges were generated');
      } else {
        logActivity({ event: 'generate_finance_charges', description: `Generated ${result.charges_generated} finance charge invoice(s) as of ${asOfDate}`, performedBy: profile.id });
        toast('success', `Generated ${result.charges_generated} finance charge invoice(s)`);
      }
      onClose();
      onSuccess();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'FinanceChargePreviewModal.handleGenerate' } });
      toast('error', sanitizeError(err));
    }
    setGenerating(false);
  };

  const handleGenerateSelected = () => {
    const ids = Array.from(selected);
    if (ids.length === 0) {
      toast('error', 'Select at least one customer');
      return;
    }
    handleGenerate(ids);
  };

  const handleGenerateAll = () => {
    // Generate for all PREVIEWED customers, not all customers in the system
    const allIds = previews.map((p) => p.customer_id);
    handleGenerate(allIds);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Finance Charge"
      accent="Preview"
      size="large"
    >
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          Preview of finance charges as of <strong>{parseLocalDate(asOfDate).toLocaleDateString()}</strong>.
          Only customers with finance charges enabled, overdue balance above the minimum threshold,
          and past their grace period are shown.
        </p>

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : previews.length === 0 ? (
          <div className="text-center py-8">
            <Zap className="w-10 h-10 text-gray-300 mx-auto mb-2" />
            <p className="text-secondary">No finance charges to generate.</p>
            <p className="text-xs text-secondary mt-1">
              No customers have overdue balances meeting the charge criteria.
            </p>
          </div>
        ) : (
          <>
            {/* Table */}
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-3 py-2.5 text-left">
                      <button
                        onClick={toggleSelectAll}
                        className="text-crx-green hover:text-crx-green/70"
                        title={selected.size === previews.length ? 'Deselect all' : 'Select all'}
                      >
                        {selected.size === previews.length ? (
                          <CheckSquare className="w-4 h-4" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>
                    </th>
                    <th className="px-3 py-2.5 text-left font-medium text-secondary">Customer</th>
                    <th className="px-3 py-2.5 text-left font-medium text-secondary">Acct #</th>
                    <th className="px-3 py-2.5 text-right font-medium text-secondary">Overdue Balance</th>
                    <th className="px-3 py-2.5 text-right font-medium text-secondary">Credit on File</th>
                    <th className="px-3 py-2.5 text-center font-medium text-secondary">Rate</th>
                    <th className="px-3 py-2.5 text-center font-medium text-secondary">Grace</th>
                    <th className="px-3 py-2.5 text-center font-medium text-secondary">Days Late</th>
                    <th className="px-3 py-2.5 text-right font-medium text-secondary">Charge</th>
                  </tr>
                </thead>
                <tbody>
                  {previews.map((p) => (
                    <tr
                      key={p.customer_id}
                      className={`border-b border-gray-100 hover:bg-crx-green-tint cursor-pointer transition-colors ${
                        selected.has(p.customer_id) ? 'bg-crx-green-tint/50' : ''
                      }`}
                      onClick={() => toggleSelect(p.customer_id)}
                    >
                      <td className="px-3 py-2.5">
                        {selected.has(p.customer_id) ? (
                          <CheckSquare className="w-4 h-4 text-crx-green" />
                        ) : (
                          <Square className="w-4 h-4 text-gray-300" />
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-medium text-nav-dark">{p.customer_name}</td>
                      <td className="px-3 py-2.5 text-secondary">{p.account_number || '—'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-red-600">
                        {fmtCents(p.overdue_balance_cents)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {p.open_credit_cents > 0 ? (
                          <span
                            className="font-mono text-amber-600 font-semibold"
                            title="Customer holds unapplied credit - consider applying it to the invoice before charging interest"
                          >
                            {fmtCents(p.open_credit_cents)}
                          </span>
                        ) : (
                          <span className="text-secondary">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <Badge variant="info">{p.charge_rate}%</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-center text-secondary">
                        {p.grace_days > 0 ? `${p.grace_days}d` : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={p.days_overdue > 90 ? 'text-red-600 font-semibold' : 'text-secondary'}>
                          {p.days_overdue}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono font-semibold text-nav-dark">
                        {fmtCents(p.charge_amount_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Summary */}
            <div className="flex items-center justify-between bg-gray-50 px-4 py-3 rounded-lg">
              <span className="text-sm text-secondary">
                {selected.size} of {previews.length} customer{previews.length !== 1 ? 's' : ''} selected
              </span>
              <span className="text-sm font-semibold text-nav-dark">
                Total Charges: <span className="font-mono">{fmtCents(totalSelectedCharge)}</span>
              </span>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                onClick={handleGenerateAll}
                loading={generating}
                icon={<Zap className="w-4 h-4" />}
              >
                Generate All ({previews.length})
              </Button>
              <Button
                onClick={handleGenerateSelected}
                loading={generating}
                icon={<Zap className="w-4 h-4" />}
              >
                Generate Selected ({selected.size})
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
