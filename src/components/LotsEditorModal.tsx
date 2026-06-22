import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { useToast } from './ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../lib/db';
import { fetchRecordLots, fetchRecentLots, saveRecordLots } from '../lib/lotRpc';
import { Sentry } from '../lib/sentry';
import type { ApplicationProduct, ApplicationRecordLotInput, RecentLotForProduct } from '../types';

interface LotsEditorModalProps {
  open: boolean;
  onClose: () => void;
  record: { id: string; record_number: string; product_data: ApplicationProduct[] } | null;
  onSaved?: () => void;
}

interface EditableLot {
  lot_number: string;
  /** Set only when the lot was chosen from a received-lot suggestion. */
  source_receiving_record_id: string | null;
  quantity_from_lot: string;
  unit: string;
}

// Case- and whitespace-insensitive normalization — mirrors the RPC's lower(btrim(...))
// so suggestion matching and the local duplicate check agree with the server.
const norm = (s: string) => s.trim().toLowerCase();

// Distinct catalog-matched products. Blend-sourced records keep one product_data entry
// PER blend_ticket_products row, so the same product_id can appear more than once (a
// chemical split across lots) — dedupe by product_id so each product gets ONE editor
// section (and the save loop counts its lots once). Drops null product_id (can't carry a lot).
function uniqueProducts(productData: ApplicationProduct[]): ApplicationProduct[] {
  const seen = new Set<string>();
  const out: ApplicationProduct[] = [];
  for (const p of productData) {
    if (!p.product_id || seen.has(p.product_id)) continue;
    seen.add(p.product_id);
    out.push(p);
  }
  return out;
}

/**
 * Edit the chemical lot(s) applied per product for one application record.
 * Multiple lots per product; a suggestion dropdown (received lots) with free-type
 * override. Saves the whole set in one replace-all call to set_application_record_lots
 * (the SECURITY DEFINER RPC is the only validated write path — direct table writes are
 * RLS-denied). The migration that creates the table + RPCs is parked pending go-live,
 * so this editor is exercised by a mocked-RPC component test until then.
 */
export default function LotsEditorModal({ open, onClose, record, onSaved }: LotsEditorModalProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const { getKey, resetKey } = useIdempotencyKey('set_application_record_lots', profile?.id || '');
  const [lotsByProduct, setLotsByProduct] = useState<Record<string, EditableLot[]>>({});
  const [suggestionsByProduct, setSuggestionsByProduct] = useState<Record<string, RecentLotForProduct[]>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  // Monotonic load token: a newer load (record switch or reopen) invalidates an in-flight
  // one so a slow resolve for record A can't apply A's lots to record B (replace-all save
  // would then wipe/corrupt B). Every post-await setState is guarded against this.
  const loadIdRef = useRef(0);

  // Distinct catalog-matched products (one editor section each). Null-product rows can't
  // carry a lot and are surfaced as a skipped note.
  const products = uniqueProducts(record?.product_data || []);
  const skippedCount = (record?.product_data || []).filter((p) => !p.product_id).length;

  const load = useCallback(async () => {
    if (!record) return;
    const myLoadId = ++loadIdRef.current; // claim this load; a newer one invalidates it
    const recId = record.id;
    setLoading(true);
    setLoadError(false);
    resetKey(); // each modal open is a fresh save intent
    const prods = uniqueProducts(record.product_data || []);
    try {
      const existing = await fetchRecordLots(recId);
      if (loadIdRef.current !== myLoadId) return; // record switched/closed — drop stale result

      const grouped: Record<string, EditableLot[]> = {};
      existing.forEach((l) => {
        (grouped[l.product_id] ||= []).push({
          lot_number: l.lot_number,
          source_receiving_record_id: l.source_receiving_record_id,
          quantity_from_lot: l.quantity_from_lot != null ? String(l.quantity_from_lot) : '',
          unit: l.unit || '',
        });
      });
      setLotsByProduct(grouped);

      // Suggestions are best-effort: a failure (e.g. RLS denial) must not block editing.
      const sugg: Record<string, RecentLotForProduct[]> = {};
      await Promise.all(
        prods.map(async (p) => {
          try {
            sugg[p.product_id] = await fetchRecentLots(p.product_id);
          } catch {
            /* optional suggestions — ignore and let the user free-type */
          }
        })
      );
      if (loadIdRef.current !== myLoadId) return;
      setSuggestionsByProduct(sugg);
    } catch (err) {
      if (loadIdRef.current !== myLoadId) return; // stale failure — don't disturb the current record
      Sentry.captureException(err, { tags: { source: 'fetch', action: 'load_application_record_lots' } });
      toast('error', 'Failed to load lots');
      // Block saving: with existing lots unloaded, a replace-all save would wipe them.
      setLoadError(true);
    } finally {
      if (loadIdRef.current === myLoadId) setLoading(false);
    }
  }, [record, toast, resetKey]);

  useEffect(() => {
    if (open && record) load();
    if (!open) {
      loadIdRef.current++; // invalidate any in-flight load for the closing record
      setLotsByProduct({});
      setSuggestionsByProduct({});
      setLoadError(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record?.id]);

  const addLot = (pid: string) =>
    setLotsByProduct((m) => ({
      ...m,
      [pid]: [...(m[pid] || []), { lot_number: '', source_receiving_record_id: null, quantity_from_lot: '', unit: '' }],
    }));

  const removeLot = (pid: string, idx: number) =>
    setLotsByProduct((m) => ({ ...m, [pid]: (m[pid] || []).filter((_, i) => i !== idx) }));

  const updateLot = (pid: string, idx: number, patch: Partial<EditableLot>) =>
    setLotsByProduct((m) => {
      const rows = [...(m[pid] || [])];
      rows[idx] = { ...rows[idx], ...patch };
      return { ...m, [pid]: rows };
    });

  // When the lot text matches a suggestion, carry its receiving_record_id so the saved
  // row keeps the receipt link (and passes the RPC's source-receipt validation). A free-typed
  // value clears the link.
  const onLotNumberChange = (pid: string, idx: number, value: string) => {
    const match = (suggestionsByProduct[pid] || []).find((s) => norm(s.lot_number) === norm(value));
    updateLot(pid, idx, { lot_number: value, source_receiving_record_id: match ? match.receiving_record_id : null });
  };

  const handleSave = async () => {
    if (!record || !profile) return;
    // Never replace-all from an unloaded state — that would delete existing lots.
    if (loadError) return;

    const p_lots: ApplicationRecordLotInput[] = [];
    const seen = new Set<string>();
    for (const p of products) {
      for (const row of lotsByProduct[p.product_id] || []) {
        const lot = row.lot_number.trim();
        if (!lot) continue; // skip empty rows
        const key = `${p.product_id}|${norm(lot)}`;
        if (seen.has(key)) {
          toast('error', `"${lot}" is listed more than once for ${p.product_name}`);
          return;
        }
        seen.add(key);
        const qtyRaw = row.quantity_from_lot.trim();
        const qty = qtyRaw === '' ? null : Number(qtyRaw);
        if (qty !== null && (!Number.isFinite(qty) || qty < 0)) {
          toast('error', `Invalid quantity for lot "${lot}"`);
          return;
        }
        p_lots.push({
          product_id: p.product_id,
          lot_number: lot,
          source_receiving_record_id: row.source_receiving_record_id,
          quantity_from_lot: qty,
          unit: row.unit.trim() || null,
        });
      }
    }

    setSaving(true);
    try {
      const result = await saveRecordLots({
        p_application_record_id: record.id,
        p_lots,
        p_performed_by: profile.id,
        p_idempotency_key: getKey(),
      });
      resetKey(); // success — next save is a new intent
      toast('success', `Saved ${result.count} lot${result.count !== 1 ? 's' : ''}`);
      onSaved?.();
      onClose();
    } catch (err) {
      // Keep the idempotency key (no resetKey) so a retry deduplicates on the server.
      let msg: string;
      if (hasRpcCode(err, RpcErrorCodes.DUPLICATE_LOT)) msg = 'The same lot is listed more than once for a product.';
      else if (hasRpcCode(err, RpcErrorCodes.PRODUCT_NOT_ON_RECORD)) msg = 'A lot references a product that is not on this record.';
      else if (hasRpcCode(err, RpcErrorCodes.SOURCE_RECEIPT_MISMATCH)) msg = 'A chosen received lot no longer matches its product/lot — re-pick it from the list.';
      else if (hasRpcCode(err, RpcErrorCodes.LOT_MISSING_NUMBER)) msg = 'Every lot needs a lot number.';
      else if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) msg = 'You do not have permission to edit lots.';
      else msg = sanitizeError(err);
      Sentry.captureException(err, { tags: { source: 'rpc', action: 'set_application_record_lots' } });
      toast('error', msg);
    } finally {
      setSaving(false);
    }
  };

  if (!record) return null;

  return (
    <Modal open={open} onClose={onClose} title="Lots —" accent={record.record_number} size="large">
      <div className="space-y-5">
        <p className="text-sm text-secondary">
          Record which product lot(s) were applied, so a lot can later be traced to its fields, dates, and customers.
          Pick a received lot from the list or type one in. Multiple lots per product are allowed.
        </p>

        {loading ? (
          <div className="py-8 text-center text-sm text-secondary">Loading lots…</div>
        ) : loadError ? (
          <div className="py-8 text-center text-sm text-red-600">
            Couldn't load this record's existing lots. Close and reopen to try again — saving is
            disabled so nothing already recorded gets overwritten.
          </div>
        ) : products.length === 0 ? (
          <div className="py-8 text-center text-sm text-secondary">
            No catalog-matched products on this record, so lots can't be recorded here.
          </div>
        ) : (
          <div className="space-y-4">
            {products.map((p) => {
              const rows = lotsByProduct[p.product_id] || [];
              const listId = `lots-${p.product_id}`;
              return (
                <div key={p.product_id} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-nav-dark">{p.product_name}</h4>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Plus className="w-4 h-4" />}
                      showChevron={false}
                      onClick={() => addLot(p.product_id)}
                    >
                      Add lot
                    </Button>
                  </div>

                  <datalist id={listId}>
                    {(suggestionsByProduct[p.product_id] || []).map((s) => (
                      <option key={s.receiving_record_id} value={s.lot_number} />
                    ))}
                  </datalist>

                  {rows.length === 0 ? (
                    <p className="text-xs text-secondary">No lots recorded for this product.</p>
                  ) : (
                    <div className="space-y-2">
                      {rows.map((row, idx) => (
                        <div key={idx} className="flex flex-wrap items-center gap-2">
                          <input
                            list={listId}
                            value={row.lot_number}
                            onChange={(e) => onLotNumberChange(p.product_id, idx, e.target.value)}
                            placeholder="Lot number"
                            aria-label={`Lot number for ${p.product_name}`}
                            className="flex-1 min-w-[10rem] px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                          />
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={row.quantity_from_lot}
                            onChange={(e) => updateLot(p.product_id, idx, { quantity_from_lot: e.target.value })}
                            placeholder="Qty (optional)"
                            aria-label={`Quantity from lot for ${p.product_name}`}
                            className="w-28 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                          />
                          <input
                            value={row.unit}
                            onChange={(e) => updateLot(p.product_id, idx, { unit: e.target.value })}
                            placeholder="Unit"
                            aria-label={`Unit for ${p.product_name}`}
                            className="w-24 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                          />
                          <button
                            type="button"
                            onClick={() => removeLot(p.product_id, idx)}
                            aria-label={`Remove lot ${idx + 1} for ${p.product_name}`}
                            className="p-2 text-secondary hover:text-red-600 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {skippedCount > 0 && (
              <p className="text-xs text-secondary">
                {skippedCount} product line(s) without a catalog match are not shown — lots need a matched product.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
          <Button variant="secondary" showChevron={false} onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            showChevron={false}
            onClick={handleSave}
            disabled={saving || loading || loadError || products.length === 0}
          >
            {saving ? 'Saving…' : 'Save lots'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
