# Patch: src/lib/dispatchDisplay.ts

All additions — nothing existing is removed or renamed (`chemicalChargeCents`
stays exported/tested even though FieldView stops calling it, per "additive
only"; DispatchBoard's live use of `jobStatusToDispatchBadge` is untouched).

## 1) `DispatchedListRow` — add `job_date` (matches migration `20260706060000`'s
new jsonb key)

Old:
```typescript
export interface DispatchedListRow {
  dispatch_id: string;
  job_field_id: string;
  job_id: string;
  job_number: string;
  /** The job lifecycle status (scheduled/in_progress/...) — drives the row badge. */
  job_status: string;
  dispatch_status: string;
```

New:
```typescript
export interface DispatchedListRow {
  dispatch_id: string;
  job_field_id: string;
  job_id: string;
  job_number: string;
  /** The job lifecycle status (scheduled/in_progress/...) — drives the row badge. */
  job_status: string;
  /** jobs.job_date (U12) — lets the FieldView card show the date without an
   *  expand-triggered fetch, and drives the Today-first sort / Done section. */
  job_date: string | null;
  dispatch_status: string;
```

## 2) `FieldViewJobCard` — add `job_date`

Old:
```typescript
export interface FieldViewJobCard {
  job_id: string;
  job_number: string;
  job_status: string;
  customer_name: string | null;
```

New:
```typescript
export interface FieldViewJobCard {
  job_id: string;
  job_number: string;
  job_status: string;
  /** jobs.job_date (U12) — see DispatchedListRow.job_date. */
  job_date: string | null;
  customer_name: string | null;
```

## 3) `groupDispatchedByJob` — carry `job_date` onto the card

Old:
```typescript
      card = {
        job_id: r.job_id,
        job_number: r.job_number,
        job_status: r.job_status,
        customer_name: r.customer_name,
        job_applied_acres: r.job_applied_acres,
        job_total_acres: r.job_total_acres,
        locations: [],
      };
```

New:
```typescript
      card = {
        job_id: r.job_id,
        job_number: r.job_number,
        job_status: r.job_status,
        job_date: r.job_date,
        customer_name: r.customer_name,
        job_applied_acres: r.job_applied_acres,
        job_total_acres: r.job_total_acres,
        locations: [],
      };
```

## 4) New pure helpers — append at the end of the file (after `chemicalChargeCents`)

```typescript
/**
 * Terminal job-lifecycle statuses (CLAUDE.md Job lifecycle:
 * `scheduled → in_progress → completed → cancelled → invoiced`). A terminal
 * job's dispatch has nothing left for the applicator to DO — it belongs in
 * the FieldView "Done" section, not mixed in with today's actionable work.
 */
export function isTerminalJobStatus(status: string): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'invoiced';
}

/** The two FieldView sections: today-first actionable jobs, and a Done tail. */
export interface FieldViewCardGroups {
  active: FieldViewJobCard[];
  done: FieldViewJobCard[];
}

/**
 * Split + sort the caller's job cards for the FieldView "My Day" list (U12).
 *
 * Design decision (mission #22/#24-33 — "hide terminal jobs by default" vs.
 * "return them with status so the UI can show a Done section"): the LATTER.
 * get_dispatched_list still returns every currently-dispatched row regardless
 * of the job's lifecycle status (unchanged — filtering server-side would give
 * an applicator no way to see what they just finished today), and the CLIENT
 * groups: non-terminal jobs sort TODAY-first (job_date === today) then by
 * ascending job_date (nulls last), tie-broken by job_number; terminal jobs
 * move to a separate `done` bucket, most-recently-dated first, so a completed
 * job doesn't visually compete with today's remaining work but isn't hidden
 * either. `todayStr` is caller-supplied (e.g. `localToday()`) so this stays a
 * pure, framework-free, unit-testable function (no `Date.now()` inside).
 *
 * Known limitation (documented, not fixed here — see the migration's header
 * comment): a job that reaches a terminal status keeps its
 * job_location_dispatches row at dispatch_status='dispatched' forever unless a
 * dispatcher explicitly undispatches it — so the Done bucket can grow without
 * bound over time. Out of scope for this unit; flagged as a fast-follow
 * (either a dispatcher habit of undispatching finished work, or a future
 * trigger that auto-transitions dispatch_status to 'completed' when the job
 * does).
 */
export function groupFieldViewCards(
  cards: FieldViewJobCard[],
  todayStr: string
): FieldViewCardGroups {
  const active: FieldViewJobCard[] = [];
  const done: FieldViewJobCard[] = [];
  for (const c of cards) {
    if (isTerminalJobStatus(c.job_status)) done.push(c);
    else active.push(c);
  }

  active.sort((a, b) => {
    const aToday = a.job_date === todayStr;
    const bToday = b.job_date === todayStr;
    if (aToday !== bToday) return aToday ? -1 : 1;
    const ad = a.job_date ?? '9999-99-99'; // undated sorts last
    const bd = b.job_date ?? '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.job_number.localeCompare(b.job_number);
  });

  done.sort((a, b) => {
    const ad = a.job_date ?? '';
    const bd = b.job_date ?? '';
    if (ad !== bd) return ad > bd ? -1 : 1; // most-recent first
    return a.job_number.localeCompare(b.job_number);
  });

  return { active, done };
}

/**
 * The strictest (longest) REI/PHI across a job's chemical mix (U12, criterion
 * "REI/PHI line when label data exists"). A job applies ALL its listed
 * chemicals together, so the field isn't safe to re-enter / harvest until the
 * LONGEST of any product's re-entry/pre-harist interval has passed — mirrors
 * how `compareToMaxRate`/label guardrails already treat a job's chemical set.
 * Returns null for a value when NO chemical in the mix has that label field on
 * file (matches the live reality that 0/604 products have REI/PHI data today —
 * the UI shows nothing for a job whose products aren't labeled yet, never a
 * misleading 0).
 */
export function maxLabelReiPhi(
  chemicals: { rei_hours: number | null | undefined; phi_days: number | null | undefined }[]
): { reiHours: number | null; phiDays: number | null } {
  let reiHours: number | null = null;
  let phiDays: number | null = null;
  for (const c of chemicals) {
    if (typeof c.rei_hours === 'number' && (reiHours === null || c.rei_hours > reiHours)) reiHours = c.rei_hours;
    if (typeof c.phi_days === 'number' && (phiDays === null || c.phi_days > phiDays)) phiDays = c.phi_days;
  }
  return { reiHours, phiDays };
}
```
