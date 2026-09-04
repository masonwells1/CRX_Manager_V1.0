import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, CheckCircle, XCircle } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import {
  resolveCycleCountWriteIntent,
  type CycleCountWriteIntent,
} from '../lib/cycleCountWriteIntent';
import { logActivity } from '../lib/activityLogger';
import HelpTip from '../components/ui/HelpTip';
import type { CycleCount, CycleCountItem } from '../types';

type CountRow = CycleCount & {
  initiator_name: string;
  completer_name: string | null;
  item_count: number;
  counted_count: number;
  variance_count: number;
};

type CountItemRow = CycleCountItem & {
  product_name: string;
};

type CompletionSnapshot = {
  items: CountItemRow[];
  itemRevision: number;
};

interface CycleCountDbRow {
  id: string;
  initiator?: { full_name: string } | null;
  completer?: { full_name: string } | null;
  items?: Array<{ is_counted: boolean; variance: number | null }>;
  [key: string]: unknown;
}

interface InventoryDbRow {
  id: string;
  product_id: string;
  quantity_available: number;
  product?: { product_name: string } | null;
}

interface CountItemDbRow {
  product?: { product_name: string } | null;
  [key: string]: unknown;
}

// Failed item writes are keyed by their OWNING cycle count so a failure in one
// count cannot block completing another. Cycle-count ids are UUIDs and never
// contain ':', so this prefix is unambiguous.
const failedItemWriteKey = (cycleCountId: string, itemId: string) => `${cycleCountId}:${itemId}`;

export default function CycleCounts() {
  const { profile, role } = useAuth();
  const { toast } = useToast();
  const completeCycleCountIdem = useIdempotencyKey('complete_cycle_count', profile?.id || '');
  const updateCycleCountItemIdem = useIdempotencyKey('update_cycle_count_item', profile?.id || '');
  const reverseCycleCountIdem = useIdempotencyKey('reverse_cycle_count', profile?.id || '');
  const cancelCycleCountIdem = useIdempotencyKey('cancel_cycle_count', profile?.id || '');
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  // New count modal
  const [showNew, setShowNew] = useState(false);
  const [newWarehouse, setNewWarehouse] = useState('Main Warehouse');
  const [newNotes, setNewNotes] = useState('');
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  // Count detail modal
  const [showDetail, setShowDetail] = useState(false);
  const [activeCount, setActiveCount] = useState<CountRow | null>(null);
  const [countItems, setCountItems] = useState<CountItemRow[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeConfirmOpen, setCompleteConfirmOpen] = useState(false);
  // The cycle count the open "complete anyway?" confirmation was asked ABOUT.
  // The confirm path completes without re-running the uncounted-items check —
  // correct for the count the operator answered for, dangerous for any other —
  // so the answer has to carry the record identity, not just a boolean.
  const [completeConfirmCountId, setCompleteConfirmCountId] = useState<string | null>(null);
  const [completeConfirmMsg, setCompleteConfirmMsg] = useState("");
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [reverseConfirmOpen, setReverseConfirmOpen] = useState(false);
  const [preparingCompletion, setPreparingCompletion] = useState(false);
  const itemWriteQueuesRef = useRef(new Map<string, Promise<void>>());
  const pendingItemWritesRef = useRef(new Set<Promise<void>>());
  const failedItemWritesRef = useRef(new Set<string>());
  const itemWriteIntentsRef = useRef(new Map<string, CycleCountWriteIntent>());
  const itemWriteSequenceRef = useRef(0);
  const completionInFlightRef = useRef(false);

  const isAdmin = role === 'admin';

  const fetchCounts = useCallback(async () => {
    setLoading(true);
    // PR-07 follow-up: dropped initiator + completer FK embeds; resolved via profile_public_view.
    const { data, error } = await supabase
      .from('cycle_counts')
      .select(`
        *,
        items:cycle_count_items(id, is_counted, variance)
      `)
      .order('created_at', { ascending: false });

    if (error) {
      Sentry.captureException(error);
      toast('error', 'Failed to load cycle counts');
      setLoading(false);
      return;
    }

    const profileIds = [...new Set([
      ...((data || []) as Array<{ initiated_by?: string | null }>).map((c) => c.initiated_by),
      ...((data || []) as Array<{ completed_by?: string | null }>).map((c) => c.completed_by),
    ].filter(Boolean) as string[])];
    const profileMap: Record<string, string> = {};
    if (profileIds.length > 0) {
      const { data: profs } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', profileIds);
      (profs || []).forEach((p: { id: string | null; full_name: string | null }) => { if (p.id) profileMap[p.id] = p.full_name ?? ''; });
    }

    const rows: CountRow[] = ((data || []) as Array<CycleCountDbRow & { initiated_by?: string | null; completed_by?: string | null }>).map((c) => ({
      ...c,
      initiator_name: c.initiated_by ? profileMap[c.initiated_by] || 'Unknown' : 'Unknown',
      completer_name: c.completed_by ? profileMap[c.completed_by] || null : null,
      item_count: c.items?.length || 0,
      counted_count: c.items?.filter((i) => i.is_counted).length || 0,
      variance_count: c.items?.filter((i) => i.variance && i.variance !== 0).length || 0,
    })) as CountRow[];
    setCounts(rows);
    setLoading(false);
  }, [toast]);

  const fetchWarehouses = useCallback(async () => {
    // Pull unique locations from inventory + warehouses table
    const [invRes, whRes] = await Promise.all([
      supabase.from('inventory').select('location'),
      supabase.from('warehouses').select('name').eq('is_active', true),
    ]);
    const invLocs = [...new Set((invRes.data || []).map((r: { location: string | null }) => r.location).filter(Boolean) as string[])];
    const whLocs = (whRes.data || []).map((r: { name: string }) => r.name);
    const all = [...new Set([...invLocs, ...whLocs])].sort();
    setWarehouses(all);
  }, []);

  useEffect(() => {
    fetchCounts();
    fetchWarehouses();
  }, [fetchCounts, fetchWarehouses]);

  const filtered = counts.filter((c) => {
    if (statusFilter && c.status !== statusFilter) return false;
    return true;
  });

  // Create new cycle count
  const handleCreate = async () => {
    if (!profile) return;

    await runCriticalAction({
      action: async () => {
        // Generate sequential count number via advisory-lock RPC
        const { data: countNumData, error: countNumError } = await supabase.rpc('next_cycle_count_number');
        if (countNumError) throw countNumError;
        const countNum = assertRpcResult<string>(countNumData, 'next_cycle_count_number');

        // Fetch inventory items for the selected warehouse
        const { data: invData, error: invError } = await supabase
          .from('inventory')
          .select('id, product_id, quantity_available, product:products(product_name)')
          .eq('location', newWarehouse)
          .order('product_id');

        if (invError) throw invError;
        const invItems = (invData || []) as unknown as InventoryDbRow[];

        if (invItems.length === 0) {
          throw new Error('No inventory found at this location');
        }

        // Create the cycle count
        const { data: cc, error: ccError } = await supabase
          .from('cycle_counts')
          .insert({
            count_number: countNum,
            warehouse: newWarehouse,
            status: 'in_progress',
            notes: newNotes || null,
          })
          .select()
          .single();

        if (ccError) throw ccError;

        // Insert items
        const items = invItems.map((inv) => ({
          cycle_count_id: cc.id,
          product_id: inv.product_id,
          inventory_id: inv.id,
          expected_qty: inv.quantity_available || 0,
        }));

        const { error: itemsError } = await supabase
          .from('cycle_count_items')
          .insert(items);

        if (itemsError) throw itemsError;

        await logActivity({ event: 'cycle_count_started', description: `Cycle count ${countNum} started for ${newWarehouse} (${invItems.length} products)`, performedBy: profile.id, entityType: 'cycle_count', entityId: cc.id });

        return `Cycle count ${countNum} created with ${invItems.length} products`;
      },
      toast,
      setLoading: setCreating,
      successMessage: 'Cycle count created',
      sentryTag: 'create_cycle_count',
      onSuccess: () => {
        setShowNew(false);
        setNewNotes('');
        fetchCounts();
      },
    });
  };

  // Open detail modal
  const openDetail = async (count: CountRow) => {
    setActiveCount(count);
    setShowDetail(true);
    setLoadingItems(true);

    // Seed the reviewed-revision baseline from the server before loading items.
    // The list row this modal opened from can be minutes old, and completion now
    // compares what the operator has actually reviewed against the authoritative
    // revision; seeding from a stale list row would warn about a change the
    // operator is already looking at. Reading the revision BEFORE the items is
    // the fail-safe order: if an item changes while the item snapshot loads, the
    // seeded revision is the older one, so completion warns (or the server
    // refuses) rather than silently adopting the change.
    const { data: revisionRow, error: revisionError } = await supabase
      .from('cycle_counts')
      .select('item_revision')
      .eq('id', count.id)
      .single();
    if (revisionError) {
      Sentry.captureException(revisionError);
    } else if (typeof revisionRow?.item_revision === 'number') {
      setActiveCount((previousCount) =>
        previousCount && previousCount.id === count.id
          ? { ...previousCount, item_revision: revisionRow.item_revision }
          : previousCount
      );
    }

    const { data, error } = await supabase
      .from('cycle_count_items')
      .select('*, product:products(product_name)')
      .eq('cycle_count_id', count.id)
      .order('created_at');

    if (error) {
      Sentry.captureException(error);
      toast('error', 'Failed to load count items');
    }

    const rows: CountItemRow[] = ((data || []) as CountItemDbRow[]).map((item) => ({
      ...item,
      product_name: item.product?.product_name || 'Unknown',
    })) as CountItemRow[];
    setCountItems(rows);
    setLoadingItems(false);
  };

  const refreshCountItems = async (cycleCountId: string): Promise<CountItemRow[] | null> => {
    const { data, error } = await supabase
      .from('cycle_count_items')
      .select('*, product:products(product_name)')
      .eq('cycle_count_id', cycleCountId)
      .order('created_at');
    if (error) {
      Sentry.captureException(error);
      toast('error', 'Failed to refresh count items before completion');
      return null;
    }
    const rows = ((data || []) as CountItemDbRow[]).map((item) => ({
      ...item,
      product_name: item.product?.product_name || 'Unknown',
    })) as CountItemRow[];
    setCountItems(rows);
    return rows;
  };

  // Update a single item's counted quantity (via RPC — server validates parent.status='in_progress').
  // Queue writes per item so a slow earlier keystroke cannot arrive after a newer value and overwrite it.
  const updateCountedQty = async (itemId: string, countedQty: number | null) => {
    const item = countItems.find((i) => i.id === itemId);
    if (!item || !profile || completionInFlightRef.current) return;

    // Reject non-finite quantities before they reach the write intent. A
    // type="number" box accepts "1e309", which parseFloat turns into Infinity,
    // and JSON.stringify canonicalizes Infinity/NaN to null. That made a garbage
    // entry produce byte-identical valueKey/scope to a deliberate "clear this
    // count" (JSON.stringify([null, null])) — so it both collided with that
    // intent and sent null to the server, silently CLEARING the counted quantity
    // instead of reporting bad input.
    if (countedQty !== null && !Number.isFinite(countedQty)) {
      toast('error', 'Enter a valid count quantity.');
      return;
    }

    const variance = countedQty !== null ? countedQty - item.expected_qty : null;
    const variancePct = countedQty !== null && item.expected_qty !== 0
      ? Math.round(((variance || 0) / item.expected_qty) * 100 * 100) / 100
      : null;
    // Retain one key for an uncertain same-value retry, but advance the local
    // sequence whenever the requested value changes. This makes A -> B -> A
    // three distinct intents instead of replaying the first A after B.
    const resolvedIntent = resolveCycleCountWriteIntent(
      itemId,
      countedQty,
      itemWriteIntentsRef.current.get(itemId),
      itemWriteSequenceRef.current,
    );
    itemWriteSequenceRef.current = resolvedIntent.nextSequence;
    itemWriteIntentsRef.current.set(itemId, resolvedIntent.intent);
    const intentScope = resolvedIntent.intent.scope;
    const idempotencyKey = updateCycleCountItemIdem.getKeyFor(intentScope);

    const previous = itemWriteQueuesRef.current.get(itemId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      try {
      const { data, error } = await supabase.rpc('update_cycle_count_item', {
        p_item_id: itemId,
        p_counted_qty: countedQty ?? undefined,
        p_performed_by: profile.id,
        p_idempotency_key: idempotencyKey,
      });

      if (error) {
        failedItemWritesRef.current.add(failedItemWriteKey(item.cycle_count_id, itemId));
        Sentry.captureException(error);
        toast('error', error.message || 'Failed to update count');
        return;
      }
      const result = assertRpcResult<{ item_revision: number }>(data, 'update_cycle_count_item');
      updateCycleCountItemIdem.resetKeyFor(intentScope);
      if (itemWriteIntentsRef.current.get(itemId)?.scope === intentScope) {
        itemWriteIntentsRef.current.delete(itemId);
      }
      failedItemWritesRef.current.delete(failedItemWriteKey(item.cycle_count_id, itemId));
      setActiveCount((previousCount) =>
        previousCount && previousCount.id === item.cycle_count_id
          ? { ...previousCount, item_revision: result.item_revision }
          : previousCount
      );

      setCountItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? {
                ...i,
                counted_qty: countedQty,
                variance,
                variance_pct: variancePct !== null ? Math.round(variancePct * 100) / 100 : null,
                is_counted: countedQty !== null,
                counted_by: profile.id,
                counted_at: new Date().toISOString(),
              }
            : i
        )
      );
      } catch (writeErr) {
        // A transport rejection or an assertRpcResult contract failure has to be
        // recorded exactly like a returned { error }. It used to escape this
        // queued task instead: no failed-write marker, no toast — and the
        // rejected promise was then dropped from pendingItemWritesRef by the
        // finally below. The first completion attempt died on Promise.all with
        // no explanation, and the SECOND saw a clean pending set and committed
        // the stale authoritative quantity, silently discarding the operator's
        // edit as an inventory adjustment.
        failedItemWritesRef.current.add(failedItemWriteKey(item.cycle_count_id, itemId));
        Sentry.captureException(writeErr);
        toast('error', 'Failed to save this count. Re-enter the quantity before completing.');
      }
    });
    itemWriteQueuesRef.current.set(itemId, write);
    pendingItemWritesRef.current.add(write);
    try {
      await write;
    } finally {
      pendingItemWritesRef.current.delete(write);
      if (itemWriteQueuesRef.current.get(itemId) === write) itemWriteQueuesRef.current.delete(itemId);
    }
  };

  // Complete the cycle count
  const waitForAuthoritativeCountItems = async (): Promise<CompletionSnapshot | null> => {
    await Promise.all([...pendingItemWritesRef.current]);
    if (!activeCount) return null;
    // Failed writes are tracked per cycle count, not component-wide. A failure
    // left behind in count A must not block completing count B: this set
    // outlives the detail modal, so an unscoped check wedged every other count
    // until the operator reopened A or reloaded the page.
    const activeFailurePrefix = failedItemWriteKey(activeCount.id, '');
    if ([...failedItemWritesRef.current].some((key) => key.startsWith(activeFailurePrefix))) {
      toast('error', 'Fix the failed count update before completing this cycle count.');
      return null;
    }
    // Read the revision first. If any item changes while the item snapshot is
    // loading, its trigger advances this revision and completion fails closed.
    const { data: countState, error: countStateError } = await supabase
      .from('cycle_counts')
      .select('item_revision, status')
      .eq('id', activeCount.id)
      .single();
    if (countStateError) {
      Sentry.captureException(countStateError);
      toast('error', 'Failed to refresh the cycle count revision before completion');
      return null;
    }
    if (countState.status !== 'in_progress') {
      toast('error', 'This cycle count is no longer in progress. Refresh before continuing.');
      return null;
    }
    if (typeof countState.item_revision !== 'number') {
      toast('error', 'Cycle count revision protection is not available. Refresh after the database update completes.');
      return null;
    }

    // Capture what the operator has actually reviewed BEFORE the refresh below
    // overwrites it. Own edits keep this in sync (update_cycle_count_item stores
    // the returned revision on activeCount), so a mismatch here means ANOTHER
    // client changed an item.
    const reviewedRevision = activeCount.item_revision;

    const items = await refreshCountItems(activeCount.id);
    if (!items) return null;

    setActiveCount((previousCount) =>
      previousCount && previousCount.id === activeCount.id
        ? { ...previousCount, item_revision: countState.item_revision }
        : previousCount
    );

    // p_expected_item_revision fails closed only for a change that lands DURING
    // completion. A change that landed BEFORE the click would otherwise be
    // adopted silently: the screen showed 10, another tab set 100, and
    // completion committed an inventory adjustment for 100 that the operator
    // never saw. The refresh above has put the real numbers on screen; require a
    // second, explicit click now that they are visible. The next click matches,
    // because setActiveCount has advanced the reviewed baseline.
    // Fail CLOSED when the reviewed baseline is missing, not open. item_revision
    // is optional on the type and the openDetail seed read can fail, and an
    // earlier version skipped the comparison in that case — which silently
    // restored the exact bug this guard exists to close. With no baseline we
    // cannot know whether the refreshed rows are what the operator reviewed, so
    // treat it the same as a mismatch. setActiveCount above has just stored the
    // authoritative revision, so the next click has a baseline and proceeds.
    if (typeof reviewedRevision !== 'number') {
      toast('error', 'Could not confirm which quantities you reviewed. The list has been refreshed — review the quantities, then complete again.');
      return null;
    }
    if (reviewedRevision !== countState.item_revision) {
      toast('error', 'These counts were changed somewhere else while this count was open. The list has been refreshed — review the updated quantities, then complete again.');
      return null;
    }

    return { items, itemRevision: countState.item_revision };
  };

  const handleComplete = async () => {
    if (!activeCount || !profile) return;
    if (completionInFlightRef.current) return;
    completionInFlightRef.current = true;
    setPreparingCompletion(true);

    try {
      const snapshot = await waitForAuthoritativeCountItems();
      if (!snapshot) return;

      const uncounted = snapshot.items.filter((i) => !i.is_counted);
      if (uncounted.length > 0) {
        setCompleteConfirmMsg(`${uncounted.length} products have not been counted yet. Complete anyway?`);
        setCompleteConfirmCountId(activeCount.id);
        setCompleteConfirmOpen(true);
        return;
      }

      await executeComplete(snapshot);
    } finally {
      completionInFlightRef.current = false;
      setPreparingCompletion(false);
    }
  };

  const executeComplete = async (snapshot?: CompletionSnapshot) => {
    setCompleteConfirmOpen(false);
    if (!activeCount || !profile) return;

    if (!snapshot) {
      // This branch runs from the confirmation dialog, and it deliberately does
      // NOT re-check uncounted items — the operator already answered "complete
      // anyway". That answer is only valid for the count it was asked about. The
      // dialog's state is separate from the detail modal's, so a count switch
      // between question and answer would otherwise complete a DIFFERENT count,
      // skipping its uncounted check, on the strength of another count's yes.
      const confirmedFor = completeConfirmCountId;
      setCompleteConfirmCountId(null);
      if (confirmedFor !== activeCount.id) {
        toast('error', 'That confirmation was for a different cycle count. Open the count you want to complete and try again.');
        return;
      }
      if (completionInFlightRef.current) return;
      completionInFlightRef.current = true;
      setPreparingCompletion(true);
      try {
        const refreshedSnapshot = await waitForAuthoritativeCountItems();
        if (refreshedSnapshot) await executeComplete(refreshedSnapshot);
      } finally {
        completionInFlightRef.current = false;
        setPreparingCompletion(false);
      }
      return;
    }

    await runCriticalAction({
      action: async () => {
        // Scope the completion key to this exact count and expected revision.
        // An unscoped key survived closing count A, so completing count B
        // replayed A's key, the server wrapper raised a payload conflict, and
        // every retry for B failed until the page was reloaded.
        const completionScope = `complete:${activeCount.id}:${snapshot.itemRevision}`;
        const key = completeCycleCountIdem.getKeyFor(completionScope);
        // complete_cycle_count RETURNS void — .throwOnError() for fire-and-forget.
        try {
          await supabase.rpc('complete_cycle_count', {
            p_cycle_count_id: activeCount.id,
            p_completed_by: profile.id,
            p_idempotency_key: key,
            p_expected_item_revision: snapshot.itemRevision,
          }).throwOnError();
        } catch (completionErr) {
          // A change that lands DURING completion is refused by
          // p_expected_item_revision. Without this branch the operator saw only
          // the sanitized raw exception ("CYCLE_COUNT_STALE_REVISION") with no
          // refreshed list and no instruction. Pull the authoritative rows back
          // in and say plainly what happened; the reviewed-revision baseline
          // advances with them, so the next click completes what is on screen.
          if (hasRpcCode(completionErr, RpcErrorCodes.CYCLE_COUNT_STALE_REVISION)) {
            await waitForAuthoritativeCountItems();
            throw new Error(
              'Someone changed a counted quantity while this count was being completed. The list has been refreshed — review the updated quantities, then complete again.'
            );
          }
          throw completionErr;
        }
        completeCycleCountIdem.resetKeyFor(completionScope);

        const varianceItems = snapshot.items.filter((i) => i.variance && i.variance !== 0);

        // The count is COMMITTED and its key is retired by this point, so the
        // inventory adjustment has already happened. Activity logging is a
        // post-commit side effect: letting it reject here would surface a
        // failure toast for a completion that succeeded, and the retry then
        // runs under a fresh key against an already-completed count.
        try {
          await logActivity({ event: 'cycle_count_completed', description: `Cycle count ${activeCount.count_number} completed — ${varianceItems.length} variances found`, performedBy: profile.id, entityType: 'cycle_count', entityId: activeCount.id });
        } catch (logErr) {
          Sentry.captureException(logErr);
        }
      },
      toast,
      setLoading: setCompleting,
      successMessage: 'Cycle count completed',
      sentryTag: 'complete_cycle_count',
      onSuccess: () => {
        setShowDetail(false);
        fetchCounts();
      },
    });
  };

  // Cancel cycle count
  const handleCancel = () => {
    if (!activeCount || !profile) return;
    setCancelConfirmOpen(true);
  };

  const executeCancelCount = async () => {
    setCancelConfirmOpen(false);
    if (!activeCount || !profile) return;

    await runCriticalAction({
      action: async () => {
        const key = cancelCycleCountIdem.getKey();
        const { data, error } = await supabase.rpc('cancel_cycle_count', {
          p_cycle_count_id: activeCount.id,
          p_performed_by: profile.id,
          p_idempotency_key: key,
        });
        if (error) throw error;
        assertRpcResult(data, 'cancel_cycle_count');
        cancelCycleCountIdem.resetKey();
      },
      toast,
      successMessage: 'Cycle count cancelled',
      sentryTag: 'cancel_cycle_count',
      onSuccess: () => {
        setShowDetail(false);
        fetchCounts();
      },
    });
  };

  // Reverse a completed cycle count (undo inventory adjustments)
  const handleReverse = () => {
    if (!activeCount || !profile) return;
    setReverseConfirmOpen(true);
  };

  const doReverse = async () => {
    if (!activeCount || !profile) return;
    setReverseConfirmOpen(false);

    setReversing(true);
    try {
      const key = reverseCycleCountIdem.getKey();
      // reverse_completed_cycle_count RETURNS void — .throwOnError() for fire-and-forget.
      await supabase.rpc('reverse_completed_cycle_count', {
        p_cycle_count_id: activeCount.id,
        p_reversed_by: profile.id,
        p_idempotency_key: key,
      }).throwOnError();
      reverseCycleCountIdem.resetKey();

      await logActivity({ event: 'cycle_count_reversed', description: `Cycle count ${activeCount.count_number} reversed — inventory adjustments undone`, performedBy: profile.id, entityType: 'cycle_count', entityId: activeCount.id });

      toast('success', `Cycle count ${activeCount.count_number} reversed. Inventory restored.`);
      setShowDetail(false);
      fetchCounts();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'reverse_cycle_count' } });
      toast('error', err instanceof Error ? err.message : 'Failed to reverse cycle count');
    } finally {
      setReversing(false);
    }
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case 'in_progress':
        return <Badge variant="info">In Progress</Badge>;
      case 'completed':
        return <Badge variant="success">Completed</Badge>;
      case 'cancelled':
        return <Badge variant="default">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const columns: Column<CountRow>[] = [
    {
      key: 'count_number',
      header: 'Count #',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.count_number}</span>,
    },
    {
      key: 'warehouse',
      header: 'Location',
      sortable: true,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => statusBadge(row.status),
    },
    {
      key: 'item_count',
      header: 'Products',
      render: (row) => (
        <span>
          {row.counted_count}/{row.item_count} counted
        </span>
      ),
    },
    {
      key: 'variance_count',
      header: 'Variances',
      render: (row) => (
        <span className={row.variance_count > 0 ? 'text-red-600 font-medium' : 'text-gray-500'}>
          {row.variance_count}
        </span>
      ),
    },
    {
      key: 'initiator_name',
      header: 'Started By',
      render: (row) => <span className="text-sm">{row.initiator_name}</span>,
    },
    {
      key: 'started_at',
      header: 'Started',
      sortable: true,
      render: (row) => (
        <span className="text-sm text-gray-500">
          {new Date(row.started_at).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h2 className="text-xl font-semibold font-heading text-nav-dark">
          Cycle Counts
          <HelpTip text="Verify physical inventory against system records. Create a count, enter actual quantities, then complete to auto-adjust inventory. Variances are logged in the transaction ledger for audit." className="ml-1" />
        </h2>
        {isAdmin && (
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowNew(true)}>
            New Cycle Count
          </Button>
        )}
      </div>

      <Card padding={false}>
        <div className="p-5">
          <DataTable<CountRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search counts..."
            searchKeys={['count_number', 'warehouse']}
            onRowClick={(row) => openDetail(row)}
            emptyTitle="No cycle counts yet"
            emptyDescription="Start a cycle count to verify inventory quantities"
            emptyAction={
              isAdmin ? (
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowNew(true)}>
                  New Cycle Count
                </Button>
              ) : undefined
            }
            loading={loading}
            filters={
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label="Filter by status"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Statuses</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            }
          />
        </div>
      </Card>

      {/* New Cycle Count Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="Start New Cycle Count">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Warehouse / Location</label>
            <select
              value={newWarehouse}
              onChange={(e) => setNewWarehouse(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              {warehouses.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </div>
          <Input
            label="Notes (Optional)"
            value={newNotes}
            onChange={(e) => setNewNotes(e.target.value)}
            placeholder="e.g., Monthly count, end-of-season audit"
          />
          <p className="text-sm text-gray-500">
            All inventory products at this location will be included in the count.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button onClick={handleCreate} loading={creating}>
              Start Count
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Modals */}
      <ConfirmModal
        open={completeConfirmOpen}
        onClose={() => setCompleteConfirmOpen(false)}
        onConfirm={() => { void executeComplete(); }}
        title="Complete with Uncounted Items"
        message={completeConfirmMsg || `Some products have not been counted yet. Complete anyway?`}
        confirmLabel="Complete Anyway"
        variant="warning"
        loading={completing || preparingCompletion}
      />
      <ConfirmModal
        open={cancelConfirmOpen}
        onClose={() => setCancelConfirmOpen(false)}
        onConfirm={executeCancelCount}
        title="Cancel Cycle Count"
        message="Cancel this cycle count? No inventory adjustments will be made."
        confirmLabel="Cancel Count"
        variant="warning"
      />
      <ConfirmModal
        open={reverseConfirmOpen}
        onClose={() => setReverseConfirmOpen(false)}
        onConfirm={doReverse}
        title="Reverse Cycle Count"
        message="Reverse this completed cycle count? All inventory adjustments will be undone."
        confirmLabel="Reverse Count"
        variant="danger"
        loading={reversing}
      />

      {/* Cycle Count Detail Modal */}
      <Modal
        open={showDetail}
        onClose={() => setShowDetail(false)}
        title={activeCount ? `Cycle Count: ${activeCount.count_number}` : 'Cycle Count'}
        size="large"
      >
        {activeCount && (
          <div className="space-y-4">
            {/* Summary bar */}
            <div className="flex items-center gap-4 text-sm">
              <div>
                <span className="text-gray-500">Location:</span>{' '}
                <span className="font-medium">{activeCount.warehouse}</span>
              </div>
              <div>
                <span className="text-gray-500">Status:</span> {statusBadge(activeCount.status)}
              </div>
              <div>
                <span className="text-gray-500">Started:</span>{' '}
                <span>{new Date(activeCount.started_at).toLocaleDateString()}</span>
              </div>
            </div>

            {/* Items table */}
            {loadingItems ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-2 border-crx-green border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto border border-gray-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium text-gray-600">Product</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-600">Expected</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-600 w-28">Counted</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-600">Variance</th>
                      <th className="text-center py-2 px-3 font-medium text-gray-600 w-16">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {countItems.map((item) => (
                      <tr key={item.id} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="py-2 px-3 font-medium text-nav-dark">{item.product_name}</td>
                        <td className="py-2 px-3 text-right text-gray-600">{item.expected_qty}</td>
                        <td className="py-2 px-3 text-right">
                          {activeCount.status === 'in_progress' ? (
                            <input
                              type="number"
                              step="0.01"
                              value={item.counted_qty ?? ''}
                              disabled={preparingCompletion || completing}
                              onChange={(e) => {
                                const val = e.target.value === '' ? null : parseFloat(e.target.value);
                                updateCountedQty(item.id, val);
                              }}
                              className="w-24 px-2 py-1 text-right text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                              placeholder="Count..."
                            />
                          ) : (
                            <span>{item.counted_qty ?? '-'}</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {item.variance !== null ? (
                            <span
                              className={`font-medium ${
                                item.variance > 0
                                  ? 'text-emerald-600'
                                  : item.variance < 0
                                  ? 'text-red-600'
                                  : 'text-gray-500'
                              }`}
                            >
                              {item.variance > 0 ? '+' : ''}
                              {item.variance}
                              {item.variance_pct !== null && (
                                <span className="text-xs ml-1">({item.variance_pct}%)</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center">
                          {item.is_counted ? (
                            <CheckCircle className="w-4 h-4 text-crx-green inline" />
                          ) : (
                            <span className="text-gray-300">○</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Summary */}
            <div className="flex items-center gap-6 text-sm bg-gray-50 rounded-lg p-3">
              <div>
                <span className="text-gray-500">Products:</span>{' '}
                <span className="font-medium">{countItems.length}</span>
              </div>
              <div>
                <span className="text-gray-500">Counted:</span>{' '}
                <span className="font-medium text-crx-green">
                  {countItems.filter((i) => i.is_counted).length}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Variances:</span>{' '}
                <span className="font-medium text-red-600">
                  {countItems.filter((i) => i.variance && i.variance !== 0).length}
                </span>
              </div>
            </div>

            {/* Actions */}
            {activeCount.status === 'in_progress' && isAdmin && (
              <div className="flex justify-between pt-2 border-t">
                <Button
                  variant="secondary"
                  onClick={handleCancel}
                  icon={<XCircle className="w-4 h-4" />}
                >
                  Cancel Count
                </Button>
                <Button
                  onClick={handleComplete}
                  loading={completing || preparingCompletion}
                  icon={<CheckCircle className="w-4 h-4" />}
                >
                  Complete &amp; Apply Adjustments
                </Button>
              </div>
            )}
            {activeCount.status === 'completed' && isAdmin && (
              <div className="flex justify-end pt-2 border-t">
                <Button
                  variant="secondary"
                  onClick={handleReverse}
                  loading={reversing}
                  icon={<XCircle className="w-4 h-4" />}
                >
                  Reverse &amp; Undo Adjustments
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>

    </div>
  );
}
