// Field-app parity #16: pure-logic tests for job-attachment helpers.
import { describe, it, expect } from 'vitest';
import {
  sanitizeFileName,
  buildAttachmentPath,
  jobIdFromPath,
  formatFileSize,
  formatUploadedAt,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_ACCEPT,
  ALLOWED_ATTACHMENT_MIME_TYPES,
  isAllowedAttachmentType,
} from './jobAttachments';

describe('sanitizeFileName', () => {
  it('keeps a clean name and lowercases', () => {
    expect(sanitizeFileName('Coverage.pdf')).toBe('coverage.pdf');
  });
  it('collapses unsafe characters into single underscores', () => {
    expect(sanitizeFileName('GPS log (final) #2.csv')).toBe('gps_log_final_2.csv');
  });
  it('strips directory portions (no traversal)', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\mason\\map.PNG')).toBe('map.png');
  });
  it('strips leading dots so no hidden files', () => {
    expect(sanitizeFileName('.bashrc')).toBe('bashrc');
  });
  it('falls back to "file" when the stem sanitizes to empty', () => {
    expect(sanitizeFileName('***.pdf')).toBe('file.pdf');
    expect(sanitizeFileName('')).toBe('file');
  });
  it('caps an overlong stem at 80 chars (extension preserved)', () => {
    const long = 'a'.repeat(200) + '.pdf';
    const out = sanitizeFileName(long);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(84);
  });
  it('handles a name with no extension', () => {
    expect(sanitizeFileName('coverage log')).toBe('coverage_log');
  });
});

describe('buildAttachmentPath', () => {
  const JOB = '00000000-0000-0000-0000-0000000aa101';
  const UUID = '11111111-2222-3333-4444-555555555555';

  it('puts the raw job id FIRST (load-bearing for storage RLS)', () => {
    const p = buildAttachmentPath(JOB, UUID, 'Coverage.pdf');
    expect(p.startsWith(`${JOB}/`)).toBe(true);
  });
  it('produces <job_id>/<uuid>_<sanitized filename>', () => {
    expect(buildAttachmentPath(JOB, UUID, 'GPS log.csv')).toBe(
      `${JOB}/${UUID}_gps_log.csv`
    );
  });
  it('round-trips: jobIdFromPath recovers the job id (mirrors SQL foldername[1])', () => {
    const p = buildAttachmentPath(JOB, UUID, 'x.pdf');
    expect(jobIdFromPath(p)).toBe(JOB);
  });
});

describe('jobIdFromPath', () => {
  it('returns the first segment', () => {
    expect(jobIdFromPath('job-9/uuid_file.pdf')).toBe('job-9');
  });
  it('returns null on empty', () => {
    expect(jobIdFromPath('')).toBeNull();
  });
});

describe('formatFileSize', () => {
  it('renders bytes', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });
  it('renders KB and MB with one decimal', () => {
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5 MB');
  });
  it('handles null/zero as em dash', () => {
    expect(formatFileSize(null)).toBe('—');
    expect(formatFileSize(0)).toBe('—');
    expect(formatFileSize(undefined)).toBe('—');
  });
  it('MAX is 25 MB', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(26214400);
  });
});

describe('formatUploadedAt', () => {
  it('formats a valid ISO timestamp', () => {
    const out = formatUploadedAt('2026-06-25T15:30:00Z');
    expect(out).not.toBe('—');
    expect(out.length).toBeGreaterThan(0);
  });
  it('returns em dash for null/invalid', () => {
    expect(formatUploadedAt(null)).toBe('—');
    expect(formatUploadedAt('not a date')).toBe('—');
  });
});

describe('attachment MIME allowlist (must mirror the bucket allowed_mime_types)', () => {
  it('accept string carries explicit MIME types, never a bare image/* (no HEIC leak)', () => {
    expect(ATTACHMENT_ACCEPT).not.toContain('image/*');
    expect(ATTACHMENT_ACCEPT.split(',')).toEqual([...ALLOWED_ATTACHMENT_MIME_TYPES]);
  });
  it('accepts allowed types', () => {
    expect(isAllowedAttachmentType('application/pdf')).toBe(true);
    expect(isAllowedAttachmentType('image/png')).toBe(true);
    expect(isAllowedAttachmentType('text/csv')).toBe(true);
  });
  it('rejects a type outside the allowlist (e.g. HEIC)', () => {
    expect(isAllowedAttachmentType('image/heic')).toBe(false);
    expect(isAllowedAttachmentType('application/x-msdownload')).toBe(false);
  });
  it('treats an empty/unknown MIME as allowed (storage makes the final call)', () => {
    expect(isAllowedAttachmentType('')).toBe(true);
    expect(isAllowedAttachmentType(null)).toBe(true);
  });
});
