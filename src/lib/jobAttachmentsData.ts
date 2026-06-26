// Field-app parity #16: data layer for per-job log-file attachments.
//
// Thin, testable wrappers around the single supabase client. The UI component calls
// these; the security boundary is the job-scoped RLS on `job_attachments` and the
// path-scoped RLS on the private `job-attachments` storage bucket (see migration
// 20260625200000_job_attachments.sql). All paths follow the load-bearing convention
// '<job_id>/<uuid>_<filename>' built by buildAttachmentPath.

import { supabase, checkMutationResult } from './db';
import type { JobAttachment } from '../types';
import {
  JOB_ATTACHMENTS_BUCKET,
  buildAttachmentPath,
} from './jobAttachments';

/**
 * List a job's attachments, newest first. RLS scopes the result to the caller's
 * visibility of the parent job, so this never needs an explicit role filter.
 */
export async function listJobAttachments(jobId: string): Promise<JobAttachment[]> {
  const { data, error } = await supabase
    .from('job_attachments')
    .select('*')
    .eq('job_id', jobId)
    .order('uploaded_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as JobAttachment[];
}

/**
 * Upload one file to the private bucket, then catalog it in job_attachments.
 * Order matters: bytes first (storage RLS gates the upload), then the row
 * (table RLS gates the insert + binds uploaded_by = the caller). On a row-insert
 * failure we best-effort remove the just-uploaded object so we don't orphan bytes.
 *
 * `uploaderId` MUST be the current profile id — the table's WITH CHECK rejects any
 * other value (no forged uploader).
 */
export async function uploadJobAttachment(params: {
  jobId: string;
  file: File;
  uploaderId: string;
  uuid: string;
}): Promise<JobAttachment> {
  const { jobId, file, uploaderId, uuid } = params;
  const path = buildAttachmentPath(jobId, uuid, file.name);

  const { error: uploadErr } = await supabase.storage
    .from(JOB_ATTACHMENTS_BUCKET)
    .upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (uploadErr) throw uploadErr;

  const insertResult = await supabase
    .from('job_attachments')
    .insert({
      job_id: jobId,
      storage_path: path,
      file_name: file.name,
      file_size: file.size,
      content_type: file.type || null,
      uploaded_by: uploaderId,
    })
    .select()
    .single();

  if (insertResult.error || insertResult.data === null) {
    // Roll back the orphaned object (best-effort; ignore secondary failure).
    await supabase.storage.from(JOB_ATTACHMENTS_BUCKET).remove([path]);
    checkMutationResult(insertResult, 'Save job attachment');
  }

  return insertResult.data as JobAttachment;
}

/**
 * Create a short-lived signed URL to download a private attachment.
 * `expiresInSeconds` defaults to 60s — long enough to open/download, short enough
 * that a leaked URL is near-useless.
 */
export async function getAttachmentDownloadUrl(
  storagePath: string,
  expiresInSeconds = 60
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(JOB_ATTACHMENTS_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data?.signedUrl) {
    throw error ?? new Error('Could not create a download link for this attachment.');
  }
  return data.signedUrl;
}

/**
 * Delete an attachment: remove the storage object AND the catalog row (both RLS-gated).
 *
 * Order matters. We remove the BYTES first, then delete the catalog ROW:
 *   - On a real storage error (`removeErr`) we abort before touching the row, so a row
 *     never ends up pointing at bytes we failed to remove.
 *   - storage-js `.remove()` can return HTTP 200 with an empty `data` array on success
 *     in some versions/paths, so we do NOT treat an empty array as failure (that would
 *     reject valid deletes — Codex P1). The success signal is the absence of `error`.
 *   - The storage DELETE RLS is kept at least as strict as the catalog-row DELETE RLS
 *     (see migration 20260625203000), so a caller who can remove the bytes can always
 *     remove the row too — the two can't diverge into an orphaned row or orphaned bytes.
 *   - `checkMutationResult` then confirms the row delete actually affected a row (it
 *     throws on a silent RLS denial), so we never report success on a no-op row delete.
 */
export async function deleteJobAttachment(attachment: Pick<JobAttachment, 'id' | 'storage_path'>): Promise<void> {
  const { error: removeErr } = await supabase.storage
    .from(JOB_ATTACHMENTS_BUCKET)
    .remove([attachment.storage_path]);
  if (removeErr) throw removeErr;

  const delResult = await supabase
    .from('job_attachments')
    .delete()
    .eq('id', attachment.id)
    .select();
  checkMutationResult(delResult, 'Delete job attachment');
}
