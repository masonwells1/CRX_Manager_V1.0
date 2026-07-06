# Patch: src/pages/JobDetail.tsx

Five small, surgical edits. Verified against the live file before writing
these blocks (line numbers as read this session; re-anchor on the `old_string`
text, not the numbers, if the file has moved).

---

## 1) Import the new notify functions (near the existing `logActivity` import, line 13)

```diff
 import { logActivity } from '../lib/activityLogger';
+import { notifyApplicatorDispatched, notifyApplicatorRescheduled, notifyApplicatorUndispatched } from '../lib/notificationTriggers';
```

---

## 2) Track the pre-save job_date so a reschedule can be detected (mirrors `savedApplicatorId`, line 316)

```diff
   const [savedApplicatorId, setSavedApplicatorId] = useState<string | null>(null);
+  // U12: mirrors savedApplicatorId — lets performSave detect a RESCHEDULE
+  // (job_date changed while the same applicator stays assigned) so the
+  // assigned applicator can be notified.
+  const [savedJobDate, setSavedJobDate] = useState<string | null>(null);
```

---

## 3) Capture the loaded job_date on fetch (line ~1414, inside `fetchJob`)

```diff
     setJobDate(j.job_date);
+    setSavedJobDate(j.job_date);
```

(This sits next to the existing `setSavedApplicatorId(j.applicator_id || null);` a
few lines below — leave that line as-is.)

---

## 4) Fire the applicator notification after a successful save (line ~2011, inside `performSave`)

Old:
```typescript
      if (profile) logActivity({ event: isNew ? 'job_created' : 'job_updated', description: isNew ? `Job created for ${customers.find(c => c.id === customerId)?.farm_name}` : `Job ${jobNumber} updated`, performedBy: profile.id });

      // §5: the job + chemicals committed — NOW write the block-mode override audit, linked
      // to the real saved job id. Reached only on a SUCCESSFUL save, so a failed/retried
      // save leaves NO orphan override row. (Codex follow-up P2.)
      if (overrideReasonForAudit) {
        await writeOverrideAudit(overrideReasonForAudit, isNew ? result.job_id : (id || null));
      }

      toast('success', isNew ? 'Job created' : 'Job saved');
      setIsDirty(false);
      setSavedApplicatorId(applicatorId || null);

      if (isNew) {
        navigate(`/jobs/${result.job_id}`);
      } else {
        await fetchJob();
      }
```

New:
```typescript
      if (profile) logActivity({ event: isNew ? 'job_created' : 'job_updated', description: isNew ? `Job created for ${customers.find(c => c.id === customerId)?.farm_name}` : `Job ${jobNumber} updated`, performedBy: profile.id });

      // §5: the job + chemicals committed — NOW write the block-mode override audit, linked
      // to the real saved job id. Reached only on a SUCCESSFUL save, so a failed/retried
      // save leaves NO orphan override row. (Codex follow-up P2.)
      if (overrideReasonForAudit) {
        await writeOverrideAudit(overrideReasonForAudit, isNew ? result.job_id : (id || null));
      }

      // U12: notify the assigned applicator on dispatch / reschedule / undispatch.
      // Best-effort (each notify* fn swallows its own errors into Sentry via
      // logNotificationFailure) — never blocks the save that already committed.
      // Applicators previously got NO notification at all for any of these three
      // (verified: no notify*/createNotification call existed around this save
      // path before U12).
      const savedJobIdForNotify = isNew ? result.job_id : (id as string);
      const newApplicatorId = applicatorId || null;
      const custNameForNotify = customers.find((c) => c.id === customerId)?.farm_name || 'Unknown';
      if (newApplicatorId && newApplicatorId !== savedApplicatorId) {
        void notifyApplicatorDispatched(newApplicatorId, jobNumber || '', custNameForNotify, jobDate, savedJobIdForNotify);
      } else if (newApplicatorId && newApplicatorId === savedApplicatorId && jobDate !== savedJobDate) {
        void notifyApplicatorRescheduled(newApplicatorId, jobNumber || '', custNameForNotify, jobDate, savedJobIdForNotify);
      }
      if (savedApplicatorId && savedApplicatorId !== newApplicatorId) {
        void notifyApplicatorUndispatched(savedApplicatorId, jobNumber || '', custNameForNotify, savedJobIdForNotify);
      }

      toast('success', isNew ? 'Job created' : 'Job saved');
      setIsDirty(false);
      setSavedApplicatorId(applicatorId || null);
      setSavedJobDate(jobDate);

      if (isNew) {
        navigate(`/jobs/${result.job_id}`);
      } else {
        await fetchJob();
      }
```

Notes:
- `savedApplicatorId`/`savedJobDate` are read BEFORE they're reassigned two
  lines later, so the comparison is always old-vs-new — order matters, don't
  move the `setSavedApplicatorId`/`setSavedJobDate` calls above this block.
- A brand-new job (`isNew`) always has `savedApplicatorId === null`, so
  assigning an applicator on creation correctly fires ONLY the "dispatched"
  notification (not also a spurious "undispatched"/"rescheduled").
- `jobNumber` is empty string on a brand-new job until `result` returns it in
  some flows — falls back to `''` so the message reads "job  for X" in the
  rare case; matches the existing `logActivity` line 3 above which has the
  same characteristic (not a new gap).

---

## 5) Gate Cancel/Transfer to office roles; let the assigned applicator see Start too (line ~2506)

Old:
```typescript
  const canEdit = isEditable && (isNew || status === 'scheduled' || status === 'in_progress');
  const canComplete = !isNew && status === 'in_progress';
  const canTransfer = !isNew && status === 'completed';
```

New:
```typescript
  const canEdit = isEditable && (isNew || status === 'scheduled' || status === 'in_progress');
  // U12: the assigned applicator (job-level applicator_id match — mirrors the
  // existing AppliedRecordsManager canEdit gate a few hundred lines down) can
  // see Start/Complete on THEIR OWN job even though isEditable is office-only.
  // Verified server-side: start_job/complete_job already authorize
  // `is_applicator() AND jobs.applicator_id = actor` (and, after migration
  // 20260706060000, a per-location dispatchee too) — this UI gate was simply
  // narrower than what the RPC already allowed, hiding a legitimate action.
  const isAssignedApplicator = role === 'applicator' && !!applicatorId && applicatorId === profile?.id;
  const canStart = !isNew && status === 'scheduled' && (isEditable || isAssignedApplicator);
  const canComplete = !isNew && status === 'in_progress' && (isEditable || isAssignedApplicator);
  // Cancel/Transfer are OFFICE decisions (cancelling work or converting it to a
  // billable invoice) — not verified-safe to hand an applicator: Cancel had NO
  // role gate at all before U12 (any of admin/sales_rep/applicator viewing this
  // page could click it), and Transfer's only gate was the job's status.
  const canCancel = !isNew && (status === 'scheduled' || status === 'in_progress') && isEditable;
  const canTransfer = !isNew && status === 'completed' && isEditable;
```

---

## 6) Wire the new `canStart`/`canCancel` flags into the buttons (line ~2571)

Old:
```typescript
          {!isNew && (status === 'scheduled' || status === 'in_progress') && (
            <Button variant="danger" onClick={() => setShowCancelConfirm(true)} loading={cancelling}>
              <Ban className="w-4 h-4" />
              Cancel Job
            </Button>
          )}
          {!isNew && status === 'scheduled' && isEditable && (
            <Button variant="secondary" onClick={handleStart} loading={starting} disabled={starting}>
              <Check className="w-4 h-4" />
              Start Job
            </Button>
          )}
```

New:
```typescript
          {canCancel && (
            <Button variant="danger" onClick={() => setShowCancelConfirm(true)} loading={cancelling}>
              <Ban className="w-4 h-4" />
              Cancel Job
            </Button>
          )}
          {canStart && (
            <Button variant="secondary" onClick={handleStart} loading={starting} disabled={starting}>
              <Check className="w-4 h-4" />
              Start Job
            </Button>
          )}
```

`canComplete`/`canTransfer` below these are already referenced by name
(`{canComplete && (...)}` / `{canTransfer && (...)}`) — no change needed there,
they pick up the new definitions from edit 5 automatically.
