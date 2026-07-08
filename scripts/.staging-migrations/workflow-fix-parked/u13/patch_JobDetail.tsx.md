# Patch — src/pages/JobDetail.tsx

Purpose: mission item 5 — a per-job "Dispatch Locations" button that opens the
existing DispatchWizard JOB-SCOPED (only this job's locations, pre-selected),
carrying each location's CURRENT per-location assignee so the wizard's new
steal-confirmation (see DispatchWizard.tsx patch) fires if this reassigns a
location away from someone else. Gated to a SAVED, non-dirty job (the wizard
needs real job_fields.id values, which only exist after save_job has run).

No changes to handleSave/performSave are needed for item 1 (whole-job dispatch
auto-sync) — that is now a DB trigger (see the migration), fired automatically
by save_job's existing job_fields insert. This keeps save_job's fragile,
already-3x-re-emitted text completely untouched.

## 1. Icon import — old block (line 3)
```tsx
import { Save, Plus, Trash2, Check, FileText, Beaker, Ban, MessageSquarePlus, Printer, CloudSun, MapPin, Truck, ClipboardList, FlaskConical, Bell, History, BookmarkPlus, GripVertical, ChevronUp, ChevronDown, Map as MapIcon, ShieldAlert, CalendarClock, AlertTriangle, Sprout } from 'lucide-react';
```

### New block
```tsx
import { Save, Plus, Trash2, Check, FileText, Beaker, Ban, MessageSquarePlus, Printer, CloudSun, MapPin, Truck, ClipboardList, FlaskConical, Bell, History, BookmarkPlus, GripVertical, ChevronUp, ChevronDown, Map as MapIcon, ShieldAlert, CalendarClock, AlertTriangle, Sprout, Send } from 'lucide-react';
```

## 2. New imports — old block (lines 47-49, right after AppliedRecordsManager/ApplicationServicePicker/WatchdogFlagBanner)
```tsx
import AppliedRecordsManager from '../components/jobs/AppliedRecordsManager';
import ApplicationServicePicker from '../components/field-app/ApplicationServicePicker';
import WatchdogFlagBanner from '../components/watchdog/WatchdogFlagBanner';
```

### New block
```tsx
import AppliedRecordsManager from '../components/jobs/AppliedRecordsManager';
import ApplicationServicePicker from '../components/field-app/ApplicationServicePicker';
import WatchdogFlagBanner from '../components/watchdog/WatchdogFlagBanner';
// U13 (#15-21/#111): job-scoped "Dispatch Locations" — reuses the SAME 3-step
// wizard the Dispatch Board uses, pre-scoped + pre-selected to this job.
import DispatchWizard from '../components/dispatch/DispatchWizard';
import type { DispatchLocation } from '../lib/dispatchWizard';
```

## 3. New state — old block (near the applicator state, lines 319-322)
```tsx
  // The applicator currently saved on the job — the license gate only fires on a CHANGE
  const [savedApplicatorId, setSavedApplicatorId] = useState<string | null>(null);
  const [showLicenseOverrideConfirm, setShowLicenseOverrideConfirm] = useState(false);
  const assignIdem = useIdempotencyKey('assign_job_applicator', profile?.id || '');
```

### New block
```tsx
  // The applicator currently saved on the job — the license gate only fires on a CHANGE
  const [savedApplicatorId, setSavedApplicatorId] = useState<string | null>(null);
  const [showLicenseOverrideConfirm, setShowLicenseOverrideConfirm] = useState(false);
  const assignIdem = useIdempotencyKey('assign_job_applicator', profile?.id || '');
  // U13 (#15-21/#111): job-scoped Dispatch Locations wizard.
  const [dispatchWizardOpen, setDispatchWizardOpen] = useState(false);
  const [dispatchWizardLocations, setDispatchWizardLocations] = useState<DispatchLocation[]>([]);
  const [dispatchWizardLoading, setDispatchWizardLoading] = useState(false);
```

## 4. New handler — insert after `assignWithOverride` (right before `const performSave = ...`, i.e. after line 1858 `};` closing `assignWithOverride`)

Old anchor (end of `assignWithOverride`, lines 1845-1860):
```tsx
  /** Assign the applicator via the override RPC (admin-only path, B5). */
  const assignWithOverride = async (jobId: string) => {
    assignIdem.resetKey();
    const { data, error } = await supabase.rpc('assign_job_applicator', {
      p_job_id: jobId,
      p_applicator_id: applicatorId,
      p_license_override: true,
      p_performed_by: profile!.id,
      p_idempotency_key: assignIdem.getKey(),
    });
    if (error) throw error;
    assertRpcResult(data, 'assign_job_applicator');
    assignIdem.resetKey();
  };

  const performSave = async (licenseOverride: boolean, overrideReasonForAudit?: string) => {
```

### New block
```tsx
  /** Assign the applicator via the override RPC (admin-only path, B5). */
  const assignWithOverride = async (jobId: string) => {
    assignIdem.resetKey();
    const { data, error } = await supabase.rpc('assign_job_applicator', {
      p_job_id: jobId,
      p_applicator_id: applicatorId,
      p_license_override: true,
      p_performed_by: profile!.id,
      p_idempotency_key: assignIdem.getKey(),
    });
    if (error) throw error;
    assertRpcResult(data, 'assign_job_applicator');
    assignIdem.resetKey();
  };

  // U13 (#15-21/#111): open the Dispatch Board wizard SCOPED to just this job's
  // locations, pre-selected. Requires a SAVED, non-dirty job — the wizard needs
  // real job_fields.id values (only exist after save_job has run), and any
  // unsaved edit could change which locations should be offered.
  const openDispatchWizard = async () => {
    if (isNew || !id) {
      toast('error', 'Save the job before dispatching its locations.');
      return;
    }
    if (isDirty) {
      toast('error', 'Save the job before dispatching its locations — the wizard must match the saved record.');
      return;
    }
    setDispatchWizardLoading(true);
    try {
      const [jfRes, dispatchRes] = await Promise.all([
        supabase
          .from('job_fields')
          .select('id, acres_to_treat, field:fields(field_name)')
          .eq('job_id', id)
          .order('sort_order'),
        supabase
          .from('job_location_dispatches')
          .select('job_field_id, applicator_id, crew_id')
          .eq('job_id', id)
          .eq('dispatch_status', 'dispatched'),
      ]);
      if (jfRes.error) throw jfRes.error;
      if (dispatchRes.error) throw dispatchRes.error;

      type JfRow = { id: string; acres_to_treat: number | null; field?: { field_name?: string } | null };
      const jfRows = (jfRes.data || []) as JfRow[];
      if (jfRows.length === 0) {
        toast('error', 'This job has no field locations to dispatch — add a location on the Locations tab first.');
        setDispatchWizardLoading(false);
        return;
      }

      type DispatchRow = { job_field_id: string; applicator_id: string | null; crew_id: string | null };
      const currentByField = new Map<string, DispatchRow>();
      ((dispatchRes.data || []) as DispatchRow[]).forEach((d) => currentByField.set(d.job_field_id, d));

      const customerName = customers.find((c) => c.id === customerId)?.farm_name || 'Customer';
      const locs: DispatchLocation[] = jfRows.map((jf) => {
        const d = currentByField.get(jf.id);
        let currentAssignee: DispatchLocation['currentAssignee'] = null;
        if (d?.applicator_id) {
          const a = applicators.find((ap) => ap.id === d.applicator_id);
          currentAssignee = { kind: 'applicator', id: d.applicator_id, name: a?.full_name || 'Unknown applicator' };
        } else if (d?.crew_id) {
          const c = groundCrews.find((gc) => gc.id === d.crew_id);
          currentAssignee = { kind: 'crew', id: d.crew_id, name: c?.name || 'Unknown crew' };
        }
        return {
          jobFieldId: jf.id,
          jobId: id,
          jobNumber,
          customerName,
          fieldName: jf.field?.field_name || 'Field',
          acres: jf.acres_to_treat ?? null,
          currentAssignee,
        };
      });
      setDispatchWizardLocations(locs);
      setDispatchWizardOpen(true);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'open_job_dispatch_wizard', jobId: id } });
      toast('error', 'Could not load this job’s locations for dispatch — try again.');
    }
    setDispatchWizardLoading(false);
  };

  const performSave = async (licenseOverride: boolean, overrideReasonForAudit?: string) => {
```

## 5. Button — old block (Applicator field block, lines 2688-2712)
```tsx
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Applicator</label>
            <select
              value={applicatorId}
              onChange={(e) => setApplicatorId(e.target.value)}
              disabled={!canEdit}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
            >
              <option value="">Select applicator...</option>
              {applicators.map((a) => (
                <option key={a.id} value={a.id}>{a.full_name} ({a.role})</option>
              ))}
            </select>
            {applicatorId && (() => {
              const st = getLicenseStatus(licensesByProfile[applicatorId] || []);
              if (st.status === 'valid') return null;
              return (
                <p className={`mt-1 text-xs font-medium ${
                  st.status === 'expired' ? 'text-red-600' : st.status === 'expiring_soon' ? 'text-yellow-600' : 'text-gray-500'
                }`}>
                  {licenseStatusLabel(st)}
                </p>
              );
            })()}
          </div>
```

### New block
```tsx
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Applicator</label>
            <select
              value={applicatorId}
              onChange={(e) => setApplicatorId(e.target.value)}
              disabled={!canEdit}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
            >
              <option value="">Select applicator...</option>
              {applicators.map((a) => (
                <option key={a.id} value={a.id}>{a.full_name} ({a.role})</option>
              ))}
            </select>
            {applicatorId && (() => {
              const st = getLicenseStatus(licensesByProfile[applicatorId] || []);
              if (st.status === 'valid') return null;
              return (
                <p className={`mt-1 text-xs font-medium ${
                  st.status === 'expired' ? 'text-red-600' : st.status === 'expiring_soon' ? 'text-yellow-600' : 'text-gray-500'
                }`}>
                  {licenseStatusLabel(st)}
                </p>
              );
            })()}
            {/* U13 (#15-21/#111): saving this dropdown auto-syncs a whole-job
                per-location dispatch via a DB trigger (no click needed). This
                button is for the OTHER case — splitting the job across
                different applicators/crews per location, or reviewing/
                reassigning an existing split. */}
            {!isNew && isEditable && (
              <button
                type="button"
                onClick={openDispatchWizard}
                disabled={dispatchWizardLoading}
                className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-crx-green hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-3.5 h-3.5" />
                {dispatchWizardLoading ? 'Loading locations…' : 'Dispatch Locations'}
              </button>
            )}
          </div>
```

## 6. Render the wizard — add near the end of the component, alongside the other modals
(e.g. right before the closing `</div>` / final `);` of the component, next to
`ConfirmModal`/`Modal` instances already rendered there — insert as a sibling):

```tsx
      {/* U13 (#15-21/#111): job-scoped Dispatch Locations wizard. */}
      <DispatchWizard
        open={dispatchWizardOpen}
        onClose={() => setDispatchWizardOpen(false)}
        locations={dispatchWizardLocations}
        initialSelectedIds={dispatchWizardLocations.map((l) => l.jobFieldId)}
        applicators={applicators
          .filter((a) => a.role === 'applicator')
          .map((a) => ({ id: a.id, full_name: a.full_name }))}
        crews={groundCrews}
        performedBy={profile?.id || ''}
        isAdmin={role === 'admin'}
        onDispatched={() => setDispatchWizardOpen(false)}
      />
```

> Exact insertion point: find the closing tags near the end of the `return (...)`
> JSX (the file's other page-level modals — e.g. `ConfirmModal` for the license
> override, `Modal` for the recipe-save prompt — are rendered as siblings right
> before the component's final `</>`/`</div>`). Add this block alongside them so
> it always mounts once JobDetail renders, gated purely by `open`.
