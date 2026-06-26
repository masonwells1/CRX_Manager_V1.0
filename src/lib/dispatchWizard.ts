/**
 * dispatchWizard.ts — pure, framework-free logic for the 3-step "Dispatch Jobs"
 * wizard (field-app parity #36).
 *
 * The wizard targets individual field LOCATIONS (job_fields rows), NOT just whole
 * jobs, and assigns each selected location to an applicator OR a crew. Different
 * selected locations can go to DIFFERENT assignees in one session, so two crews
 * can split one big job.
 *
 * Kept side-effect-free so the selection model, the per-location assignment map,
 * and the commit-payload builder are all unit-testable in isolation. The React
 * component owns only state + the RPC call.
 */

/** The three wizard steps, in order. */
export type DispatchStep = 'select' | 'assign' | 'finish';
export const DISPATCH_STEPS: DispatchStep[] = ['select', 'assign', 'finish'];

/** An assignee is an applicator OR a crew (exactly one). */
export type AssigneeKind = 'applicator' | 'crew';

export interface DispatchAssignee {
  kind: AssigneeKind;
  /** profiles.id for an applicator, ground_crews.id for a crew. */
  id: string;
  /** Display name (applicator full_name or crew name). */
  name: string;
}

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

/**
 * The per-location assignment map: job_field_id -> chosen assignee (or undefined
 * if not yet assigned). This is the heart of Step 2 — it lets different selected
 * locations map to different applicators/crews within one dispatch session.
 */
export type AssignmentMap = Record<string, DispatchAssignee | undefined>;

/** One row in the RPC payload (matches dispatch_job_locations p_assignments). */
export interface DispatchAssignmentPayload {
  job_field_id: string;
  applicator_id: string | null;
  crew_id: string | null;
}

/** Toggle a location in/out of the selected set (immutably). */
export function toggleLocation(selected: ReadonlySet<string>, jobFieldId: string): Set<string> {
  const next = new Set(selected);
  if (next.has(jobFieldId)) next.delete(jobFieldId);
  else next.add(jobFieldId);
  return next;
}

/**
 * Set (or clear) the assignee for one location (immutably). Passing `undefined`
 * clears it. The wizard uses this when the dispatcher picks an applicator/crew
 * for a specific selected location in Step 2.
 */
export function setAssignment(
  map: AssignmentMap,
  jobFieldId: string,
  assignee: DispatchAssignee | undefined
): AssignmentMap {
  const next: AssignmentMap = { ...map };
  if (assignee) next[jobFieldId] = assignee;
  else delete next[jobFieldId];
  return next;
}

/**
 * Assign EVERY currently-selected location to one assignee in a single action
 * (the "apply to all" convenience in Step 2). Only touches selected locations.
 */
export function assignAll(
  map: AssignmentMap,
  selected: ReadonlySet<string>,
  assignee: DispatchAssignee
): AssignmentMap {
  const next: AssignmentMap = { ...map };
  for (const jobFieldId of selected) next[jobFieldId] = assignee;
  return next;
}

/** Drop assignments for any location no longer selected (keeps the map tidy). */
export function pruneAssignments(map: AssignmentMap, selected: ReadonlySet<string>): AssignmentMap {
  const next: AssignmentMap = {};
  for (const jobFieldId of Object.keys(map)) {
    if (selected.has(jobFieldId) && map[jobFieldId]) next[jobFieldId] = map[jobFieldId];
  }
  return next;
}

/** True once at least one location is selected (Step 1 -> Step 2 gate). */
export function canAdvanceToAssign(selected: ReadonlySet<string>): boolean {
  return selected.size > 0;
}

/**
 * True once EVERY selected location has an assignee (Step 2 -> Step 3 gate).
 * An empty selection is not finishable.
 */
export function canAdvanceToFinish(selected: ReadonlySet<string>, map: AssignmentMap): boolean {
  if (selected.size === 0) return false;
  for (const jobFieldId of selected) {
    if (!map[jobFieldId]) return false;
  }
  return true;
}

/** Count of selected locations still missing an assignee (for Step 2 hints). */
export function unassignedCount(selected: ReadonlySet<string>, map: AssignmentMap): number {
  let n = 0;
  for (const jobFieldId of selected) if (!map[jobFieldId]) n += 1;
  return n;
}

/**
 * Build the RPC payload (p_assignments) from the selection + assignment map.
 * Only selected, fully-assigned locations are included; each becomes exactly one
 * { job_field_id, applicator_id|null, crew_id|null } with the XOR honored
 * (applicator XOR crew). Throws if a selected location is unassigned — callers
 * gate on canAdvanceToFinish first, so this is a defensive invariant.
 */
export function buildDispatchPayload(
  selected: ReadonlySet<string>,
  map: AssignmentMap
): DispatchAssignmentPayload[] {
  const payload: DispatchAssignmentPayload[] = [];
  for (const jobFieldId of selected) {
    const assignee = map[jobFieldId];
    if (!assignee) {
      throw new Error(`Location ${jobFieldId} has no assignee`);
    }
    payload.push({
      job_field_id: jobFieldId,
      applicator_id: assignee.kind === 'applicator' ? assignee.id : null,
      crew_id: assignee.kind === 'crew' ? assignee.id : null,
    });
  }
  return payload;
}

/**
 * Summarize the pending dispatch for the Step 3 confirmation: per assignee, the
 * list of locations going to them. Stable ordering by assignee name then job/field.
 */
export interface DispatchSummaryGroup {
  assignee: DispatchAssignee;
  locations: DispatchLocation[];
}

export function summarizeDispatch(
  selected: ReadonlySet<string>,
  map: AssignmentMap,
  locations: ReadonlyArray<DispatchLocation>
): DispatchSummaryGroup[] {
  const byJobField = new Map(locations.map((l) => [l.jobFieldId, l]));
  const groups = new Map<string, DispatchSummaryGroup>();
  for (const jobFieldId of selected) {
    const assignee = map[jobFieldId];
    const loc = byJobField.get(jobFieldId);
    if (!assignee || !loc) continue;
    const key = `${assignee.kind}:${assignee.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { assignee, locations: [] };
      groups.set(key, group);
    }
    group.locations.push(loc);
  }
  const result = Array.from(groups.values());
  for (const g of result) {
    g.locations.sort((a, b) =>
      a.jobNumber.localeCompare(b.jobNumber) || a.fieldName.localeCompare(b.fieldName)
    );
  }
  result.sort((a, b) => a.assignee.name.localeCompare(b.assignee.name));
  return result;
}

/**
 * Aggregate the distinct assignee names for a job from its per-location dispatch
 * rows (criteria #5/#6: a job split between two applicators shows BOTH names).
 * Falls back to the supplied whole-job applicator name when the job has NO
 * per-location dispatches. Returns a de-duplicated, sorted display string (or
 * null when there is nothing to show).
 */
export function aggregateAssignedTo(
  perLocationNames: ReadonlyArray<string | null | undefined>,
  jobLevelApplicatorName: string | null | undefined
): string | null {
  const names = perLocationNames.filter((n): n is string => !!n && n.trim() !== '');
  if (names.length > 0) {
    const distinct = Array.from(new Set(names.map((n) => n.trim()))).sort((a, b) => a.localeCompare(b));
    return distinct.join(', ');
  }
  const fallback = (jobLevelApplicatorName ?? '').trim();
  return fallback === '' ? null : fallback;
}
