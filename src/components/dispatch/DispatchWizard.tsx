/**
 * DispatchWizard.tsx — the 3-step "Dispatch Jobs" wizard (field-app parity #36).
 *
 * ChemMan parity: Step 1 Select Locations -> Step 2 Assign Selections ->
 * Step 3 Finish Dispatching. The dispatcher picks individual field LOCATIONS
 * (job_fields rows) across jobs, assigns each selected location to an applicator
 * OR a crew (different locations can go to different assignees in one session),
 * and commits — each location is recorded in job_location_dispatches with a
 * dispatch timestamp via the dispatch_job_locations RPC.
 *
 * Dark, touch-friendly, matches the DispatchBoard field aesthetic. Pure
 * selection/assignment/payload logic lives in src/lib/dispatchWizard.ts (unit
 * tested); this component owns state, rendering, and the single RPC call.
 */
import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  X,
  Check,
  ChevronRight,
  ChevronLeft,
  MapPin,
  Users,
  Send,
  Loader2,
} from 'lucide-react';
import { supabase, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../../lib/db';
import type { Json } from '../../types/supabase';
import ConfirmModal from '../ui/ConfirmModal';
import { Sentry } from '../../lib/sentry';
import { useToast } from '../ui/Toast';
import { notifyApplicatorDispatched } from '../../lib/notificationTriggers';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import {
  DISPATCH_STEPS,
  toggleLocation,
  setAssignment,
  assignAll,
  pruneAssignments,
  canAdvanceToAssign,
  canAdvanceToFinish,
  unassignedCount,
  buildDispatchPayload,
  summarizeDispatch,
  locationsBeingStolen,
  type DispatchStep,
  type DispatchLocation,
  type DispatchAssignee,
  type AssignmentMap,
} from '../../lib/dispatchWizard';

export interface WizardApplicator {
  id: string;
  full_name: string;
}
export interface WizardCrew {
  id: string;
  name: string;
}

interface DispatchWizardProps {
  open: boolean;
  onClose: () => void;
  /** All dispatchable field locations, flattened across the visible jobs. */
  locations: DispatchLocation[];
  applicators: WizardApplicator[];
  crews: WizardCrew[];
  performedBy: string;
  /** Admins may override an expired-license dispatch (mirrors assign flow). */
  isAdmin: boolean;
  /** Called after a successful commit so the board can refetch. */
  onDispatched: () => void;
  /**
   * U13 (#15-21/#111): job-field-ids to pre-select in Step 1 when the wizard
   * opens (e.g. JobDetail's "Dispatch Locations" button pre-selects the whole
   * job). Applied exactly ONCE per open (one-shot ref, reset on close) so it
   * never fights a user's mid-session deselection. Omit for the ordinary
   * DispatchBoard flow (no pre-selection, unchanged).
   */
  initialSelectedIds?: string[];
}

const STEP_META: Record<DispatchStep, { n: number; label: string }> = {
  select: { n: 1, label: 'Select Locations' },
  assign: { n: 2, label: 'Assign Selections' },
  finish: { n: 3, label: 'Finish Dispatching' },
};

export default function DispatchWizard({
  open,
  onClose,
  locations,
  applicators,
  crews,
  performedBy,
  isAdmin,
  onDispatched,
  initialSelectedIds,
}: DispatchWizardProps) {
  const { toast } = useToast();
  const dispatchIdem = useIdempotencyKey('dispatch_job_locations', performedBy);

  const [step, setStep] = useState<DispatchStep>('select');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignments, setAssignments] = useState<AssignmentMap>({});
  const [submitting, setSubmitting] = useState(false);
  // The assignee currently chosen in the Step 2 picker (applied per-location or to all).
  const [activeAssignee, setActiveAssignee] = useState<DispatchAssignee | null>(null);
  // Set when the commit hit LICENSE_EXPIRED and the admin can choose to override.
  const [licenseOverridePrompt, setLicenseOverridePrompt] = useState(false);
  // U13: confirm-before-steal — set when Finish is clicked and >=1 selected
  // location would be reassigned away from a DIFFERENT existing assignee.
  const [stealConfirmOpen, setStealConfirmOpen] = useState(false);

  // U13 (Codex R1 #4): pre-select EXACTLY ONCE per open (job-scoped callers).
  // A one-shot ref (reset when the wizard closes) — NOT a "while the selection
  // is empty" check — because callers typically pass a fresh array literal on
  // every render, which would re-fire this effect and re-select everything the
  // moment the user deselects their last pre-selected location.
  const initialSelectionAppliedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      initialSelectionAppliedRef.current = false;
      return;
    }
    if (initialSelectionAppliedRef.current) return;
    initialSelectionAppliedRef.current = true;
    if (initialSelectedIds && initialSelectedIds.length > 0) {
      setSelected(new Set(initialSelectedIds));
    }
     
  }, [open, initialSelectedIds]);

  const reset = useCallback(() => {
    setStep('select');
    setSelected(new Set());
    setAssignments({});
    setActiveAssignee(null);
    setSubmitting(false);
    setLicenseOverridePrompt(false);
    dispatchIdem.resetKey();
  }, [dispatchIdem]);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // Locations grouped by job for the Step 1 picker.
  const jobsWithLocations = useMemo(() => {
    const byJob = new Map<string, { jobNumber: string; customerName: string; locs: DispatchLocation[] }>();
    for (const loc of locations) {
      let g = byJob.get(loc.jobId);
      if (!g) {
        g = { jobNumber: loc.jobNumber, customerName: loc.customerName, locs: [] };
        byJob.set(loc.jobId, g);
      }
      g.locs.push(loc);
    }
    return Array.from(byJob.values()).sort((a, b) => a.jobNumber.localeCompare(b.jobNumber));
  }, [locations]);

  const selectedLocations = useMemo(
    () => locations.filter((l) => selected.has(l.jobFieldId)),
    [locations, selected]
  );

  const assigneeOptions: DispatchAssignee[] = useMemo(
    () => [
      ...applicators.map((a) => ({ kind: 'applicator' as const, id: a.id, name: a.full_name })),
      ...crews.map((c) => ({ kind: 'crew' as const, id: c.id, name: c.name })),
    ],
    [applicators, crews]
  );

  const summary = useMemo(
    () => summarizeDispatch(selected, assignments, locations),
    [selected, assignments, locations]
  );

  const missing = unassignedCount(selected, assignments);
  const stolenLocations = useMemo(
    () => locationsBeingStolen(selected, assignments, locations),
    [selected, assignments, locations]
  );

  function toggle(jobFieldId: string) {
    setSelected((prev) => {
      const next = toggleLocation(prev, jobFieldId);
      // Keep assignments tidy: drop any that are no longer selected.
      setAssignments((m) => pruneAssignments(m, next));
      return next;
    });
  }

  function goAssign() {
    if (canAdvanceToAssign(selected)) setStep('assign');
  }
  function goFinish() {
    if (canAdvanceToFinish(selected, assignments)) setStep('finish');
  }

  function applyToLocation(jobFieldId: string, assignee: DispatchAssignee | undefined) {
    setAssignments((m) => setAssignment(m, jobFieldId, assignee));
  }
  function applyToAll() {
    if (activeAssignee) setAssignments((m) => assignAll(m, selected, activeAssignee));
  }

  async function handleFinish(licenseOverride = false) {
    if (!canAdvanceToFinish(selected, assignments)) return;
    setSubmitting(true);
    try {
      const payload = buildDispatchPayload(selected, assignments);
      const { data, error } = await supabase.rpc('dispatch_job_locations', {
        p_assignments: payload as unknown as Json,
        p_performed_by: performedBy,
        p_idempotency_key: dispatchIdem.getKey(),
        p_license_override: licenseOverride,
      });
      if (error) throw error;
      const result = assertRpcResult<{ dispatched: number }>(data, 'dispatch_job_locations');
      dispatchIdem.resetKey();
      toast('success', `Dispatched ${result.dispatched} location${result.dispatched === 1 ? '' : 's'}${licenseOverride ? ' (license override)' : ''}`);

      // U12: notify each dispatched APPLICATOR (not crews — no single user to
      // notify). De-dupe to one notice per (applicator, job) pair so a job
      // split across several of the caller's selected locations, all going to
      // the same applicator, doesn't fire duplicate notifications.
      const notified = new Set<string>();
      for (const jobFieldId of selected) {
        const assignee = assignments[jobFieldId];
        const loc = locations.find((l) => l.jobFieldId === jobFieldId);
        if (!assignee || assignee.kind !== 'applicator' || !loc) continue;
        const dedupeKey = `${assignee.id}:${loc.jobId}`;
        if (notified.has(dedupeKey)) continue;
        notified.add(dedupeKey);
        void notifyApplicatorDispatched(assignee.id, loc.jobNumber, loc.customerName, null, loc.jobId);
      }

      onDispatched();
      handleClose();
    } catch (err) {
      // An assignee's licenses are all expired: an admin can override; others are blocked.
      if (hasRpcCode(err, RpcErrorCodes.LICENSE_EXPIRED)) {
        // Replaying the same idempotency key would return the cached error path? No —
        // the failed call cached nothing (it raised). Reset the key so the override
        // retry is a fresh attempt.
        dispatchIdem.resetKey();
        if (isAdmin) {
          setLicenseOverridePrompt(true);
        } else {
          toast('error', "An applicator's license has expired — an admin can override if needed.");
        }
        setSubmitting(false);
        return;
      }
      Sentry.captureException(err, { tags: { source: 'action', action: 'dispatch_job_locations' } });
      toast('error', 'Failed to dispatch. Please try again.');
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label="Dispatch Jobs wizard">
      <button type="button" aria-label="Close dispatch wizard" className="absolute inset-0 bg-black/70" onClick={handleClose} />
      <div className="relative w-full max-w-3xl mx-4 max-h-[92vh] flex flex-col rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl text-slate-100">
        {/* Header + stepper */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Send className="w-5 h-5 text-crx-green" /> Dispatch Jobs
          </h2>
          <button onClick={handleClose} aria-label="Close" className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>

        <ol className="flex items-center gap-2 px-5 py-3 border-b border-slate-800 text-xs">
          {DISPATCH_STEPS.map((s, i) => {
            const meta = STEP_META[s];
            const isActive = s === step;
            const isDone = DISPATCH_STEPS.indexOf(step) > i;
            return (
              <li key={s} className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold ${
                    isActive
                      ? 'bg-crx-green text-white'
                      : isDone
                        ? 'bg-crx-green/30 text-crx-green'
                        : 'bg-slate-800 text-slate-500'
                  }`}
                >
                  {isDone ? <Check className="w-3.5 h-3.5" /> : meta.n}
                </span>
                <span className={isActive ? 'text-slate-100 font-medium' : 'text-slate-500'}>{meta.label}</span>
                {i < DISPATCH_STEPS.length - 1 && <ChevronRight className="w-4 h-4 text-slate-700" />}
              </li>
            );
          })}
        </ol>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* STEP 1 — SELECT LOCATIONS */}
          {step === 'select' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-400">
                Pick the individual field locations to dispatch. You can select locations across more than one job.
              </p>
              {jobsWithLocations.length === 0 ? (
                <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-8 text-center text-slate-400">
                  No dispatchable locations. Only scheduled or in-progress jobs with fields can be dispatched.
                </div>
              ) : (
                jobsWithLocations.map((g) => (
                  <div key={g.jobNumber} className="rounded-xl border border-slate-800 overflow-hidden">
                    <div className="px-4 py-2.5 bg-slate-800/60 flex items-center justify-between">
                      <span className="text-sm font-semibold text-slate-100">{g.jobNumber}</span>
                      <span className="text-xs text-slate-400">{g.customerName}</span>
                    </div>
                    <div className="divide-y divide-slate-800">
                      {g.locs.map((loc) => {
                        const isSel = selected.has(loc.jobFieldId);
                        return (
                          <label
                            key={loc.jobFieldId}
                            className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-800/40 min-h-[44px]"
                          >
                            <input
                              type="checkbox"
                              checked={isSel}
                              onChange={() => toggle(loc.jobFieldId)}
                              className="w-5 h-5 rounded border-slate-600 bg-slate-800 text-crx-green focus:ring-crx-green/40"
                            />
                            <MapPin className={`w-4 h-4 ${isSel ? 'text-crx-green' : 'text-slate-500'}`} />
                            <span className="flex-1 text-sm text-slate-200">{loc.fieldName}</span>
                            {loc.acres != null && <span className="text-xs text-slate-500 tabular-nums">{loc.acres} ac</span>}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* STEP 2 — ASSIGN SELECTIONS */}
          {step === 'assign' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-400">
                Assign each selected location to an applicator or crew. Different locations can go to different
                people — that is how one job is split between two applicators.
              </p>

              {/* Apply-to-all helper */}
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-800/40 p-3">
                <span className="text-xs text-slate-400">Quick assign all selected to:</span>
                <select
                  value={activeAssignee ? `${activeAssignee.kind}:${activeAssignee.id}` : ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setActiveAssignee(val ? assigneeOptions.find((o) => `${o.kind}:${o.id}` === val) ?? null : null);
                  }}
                  className="flex-1 min-w-[160px] text-sm rounded-lg bg-slate-800 border border-slate-700 px-3 py-2.5 text-slate-100 min-h-[44px] focus:outline-none focus:ring-2 focus:ring-crx-green/40"
                >
                  <option value="">Choose…</option>
                  {applicators.length > 0 && (
                    <optgroup label="Applicators">
                      {applicators.map((a) => (
                        <option key={a.id} value={`applicator:${a.id}`}>{a.full_name}</option>
                      ))}
                    </optgroup>
                  )}
                  {crews.length > 0 && (
                    <optgroup label="Crews">
                      {crews.map((c) => (
                        <option key={c.id} value={`crew:${c.id}`}>{c.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button
                  onClick={applyToAll}
                  disabled={!activeAssignee}
                  className="px-3 py-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm font-medium text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
                >
                  Apply to all
                </button>
              </div>

              {/* Per-location assignment rows */}
              <div className="space-y-2">
                {selectedLocations.map((loc) => {
                  const current = assignments[loc.jobFieldId];
                  return (
                    <div key={loc.jobFieldId} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-100 truncate">{loc.fieldName}</p>
                        <p className="text-xs text-slate-500 truncate">{loc.jobNumber} · {loc.customerName}</p>
                        {loc.currentAssignee && (
                          <p className="text-xs text-amber-400/90 truncate">
                            Currently: {loc.currentAssignee.name} ({loc.currentAssignee.kind})
                          </p>
                        )}
                      </div>
                      <select
                        value={current ? `${current.kind}:${current.id}` : ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          applyToLocation(loc.jobFieldId, val ? assigneeOptions.find((o) => `${o.kind}:${o.id}` === val) : undefined);
                        }}
                        className={`text-sm rounded-lg bg-slate-800 border px-3 py-2.5 text-slate-100 min-h-[44px] min-w-[170px] focus:outline-none focus:ring-2 focus:ring-crx-green/40 ${
                          current ? 'border-crx-green/50' : 'border-amber-500/50'
                        }`}
                      >
                        <option value="">Unassigned</option>
                        {applicators.length > 0 && (
                          <optgroup label="Applicators">
                            {applicators.map((a) => (
                              <option key={a.id} value={`applicator:${a.id}`}>{a.full_name}</option>
                            ))}
                          </optgroup>
                        )}
                        {crews.length > 0 && (
                          <optgroup label="Crews">
                            {crews.map((c) => (
                              <option key={c.id} value={`crew:${c.id}`}>{c.name}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>
                  );
                })}
              </div>

              {missing > 0 && (
                <p className="text-xs text-amber-300">
                  {missing} selected location{missing === 1 ? '' : 's'} still need{missing === 1 ? 's' : ''} an assignee.
                </p>
              )}
            </div>
          )}

          {/* STEP 3 — FINISH DISPATCHING */}
          {step === 'finish' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-400">
                Review and confirm. Finishing records each location as dispatched to its applicator or crew with a
                timestamp.
              </p>
              {summary.map((grp) => (
                <div key={`${grp.assignee.kind}:${grp.assignee.id}`} className="rounded-xl border border-slate-800 overflow-hidden">
                  <div className="px-4 py-2.5 bg-slate-800/60 flex items-center gap-2">
                    <Users className="w-4 h-4 text-crx-green" />
                    <span className="text-sm font-semibold text-slate-100">{grp.assignee.name}</span>
                    <span className="text-xs text-slate-500">
                      ({grp.assignee.kind === 'crew' ? 'crew' : 'applicator'}) · {grp.locations.length} location{grp.locations.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <ul className="divide-y divide-slate-800">
                    {grp.locations.map((loc) => (
                      <li key={loc.jobFieldId} className="px-4 py-2.5 flex items-center gap-2 text-sm">
                        <MapPin className="w-3.5 h-3.5 text-slate-500" />
                        <span className="text-slate-200">{loc.fieldName}</span>
                        <span className="text-xs text-slate-500">· {loc.jobNumber}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-slate-800">
          <div className="text-xs text-slate-500">
            {selected.size} location{selected.size === 1 ? '' : 's'} selected
          </div>
          <div className="flex items-center gap-2">
            {step !== 'select' && (
              <button
                onClick={() => setStep(step === 'finish' ? 'assign' : 'select')}
                disabled={submitting}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-700 text-sm font-medium text-slate-200 hover:bg-slate-800 min-h-[44px] disabled:opacity-50"
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}
            {step === 'select' && (
              <button
                onClick={goAssign}
                disabled={!canAdvanceToAssign(selected)}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-crx-green text-sm font-semibold text-white hover:bg-crx-green/90 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
              >
                Next: Assign <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {step === 'assign' && (
              <button
                onClick={goFinish}
                disabled={!canAdvanceToFinish(selected, assignments)}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-crx-green text-sm font-semibold text-white hover:bg-crx-green/90 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
              >
                Next: Finish <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {step === 'finish' && (
              <button
                onClick={() => (stolenLocations.length > 0 ? setStealConfirmOpen(true) : handleFinish())}
                disabled={submitting || !canAdvanceToFinish(selected, assignments)}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-crx-green text-sm font-semibold text-white hover:bg-crx-green/90 disabled:opacity-50 min-h-[44px]"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Finish Dispatching
              </button>
            )}
          </div>
        </div>
      </div>

      {/* License-expired override (admin only) — mirrors the whole-job assign flow. */}
      <ConfirmModal
        open={licenseOverridePrompt}
        onClose={() => setLicenseOverridePrompt(false)}
        onConfirm={() => {
          setLicenseOverridePrompt(false);
          handleFinish(true);
        }}
        title="Applicator License Expired"
        message="An applicator in this dispatch has an expired license. Dispatch anyway? The override is recorded."
        confirmLabel="Dispatch Anyway"
        variant="warning"
      />

      {/* U13 (#15-21/#111): confirm before stealing a location from its current
          assignee — never silently reassign someone else's work. */}
      <ConfirmModal
        open={stealConfirmOpen}
        onClose={() => setStealConfirmOpen(false)}
        onConfirm={() => {
          setStealConfirmOpen(false);
          handleFinish();
        }}
        title="Reassign From Current Assignee?"
        message={`${stolenLocations.length} selected location${stolenLocations.length === 1 ? ' is' : 's are'} currently assigned to someone else (${
          [...new Set(stolenLocations.map((l) => l.currentAssignee?.name).filter(Boolean))].join(', ')
        }). Dispatching now will move ${stolenLocations.length === 1 ? 'it' : 'them'} to your new selection. Continue?`}
        confirmLabel="Reassign Anyway"
        variant="warning"
      />
    </div>
  );
}
