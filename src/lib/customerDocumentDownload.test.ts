import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  storageFrom: vi.fn(),
}));

vi.mock('./db', () => ({
  supabase: {
    storage: {
      from: mocks.storageFrom,
    },
  },
}));

import { downloadCustomerDocumentFile } from './customerDocumentDownload';

describe('downloadCustomerDocumentFile', () => {
  const createObjectURL = vi.fn(() => 'blob:customer-document');
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.storageFrom.mockReturnValue({ download: mocks.download });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('downloads through authenticated Storage instead of minting a bearer URL', async () => {
    const blob = new Blob(['private customer document'], { type: 'application/pdf' });
    mocks.download.mockResolvedValue({ data: blob, error: null });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await downloadCustomerDocumentFile('customer-id/document.pdf', 'permit.pdf');

    expect(mocks.storageFrom).toHaveBeenCalledWith('customer-documents');
    expect(mocks.download).toHaveBeenCalledWith('customer-id/document.pdf');
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[href="blob:customer-document"]')).toBeNull();

    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:customer-document');
  });

  it('does not create a browser download when Storage refuses the current actor', async () => {
    const denied = new Error('Object not found');
    mocks.download.mockResolvedValue({ data: null, error: denied });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await expect(downloadCustomerDocumentFile('customer-id/deleted.pdf', 'deleted.pdf')).rejects.toBe(denied);

    expect(click).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
