# Patch: src/pages/DispatchBoard.tsx

Notify the affected applicator(s) on a reassign (Dispatched List "Reassign")
and on an undispatch. Both handlers already have `row: DispatchedListRow`
(carries `job_id`, `job_number`, `customer_name`, the CURRENT `applicator_id`)
in scope.

## 1) Import (near the existing dispatchDisplay import block, line ~60)

```diff
   jobStatusToDispatchBadge,
+  // U12
 } from '../lib/dispatchDisplay';
+import { notifyApplicatorDispatched, notifyApplicatorUndispatched } from '../lib/notificationTriggers';
```

(Insert the `notifyApplicatorDispatched`/`notifyApplicatorUndispatched` import
as its own line near the other top-of-file imports — the inline comment above
is illustrative of WHERE, not a literal diff against the multi-line
`dispatchDisplay` import list; don't actually add a stray comment inside that
import block.)

## 2) `doReassign` — after success (line ~1216-1223)

Old:
```typescript
      if (error) throw error;
      assertRpcResult<{ dispatched: number }>(data, 'dispatch_job_locations');
      reassignKeysRef.current.delete(scope); // confirmed success → next reassign of this intent is a new action
      toast('success', `Reassigned ${row.field_name || 'location'}${licenseOverride ? ' (license override)' : ''}`);
      setReassignFor(null);
      setReassignChoice('');
      await fetchRows();
      onChanged(); // keep the job-row 'Assigned To' on the board in sync (criterion #4/#5)
```

New:
```typescript
      if (error) throw error;
      assertRpcResult<{ dispatched: number }>(data, 'dispatch_job_locations');
      reassignKeysRef.current.delete(scope); // confirmed success → next reassign of this intent is a new action
      toast('success', `Reassigned ${row.field_name || 'location'}${licenseOverride ? ' (license override)' : ''}`);

      // U12: notify the NEW applicator they got this location, and — if the
      // PREVIOUS assignee was a different applicator — notify them it's off
      // their plate. Crews are skipped (no single user to notify). Best-effort;
      // never blocks the already-committed reassign.
      if (kind === 'applicator') {
        void notifyApplicatorDispatched(id, row.job_number, row.customer_name || 'Unknown', null, row.job_id);
      }
      if (row.applicator_id && row.applicator_id !== (kind === 'applicator' ? id : null)) {
        void notifyApplicatorUndispatched(row.applicator_id, row.job_number, row.customer_name || 'Unknown', row.job_id);
      }

      setReassignFor(null);
      setReassignChoice('');
      await fetchRows();
      onChanged(); // keep the job-row 'Assigned To' on the board in sync (criterion #4/#5)
```

`kind`/`id` are already destructured at the top of `doReassign`
(`const [kind, id] = choice.split(':');`).

## 3) `doUndispatch` — after success (line ~1263-1268)

Old:
```typescript
      if (res.undispatched > 0) {
        toast('success', `Undispatched ${row.field_name || 'location'}`);
      } else {
        toast('info', 'This location was already undispatched or its job is no longer active — list refreshed.');
      }
```

New:
```typescript
      if (res.undispatched > 0) {
        toast('success', `Undispatched ${row.field_name || 'location'}`);
        // U12: tell the applicator this location is off their plate. Skipped
        // for a crew dispatch (no single user) and skipped when undispatched=0
        // (nothing actually changed — see the else branch below).
        if (row.applicator_id) {
          void notifyApplicatorUndispatched(row.applicator_id, row.job_number, row.customer_name || 'Unknown', row.job_id);
        }
      } else {
        toast('info', 'This location was already undispatched or its job is no longer active — list refreshed.');
      }
```
