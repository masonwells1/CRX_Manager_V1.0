import { useMemo, useState } from 'react';
import { Check, Calendar, CircleDot, User, Layers, AlertTriangle, Pencil, Truck } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { sanitizeError } from '../../lib/errorSanitizer';
import { Sentry } from '../../lib/sentry';
import { logActivity } from '../../lib/activityLogger';
import { useAuth } from '../../contexts/AuthContext';
import type { JobStatus } from '../../types';
import {
  type MassEditDraft,
  emptyMassEditDraft,
  MASS_EDIT_STATUS_OPTIONS,
  isStatusBulkSafe,
  partitionByStatusLegality,
  buildFieldPatch,
  hasAnyChange,
  describeChanges,
  loaderInputsValid,
} from './jobMassEdit';

/** Minimal shape of a selected job the modal needs (id + current status). */
export interface MassEditJob {
  id: string;
  job_number: string;
  status: JobStatus;
}

interface JobMassEditModalProps {
  open: boolean;
  onClose: () => void;
  /** The checkbox-selected jobs (filtered+selected set from useRowSelection). */
  selectedJobs: MassEditJob[];
  /** Applicator picker options (id + display name), reused from the Jobs page. */
  applicators: { id: string; full_name: string }[];
  /** Batch picker options (id + name), reused from the Jobs page #3 catalog. */
  batches: { id: string; name: string }[];
  /** Called after a successful apply so the parent can refetch the list. */
  onApplied: () => void;
}

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50 disabled:text-secondary';

/**
 * Field-app parity #7: Mass Edit over the checkbox-selected jobs. The modal
 * states "N jobs selected" and offers OPT-IN sections — Schedule Date, Status,
 * Applicator, Batch — each OFF by default so an untouched field is left
 * unchanged. Apply writes ONLY the enabled sections to every selected job and
 * refreshes the list.
 *
 * Status is handled carefully: only a `cancelled` bulk-set is a safe pure
 * .update() (no required side-effects); the forward lifecycle steps run through
 * RPCs that create application records / inventory / invoices, so they are
 * offered but disabled here and surfaced as "do this per job". Even for the
 * safe target we pre-flight each job against _enforce_job_status_transition()'s
 * rules so we never fire an UPDATE the trigger would reject — jobs that can't
 * legally move are reported as skipped instead of silently failing the batch.
 *
 * NOTE (#10 wire-up): a Loader Worksheet opt-in section belongs here once
 * section #10 (Loader Worksheet PDF wired to FIELD JOBS) lands. See the marked
 * insertion point in the JSX below.
 */
export default function JobMassEditModal({
  open,
  onClose,
  selectedJobs,
  applicators,
  batches,
  onApplied,
}: JobMassEditModalProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [draft, setDraft] = useState<MassEditDraft>(emptyMassEditDraft);
  const [applying, setApplying] = useState(false);

  const count = selectedJobs.length;

  const patch = <K extends keyof MassEditDraft>(key: K, value: MassEditDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  // Pre-flight the chosen status against each selected job's current status.
  const statusPartition = useMemo(() => {
    if (!draft.setStatus || !draft.status) return null;
    return partitionByStatusLegality(selectedJobs, draft.status as JobStatus);
  }, [draft.setStatus, draft.status, selectedJobs]);

  const statusSafe = draft.status ? isStatusBulkSafe(draft.status as JobStatus) : false;

  const applicatorName = draft.applicatorId
    ? applicators.find((a) => a.id === draft.applicatorId)?.full_name
    : undefined;
  const batchName = draft.batchRef ? batches.find((b) => b.id === draft.batchRef)?.name : undefined;

  const changes = describeChanges(draft, { applicatorName, batchName });
  // Apply is enabled when there's a change AND, if a status change is requested,
  // it's a bulk-safe target with at least one eligible job.
  const statusActionable =
    !draft.setStatus ||
    (statusSafe && (statusPartition?.eligible.length ?? 0) > 0);
  // #10: a bad loader number (negative rate / non-positive capacity) would be
  // rejected by the jobs CHECK constraints — block Apply until it's fixed.
  const loaderValid = loaderInputsValid(draft);
  const canApply = hasAnyChange(draft) && statusActionable && loaderValid && count > 0 && !applying;

  const reset = () => setDraft(emptyMassEditDraft);

  const handleClose = () => {
    reset();
    onClose();
  };

  const apply = async () => {
    if (count === 0) {
      handleClose();
      return;
    }
    setApplying(true);
    try {
      const allIds = selectedJobs.map((j) => j.id);
      const now = new Date().toISOString();

      // 1) Non-status fields (date / planning date / applicator / batch) — a
      //    single .update() across ALL selected jobs. Only enabled sections ride.
      const fieldPatch = buildFieldPatch(draft);
      if (fieldPatch) {
        const result = await supabase
          .from('jobs')
          .update({ ...fieldPatch, updated_at: now, updated_by: profile?.id ?? null })
          .in('id', allIds)
          .select('id');
        checkMutationResult(result, 'Mass edit jobs');
      }

      // 2) Status — only the bulk-safe target (cancelled), and only on the jobs
      //    the trigger will accept. Eligible jobs move; blocked jobs are skipped
      //    and reported (never silently failed).
      let statusMoved = 0;
      let statusSkipped = 0;
      if (draft.setStatus && draft.status && statusPartition) {
        const eligibleIds = statusPartition.eligible.map((j) => j.id);
        statusSkipped = statusPartition.blocked.length;
        if (eligibleIds.length > 0) {
          const result = await supabase
            .from('jobs')
            .update({ status: draft.status, updated_at: now, updated_by: profile?.id ?? null })
            .in('id', eligibleIds)
            .select('id');
          checkMutationResult(result, 'Mass edit job status');
          statusMoved = eligibleIds.length;
        }
      }

      if (profile) {
        logActivity({
          event: 'jobs_mass_edited',
          description: `Mass-edited ${count} job(s): ${changes.join('; ')}`,
          performedBy: profile.id,
        });
      }

      // Result toast — clear about what changed, including any skipped status moves.
      if (statusSkipped > 0) {
        toast(
          'success',
          `Updated ${count} job(s). Status set on ${statusMoved}; ${statusSkipped} skipped (not a legal status change).`
        );
      } else {
        toast('success', `Updated ${count} job(s)`);
      }
      reset();
      onApplied();
      onClose();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        extra: { context: 'JobMassEditModal.apply' },
      });
      toast('error', sanitizeError(err));
    }
    setApplying(false);
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Mass Edit"
      accent={`${count} job${count !== 1 ? 's' : ''} selected`}
      size="large"
    >
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          Turn on a section to change that field on all {count} selected job{count !== 1 ? 's' : ''}.
          Sections left off are not touched.
        </p>

        {/* --- Schedule Date ------------------------------------------------ */}
        <Section
          icon={<Calendar className="w-4 h-4 text-crx-green" />}
          label="Schedule Date"
          enabled={draft.setJobDate}
          onToggle={(v) => patch('setJobDate', v)}
        >
          <input
            type="date"
            value={draft.jobDate}
            disabled={!draft.setJobDate}
            onChange={(e) => patch('jobDate', e.target.value)}
            aria-label="New schedule date"
            className={inputCls}
          />
          {draft.setJobDate && !draft.jobDate && (
            <p className="mt-1 text-xs text-amber-600">Pick a date to apply.</p>
          )}
          {/* The #1 planning sub-field (jobs.schedule_date), optional. */}
          <label className="mt-2 flex items-center gap-2 text-xs text-secondary">
            <input
              type="checkbox"
              checked={draft.setScheduleDate}
              onChange={(e) => patch('setScheduleDate', e.target.checked)}
              className="rounded border-gray-300 text-crx-green focus:ring-crx-green/30"
            />
            Also set the planning date (Schedule Date field)
          </label>
          {draft.setScheduleDate && (
            <input
              type="date"
              value={draft.scheduleDate}
              onChange={(e) => patch('scheduleDate', e.target.value)}
              aria-label="New planning date"
              className={`${inputCls} mt-1`}
            />
          )}
        </Section>

        {/* --- Status ------------------------------------------------------- */}
        <Section
          icon={<CircleDot className="w-4 h-4 text-crx-green" />}
          label="Status"
          enabled={draft.setStatus}
          onToggle={(v) => patch('setStatus', v)}
        >
          <select
            value={draft.status}
            disabled={!draft.setStatus}
            onChange={(e) => patch('status', e.target.value as JobStatus)}
            aria-label="New status"
            className={inputCls}
          >
            <option value="">Choose status…</option>
            {MASS_EDIT_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} disabled={!o.bulkSafe}>
                {o.label}
                {!o.bulkSafe ? ' — change per job' : ''}
              </option>
            ))}
          </select>
          {draft.setStatus && draft.status && !statusSafe && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              Starting, completing or invoicing a job creates application records and inventory
              moves, so those happen one job at a time on the job page — they can&apos;t be bulk-set
              here. Only cancelling can be done in bulk.
            </p>
          )}
          {draft.setStatus && statusSafe && statusPartition && (
            <p className="mt-1.5 text-xs text-secondary">
              {statusPartition.eligible.length} will change
              {statusPartition.unchanged.length > 0 && `, ${statusPartition.unchanged.length} already there`}
              {statusPartition.blocked.length > 0 && (
                <span className="text-amber-600">
                  , {statusPartition.blocked.length} skipped (can&apos;t cancel a {' '}
                  {[...new Set(statusPartition.blocked.map((j) => j.status.replace('_', ' ')))].join('/')} job)
                </span>
              )}
              .
            </p>
          )}
        </Section>

        {/* --- Applicator --------------------------------------------------- */}
        <Section
          icon={<User className="w-4 h-4 text-crx-green" />}
          label="Applicator"
          enabled={draft.setApplicator}
          onToggle={(v) => patch('setApplicator', v)}
        >
          <select
            value={draft.applicatorId ?? ''}
            disabled={!draft.setApplicator}
            onChange={(e) => patch('applicatorId', e.target.value || null)}
            aria-label="New applicator"
            className={inputCls}
          >
            <option value="">(Clear applicator)</option>
            {applicators.map((a) => (
              <option key={a.id} value={a.id}>{a.full_name}</option>
            ))}
          </select>
        </Section>

        {/* --- Batch -------------------------------------------------------- */}
        <Section
          icon={<Layers className="w-4 h-4 text-crx-green" />}
          label="Batch"
          enabled={draft.setBatch}
          onToggle={(v) => patch('setBatch', v)}
        >
          <select
            value={draft.batchRef ?? ''}
            disabled={!draft.setBatch}
            onChange={(e) => patch('batchRef', e.target.value || null)}
            aria-label="New batch"
            className={inputCls}
          >
            <option value="">(Remove from batch)</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </Section>

        {/* --- Loader Worksheet (#10) --------------------------------------- */}
        <Section
          icon={<Truck className="w-4 h-4 text-crx-green" />}
          label="Loader Worksheet"
          enabled={draft.setLoader}
          onToggle={(v) => patch('setLoader', v)}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-secondary mb-1">Carrier Rate (gal/acre)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={draft.carrierRateGpa}
                disabled={!draft.setLoader}
                onChange={(e) => patch('carrierRateGpa', e.target.value)}
                aria-label="Carrier rate gallons per acre"
                placeholder="blank = clear"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs text-secondary mb-1">Tank Capacity (gal)</label>
              <input
                type="number"
                step="1"
                min="0"
                value={draft.loaderTankCapacity}
                disabled={!draft.setLoader}
                onChange={(e) => patch('loaderTankCapacity', e.target.value)}
                aria-label="Tank capacity gallons"
                placeholder="blank = use vehicle"
                className={inputCls}
              />
            </div>
          </div>
          <label className="block text-xs text-secondary mt-2 mb-1">Loader Comment</label>
          <textarea
            value={draft.loaderComment}
            disabled={!draft.setLoader}
            onChange={(e) => patch('loaderComment', e.target.value)}
            rows={2}
            aria-label="Loader comment"
            placeholder="blank = clear"
            className={`${inputCls} resize-none`}
          />
          {draft.setLoader && !loaderValid && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              Carrier rate can&apos;t be negative and tank capacity must be greater than zero.
            </p>
          )}
          <p className="mt-1.5 text-xs text-secondary">
            Applies the same loader-worksheet settings to all {count} selected job{count !== 1 ? 's' : ''}. A blank field clears that value.
          </p>
        </Section>

        {/* Confirm summary + actions */}
        {changes.length > 0 && (
          <div className="rounded-lg bg-crx-green/5 border border-crx-green/20 p-3">
            <p className="text-xs font-medium text-nav-dark mb-1">
              About to change on {count} job{count !== 1 ? 's' : ''}:
            </p>
            <ul className="text-xs text-secondary space-y-0.5">
              {changes.map((c, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <Check className="w-3 h-3 text-crx-green flex-shrink-0" />
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
          <Button variant="secondary" onClick={handleClose} showChevron={false}>
            Cancel
          </Button>
          <Button
            icon={<Pencil className="w-4 h-4" />}
            onClick={apply}
            disabled={!canApply}
            loading={applying}
            showChevron={false}
          >
            Apply to {count} job{count !== 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** One opt-in row: a header checkbox that enables/disables its body controls. */
function Section({
  icon,
  label,
  enabled,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border p-3 transition-colors ${enabled ? 'border-crx-green/40 bg-crx-green/5' : 'border-gray-200'}`}>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="rounded border-gray-300 text-crx-green focus:ring-crx-green/30"
        />
        {icon}
        <span className="text-sm font-medium text-nav-dark">{label}</span>
        {!enabled && <span className="text-xs text-secondary">— leave unchanged</span>}
      </label>
      {enabled && <div className="mt-2 pl-6">{children}</div>}
    </div>
  );
}
