# Patch — src/lib/dispatchWizard.ts

Purpose: (1) let a caller attach the location's CURRENT assignee so the wizard
can show a "Currently assigned to X" chip and require confirmation before
silently stealing a location from someone else (mission item 5); (2) a pure,
unit-testable helper `locationsBeingStolen` the component uses to decide
whether to show that confirm step. Additive only — no existing export's
signature changes.

## Old block (lines 30-40)
```ts
/** A selectable field location, flattened across jobs for Step 1. */
export interface DispatchLocation {
  /** job_fields.id — the per-job location id (the dispatch target). */
  jobFieldId: string;
  jobId: string;
  jobNumber: string;
  customerName: string;
  /** fields.field_name (or a fallback label). */
  fieldName: string;
  acres: number | null;
}
```

## New block
```ts
/** A selectable field location, flattened across jobs for Step 1. */
export interface DispatchLocation {
  /** job_fields.id — the per-job location id (the dispatch target). */
  jobFieldId: string;
  jobId: string;
  jobNumber: string;
  customerName: string;
  /** fields.field_name (or a fallback label). */
  fieldName: string;
  acres: number | null;
  /**
   * U13 (#15-21/#111): the location's CURRENT active ('dispatched') assignee,
   * if any — populated by callers that pre-fetch job_location_dispatches (e.g.
   * JobDetail's job-scoped "Dispatch Locations" button). Optional/undefined for
   * callers that don't track it (e.g. the DispatchBoard's board-wide wizard,
   * unchanged) — no chip/steal-confirmation renders for those, so this is fully
   * backward compatible.
   */
  currentAssignee?: DispatchAssignee | null;
}
```

---

Append this new helper at the END of the file (after `aggregateAssignedTo`),
right after its closing brace:

```ts

/**
 * U13 (#15-21/#111): which SELECTED, fully-assigned locations would be
 * reassigned AWAY from a DIFFERENT existing assignee ("stolen" from whoever
 * currently has them). A location with no currentAssignee (never dispatched)
 * or whose chosen assignee is the SAME as its current one is never "stolen".
 * Pure so the Step-3 steal-confirmation gate is unit-testable without mounting
 * the wizard.
 */
export function locationsBeingStolen(
  selected: ReadonlySet<string>,
  map: AssignmentMap,
  locations: ReadonlyArray<DispatchLocation>
): DispatchLocation[] {
  const byId = new Map(locations.map((l) => [l.jobFieldId, l]));
  const stolen: DispatchLocation[] = [];
  for (const jobFieldId of selected) {
    const loc = byId.get(jobFieldId);
    const chosen = map[jobFieldId];
    if (!loc || !chosen || !loc.currentAssignee) continue;
    if (loc.currentAssignee.kind !== chosen.kind || loc.currentAssignee.id !== chosen.id) {
      stolen.push(loc);
    }
  }
  return stolen;
}
```
