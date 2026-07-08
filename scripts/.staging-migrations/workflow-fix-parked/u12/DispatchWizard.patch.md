# Patch: src/components/dispatch/DispatchWizard.tsx

Notify each applicator dispatched a location in THIS wizard session, after the
`dispatch_job_locations` RPC succeeds. One notification per (applicator, job)
pair — a job with several selected locations all going to the same applicator
fires exactly one notice, not one per location.

## 1) Import (near the existing imports, line ~29)

```diff
 import { useToast } from '../ui/Toast';
+import { notifyApplicatorDispatched } from '../../lib/notificationTriggers';
```

## 2) After the success toast in `handleFinish` (line ~184-188)

Old:
```typescript
      const result = assertRpcResult<{ dispatched: number }>(data, 'dispatch_job_locations');
      dispatchIdem.resetKey();
      toast('success', `Dispatched ${result.dispatched} location${result.dispatched === 1 ? '' : 's'}${licenseOverride ? ' (license override)' : ''}`);
      onDispatched();
      handleClose();
```

New:
```typescript
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
```

`selected` / `assignments` / `locations` are already in scope (component
state/props used a few lines above by `buildDispatchPayload`). Best-effort —
`notifyApplicatorDispatched` swallows its own errors (see
`notificationTriggers.patch.md`), so a notify failure never blocks the
already-committed dispatch or the wizard's close/onDispatched flow.
