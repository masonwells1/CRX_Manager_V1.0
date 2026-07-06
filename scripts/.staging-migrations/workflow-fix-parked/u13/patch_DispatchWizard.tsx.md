# Patch — src/components/dispatch/DispatchWizard.tsx

Purpose: (1) accept an optional `initialSelectedIds` so a job-scoped caller
(JobDetail) can open the wizard with its own locations pre-selected (mission
item 5: "opens the wizard JOB-SCOPED (pre-selected)"); (2) show a "Currently: X"
chip per location in Step 2 when `currentAssignee` is present; (3) require an
explicit confirm before finishing if any selected location would be reassigned
away from a DIFFERENT existing assignee ("stealing" it). Fully backward
compatible with DispatchBoard's existing invocation (no `currentAssignee` on its
locations => no chip, no steal-confirm, unchanged behavior).

## 1. Import — old block (lines 32-47)
```ts
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
  type DispatchStep,
  type DispatchLocation,
  type DispatchAssignee,
  type AssignmentMap,
} from '../../lib/dispatchWizard';
```

### New block
```ts
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
```

## 2. Props — old block (lines 58-70)
```ts
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
}
```

### New block
```ts
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
   * job). Applied once per open (when the current selection is empty) so it
   * never fights a user's mid-session deselection. Omit for the ordinary
   * DispatchBoard flow (no pre-selection, unchanged).
   */
  initialSelectedIds?: string[];
}
```

## 3. Component signature + pre-select effect — old block (lines 78-99)
```ts
export default function DispatchWizard({
  open,
  onClose,
  locations,
  applicators,
  crews,
  performedBy,
  isAdmin,
  onDispatched,
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
```

### New block
```ts
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

  // U13: pre-select on a fresh open (job-scoped callers). Only fires while the
  // selection is still empty, so it can never clobber a user's in-progress
  // deselection on a re-render.
  useEffect(() => {
    if (open && initialSelectedIds && initialSelectedIds.length > 0 && selected.size === 0) {
      setSelected(new Set(initialSelectedIds));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSelectedIds]);
```

> Note: add `useEffect` to the existing `import { useMemo, useState, useCallback } from 'react';`
> line near the top of the file (becomes `import { useMemo, useState, useCallback, useEffect } from 'react';`).

## 4. Steal-aware Finish handling — old block
```ts
  const missing = unassignedCount(selected, assignments);
```

### New block
```ts
  const missing = unassignedCount(selected, assignments);
  const stolenLocations = useMemo(
    () => locationsBeingStolen(selected, assignments, locations),
    [selected, assignments, locations]
  );
```

## 5. Step-2 per-location row — old block
```ts
              <div className="space-y-2">
                {selectedLocations.map((loc) => {
                  const current = assignments[loc.jobFieldId];
                  return (
                    <div key={loc.jobFieldId} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-100 truncate">{loc.fieldName}</p>
                        <p className="text-xs text-slate-500 truncate">{loc.jobNumber} · {loc.customerName}</p>
                      </div>
```

### New block
```ts
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
```

## 6. Finish button — old block
```ts
            {step === 'finish' && (
              <button
                onClick={() => handleFinish()}
                disabled={submitting || !canAdvanceToFinish(selected, assignments)}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-crx-green text-sm font-semibold text-white hover:bg-crx-green/90 disabled:opacity-50 min-h-[44px]"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Finish Dispatching
              </button>
            )}
```

### New block
```ts
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
```

## 7. Add a second ConfirmModal — old block (end of file, the license-override modal)
```ts
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
    </div>
  );
}
```

### New block
```ts
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
```

## Unit-test note
`src/lib/__tests__/dispatchWizard.test.ts` should gain a case for
`locationsBeingStolen` (existing file/pattern; not reproduced here to keep this
patch focused — add a couple of cases: no currentAssignee => not stolen; same
assignee re-selected => not stolen; different assignee chosen => stolen).
