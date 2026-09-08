import { useParams } from 'react-router-dom';
import JobDetail from '../pages/JobDetail';

/**
 * Route element for `jobs/:id`. Its only job is to remount JobDetail whenever the job in the
 * URL changes.
 *
 * React reuses a component when only its props change, so `/jobs/a` -> `/jobs/b` kept ONE
 * JobDetail instance alive and poured the next record into it. Everything that page holds
 * outside the fields it explicitly resets then survived the change of record:
 *
 *   - The `/jobs/new` branch clears six pieces of state, so opening New Job from a loaded job
 *     left that job's customer, dates, notes, fields, chemicals and billing splits on the blank
 *     form. `save_job` there passes `p_job_id: null`, so Save INSERTED a brand-new job carrying
 *     another customer's data, which then drove that customer's bill. No race was required —
 *     load a job, click New Job. (Codex CRX-ENTITY-001.)
 *   - Every confirmation dialog stayed standing. A Complete/Cancel/Transfer prompt opened on
 *     job A ran its `onConfirm` from the CURRENT render, so confirming it after moving to job B
 *     acted on B — and completing a job deducts inventory and writes an application record
 *     against a job nobody asked to complete. (Codex CRX-ENTITY-002.)
 *
 * Keying by the route id makes React discard the old instance and build a fresh one, which
 * retires the whole class rather than enumerating its members. The alternative — hand-listing
 * every field to reset on the new-job branch, and every dialog to close on a route change — was
 * rejected: it is ~30 setters plus 7 dialogs, and it rots silently the moment anyone adds one.
 *
 * Both defects predate the cross-record work on this page; `main` has the same shapes.
 *
 * This file exists separately from App.tsx so the behaviour can be tested against the component
 * the router actually renders, rather than against a key a test file added for itself. App.tsx
 * lazy-loads THIS module, so JobDetail stays in its own chunk exactly as before.
 *
 * It lives under components/ rather than pages/ because it is a routing wrapper, not a page —
 * the same reasoning that puts ProtectedRoute in components/auth. That also keeps it out of the
 * pages smoke inventory, which is correct rather than convenient: mounting it mounts JobDetail,
 * whose calendar dependency hard-crashes the jsdom worker, so the inventory could only ever have
 * marked it skipped. The tests beside this file mount it for real instead.
 *
 * The async guards inside JobDetail — the load-generation ticket, the started-for route id, and
 * the route-epoch counter — are deliberately KEPT. See the note in JobDetail.tsx for which of
 * them a remount makes redundant and which still carry weight.
 */
export default function JobDetailRoute() {
  const { id } = useParams();
  return <JobDetail key={id} />;
}
