/**
 * BulkFieldImport.retry.test.tsx — the duplicate-field retry defect.
 *
 * save_field COMMITS before set_field_boundary runs. When the boundary call then
 * fails and the operator corrects the geometry and re-imports that row, the
 * import must replay save_field's ORIGINAL idempotency key so the server returns
 * the field it already created. Minting a fresh key there calls save_field again
 * with p_field_id: null and creates a SECOND field, orphaning the first,
 * boundary-less one — and fields_delete RLS is admin-only, so a sales_rep cannot
 * clean that up.
 *
 * These tests drive the real component through the real handleUpload and the real
 * useIdempotencyKey hook. Only the network boundary and the file parser are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { Polygon } from 'geojson';

const rpc = vi.fn();

function chainable() {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  for (const m of ['select', 'eq', 'order', 'limit', 'is', 'in', 'neq']) builder[m] = vi.fn(self);
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    Promise.resolve({ data: [], error: null }).then(resolve);
    return builder;
  });
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: { from: vi.fn(() => chainable()), rpc: (...args: unknown[]) => rpc(...args) },
  assertRpcResult: (data: unknown) => data != null,
  rpcAuthErrorMessage: () => null,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1' } }),
}));

vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock('./ImportPreviewMap', () => ({ default: () => <div /> }));
vi.mock('./AttributeMappingStep', () => ({ default: () => <div /> }));
vi.mock('./FieldCustomerAssignment', () => ({
  default: ({ onApplyToAll }: { onApplyToAll: (id: string) => void }) => (
    <button onClick={() => onApplyToAll('cust-1')}>stub-assign</button>
  ),
}));

// A square whose corner moves between runs — "the operator corrected the boundary".
function square(offset: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [[
      [-88.0, 40.0], [-88.0, 40.01], [-87.99 + offset, 40.01], [-87.99 + offset, 40.0], [-88.0, 40.0],
    ]],
  };
}

let geometryOffset = 0;

vi.mock('../../lib/fieldImportParser', () => ({
  parseShapefileBundle: vi.fn(),
  parseShapefileZip: vi.fn(),
  parseKMLFile: vi.fn(),
  parseGeoJSONFile: () => ({
    featureCollection: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: square(geometryOffset), properties: { NAME: 'North 40' } }],
    },
    attributeKeys: ['NAME'],
    crsDetected: 'EPSG:4326',
    warnings: [],
    featureCount: 1,
    fullGeometries: [square(geometryOffset)],
  }),
  calculateFieldMetrics: () => ({ acres: 40, centroid: { type: 'Point', coordinates: [-88, 40] } }),
  validateFullGeometry: () => [],
  geometryAcres: () => 40 + geometryOffset * 1000,
}));

import BulkFieldImport from './BulkFieldImport';

/** Drives the modal from step 1 to a finished import. */
async function click(name: RegExp) {
  const el = await screen.findByRole('button', { name });
  await act(async () => { fireEvent.click(el); });
}

async function runImport() {
  const file = new File(['{}'], 'fields.geojson', { type: 'application/geo+json' });
  const input = document.getElementById('field-import-input') as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
  await click(/parse files/i);
  await click(/^next$/i);          // step 2 -> 3
  await click(/^next$/i);          // step 3 -> 4
  await click(/stub-assign/i);
  await click(/^next$/i);          // step 4 -> 5
  await click(/import 1 field/i);
  // Step 7. Not the "Close" button — the modal's own X control is also named
  // Close and is present from step 1, so waiting on it would pass instantly.
  await waitFor(() => expect(screen.getByText(/import complete/i)).toBeInTheDocument());
}

/** The footer dismiss button; the modal's X control shares the accessible name. */
async function closeModal() {
  const all = screen.getAllByRole('button', { name: /close/i });
  await act(async () => { fireEvent.click(all[all.length - 1]); });
}

function callsTo(name: string) {
  return rpc.mock.calls.filter((c) => c[0] === name);
}

describe('BulkFieldImport — retry after a committed save_field', () => {
  beforeEach(() => {
    rpc.mockReset();
    geometryOffset = 0;
  });

  it('replays the ORIGINAL save_field key when the boundary failed and the geometry was corrected', async () => {
    // Run 1: save_field commits, set_field_boundary fails.
    rpc.mockImplementation((fn: string) => {
      if (fn === 'save_field') return Promise.resolve({ data: 'field-A', error: null });
      if (fn === 'set_field_boundary') return Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } });
      return Promise.resolve({ data: {}, error: null });
    });

    const { rerender } = render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    const firstSave = callsTo('save_field');
    expect(firstSave).toHaveLength(1);
    const originalKey = firstSave[0][1].p_idempotency_key;
    expect(screen.getByText(/boundary measurement failed/i)).toBeInTheDocument();

    // The operator corrects the boundary and re-imports the row. The modal stays
    // mounted (Fields.tsx never unmounts it), which is what keeps the key cached.
    geometryOffset = 0.001;
    rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
      // The server replays the committed receipt for a key it has already seen,
      // returning the ORIGINAL field id rather than inserting again.
      if (fn === 'save_field') {
        return Promise.resolve({
          data: args.p_idempotency_key === originalKey ? 'field-A' : 'field-B-DUPLICATE',
          error: null,
        });
      }
      return Promise.resolve({ data: { field_id: args.p_field_id }, error: null });
    });

    await closeModal();
    rerender(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    const saves = callsTo('save_field');
    expect(saves).toHaveLength(2);

    // THE DEFECT: before the fix the changed geometry changed save_field's scope,
    // minting a new key and creating a second field.
    expect(saves[1][1].p_idempotency_key).toBe(originalKey);
    expect(saves[1][1].p_field_id).toBeNull();

    // Only ONE field was ever created, and the corrected boundary landed on it.
    const boundaryCalls = callsTo('set_field_boundary');
    expect(boundaryCalls[boundaryCalls.length - 1][1].p_field_id).toBe('field-A');
    expect(screen.getByText(/1 field/i)).toBeInTheDocument();
  });

  it('mints a FRESH boundary key for the corrected geometry, so the retry is real work', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'save_field') return Promise.resolve({ data: 'field-A', error: null });
      if (fn === 'set_field_boundary') return Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } });
      return Promise.resolve({ data: {}, error: null });
    });

    const { rerender } = render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();
    const firstBoundaryKey = callsTo('set_field_boundary')[0][1].p_idempotency_key;

    geometryOffset = 0.001;
    rpc.mockImplementation((fn: string, args: Record<string, unknown>) =>
      Promise.resolve(fn === 'save_field'
        ? { data: 'field-A', error: null }
        : { data: { field_id: args.p_field_id }, error: null }));

    await closeModal();
    rerender(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    const boundaryKeys = callsTo('set_field_boundary').map((c) => c[1].p_idempotency_key);
    expect(boundaryKeys).toHaveLength(2);
    // A corrected boundary is genuinely different work — it must NOT replay the
    // receipt of the geometry the operator just rejected.
    expect(boundaryKeys[1]).not.toBe(firstBoundaryKey);
  });

  it('replays the same save_field key when the identical row is retried unchanged', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'save_field') return Promise.resolve({ data: 'field-A', error: null });
      if (fn === 'set_field_boundary') return Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } });
      return Promise.resolve({ data: {}, error: null });
    });

    const { rerender } = render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();
    const originalKey = callsTo('save_field')[0][1].p_idempotency_key;

    await closeModal();
    rerender(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();   // geometryOffset unchanged — a plain retry

    const saves = callsTo('save_field');
    expect(saves).toHaveLength(2);
    expect(saves[1][1].p_idempotency_key).toBe(originalKey);
  });
});
