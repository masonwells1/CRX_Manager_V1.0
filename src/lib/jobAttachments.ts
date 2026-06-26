// Field-app parity #16: pure helpers for per-job log-file attachments.
//
// The storage object path convention is LOAD-BEARING for security: the RLS policies
// on storage.objects extract the job id from the FIRST path segment
// (storage.foldername(name))[1] and gate on job visibility. So the path MUST be
// '<job_id>/<uuid>_<sanitized filename>' — the job id first, then a unique,
// collision-proof, sanitized object name. These helpers are unit-tested.

/** 25 MB per-file cap for log files (PDFs, images, GPS/coverage logs). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const JOB_ATTACHMENTS_BUCKET = 'job-attachments';

/**
 * MIME types the private bucket accepts — MUST stay in sync with allowed_mime_types
 * on the `job-attachments` bucket (migration 20260625200000_job_attachments.sql).
 * Codex post-fix P2: the file picker's `accept` must NOT advertise broader types than
 * the bucket allows (e.g. a bare `image/*` lets a phone pick HEIC, which Storage then
 * rejects). We drive BOTH the picker `accept` and a client-side pre-upload guard from
 * this one list so the UX fails fast with a clear message instead of a raw 4xx.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/csv',
  'text/plain',
  'text/xml',
  'application/xml',
  'application/vnd.google-earth.kml+xml',
  'application/gpx+xml',
  'application/octet-stream',
  'application/zip',
] as const;

/** The `accept` attribute for the file input — explicit MIME types only (no `image/*`). */
export const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_MIME_TYPES.join(',');

/**
 * True if a browser-reported MIME type is one the bucket will accept. An empty MIME
 * (some CSV/GPX/KML files report '') is allowed through as application/octet-stream,
 * which is in the allowlist — Storage makes the final call.
 */
export function isAllowedAttachmentType(mime: string | null | undefined): boolean {
  if (!mime) return true; // unknown MIME → let octet-stream / storage decide
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Sanitize a user-supplied filename into a safe storage object segment.
 * - keeps the extension
 * - lowercases, replaces any run of non-alphanumeric/dot/hyphen chars with '_'
 * - strips path separators and leading dots (no traversal, no hidden files)
 * - caps length so the full object path stays well under storage limits
 * Never returns an empty string (falls back to 'file').
 */
export function sanitizeFileName(name: string): string {
  const trimmed = (name ?? '').trim();
  // Drop any directory portion a browser/file might include.
  const base = trimmed.split(/[\\/]/).pop() ?? '';
  // Split extension off the last dot (if any) so we can sanitize parts separately.
  const lastDot = base.lastIndexOf('.');
  const hasExt = lastDot > 0 && lastDot < base.length - 1;
  const rawStem = hasExt ? base.slice(0, lastDot) : base;
  const rawExt = hasExt ? base.slice(lastDot + 1) : '';

  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '_') // collapse unsafe runs to a single underscore
      .replace(/^[._-]+/, '') // no leading dot/underscore/hyphen
      .replace(/[._-]+$/, ''); // no trailing junk

  let stem = clean(rawStem);
  const ext = clean(rawExt).replace(/\./g, ''); // extension carries no dots
  if (!stem) stem = 'file';
  // Cap the stem so the object name is bounded.
  if (stem.length > 80) stem = stem.slice(0, 80);

  return ext ? `${stem}.${ext}` : stem;
}

/**
 * Build the storage object path for a job attachment:
 *   '<job_id>/<uuid>_<sanitized filename>'
 * The leading job_id segment is what the storage RLS policy scopes on, so it must
 * be the raw job id with no extra prefix. `uuid` makes the object name unique even
 * when two files share a name.
 */
export function buildAttachmentPath(jobId: string, uuid: string, fileName: string): string {
  return `${jobId}/${uuid}_${sanitizeFileName(fileName)}`;
}

/**
 * Extract the job id encoded in an attachment object path's first segment.
 * Returns null if the path has no leading segment. (Mirrors the SQL
 * (storage.foldername(name))[1] the RLS policy uses — handy for client-side
 * assertions/tests.)
 */
export function jobIdFromPath(path: string): string | null {
  const first = (path ?? '').split('/')[0];
  return first ? first : null;
}

/** Human-readable file size. 0/undefined → '—'. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  // Whole bytes show no decimals; larger units show up to 1 decimal.
  const rounded = i === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/** Format an ISO timestamp as a local date-time for the attachments list. */
export function formatUploadedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
