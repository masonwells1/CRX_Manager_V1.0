import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Vehicle } from '../../types';

interface QueryResult {
  data: unknown;
  error: { code?: string } | null;
}

const { mockFrom, mockToast, queryResults, builders } = vi.hoisted(() => {
  const queryResults: QueryResult[] = [];
  const builders: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const mockFrom = vi.fn(() => {
    const result = queryResults.shift() ?? { data: [], error: null };
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    const self = () => builder;
    for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'order']) {
      builder[method] = vi.fn(self);
    }
    Object.assign(builder, {
      then: vi.fn((resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve)),
    });
    builders.push(builder);
    return builder;
  });
  return { mockFrom, mockToast: vi.fn(), queryResults, builders };
});

vi.mock('../../lib/db', () => ({
  supabaseUntyped: { from: mockFrom },
  checkMutationResult: (result: QueryResult) => {
    if (result.error) throw result.error;
    if (result.data === null || (Array.isArray(result.data) && result.data.length === 0)) {
      throw new Error('no rows were affected');
    }
  },
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

import { LoaderWorksheetsPanel } from './LoaderWorksheetsPanel';

const createdAt = '2026-07-11T12:00:00.000Z';
const worksheets = [
  {
    id: 'worksheet-a', job_id: 'job-1', vehicle_id: 'vehicle-1', capacity_gal: 2000,
    carrier_rate_gpa: 15, load_balance_mode: 'full_loads_remainder', per_load_acres: null,
    loads_done: [], comment: null, is_selected: false, created_by: 'user-1', created_at: createdAt, updated_at: createdAt,
  },
  {
    id: 'worksheet-b', job_id: 'job-1', vehicle_id: null, capacity_gal: 1150,
    carrier_rate_gpa: 15, load_balance_mode: 'proportional', per_load_acres: null,
    loads_done: [], comment: null, is_selected: true, created_by: 'user-1', created_at: createdAt, updated_at: createdAt,
  },
];

const vehicles = [{
  id: 'vehicle-1', vehicle_name: 'Rogator', capacity_gallons: 2000, capacity_unit: 'gal', status: 'active', category: 'Sprayer',
}] as unknown as Vehicle[];

function renderPanel({
  canEdit = true,
  displayMode = 'individual',
}: {
  canEdit?: boolean;
  displayMode?: 'individual' | 'condensed';
} = {}) {
  return render(
    <LoaderWorksheetsPanel
      jobId="job-1"
      vehicles={vehicles}
      jobVehicleId="vehicle-1"
      totalAcres={344.67}
      products={[]}
      defaultCarrierRateGpa={15}
      legacyWorksheet={{ vehicleId: 'vehicle-1', capacityGal: 2000, carrierRateGpa: 15, comment: null }}
      legacyContent={<p>Legacy loader form</p>}
      canEdit={canEdit}
      displayMode={displayMode}
      onDisplayModeChange={vi.fn()}
    />,
  );
}

describe('LoaderWorksheetsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.splice(0);
    builders.splice(0);
  });

  it('renders the saved worksheet list with vehicle lookup and selected status', async () => {
    queryResults.push({ data: worksheets, error: null });
    renderPanel();

    expect(await screen.findByText('Saved worksheets')).toBeInTheDocument();
    expect(screen.getByText('Rogator')).toBeInTheDocument();
    expect(screen.getByText('Selected')).toBeInTheDocument();
    expect(mockFrom).toHaveBeenCalledWith('job_loader_worksheets');
    expect(builders[0].eq).toHaveBeenCalledWith('job_id', 'job-1');
    expect(builders[0].order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('clears the other selection before setting the target selection', async () => {
    queryResults.push(
      { data: worksheets, error: null },
      { data: [{ id: 'worksheet-b' }], error: null },
      { data: [{ id: 'worksheet-a' }], error: null },
      { data: [{ ...worksheets[0], is_selected: true }, { ...worksheets[1], is_selected: false }], error: null },
    );
    renderPanel();
    await screen.findByText('Saved worksheets');

    fireEvent.click(screen.getAllByRole('button', { name: 'Select' })[0]);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Loader worksheet selected for printing'));
    expect(builders[1].update).toHaveBeenCalledWith({ is_selected: false });
    expect(builders[1].eq).toHaveBeenCalledWith('job_id', 'job-1');
    expect(builders[1].neq).toHaveBeenCalledWith('id', 'worksheet-a');
    expect(builders[2].update).toHaveBeenCalledWith({ is_selected: true });
    expect(builders[2].eq).toHaveBeenCalledWith('id', 'worksheet-a');
  });

  it('refreshes and tells the user when a concurrent selector causes 23505', async () => {
    queryResults.push(
      { data: worksheets, error: null },
      { data: [{ id: 'worksheet-b' }], error: null },
      { data: null, error: { code: '23505' } },
      { data: worksheets, error: null },
    );
    renderPanel();
    await screen.findByText('Saved worksheets');

    fireEvent.click(screen.getAllByRole('button', { name: 'Select' })[0]);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Selection changed elsewhere — refreshed'));
    expect(mockFrom).toHaveBeenCalledTimes(4);
  });

  it('refreshes after every failed selection step, not only a selection collision', async () => {
    queryResults.push(
      { data: worksheets, error: null },
      { data: [{ id: 'worksheet-b' }], error: null },
      { data: null, error: { code: '42501' } },
      { data: worksheets, error: null },
    );
    renderPanel();
    await screen.findByText('Saved worksheets');

    fireEvent.click(screen.getAllByRole('button', { name: 'Select' })[0]);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Could not select that loader worksheet. Refreshed to match the saved selection.'));
    expect(mockFrom).toHaveBeenCalledTimes(4);
  });

  it('does not persist manual load acres that do not total the job acres', async () => {
    queryResults.push({ data: [worksheets[1]], error: null });
    renderPanel();
    await screen.findByText('Selected worksheet loads');

    const acresInputs = screen.getAllByLabelText(/Load \d+ acres/);
    await waitFor(() => expect(acresInputs[0]).not.toHaveValue(''));
    fireEvent.change(acresInputs[0], { target: { value: '100' } });
    fireEvent.change(acresInputs[1], { target: { value: '100' } });
    fireEvent.change(acresInputs[2], { target: { value: '100' } });
    fireEvent.change(acresInputs[3], { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save load acres' }));

    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('inserts a new worksheet after Save worksheet is clicked', async () => {
    queryResults.push(
      { data: [], error: null },
      { data: [{ id: 'worksheet-new' }], error: null },
      { data: [], error: null },
    );
    renderPanel();
    await screen.findByText('Legacy loader form');

    fireEvent.click(screen.getByRole('button', { name: 'Save as worksheet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save worksheet' }));

    await waitFor(() => expect(builders[1].insert).toHaveBeenCalledWith(expect.objectContaining({
      job_id: 'job-1',
      vehicle_id: 'vehicle-1',
      capacity_gal: 2000,
      carrier_rate_gpa: 15,
      per_load_acres: null,
      loads_done: [],
      is_selected: false,
    })));
  });

  it('updates valid manual load acres after Save load acres is clicked', async () => {
    const selectedWorksheet = { ...worksheets[0], is_selected: true };
    queryResults.push(
      { data: [selectedWorksheet], error: null },
      { data: [{ id: selectedWorksheet.id }], error: null },
      { data: [selectedWorksheet], error: null },
    );
    renderPanel();
    await screen.findByText('Selected worksheet loads');

    const acresInputs = screen.getAllByLabelText(/Load \d+ acres/);
    fireEvent.change(acresInputs[0], { target: { value: '130' } });
    fireEvent.change(acresInputs[1], { target: { value: '130' } });
    fireEvent.change(acresInputs[2], { target: { value: '84.67' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save load acres' }));

    await waitFor(() => expect(builders[1].update).toHaveBeenCalledWith({ per_load_acres: [130, 130, 84.67] }));
  });

  it('rejects manual load acres that would overfill a tank', async () => {
    const selectedWorksheet = { ...worksheets[0], is_selected: true };
    queryResults.push({ data: [selectedWorksheet], error: null });
    renderPanel();
    await screen.findByText('Selected worksheet loads');

    const acresInputs = screen.getAllByLabelText(/Load \d+ acres/);
    fireEvent.change(acresInputs[0], { target: { value: '140' } });
    fireEvent.change(acresInputs[1], { target: { value: '100' } });
    fireEvent.change(acresInputs[2], { target: { value: '104.67' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save load acres' }));

    expect(await screen.findByText('Load 1 needs 2,100 gal — tank holds 2,000 gal.')).toBeInTheDocument();
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('clears manual load acres after Reset to auto is clicked', async () => {
    const selectedWorksheet = { ...worksheets[0], is_selected: true, per_load_acres: [100, 100, 144.67] };
    queryResults.push(
      { data: [selectedWorksheet], error: null },
      { data: [{ id: selectedWorksheet.id }], error: null },
      { data: [selectedWorksheet], error: null },
    );
    renderPanel();
    await screen.findByText('Selected worksheet loads');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to auto' }));

    await waitFor(() => expect(builders[1].update).toHaveBeenCalledWith({ per_load_acres: null }));
  });

  it('clears manual load acres when an edited layout changes', async () => {
    const selectedWorksheet = { ...worksheets[0], is_selected: true, per_load_acres: [130, 130, 84.67] };
    queryResults.push(
      { data: [selectedWorksheet], error: null },
      { data: [{ id: selectedWorksheet.id }], error: null },
      { data: [{ ...selectedWorksheet, capacity_gal: 1900, per_load_acres: null }], error: null },
    );
    renderPanel();
    await screen.findByText('Saved worksheets');

    fireEvent.click(screen.getByRole('button', { name: /Edit loader worksheet/ }));
    fireEvent.change(screen.getByLabelText('Tank capacity (gal)'), { target: { value: '1900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save worksheet' }));

    await waitFor(() => expect(builders[1].update).toHaveBeenCalledWith(expect.objectContaining({
      capacity_gal: 1900,
      per_load_acres: null,
    })));
    expect(mockToast).toHaveBeenCalledWith('success', 'Manual load acres reset — layout changed');
  });

  it('offers recovery when saved manual acres are invalid for the current layout', async () => {
    const invalidWorksheet = { ...worksheets[0], is_selected: true, per_load_acres: [100, 100, 144.67] };
    queryResults.push(
      { data: [invalidWorksheet], error: null },
      { data: [{ id: invalidWorksheet.id }], error: null },
      { data: [{ ...invalidWorksheet, per_load_acres: null }], error: null },
    );
    renderPanel();
    await screen.findByText('This worksheet has saved manual load acres that no longer fit this layout. Reset them to automatic loads, then review the revised plan.');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to auto' }));

    await waitFor(() => expect(builders[1].update).toHaveBeenCalledWith({ per_load_acres: null }));
  });

  it('labels condensed load values as per-tank amounts', async () => {
    queryResults.push({ data: [{ ...worksheets[0], is_selected: true }], error: null });
    renderPanel({ displayMode: 'condensed' });

    expect(await screen.findByText('2 × Loads 1–2')).toBeInTheDocument();
    expect(screen.getByText('133.33 each')).toBeInTheDocument();
    expect(screen.getByText('2,000 gal each')).toBeInTheDocument();
  });

  it('makes the legacy-print fallback explicit when no saved worksheet is selected', async () => {
    queryResults.push({ data: worksheets.map((worksheet) => ({ ...worksheet, is_selected: false })), error: null });
    renderPanel();

    expect(await screen.findByRole('status')).toHaveTextContent("No worksheet selected — printing uses the job's legacy loader values.");
  });

  it('does not expose worksheet mutations when editing permission is absent', async () => {
    queryResults.push({ data: worksheets, error: null });
    renderPanel({ canEdit: false });

    await screen.findByText('Saved worksheets');
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit loader worksheet/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete loader worksheet/ })).not.toBeInTheDocument();
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});
