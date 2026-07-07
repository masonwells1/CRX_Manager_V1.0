# Patch — src/pages/QuoteBuilder.tsx

Purpose: mission item 6 (#111) — block scheduling a job from a section with no
Field selected (verified live: `create_job_from_quote_section`'s U5 text at
`supabase/migrations/20260706030000_closed_short_booking_closure.sql:527` only
inserts a `job_fields` row `IF v_section.field_id IS NOT NULL` — a field-less
section silently creates a LOCATION-LESS job: 0 acres, nothing to apply
chemicals on, nothing our new U13 dispatch-sync can ever attach to), and
per-section job badges (none exist today — verified via grep, no
`sectionJobs`/"already scheduled" logic in the current file).

No RPC change — `create_job_from_quote_section` is NOT touched again (it has
already been re-emitted for U5 this session; this is a client-side guard only,
avoiding a 4th re-emit of the same lineage).

## 1. Type imports — old block (lines 57-71)
```tsx
import type {
  Quote,
  QuoteSection,
  QuoteItem,
  QuoteVersion,
  QuotePdfTemplate,
  QuoteTemplate,
  Product,
  Customer,
  UnitConversion,
  CommissionSplit,
  QuoteStatus,
  BookingSettlement,
} from '../types';
import type { Json } from '../types/supabase';
```

### New block
```tsx
import type {
  Quote,
  QuoteSection,
  QuoteItem,
  QuoteVersion,
  QuotePdfTemplate,
  QuoteTemplate,
  Product,
  Customer,
  UnitConversion,
  CommissionSplit,
  QuoteStatus,
  BookingSettlement,
  JobStatus,
} from '../types';
import type { Json } from '../types/supabase';
```

## 2. New state — old block (near `schedulingJobSectionKey`, line 1619)
```tsx
  const [schedulingJobSectionKey, setSchedulingJobSectionKey] = useState<string | null>(null);
```

### New block
```tsx
  const [schedulingJobSectionKey, setSchedulingJobSectionKey] = useState<string | null>(null);
  // U13 (#111): quote_section.id -> the job already scheduled from it (if any).
  // Populated by fetchQuote + updated locally right after a successful schedule
  // so the badge/hide-button logic never needs a full page reload.
  const [sectionJobs, setSectionJobs] = useState<Record<string, { id: string; job_number: string; status: JobStatus }>>({});
```

## 3. Block field-less scheduling — old block (lines 1621-1624)
```tsx
  const handleScheduleJob = async (sectionKey: string) => {
    const sec = sections.find((s) => s._key === sectionKey);
    if (!sec?.id || !quoteId || !profile) return;
    setSchedulingJobSectionKey(sectionKey);
```

### New block
```tsx
  const handleScheduleJob = async (sectionKey: string) => {
    const sec = sections.find((s) => s._key === sectionKey);
    if (!sec?.id || !quoteId || !profile) return;
    // U13 (#111): create_job_from_quote_section only inserts a job_fields row
    // `IF v_section.field_id IS NOT NULL` — a field-less section would silently
    // create a job with ZERO locations (no acres, nothing to apply chemicals on
    // or dispatch). Block here rather than let that job get created.
    if (!sec.field_id) {
      toast('error', 'Select a Field for this section before scheduling a job — a job needs a location to apply chemicals on and to dispatch.');
      return;
    }
    setSchedulingJobSectionKey(sectionKey);
```

## 4. Record the created job on success — old block (lines 1626-1637)
```tsx
    try {
      const idemKey = scheduleJobIdem.getKey();
      const { data, error } = await supabase.rpc('create_job_from_quote_section', {
        p_quote_id: quoteId,
        p_section_id: sec.id,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ job_id: string }>(data, 'create_job_from_quote_section');
      scheduleJobIdem.resetKey();
      toast('success', `Job scheduled from "${sec.section_name}"`);
      navigate(`/jobs/${result.job_id}`);
```

### New block
```tsx
    try {
      const idemKey = scheduleJobIdem.getKey();
      const { data, error } = await supabase.rpc('create_job_from_quote_section', {
        p_quote_id: quoteId,
        p_section_id: sec.id,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ job_id: string }>(data, 'create_job_from_quote_section');
      scheduleJobIdem.resetKey();
      // U13 (#111): record the badge immediately (no reload needed) + it also
      // hides the "Schedule Job" button for this section (the RPC would reject
      // a second job for the same section anyway — this makes that visible
      // BEFORE the user clicks, instead of via an error toast).
      setSectionJobs((prev) => ({ ...prev, [sec.id as string]: { id: result.job_id, job_number: '(new)', status: 'scheduled' } }));
      toast('success', `Job scheduled from "${sec.section_name}"`);
      navigate(`/jobs/${result.job_id}`);
```

> Note: the real `job_number` isn't known client-side until the job is fetched
> (the RPC returns only `job_id`) — `'(new)'` is a harmless placeholder since
> `navigate()` immediately leaves QuoteBuilder for JobDetail; if this quote is
> revisited, `fetchQuote` (next patch block) re-fetches the real job_number.

## 5. Fetch existing section jobs on load — old block (`fetchQuote`, right after
`setSections(...)`, line 519-521)
```tsx
    setSections(localSections.length > 0 ? localSections : [makeEmptySection(1)]);

    // Fetch version history for this quote
```

### New block
```tsx
    setSections(localSections.length > 0 ? localSections : [makeEmptySection(1)]);

    // U13 (#111): which sections already have a job scheduled from them, so the
    // badge renders and the "Schedule Job" button hides on load (not just after
    // a fresh schedule this session).
    const { data: sectionJobsData } = await supabase
      .from('jobs')
      .select('id, job_number, status, quote_section_id')
      .eq('quote_id', quoteId)
      .is('deleted_at', null)
      .not('quote_section_id', 'is', null);
    const sectionJobMap: Record<string, { id: string; job_number: string; status: JobStatus }> = {};
    ((sectionJobsData || []) as { id: string; job_number: string; status: JobStatus; quote_section_id: string }[])
      .forEach((j) => { sectionJobMap[j.quote_section_id] = { id: j.id, job_number: j.job_number, status: j.status }; });
    setSectionJobs(sectionJobMap);

    // Fetch version history for this quote
```

## 6. Badge + hide button — old block (the section header row + the Schedule
Job button, lines 2644-2698)
```tsx
                  <span className="text-xs font-mono text-gray-400 w-6">
                    {sec.sort_order}
                  </span>
                  <input
                    value={sec.section_name}
                    onChange={(e) => updateSectionName(sec._key, e.target.value)}
                    className="text-sm font-semibold font-heading text-nav-dark bg-transparent border-none outline-none focus:ring-0 flex-1"
                    placeholder="Section name"
                  />
                  <span className="text-sm font-mono text-secondary">
                    {fmt(sectionTotal)}
                  </span>
```

### New block
```tsx
                  <span className="text-xs font-mono text-gray-400 w-6">
                    {sec.sort_order}
                  </span>
                  <input
                    value={sec.section_name}
                    onChange={(e) => updateSectionName(sec._key, e.target.value)}
                    className="text-sm font-semibold font-heading text-nav-dark bg-transparent border-none outline-none focus:ring-0 flex-1"
                    placeholder="Section name"
                  />
                  {/* U13 (#111): per-section job badge — a section that already has a
                      scheduled job links straight to it (and the Schedule Job button
                      below hides, since a 2nd job per section is rejected server-side). */}
                  {sec.id && sectionJobs[sec.id] && (
                    <button
                      type="button"
                      onClick={() => navigate(`/jobs/${sectionJobs[sec.id as string].id}`)}
                      className="flex-shrink-0"
                      title="Open the job scheduled from this section"
                    >
                      <Badge variant={statusToBadgeVariant[sectionJobs[sec.id as string].status] || 'info'}>
                        Job {sectionJobs[sec.id as string].job_number}
                      </Badge>
                    </button>
                  )}
                  <span className="text-sm font-mono text-secondary">
                    {fmt(sectionTotal)}
                  </span>
```

Old block (the "Schedule Job" button condition, line 2694):
```tsx
                  {canScheduleJobs && quoteId && sec.id && sec.items.length > 0 && (
                    <Button variant="ghost" size="sm" icon={<CalendarClock className="w-3 h-3" />} showChevron={false} onClick={() => currentStatus === 'draft' ? setConfirmDraftScheduleKey(sec._key) : handleScheduleJob(sec._key)} loading={schedulingJobSectionKey === sec._key}>
                      Schedule Job
                    </Button>
                  )}
```

### New block
```tsx
                  {canScheduleJobs && quoteId && sec.id && sec.items.length > 0 && !sectionJobs[sec.id] && (
                    <Button variant="ghost" size="sm" icon={<CalendarClock className="w-3 h-3" />} showChevron={false} onClick={() => currentStatus === 'draft' ? setConfirmDraftScheduleKey(sec._key) : handleScheduleJob(sec._key)} loading={schedulingJobSectionKey === sec._key}>
                      Schedule Job
                    </Button>
                  )}
```

## Type check
`Badge` and `statusToBadgeVariant` are already imported (line 34:
`import Badge, { statusToBadgeVariant } from '../components/ui/Badge';`) — no
new import needed. `statusToBadgeVariant` already maps `scheduled` / `in_progress`
/ `completed` / `invoiced` / `cancelled` (verified live in
`src/components/ui/Badge.tsx`), so the job-status badge renders correctly with
zero changes to Badge.tsx.
