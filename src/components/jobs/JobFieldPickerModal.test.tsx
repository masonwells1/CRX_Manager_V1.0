import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import JobFieldPickerModal from './JobFieldPickerModal';

const { rpcMock, toastMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('../../lib/db', () => ({
  supabase: { rpc: rpcMock },
  assertRpcResult: (data: unknown) => data,
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('../map/CRXMap', () => ({ default: ({ children }: { children?: React.ReactNode }) => <div data-testid="map">{children}</div> }));
vi.mock('../map/FieldBoundaryLayer', () => ({ default: () => null }));
vi.mock('../map/FieldMarkerLayer', () => ({ default: () => null }));

const field = {
  id: 'field-1', customer_id: 'customer-1', customer_name: 'Test Farm', field_name: 'North 40', county: 'Clay', crop_type: 'Corn',
  total_acres: 40, measured_acres: 32, override_acres: 27, is_active: true, centroid_geojson: null, boundary_geojson: null,
};

function renderPicker(onAdd = vi.fn(), alreadyOnJobIds = new Set<string>()) {
  render(
    <JobFieldPickerModal
      open
      onClose={vi.fn()}
      onAdd={onAdd}
      alreadyOnJobIds={alreadyOnJobIds}
      billableAcresById={new Map([['field-1', 27]])}
    />,
  );
  return onAdd;
}

describe('JobFieldPickerModal', () => {
  let testNow = Date.now();

  beforeEach(() => {
    testNow += 6 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(testNow);
    rpcMock.mockReset();
    toastMock.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it('shows a loading state while the fields RPC is pending', () => {
    rpcMock.mockImplementation(() => new Promise(() => {}));
    renderPicker();
    expect(screen.getByText('Loading fields...')).toBeInTheDocument();
  });

  it('shows an empty result after a successful empty RPC response', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    renderPicker();
    expect(await screen.findByText('No fields match these filters.')).toBeInTheDocument();
  });

  it('toggles a table selection and returns its job-location payload', async () => {
    rpcMock.mockResolvedValue({ data: [field], error: null });
    const onAdd = renderPicker();

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select North 40' }));
    const addButton = screen.getByRole('button', { name: /Add 1 Location/i });
    expect(addButton).toBeEnabled();
    fireEvent.click(addButton);

    expect(onAdd).toHaveBeenCalledWith([expect.objectContaining({
      field_id: 'field-1',
      field_name: 'North 40',
      customer_id: 'customer-1',
      billable_acres: 27,
    })]);
  });

  it('explains when an already-on-job field is clicked', async () => {
    rpcMock.mockResolvedValue({ data: [field], error: null });
    renderPicker(vi.fn(), new Set(['field-1']));

    fireEvent.click(await screen.findByText('North 40'));

    expect(toastMock).toHaveBeenCalledWith('info', 'North 40 is already on this job');
  });
});
