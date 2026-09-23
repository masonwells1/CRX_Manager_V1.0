import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  storageFrom: vi.fn(),
  uploadToSignedUrl: vi.fn(),
  createSignedUrl: vi.fn(),
  download: vi.fn(),
}));

vi.mock('./db', () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    storage: { from: mocks.storageFrom },
  },
}));

import {
  downloadCustomerDocumentFile,
  uploadCustomerDocumentFile,
} from './customerDocumentFiles';

describe('customerDocumentFiles', () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:customer-document');
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.storageFrom.mockReturnValue({
      uploadToSignedUrl: mocks.uploadToSignedUrl,
      createSignedUrl: mocks.createSignedUrl,
      download: mocks.download,
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('downloads bytes through the Edge Function, never a Storage signed URL', async () => {
    mocks.invoke.mockResolvedValue({ data: new Blob(['pdf bytes']), error: null });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await downloadCustomerDocumentFile('doc-1', 'permit.pdf', 'application/pdf');

    expect(mocks.invoke).toHaveBeenCalledWith('customer-document-files', {
      body: { action: 'download', document_id: 'doc-1' },
    });
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    const saved = createObjectURL.mock.calls[0]?.[0];
    expect(saved?.type).toBe('application/pdf');
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[href="blob:customer-document"]')).toBeNull();

    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:customer-document');
  });

  it('shows the server reason and saves nothing when a removed document is refused', async () => {
    const context = new Response(JSON.stringify({ error: 'This document is no longer available.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.invoke.mockResolvedValue({ data: null, error: Object.assign(new Error('non-2xx'), { context }) });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await expect(downloadCustomerDocumentFile('doc-1', 'permit.pdf', 'application/pdf'))
      .rejects.toThrow('This document is no longer available.');
    expect(click).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('uploads with a server-issued token to the server-chosen path', async () => {
    mocks.invoke.mockResolvedValue({ data: { storage_path: 'cust/u1-map.pdf', token: 'tok' }, error: null });
    mocks.uploadToSignedUrl.mockResolvedValue({ data: { path: 'cust/u1-map.pdf' }, error: null });
    const file = new File(['x'], 'map.pdf', { type: 'application/pdf' });

    await expect(uploadCustomerDocumentFile('cust', file)).resolves.toBe('cust/u1-map.pdf');

    expect(mocks.invoke).toHaveBeenCalledWith('customer-document-files', {
      body: {
        action: 'prepare_upload',
        customer_id: 'cust',
        filename: 'map.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1,
      },
    });
    expect(mocks.storageFrom).toHaveBeenCalledWith('customer-documents');
    expect(mocks.uploadToSignedUrl).toHaveBeenCalledWith('cust/u1-map.pdf', 'tok', file, { contentType: 'application/pdf' });
  });

  it('refuses a malformed prepare response instead of uploading', async () => {
    mocks.invoke.mockResolvedValue({ data: { storage_path: 'cust/u1-map.pdf' }, error: null });
    const file = new File(['x'], 'map.pdf', { type: 'application/pdf' });

    await expect(uploadCustomerDocumentFile('cust', file)).rejects.toThrow('Could not prepare the upload.');
    expect(mocks.uploadToSignedUrl).not.toHaveBeenCalled();
  });
});
