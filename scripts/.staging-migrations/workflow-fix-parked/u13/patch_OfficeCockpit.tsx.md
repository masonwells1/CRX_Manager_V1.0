# Patch — src/pages/OfficeCockpit.tsx

Purpose: mission item 3 — a "Needs Dispatch" cockpit tile (the (h) slot the
file's own header comment left open: "(g) Inventory shortfalls — deferred
follow-on" is (g); this adds (h)). Same fetch/render pattern as every other
tile in this file (Card + TileHeader + AllClear + a `.slice(0,6)` list).

## 1. New row type — old block (near `ShortfallRow`, lines 105-114)
```tsx
interface ShortfallRow {
  product_id: string;
  product_name: string;
  inventory_unit: string | null;
  needed_qty: number;
  available_free: number;
  shortfall_qty: number;
  job_count: number;
  job_numbers: string[];
}
```

### New block
```tsx
interface ShortfallRow {
  product_id: string;
  product_name: string;
  inventory_unit: string | null;
  needed_qty: number;
  available_free: number;
  shortfall_qty: number;
  job_count: number;
  job_numbers: string[];
}

/** U13 (#15-21/#111): a SCHEDULED job with no active per-location dispatch. */
interface NeedsDispatchJobRow {
  id: string;
  job_number: string;
  job_date: string;
  customer_name: string;
}
```

## 2. CockpitData — old block (the interface, ~lines 116-124)
```tsx
interface CockpitData {
  unbilledJobs: UnbilledJobRow[];
  postableInvoices: PostableInvoiceRow[];
  watchdogFlags: WatchdogFlag[];
  upcomingJobs: UpcomingJobRow[];
```
(followed by the remaining fields — only ADD one line, do not remove any existing field)

### New block
```tsx
interface CockpitData {
  unbilledJobs: UnbilledJobRow[];
  postableInvoices: PostableInvoiceRow[];
  watchdogFlags: WatchdogFlag[];
  upcomingJobs: UpcomingJobRow[];
  /** U13: scheduled jobs with no active per-location dispatch. */
  needsDispatchJobs: NeedsDispatchJobRow[];
```

## 3. Initial state — old block
```tsx
  const [data, setData] = useState<CockpitData>({
    unbilledJobs: [],
    postableInvoices: [],
    watchdogFlags: [],
    upcomingJobs: [],
    expiringLicenses: [],
    overdueAR: [],
    shortfalls: [],
    shortfallsLoadOk: false,
    watchdogLoadOk: false,
  });
```

### New block
```tsx
  const [data, setData] = useState<CockpitData>({
    unbilledJobs: [],
    postableInvoices: [],
    watchdogFlags: [],
    upcomingJobs: [],
    needsDispatchJobs: [],
    expiringLicenses: [],
    overdueAR: [],
    shortfalls: [],
    shortfallsLoadOk: false,
    watchdogLoadOk: false,
  });
```

## 4. Fetch — old block (the `Promise.all` array + its result destructuring, lines 280-341)
```tsx
    const [
      unbilledJobsRes,
      postableInvRes,
      upcomingJobsRes,
      expiringLicRes,
      overdueARRes,
    ] = await Promise.all([
      // (a) Completed jobs with no invoice
      supabase
        .from('jobs')
        .select('id, job_number, job_date, total_acres, total_price_cents, customer:customers(farm_name)')
        .eq('status', 'completed')
        .is('invoice_id', null)
        .is('deleted_at', null)
        .order('job_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (b) Draft/unposted field-app invoices (§4 auto-populates these)
      supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, status, total_amount_cents, job_id, invoice_group_id, pricing_pending, customer:customers(farm_name)')
        .in('status', ['draft', 'unposted'])
        .eq('invoice_type', 'field_application')
        .is('deleted_at', null)
        .order('invoice_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (d) Upcoming scheduled jobs (next 7 days) — proxy for weather-at-risk
      supabase
        .from('jobs')
        .select('id, job_number, job_date, total_acres, customer:customers(farm_name)')
        .eq('status', 'scheduled')
        .is('deleted_at', null)
        .gte('job_date', today)
        .lte('job_date', in7Days)
        .order('job_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (e) Expiring applicator licenses / buyer certs within 30 days
      supabase
        .from('applicator_licenses')
        .select('id, holder_name, license_type, expiry_date, customer:customers(farm_name)')
        .eq('is_active', true)
        .gte('expiry_date', past30Days)
        .lte('expiry_date', in30Days)
        .order('expiry_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (f) Overdue field-app AR: balance > 0, past due_date. Include BOTH 'posted'
      // (past due but not yet swept) AND 'overdue' (already marked by mark_overdue_invoices)
      // — filtering to 'posted' alone hides the invoices that are actually overdue.
      supabase
        .from('invoices')
        .select('id, invoice_number, due_date, balance_cents, customer:customers(farm_name)')
        .eq('invoice_type', 'field_application')
        .in('status', ['posted', 'overdue'])
        .lt('due_date', today)
        .gt('balance_cents', 0)
        .is('deleted_at', null)
        .order('due_date', { ascending: true })
        .limit(TILE_LIMIT),
    ]);

    const errors = [
      unbilledJobsRes.error,
      postableInvRes.error,
      watchdogRes.error,
      shortfallsRes.error,
      upcomingJobsRes.error,
      expiringLicRes.error,
      overdueARRes.error,
    ].filter(Boolean);
```

### New block
```tsx
    const [
      unbilledJobsRes,
      postableInvRes,
      upcomingJobsRes,
      expiringLicRes,
      overdueARRes,
      needsDispatchRes,
    ] = await Promise.all([
      // (a) Completed jobs with no invoice
      supabase
        .from('jobs')
        .select('id, job_number, job_date, total_acres, total_price_cents, customer:customers(farm_name)')
        .eq('status', 'completed')
        .is('invoice_id', null)
        .is('deleted_at', null)
        .order('job_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (b) Draft/unposted field-app invoices (§4 auto-populates these)
      supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, status, total_amount_cents, job_id, invoice_group_id, pricing_pending, customer:customers(farm_name)')
        .in('status', ['draft', 'unposted'])
        .eq('invoice_type', 'field_application')
        .is('deleted_at', null)
        .order('invoice_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (d) Upcoming scheduled jobs (next 7 days) — proxy for weather-at-risk
      supabase
        .from('jobs')
        .select('id, job_number, job_date, total_acres, customer:customers(farm_name)')
        .eq('status', 'scheduled')
        .is('deleted_at', null)
        .gte('job_date', today)
        .lte('job_date', in7Days)
        .order('job_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (e) Expiring applicator licenses / buyer certs within 30 days
      supabase
        .from('applicator_licenses')
        .select('id, holder_name, license_type, expiry_date, customer:customers(farm_name)')
        .eq('is_active', true)
        .gte('expiry_date', past30Days)
        .lte('expiry_date', in30Days)
        .order('expiry_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (f) Overdue field-app AR: balance > 0, past due_date. Include BOTH 'posted'
      // (past due but not yet swept) AND 'overdue' (already marked by mark_overdue_invoices)
      // — filtering to 'posted' alone hides the invoices that are actually overdue.
      supabase
        .from('invoices')
        .select('id, invoice_number, due_date, balance_cents, customer:customers(farm_name)')
        .eq('invoice_type', 'field_application')
        .in('status', ['posted', 'overdue'])
        .lt('due_date', today)
        .gt('balance_cents', 0)
        .is('deleted_at', null)
        .order('due_date', { ascending: true })
        .limit(TILE_LIMIT),

      // (h) U13 (#15-21/#111): scheduled jobs with NO active per-location
      // dispatch. Embeds job_location_dispatches (dispatch_status) and filters
      // client-side for "none are 'dispatched'" below — mirrors the same
      // technique used by the Jobs list's "Needs Dispatch" column/filter, so
      // the two screens agree on exactly which jobs qualify.
      supabase
        .from('jobs')
        .select('id, job_number, job_date, customer:customers(farm_name), job_location_dispatches(dispatch_status)')
        .eq('status', 'scheduled')
        .is('deleted_at', null)
        .order('job_date', { ascending: true })
        .limit(TILE_LIMIT),
    ]);

    const errors = [
      unbilledJobsRes.error,
      postableInvRes.error,
      watchdogRes.error,
      shortfallsRes.error,
      upcomingJobsRes.error,
      expiringLicRes.error,
      overdueARRes.error,
      needsDispatchRes.error,
    ].filter(Boolean);
```

## 5. Map the result — old block (right after `overdueAR` is built, before `let shortfalls`, ~lines 408-415)
```tsx
    const overdueAR: OverdueARRow[] = ((overdueARRes.data || []) as RawOverdueAR[]).map((r) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      due_date: r.due_date,
      balance_cents: r.balance_cents,
      customer_name: r.customer?.farm_name ?? 'Unknown',
    }));

    let shortfalls: ShortfallRow[] = [];
```

### New block
```tsx
    const overdueAR: OverdueARRow[] = ((overdueARRes.data || []) as RawOverdueAR[]).map((r) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      due_date: r.due_date,
      balance_cents: r.balance_cents,
      customer_name: r.customer?.farm_name ?? 'Unknown',
    }));

    // U13: keep only jobs where NONE of the embedded dispatch rows are
    // currently 'dispatched' (a cancelled/completed dispatch row doesn't count).
    type RawNeedsDispatch = {
      id: string; job_number: string; job_date: string;
      customer?: { farm_name?: string } | null;
      job_location_dispatches?: Array<{ dispatch_status?: string }>;
    };
    const needsDispatchJobs: NeedsDispatchJobRow[] = ((needsDispatchRes.data || []) as RawNeedsDispatch[])
      .filter((r) => !(r.job_location_dispatches || []).some((d) => d.dispatch_status === 'dispatched'))
      .map((r) => ({
        id: r.id,
        job_number: r.job_number,
        job_date: r.job_date,
        customer_name: r.customer?.farm_name ?? 'Unknown',
      }));

    let shortfalls: ShortfallRow[] = [];
```

## 6. setData — old block
```tsx
    setData({ unbilledJobs, postableInvoices, watchdogFlags, upcomingJobs, expiringLicenses, overdueAR, shortfalls, shortfallsLoadOk, watchdogLoadOk });
```

### New block
```tsx
    setData({ unbilledJobs, postableInvoices, watchdogFlags, upcomingJobs, needsDispatchJobs, expiringLicenses, overdueAR, shortfalls, shortfallsLoadOk, watchdogLoadOk });
```

## 7. Include in the exception count — old block
```tsx
  const totalExceptions =
    data.unbilledJobs.length +
    data.postableInvoices.length +
    data.watchdogFlags.length +
    data.expiringLicenses.length +
    data.overdueAR.length +
    data.shortfalls.length;
```

### New block
```tsx
  const totalExceptions =
    data.unbilledJobs.length +
    data.postableInvoices.length +
    data.watchdogFlags.length +
    data.expiringLicenses.length +
    data.overdueAR.length +
    data.shortfalls.length +
    data.needsDispatchJobs.length;
```

## 8. New tile JSX — add a new `<Card>` block as a sibling of the "(a) Unbilled
Jobs" tile shown earlier in this file (same `TileHeader` + `AllClear` +
`.slice(0,6)` list pattern). Insert it directly after the Unbilled Jobs `<Card>`
closes (i.e. right before tile (b)'s `<Card>` begins), using the `Send` icon
(new import — add `Send` to the existing `lucide-react` import list at the top
of the file, alongside `RefreshCw, Tractor, FileCheck, ...`):

```tsx
        {/* (h) U13 (#15-21/#111): scheduled jobs with no active dispatch */}
        <Card>
          <TileHeader
            icon={<Send className="w-5 h-5 text-sky-500" />}
            title="Needs Dispatch"
            count={data.needsDispatchJobs.length}
            countColor="text-sky-600"
            linkLabel="View all"
            onLink={() => navigate('/jobs')}
          />
          {data.needsDispatchJobs.length === 0 ? (
            <AllClear label="No scheduled jobs without a dispatched applicator or crew." />
          ) : (
            <div className="divide-y divide-gray-100">
              {data.needsDispatchJobs.slice(0, 6).map((row) => (
                <button
                  key={row.id}
                  onClick={() => navigate(`/jobs/${row.id}`)}
                  className="w-full flex items-center justify-between py-2 text-sm hover:bg-gray-50 rounded transition-colors text-left"
                >
                  <div>
                    <span className="font-medium text-nav-dark">{row.customer_name}</span>
                    <span className="ml-2 text-gray-500">#{row.job_number}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
```
