# Patch — src/pages/Jobs.tsx

Purpose: mission item 4 (Applicators column reads dispatches, falls back to
applicator_id) + item 3 (Needs Dispatch badge/filter on the Jobs list).

## 1. Import the pure aggregator (no React dep) — old block (line 62-63)
```tsx
import type { Job, JobStatus, JobTag, GroundCrew, JobBatch } from '../types';
import type { Json } from '../types/supabase';
```

### New block
```tsx
import type { Job, JobStatus, JobTag, GroundCrew, JobBatch } from '../types';
import type { Json } from '../types/supabase';
import { aggregateAssignedTo } from '../lib/dispatchWizard';
```

## 2. JobRow type — old block (lines 76-105, the two fields near the end)
```tsx
  /** Field-app parity #3: the named batch this job belongs to (null = none). */
  batch_name: string | null;
};
```

### New block
```tsx
  /** Field-app parity #3: the named batch this job belongs to (null = none). */
  batch_name: string | null;
  /**
   * U13 (#15-21/#111): the per-location dispatch assignee names for this job
   * (a job split across two applicators/crews shows BOTH), falling back to the
   * whole-job applicator_name when there are no active per-location dispatches.
   * '-' when neither exists — mirrors DispatchBoard's aggregateAssignedTo.
   */
  assigned_to_label: string;
  /** U13: true for a SCHEDULED job with NO active ('dispatched') per-location row. */
  needs_dispatch: boolean;
};
```

## 3. fetchJobs select embed — old block (lines 408-421)
```tsx
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customer:customers(farm_name, account_number, phone),
        vehicle:vehicles(vehicle_name),
        job_fields(crop, field:fields(field_name, crop_type, county, state)),
        job_chemicals(rate_per_acre, rate_unit, product:products(product_name)),
        job_tag_assignments(tag:job_tags(id, name, color, created_by, created_at, updated_at)),
        batch:job_batches(name)
      `)
      .is('deleted_at', null)
      .order('job_date', { ascending: false })
      .limit(JOBS_FETCH_LIMIT);
```

### New block
```tsx
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customer:customers(farm_name, account_number, phone),
        vehicle:vehicles(vehicle_name),
        job_fields(crop, field:fields(field_name, crop_type, county, state)),
        job_chemicals(rate_per_acre, rate_unit, product:products(product_name)),
        job_tag_assignments(tag:job_tags(id, name, color, created_by, created_at, updated_at)),
        batch:job_batches(name),
        job_location_dispatches(applicator_id, crew_id, dispatch_status)
      `)
      .is('deleted_at', null)
      .order('job_date', { ascending: false })
      .limit(JOBS_FETCH_LIMIT);
```

## 4. RawJob type — old block (lines 460-471)
```tsx
    type RawJob = Record<string, unknown> & {
      customer?: { farm_name?: string; account_number?: string | null; phone?: string | null };
      vehicle?: { vehicle_name?: string };
      job_fields?: Array<{ crop?: string | null; field?: { field_name?: string; crop_type?: string | null; county?: string | null; state?: string | null } }>;
      job_chemicals?: Array<{ rate_per_acre?: number | null; rate_unit?: string | null; product?: { product_name?: string } }>;
      job_tag_assignments?: Array<{ tag?: JobTag | null }>;
      batch?: { name?: string } | null;
      applicator_id?: string | null;
      created_by?: string | null;
      updated_by?: string | null;
      last_printed_by?: string | null;
    };
```

### New block
```tsx
    type RawJob = Record<string, unknown> & {
      customer?: { farm_name?: string; account_number?: string | null; phone?: string | null };
      vehicle?: { vehicle_name?: string };
      job_fields?: Array<{ crop?: string | null; field?: { field_name?: string; crop_type?: string | null; county?: string | null; state?: string | null } }>;
      job_chemicals?: Array<{ rate_per_acre?: number | null; rate_unit?: string | null; product?: { product_name?: string } }>;
      job_tag_assignments?: Array<{ tag?: JobTag | null }>;
      batch?: { name?: string } | null;
      job_location_dispatches?: Array<{ applicator_id?: string | null; crew_id?: string | null; dispatch_status?: string }>;
      applicator_id?: string | null;
      status?: JobStatus;
      created_by?: string | null;
      updated_by?: string | null;
      last_printed_by?: string | null;
    };
```

## 5. Name resolution — the existing `profileIds`/`nameMap` block already resolves
`applicator_id` names (lines 477-487) — no change needed there; per-location
`applicator_id`s dispatched to a DIFFERENT profile than the job-level one are
already covered because they are also profiles. Only ADD a crew-name lookup
since crews aren't in `profileIds`. Old block (right after the `nameMap` build,
before `// Field-app FIX 2 ...`, lines 488-489):
```tsx

    // Field-app FIX 2 (Wave 2a security): resolve each job's BILLED customers via the
```

### New block
```tsx

    // U13 (#15-21/#111): resolve crew names for the per-location dispatch
    // aggregation below (job_location_dispatches.crew_id has no embed here —
    // ground_crews isn't in the jobs select — so look them up in one batch).
    const dispatchCrewIds = [...new Set(
      raw.flatMap((j) => (j.job_location_dispatches || []).map((d) => d.crew_id)).filter(Boolean) as string[]
    )];
    const crewNameMap: Record<string, string> = {};
    if (dispatchCrewIds.length > 0) {
      const { data: crewRows } = await supabase.from('ground_crews').select('id, name').in('id', dispatchCrewIds);
      (crewRows || []).forEach((c: { id: string; name: string }) => { crewNameMap[c.id] = c.name; });
    }

    // Field-app FIX 2 (Wave 2a security): resolve each job's BILLED customers via the
```

## 6. Row mapping — old block (lines 568-589, the `return { ...(j as unknown as Job), ... }`)
```tsx
      return {
        ...(j as unknown as Job),
        customer_name: j.customer?.farm_name || 'Unknown',
        applicator_name: j.applicator_id ? nameMap[j.applicator_id] || '-' : '-',
        vehicle_name: j.vehicle?.vehicle_name || '-',
        field_count: Array.isArray(j.job_fields) ? j.job_fields.length : 0,
        customers: jobCustomers,
        customers_search: customersSearch,
        customer_phone: j.customer?.phone ?? null,
        locations,
        crops,
        chemicals,
        created_by_name: j.created_by ? nameMap[j.created_by] || '-' : '-',
        updated_by_name: j.updated_by ? nameMap[j.updated_by] || '-' : '-',
        last_printed_by_name: j.last_printed_by ? nameMap[j.last_printed_by] || '-' : '-',
        jobTags,
        counties,
        states,
        chemicalNames,
        batch_name: j.batch?.name ?? null,
      };
    });
```

### New block
```tsx
      // U13 (#15-21/#111): aggregate per-location ACTIVE dispatch assignee names
      // (a split job shows BOTH), falling back to the whole-job applicator —
      // mirrors DispatchBoard's aggregateAssignedTo exactly so the two screens
      // never disagree on "who has this job".
      const activeDispatches = (j.job_location_dispatches || []).filter((d) => d.dispatch_status === 'dispatched');
      const dispatchNames = activeDispatches.map((d) =>
        d.applicator_id ? (nameMap[d.applicator_id] || null) : d.crew_id ? (crewNameMap[d.crew_id] || null) : null
      );
      const jobLevelApplicatorName = j.applicator_id ? nameMap[j.applicator_id] || null : null;
      const assignedToLabel = aggregateAssignedTo(dispatchNames, jobLevelApplicatorName) || '-';
      const needsDispatch = j.status === 'scheduled' && activeDispatches.length === 0;

      return {
        ...(j as unknown as Job),
        customer_name: j.customer?.farm_name || 'Unknown',
        applicator_name: j.applicator_id ? nameMap[j.applicator_id] || '-' : '-',
        vehicle_name: j.vehicle?.vehicle_name || '-',
        field_count: Array.isArray(j.job_fields) ? j.job_fields.length : 0,
        customers: jobCustomers,
        customers_search: customersSearch,
        customer_phone: j.customer?.phone ?? null,
        locations,
        crops,
        chemicals,
        created_by_name: j.created_by ? nameMap[j.created_by] || '-' : '-',
        updated_by_name: j.updated_by ? nameMap[j.updated_by] || '-' : '-',
        last_printed_by_name: j.last_printed_by ? nameMap[j.last_printed_by] || '-' : '-',
        jobTags,
        counties,
        states,
        chemicalNames,
        batch_name: j.batch?.name ?? null,
        assigned_to_label: assignedToLabel,
        needs_dispatch: needsDispatch,
      };
    });
```

## 7. Needs-Dispatch quick filter (client-side toggle, does NOT touch the shared
`JobFilters`/`jobFilters.ts` machinery — kept minimal/additive) —
old block (the `visibleJobs` memo, lines 637-656):
```tsx
  const visibleJobs = useMemo(() => {
    return jobs.filter((j) => {
      // Field-app parity #8: "Show Completed Jobs" toggle. When OFF, hide
      // completed jobs from the list (and therefore from totals + selection,
      // which read this same view). An explicit status filter that DOES include
      // 'completed' wins — the user clearly asked for them.
      if (!listSettings.showCompleted && j.status === 'completed' && !applied.statuses.includes('completed')) {
        return false;
      }
      const facts: JobFilterFacts = {
        tagIds: new Set(j.jobTags.map((t) => t.id)),
        crops: j.crops,
        counties: j.counties,
        states: j.states,
        chemicals: j.chemicalNames,
        fieldNames: j.locations,
      };
      return jobMatchesClientFilters(facts, applied);
    });
  }, [jobs, applied, listSettings.showCompleted]);
```

### New block
```tsx
  // U13 (#15-21/#111): "Needs Dispatch only" — a lightweight, LOCAL quick
  // filter (not plumbed into the shared JobFilters/jobFilters.ts facts system,
  // to keep this change additive and low-risk). Off by default.
  const [needsDispatchOnly, setNeedsDispatchOnly] = useState(false);

  const visibleJobs = useMemo(() => {
    return jobs.filter((j) => {
      // Field-app parity #8: "Show Completed Jobs" toggle. When OFF, hide
      // completed jobs from the list (and therefore from totals + selection,
      // which read this same view). An explicit status filter that DOES include
      // 'completed' wins — the user clearly asked for them.
      if (!listSettings.showCompleted && j.status === 'completed' && !applied.statuses.includes('completed')) {
        return false;
      }
      if (needsDispatchOnly && !j.needs_dispatch) {
        return false;
      }
      const facts: JobFilterFacts = {
        tagIds: new Set(j.jobTags.map((t) => t.id)),
        crops: j.crops,
        counties: j.counties,
        states: j.states,
        chemicals: j.chemicalNames,
        fieldNames: j.locations,
      };
      return jobMatchesClientFilters(facts, applied);
    });
  }, [jobs, applied, listSettings.showCompleted, needsDispatchOnly]);
```

## 8. Applicators column — old block (lines 1348-1352)
```tsx
    {
      key: 'applicator_name',
      header: 'Applicators',
      sortable: true,
    },
```

### New block
```tsx
    {
      key: 'applicator_name',
      header: 'Applicators',
      sortable: true,
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span>{r.assigned_to_label}</span>
          {r.needs_dispatch && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200 rounded"
              title="Scheduled with no dispatched applicator or crew"
            >
              Needs Dispatch
            </span>
          )}
        </span>
      ),
    },
```

> `sortable: true` keeps sorting on the raw `applicator_name` string column key
> (DataTable sorts by `row[key]`, i.e. `applicator_name`, not the rendered JSX) —
> unchanged sort behavior; only the CELL's rendering changes.

## 9. Quick-filter toggle control — add near the other filter-bar controls (e.g.
next to the date-preset buttons / "Show Completed Jobs" toggle in List
Settings). Minimal standalone control, does not require reading the whole
filter-bar JSX to place correctly — add wherever a peer boolean toggle already
renders (search for how `listSettings.showCompleted` is exposed as a checkbox
in the List Settings modal, OR — simpler and equally valid — drop this button
inline just above the `<DataTable ...>` call):
```tsx
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => setNeedsDispatchOnly((v) => !v)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
            needsDispatchOnly
              ? 'bg-amber-50 border-amber-300 text-amber-800'
              : 'bg-white border-gray-200 text-secondary hover:bg-gray-50'
          }`}
        >
          Needs Dispatch only {needsDispatchOnly && `(${jobs.filter((j) => j.needs_dispatch).length})`}
        </button>
      </div>
```
Exact placement: immediately above the `<DataTable` render call for the jobs
table (search `<DataTable` in the JSX return — insert this block right before
it, inside the same `<Card>`/wrapper).
