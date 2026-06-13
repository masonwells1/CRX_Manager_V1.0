/**
 * Pure helpers for the JobDetail save + WPS flows. Extracted so the 2026-06-13
 * overlapping-sessions recovery fixes are unit-testable without mounting the page:
 *   #4 — a failed save must never leave a committed applicator override change.
 *   #5 — a WPS notice must reflect the SAVED job, never unsaved form values.
 */

/**
 * The applicator_id save_job should persist. Under a license override we must NEVER
 * change the applicator inside save_job (it is (re)assigned afterward via
 * assign_job_applicator), so a failed save cannot leave a committed applicator
 * change behind (#4):
 *   - override + new job      -> null (create unassigned)
 *   - override + existing job -> the persisted applicator (a same-value UPDATE OF
 *                                applicator_id is a no-op for the license trigger)
 *   - no override             -> the form's applicator
 */
export function overrideSaveApplicatorId(opts: {
  licenseOverride: boolean;
  isNew: boolean;
  applicatorId: string;
  savedApplicatorId: string | null;
}): string | null {
  if (!opts.licenseOverride) return opts.applicatorId || null;
  return opts.isNew ? null : (opts.savedApplicatorId || null);
}

/**
 * Whether to (re)assign the applicator via assign_job_applicator AFTER save_job
 * commits — only under an override, only when an applicator is selected, and only
 * when it differs from what is already persisted (#4).
 */
export function shouldReassignApplicatorAfterSave(opts: {
  licenseOverride: boolean;
  applicatorId: string;
  savedApplicatorId: string | null;
}): boolean {
  return opts.licenseOverride && !!opts.applicatorId && opts.applicatorId !== opts.savedApplicatorId;
}

/**
 * Whether a WPS pre-application notice may be generated. The notice is built from
 * the current form, so it must reflect the SAVED job — block while the form has
 * unsaved edits (#5).
 */
export function canGenerateWpsNotice(opts: { isDirty: boolean }): boolean {
  return !opts.isDirty;
}
