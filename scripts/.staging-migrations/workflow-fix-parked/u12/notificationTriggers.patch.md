# Patch: src/lib/notificationTriggers.ts

Append these three exported functions immediately after `notifyDriverAssigned`
(after line 186, before `notifyOrderStatusChange`). They mirror
`notifyDriverAssigned` exactly (same `createNotification` call shape, same
`logNotificationFailure` catch pattern) — the only reason they can now reach a
DIFFERENT user than the caller is migration `20260706060000`'s `notif_insert`
RLS widen (admin OR sales_rep OR self), verified against the live policy
before writing this.

## Insert after line 186 (`}` closing `notifyDriverAssigned`)

```typescript
/**
 * Notify an applicator when a job is dispatched/assigned to them — either the
 * whole-job legacy assign (JobDetail assigning jobs.applicator_id) or a
 * per-location dispatch (DispatchWizard / DispatchBoard reassign). Mirrors
 * notifyDriverAssigned's shape exactly. U12 (2026-07-06): applicators had NO
 * notification at all before this — verified by grepping JobDetail.tsx/
 * DispatchWizard.tsx/DispatchBoard.tsx for any notify*/createNotification call
 * around the assign/dispatch RPCs; none existed.
 */
export async function notifyApplicatorDispatched(
  applicatorId: string,
  jobNumber: string,
  customerName: string,
  jobDate: string | null,
  jobId: string
) {
  try {
    const dateLabel = jobDate ? new Date(jobDate).toLocaleDateString() : 'an upcoming date';
    await createNotification(
      applicatorId,
      'New Job Assigned',
      `You've been assigned job ${jobNumber} for ${customerName} on ${dateLabel}`,
      'job_dispatched',
      'job',
      jobId
    );
  } catch (err) {
    await logNotificationFailure('job_dispatched', err, 'job', jobId, {
      context: 'notifyApplicatorDispatched',
      applicatorId,
      jobNumber,
    });
  }
}

/**
 * Notify an applicator when a job THEY were assigned to gets rescheduled to a
 * different date (job_date changed while the same applicator stays assigned).
 */
export async function notifyApplicatorRescheduled(
  applicatorId: string,
  jobNumber: string,
  customerName: string,
  newJobDate: string | null,
  jobId: string
) {
  try {
    const dateLabel = newJobDate ? new Date(newJobDate).toLocaleDateString() : 'an unscheduled date';
    await createNotification(
      applicatorId,
      'Job Rescheduled',
      `Job ${jobNumber} for ${customerName} was moved to ${dateLabel}`,
      'job_rescheduled',
      'job',
      jobId
    );
  } catch (err) {
    await logNotificationFailure('job_rescheduled', err, 'job', jobId, {
      context: 'notifyApplicatorRescheduled',
      applicatorId,
      jobNumber,
    });
  }
}

/**
 * Notify an applicator when they're REMOVED from a job — the whole-job
 * applicator was changed/cleared, or their per-location dispatch was
 * undispatched/reassigned to someone else. Lets them know it's off their plate
 * without them discovering it only when the card silently disappears.
 */
export async function notifyApplicatorUndispatched(
  applicatorId: string,
  jobNumber: string,
  customerName: string,
  jobId: string
) {
  try {
    await createNotification(
      applicatorId,
      'Job Removed From Your Schedule',
      `Job ${jobNumber} for ${customerName} is no longer assigned to you`,
      'job_undispatched',
      'job',
      jobId
    );
  } catch (err) {
    await logNotificationFailure('job_undispatched', err, 'job', jobId, {
      context: 'notifyApplicatorUndispatched',
      applicatorId,
      jobNumber,
    });
  }
}
```

No other change to this file. `notification_type` values `job_dispatched` /
`job_rescheduled` / `job_undispatched` are free text — verified live
`notifications` table has NO CHECK constraint on `notification_type` (query:
`SELECT conname FROM pg_constraint WHERE conrelid='notifications'::regclass
AND contype='c'` returned zero rows), so no migration is needed for these
values.
