import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Customer } from '../../types';

const mocks = vi.hoisted(() => {
  const idemState = { current: null as string | null, sequence: 0 };
  return {
    from: vi.fn(),
    rpc: vi.fn(),
    upload: vi.fn(),
    remove: vi.fn(),
    invoke: vi.fn(),
    lookup: vi.fn(),
    compressImage: vi.fn(),
    captureException: vi.fn(),
    getKey: vi.fn(() => {
      if (!idemState.current) idemState.current = `bulk-idem-${++idemState.sequence}`;
      return idemState.current;
    }),
    resetKey: vi.fn(() => { idemState.current = null; }),
    idemState,
    authState: {
      profile: { id: 'user-1', full_name: 'Test User' } as {
        id: string;
        full_name: string;
      } | null,
    },
  };
});

function lookupBuilder() {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq']) builder[method] = vi.fn(() => builder);
  builder.maybeSingle = mocks.lookup;
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
    storage: {
      from: vi.fn(() => ({ upload: mocks.upload, remove: mocks.remove })),
    },
    functions: { invoke: mocks.invoke },
  },
  assertRpcResult: (data: unknown) => data,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: mocks.authState.profile }),
}));

vi.mock('../../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: mocks.getKey, resetKey: mocks.resetKey }),
}));

vi.mock('../../lib/imageCompression', () => ({
  compressImage: mocks.compressImage,
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.captureException },
}));

import { BulkTicketUpload } from './BulkTicketUpload';

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function image(name: string, type = 'image/jpeg') {
  return new File([`${name}-bytes`], name, { type });
}

function selectImages(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

function uploadButton(count: number) {
  return screen.getByRole('button', {
    name: new RegExp(`upload ${count} image${count === 1 ? '' : 's'}`, 'i'),
  });
}

describe('BulkTicketUpload retry-safe atomic creation', () => {
  const defaultProps = {
    customers: [{ id: 'c1', farm_name: 'Smith Farm' }] as unknown as Customer[],
    onUploadComplete: vi.fn(),
  };
  let uuidIndex: number;

  beforeEach(() => {
    window.sessionStorage.clear();
    for (const mock of [
      mocks.from, mocks.rpc, mocks.upload, mocks.remove, mocks.invoke,
      mocks.lookup, mocks.compressImage, mocks.captureException,
      mocks.getKey, mocks.resetKey,
    ]) mock.mockReset();
    mocks.idemState.current = null;
    mocks.idemState.sequence = 0;
    mocks.authState.profile = { id: 'user-1', full_name: 'Test User' };
    mocks.getKey.mockImplementation(() => {
      if (!mocks.idemState.current) {
        mocks.idemState.current = `bulk-idem-${++mocks.idemState.sequence}`;
      }
      return mocks.idemState.current;
    });
    mocks.resetKey.mockImplementation(() => { mocks.idemState.current = null; });
    uuidIndex = 0;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () => UUIDS[uuidIndex++] as `${string}-${string}-${string}-${string}-${string}`,
    );
    mocks.from.mockImplementation(() => lookupBuilder());
    mocks.lookup.mockResolvedValue({ data: null, error: null });
    mocks.compressImage.mockImplementation(async (file: File) => file);
    mocks.upload.mockResolvedValue({ error: null });
    mocks.remove.mockResolvedValue({ error: null });
    mocks.invoke.mockResolvedValue({ data: { success: true }, error: null });
    mocks.rpc.mockImplementation(async (_name: string, args: { p_ticket_id: string }) => ({
      data: { success: true, ticket_id: args.p_ticket_id, ticket_number: 'BT-1' },
      error: null,
    }));
    defaultProps.onUploadComplete.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it('sends one atomic RPC with a stable UUID/key/path and finalizes the successful upload', async () => {
    const { container } = render(<BulkTicketUpload {...defaultProps} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByPlaceholderText('Enter driver name'), { target: { value: 'Pat Driver' } });
    fireEvent.change(screen.getByPlaceholderText('Enter tank number'), { target: { value: 'Tank 7' } });
    selectImages(container, [image('scan.png', 'image/png')]);

    fireEvent.click(uploadButton(1));

    await waitFor(() => expect(defaultProps.onUploadComplete).toHaveBeenCalledTimes(1));
    expect(mocks.upload).toHaveBeenCalledWith(
      `${UUIDS[0]}/1.png`,
      expect.any(File),
      { contentType: 'image/png', upsert: true },
    );
    expect(mocks.rpc).toHaveBeenCalledWith('create_blend_ticket', expect.objectContaining({
      p_ticket_id: UUIDS[0],
      p_ticket_payload: expect.objectContaining({
        customer_id: 'c1',
        driver_name: 'Pat Driver',
        tank_number: 'Tank 7',
      }),
      p_products: [],
      p_images: [{
        storage_path: `${UUIDS[0]}/1.png`,
        file_size: expect.any(Number),
        mime_type: 'image/png',
        upload_order: 1,
      }],
      p_enqueue_ocr: true,
      p_performed_by: 'user-1',
      p_idempotency_key: 'bulk-idem-1',
    }));
    expect(mocks.invoke).toHaveBeenCalledWith('process-blend-ticket', {
      body: { blend_ticket_id: UUIDS[0] },
    });
    expect(mocks.resetKey).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('cleans the first file when second-file compression fails, then starts a fresh paired intent', async () => {
    const first = image('one.jpg');
    const second = image('two.jpg');
    mocks.compressImage
      .mockImplementationOnce(async () => first)
      .mockRejectedValueOnce(new Error('compression failed'));

    const { container } = render(<BulkTicketUpload {...defaultProps} />);
    selectImages(container, [first, second]);
    fireEvent.click(uploadButton(2));

    expect(await screen.findByText('compression failed')).toBeInTheDocument();
    expect(mocks.remove).toHaveBeenCalledWith([`${UUIDS[0]}/1.jpg`]);
    expect(mocks.rpc).not.toHaveBeenCalled();

    fireEvent.click(uploadButton(2));
    await waitFor(() => expect(defaultProps.onUploadComplete).toHaveBeenCalledTimes(1));
    expect(mocks.upload.mock.calls.map(([path]) => path)).toEqual([
      `${UUIDS[0]}/1.jpg`,
      `${UUIDS[1]}/1.jpg`,
      `${UUIDS[1]}/2.jpg`,
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith('create_blend_ticket', expect.objectContaining({
      p_ticket_id: UUIDS[1],
      p_idempotency_key: 'bulk-idem-1',
    }));
  });

  it('retains the same intent and object prefix when cleanup itself fails', async () => {
    const first = image('one.jpg');
    const second = image('two.jpg');
    mocks.compressImage
      .mockImplementationOnce(async () => first)
      .mockRejectedValueOnce(new Error('compression failed'));
    mocks.remove.mockResolvedValueOnce({ error: { message: 'storage delete failed' } });

    const { container } = render(<BulkTicketUpload {...defaultProps} />);
    selectImages(container, [first, second]);
    fireEvent.click(uploadButton(2));
    expect(await screen.findByText('compression failed')).toBeInTheDocument();

    fireEvent.click(uploadButton(2));
    await waitFor(() => expect(defaultProps.onUploadComplete).toHaveBeenCalledTimes(1));
    expect(mocks.upload.mock.calls.map(([path]) => path)).toEqual([
      `${UUIDS[0]}/1.jpg`,
      `${UUIDS[0]}/1.jpg`,
      `${UUIDS[0]}/2.jpg`,
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith('create_blend_ticket', expect.objectContaining({
      p_ticket_id: UUIDS[0],
      p_idempotency_key: 'bulk-idem-1',
    }));
  });

  it('retries an indeterminate RPC/lookup with the same committed intent and never deletes its objects', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } })
      .mockImplementationOnce(async (_name: string, args: { p_ticket_id: string }) => ({
        data: { success: true, ticket_id: args.p_ticket_id, ticket_number: 'BT-1' },
        error: null,
      }));
    mocks.lookup.mockResolvedValueOnce({ data: null, error: { message: 'lookup unavailable' } });

    const { container } = render(<BulkTicketUpload {...defaultProps} />);
    selectImages(container, [image('scan.jpg')]);
    fireEvent.click(uploadButton(1));
    expect(await screen.findByText(
      'Upload status is uncertain. No files were changed; retry to check again.',
    )).toBeInTheDocument();

    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.resetKey).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /check upload status & retry/i }));

    await waitFor(() => expect(defaultProps.onUploadComplete).toHaveBeenCalledTimes(1));
    expect(mocks.upload.mock.calls.map(([path]) => path)).toEqual([
      `${UUIDS[0]}/1.jpg`,
    ]);
    expect(mocks.rpc.mock.calls.map(([, args]) => ({
      ticketId: args.p_ticket_id,
      idem: args.p_idempotency_key,
    }))).toEqual([
      { ticketId: UUIDS[0], idem: 'bulk-idem-1' },
      { ticketId: UUIDS[0], idem: 'bulk-idem-1' },
    ]);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('treats a rejected create RPC as uncertain and reconciles the frozen intent before retrying', async () => {
    mocks.rpc
      .mockRejectedValueOnce(new Error('request stream closed'))
      .mockImplementationOnce(async (_name: string, args: { p_ticket_id: string }) => ({
        data: { success: true, ticket_id: args.p_ticket_id, ticket_number: 'BT-1' },
        error: null,
      }));

    const { container } = render(<BulkTicketUpload {...defaultProps} />);
    selectImages(container, [image('scan.jpg')]);
    fireEvent.click(uploadButton(1));

    expect(await screen.findByText(
      'Upload status is uncertain. No files were changed; retry to check again.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /check upload status & retry/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.resetKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /check upload status & retry/i }));
    await waitFor(() => expect(defaultProps.onUploadComplete).toHaveBeenCalledTimes(1));

    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.upload.mock.calls.map(([path]) => path)).toEqual([
      `${UUIDS[0]}/1.jpg`,
    ]);
    expect(mocks.rpc.mock.calls.map(([, args]) => ({
      ticketId: args.p_ticket_id,
      idem: args.p_idempotency_key,
    }))).toEqual([
      { ticketId: UUIDS[0], idem: 'bulk-idem-1' },
      { ticketId: UUIDS[0], idem: 'bulk-idem-1' },
    ]);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('restores and reconciles an uncertain intent after remount without a new UUID or blob upload', async () => {
    mocks.rpc
      .mockRejectedValueOnce(new Error('connection reset after commit attempt'))
      .mockImplementationOnce(async (_name: string, args: { p_ticket_id: string }) => ({
        data: { success: true, ticket_id: args.p_ticket_id, ticket_number: 'BT-1' },
        error: null,
      }));

    const firstRender = render(<BulkTicketUpload {...defaultProps} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c1' } });
    selectImages(firstRender.container, [image('scan.png', 'image/png')]);
    fireEvent.click(uploadButton(1));
    expect(await screen.findByRole('button', { name: /check upload status & retry/i })).toBeInTheDocument();
    firstRender.unmount();

    render(<BulkTicketUpload {...defaultProps} />);
    expect(await screen.findByText(/previous upload may have completed/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('c1');
    fireEvent.click(screen.getByRole('button', { name: /check upload status & retry/i }));

    await waitFor(() => expect(defaultProps.onUploadComplete).toHaveBeenCalledTimes(1));
    expect(uuidIndex).toBe(1);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls.map(([, args]) => ({
      ticketId: args.p_ticket_id,
      customerId: args.p_ticket_payload.customer_id,
      imagePaths: args.p_images.map((entry: { storage_path: string }) => entry.storage_path),
      idem: args.p_idempotency_key,
    }))).toEqual([
      {
        ticketId: UUIDS[0],
        customerId: 'c1',
        imagePaths: [`${UUIDS[0]}/1.png`],
        idem: 'bulk-idem-1',
      },
      {
        ticketId: UUIDS[0],
        customerId: 'c1',
        imagePaths: [`${UUIDS[0]}/1.png`],
        idem: 'bulk-idem-1',
      },
    ]);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('reconciles a committed uncertain attempt before upload and never overwrites canonical bytes', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } });
    mocks.lookup
      .mockResolvedValueOnce({ data: null, error: { message: 'lookup unavailable' } })
      .mockResolvedValueOnce({ data: { id: UUIDS[0], ticket_number: 'BT-1' }, error: null });

    const { container } = render(<BulkTicketUpload {...defaultProps} />);
    selectImages(container, [image('scan.jpg')]);
    fireEvent.click(uploadButton(1));
    expect(await screen.findByRole('button', { name: /check upload status & retry/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /check upload status & retry/i }));
    await waitFor(() => expect(defaultProps.onUploadComplete).toHaveBeenCalledTimes(1));

    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('process-blend-ticket', {
      body: { blend_ticket_id: UUIDS[0] },
    });
  });

  it('clears in-memory upload intent when the authenticated user changes', async () => {
    mocks.rpc
      .mockRejectedValueOnce(new Error('request stream closed'))
      .mockImplementationOnce(async (_name: string, args: { p_ticket_id: string }) => ({
        data: { success: true, ticket_id: args.p_ticket_id, ticket_number: 'BT-2' },
        error: null,
      }));

    const rendered = render(<BulkTicketUpload {...defaultProps} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'c1' } });
    selectImages(rendered.container, [image('user-a.jpg')]);
    fireEvent.click(uploadButton(1));
    expect(await screen.findByRole('button', { name: /check upload status & retry/i }))
      .toBeInTheDocument();

    const userOneStorageKey = Object.keys(window.sessionStorage)
      .find((key) => key.includes('user-1'));
    expect(userOneStorageKey).toBeDefined();

    mocks.authState.profile = { id: 'user-2', full_name: 'Other User' };
    rendered.rerender(<BulkTicketUpload {...defaultProps} />);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /check upload status & retry/i }))
        .not.toBeInTheDocument();
    });
    expect(screen.getByRole('combobox')).toBeEnabled();
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(window.sessionStorage.getItem(userOneStorageKey!)).not.toBeNull();
    expect(mocks.resetKey).toHaveBeenCalled();

    selectImages(rendered.container, [image('user-b.jpg')]);
    fireEvent.click(uploadButton(1));
    await waitFor(() => expect(defaultProps.onUploadComplete).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      'create_blend_ticket',
      expect.objectContaining({
        p_ticket_id: UUIDS[1],
        p_performed_by: 'user-2',
        p_idempotency_key: 'bulk-idem-2',
      }),
    );
  });
});
