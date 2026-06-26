// Field-app parity #16: data-layer tests with a MOCKED supabase client.
//
// The local stack has no Storage API container, so the real file-BYTES round-trip
// can't run here. These tests pin the CONTRACT the component relies on: the exact
// object-path convention, the row insert (with the caller as uploader), the
// signed-URL call, and delete-both-sides — plus the orphan-cleanup on a failed
// insert. The job-scoped RLS itself is proven by the psql security proof.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockStorageFrom, storageApi } = vi.hoisted(() => {
  const storageApi = {
    upload: vi.fn(),
    remove: vi.fn(),
    createSignedUrl: vi.fn(),
  };
  return {
    mockFrom: vi.fn(),
    mockStorageFrom: vi.fn(() => storageApi),
    storageApi,
  };
});

vi.mock('./db', () => ({
  supabase: { from: mockFrom, storage: { from: mockStorageFrom } },
  // pass-through of the real semantics: throw if error or empty
  checkMutationResult: (result: { error: unknown; data: unknown }, op: string) => {
    if (result.error) throw result.error;
    if (result.data === null || result.data === undefined) {
      throw new Error(`${op} failed: no rows were affected.`);
    }
    if (Array.isArray(result.data) && result.data.length === 0) {
      throw new Error(`${op} failed: no rows were affected.`);
    }
  },
}));

import {
  uploadJobAttachment,
  listJobAttachments,
  getAttachmentDownloadUrl,
  deleteJobAttachment,
} from './jobAttachmentsData';

const JOB = '00000000-0000-0000-0000-0000000aa101';
const UPLOADER = '00000000-0000-0000-0000-0000000000a1';
const UUID = 'abcabcab-1111-2222-3333-444444444444';

function makeFile(name: string, size = 1234, type = 'application/pdf'): File {
  return new File([new ArrayBuffer(size)], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStorageFrom.mockReturnValue(storageApi);
});

describe('uploadJobAttachment', () => {
  it('uploads to <job_id>/<uuid>_<sanitized name> then inserts the catalog row with the caller as uploader', async () => {
    storageApi.upload.mockResolvedValue({ error: null });
    const insertChain = {
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: 'att-1', job_id: JOB, storage_path: `${JOB}/${UUID}_coverage.pdf`, file_name: 'Coverage.pdf' },
        error: null,
      }),
    };
    const insert = vi.fn().mockReturnValue(insertChain);
    mockFrom.mockReturnValue({ insert });

    const res = await uploadJobAttachment({
      jobId: JOB,
      file: makeFile('Coverage.pdf'),
      uploaderId: UPLOADER,
      uuid: UUID,
    });

    // Bucket + path convention (load-bearing for storage RLS).
    expect(mockStorageFrom).toHaveBeenCalledWith('job-attachments');
    expect(storageApi.upload).toHaveBeenCalledWith(
      `${JOB}/${UUID}_coverage.pdf`,
      expect.any(File),
      expect.objectContaining({ contentType: 'application/pdf' })
    );
    // Row insert binds uploaded_by = the caller (no forged uploader).
    expect(mockFrom).toHaveBeenCalledWith('job_attachments');
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        job_id: JOB,
        storage_path: `${JOB}/${UUID}_coverage.pdf`,
        file_name: 'Coverage.pdf',
        file_size: 1234,
        content_type: 'application/pdf',
        uploaded_by: UPLOADER,
      })
    );
    expect(res.id).toBe('att-1');
  });

  it('aborts (throws) and does NOT insert a row if the upload fails', async () => {
    storageApi.upload.mockResolvedValue({ error: new Error('storage denied') });
    const insert = vi.fn();
    mockFrom.mockReturnValue({ insert });

    await expect(
      uploadJobAttachment({ jobId: JOB, file: makeFile('x.pdf'), uploaderId: UPLOADER, uuid: UUID })
    ).rejects.toThrow('storage denied');
    expect(insert).not.toHaveBeenCalled();
  });

  it('removes the orphaned object when the row insert is RLS-denied', async () => {
    storageApi.upload.mockResolvedValue({ error: null });
    storageApi.remove.mockResolvedValue({ error: null });
    const insertChain = {
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }), // silent RLS denial
    };
    mockFrom.mockReturnValue({ insert: vi.fn().mockReturnValue(insertChain) });

    await expect(
      uploadJobAttachment({ jobId: JOB, file: makeFile('x.pdf'), uploaderId: UPLOADER, uuid: UUID })
    ).rejects.toThrow(/no rows were affected/);
    // Orphan cleanup fired with the exact path.
    expect(storageApi.remove).toHaveBeenCalledWith([`${JOB}/${UUID}_x.pdf`]);
  });
});

describe('listJobAttachments', () => {
  it('selects by job_id ordered newest first', async () => {
    const order = vi.fn().mockResolvedValue({ data: [{ id: 'a' }], error: null });
    const eq = vi.fn().mockReturnValue({ order });
    const select = vi.fn().mockReturnValue({ eq });
    mockFrom.mockReturnValue({ select });

    const rows = await listJobAttachments(JOB);
    expect(mockFrom).toHaveBeenCalledWith('job_attachments');
    expect(eq).toHaveBeenCalledWith('job_id', JOB);
    expect(order).toHaveBeenCalledWith('uploaded_at', { ascending: false });
    expect(rows).toEqual([{ id: 'a' }]);
  });

  it('throws on error', async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: new Error('boom') });
    mockFrom.mockReturnValue({ select: () => ({ eq: () => ({ order }) }) });
    await expect(listJobAttachments(JOB)).rejects.toThrow('boom');
  });
});

describe('getAttachmentDownloadUrl', () => {
  it('creates a short-lived signed URL (private bucket)', async () => {
    storageApi.createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed/url' }, error: null });
    const url = await getAttachmentDownloadUrl(`${JOB}/${UUID}_x.pdf`);
    expect(mockStorageFrom).toHaveBeenCalledWith('job-attachments');
    expect(storageApi.createSignedUrl).toHaveBeenCalledWith(`${JOB}/${UUID}_x.pdf`, 60);
    expect(url).toBe('https://signed/url');
  });

  it('throws when no signed URL is returned', async () => {
    storageApi.createSignedUrl.mockResolvedValue({ data: null, error: new Error('denied') });
    await expect(getAttachmentDownloadUrl('p')).rejects.toThrow('denied');
  });
});

describe('deleteJobAttachment', () => {
  it('removes the storage object AND deletes the row', async () => {
    storageApi.remove.mockResolvedValue({ error: null });
    const eq = vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue({ data: [{ id: 'att-1' }], error: null }) });
    const del = vi.fn().mockReturnValue({ eq });
    mockFrom.mockReturnValue({ delete: del });

    await deleteJobAttachment({ id: 'att-1', storage_path: `${JOB}/${UUID}_x.pdf` });
    expect(storageApi.remove).toHaveBeenCalledWith([`${JOB}/${UUID}_x.pdf`]);
    expect(eq).toHaveBeenCalledWith('id', 'att-1');
  });

  it('aborts before deleting the row if the object remove fails', async () => {
    storageApi.remove.mockResolvedValue({ error: new Error('remove denied') });
    const del = vi.fn();
    mockFrom.mockReturnValue({ delete: del });
    await expect(
      deleteJobAttachment({ id: 'att-1', storage_path: 'p' })
    ).rejects.toThrow('remove denied');
    expect(del).not.toHaveBeenCalled();
  });
});
