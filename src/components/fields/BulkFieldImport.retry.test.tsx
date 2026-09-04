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
// Stubbed, but it must still be able to SET a mapping: without an acre-denominated
// column mapped to total_acres, pf.stated_acres stays null and the override RPC is
// never called at all — which would make the override test silently vacuous.
vi.mock('./AttributeMappingStep', () => ({
  default: ({ onMappingChange }: { onMappingChange: (m: Record<string, string>) => void }) => (
    // field_name MUST be mapped too. Unmapped, each row falls back to
    // `Imported Field ${i + 1}`, so two rows are never actually identical and the
    // occurrence counter is never exercised — a vacuous test. Caught by mutation:
    // neutering the counter left the two-row test GREEN until this was mapped.
    <button onClick={() => onMappingChange({ field_name: 'NAME', total_acres: 'ACRES' })}>
      stub-map-acres
    </button>
  ),
}));
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
// How many rows the parsed file contains. Rows are IDENTICAL in every save_field
// column (same name, no other attributes mapped), which is exactly the case the
// per-identity occurrence counter exists to separate.
let rowCount = 1;
// The file's stated acreage. In-band (0.1-5000) so set_field_override_acres is
// actually called rather than skipped with a warning.
const statedAcresValue = '40';

vi.mock('../../lib/fieldImportParser', () => ({
  parseShapefileBundle: vi.fn(),
  parseShapefileZip: vi.fn(),
  parseKMLFile: vi.fn(),
  parseGeoJSONFile: () => ({
    featureCollection: {
      type: 'FeatureCollection',
      features: Array.from({ length: rowCount }, () => ({
        type: 'Feature',
        geometry: square(geometryOffset),
        properties: { NAME: 'North 40', ACRES: statedAcresValue },
      })),
    },
    attributeKeys: ['NAME', 'ACRES'],
    crsDetected: 'EPSG:4326',
    warnings: [],
    featureCount: rowCount,
    fullGeometries: Array.from({ length: rowCount }, () => square(geometryOffset)),
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
  await click(/stub-map-acres/i);  // map the acre column so stated_acres is real
  await click(/^next$/i);          // step 3 -> 4
  await click(/stub-assign/i);
  await click(/^next$/i);          // step 4 -> 5
  await click(new RegExp(`import ${rowCount} field`, 'i'));
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
    rowCount = 1;
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

  // Codex gpt-5.6-sol, 2026-09-04, finding 2 (rated 75%, CONFIRMED from source at 100%):
  // retirement was gated on boundaryOk alone, so a boundary-success/override-FAILURE row
  // retired its save key while unfinished. Retrying then minted a fresh key and inserted
  // a SECOND field. Finding 20: no behavioral test covered the override path at all.
  it('keeps the save_field key when the OVERRIDE fails, so retrying does not duplicate', async () => {
    rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'save_field') return Promise.resolve({ data: 'field-A', error: null });
      if (fn === 'set_field_override_acres') {
        return Promise.resolve({ data: null, error: { message: 'override boom', code: 'XX000' } });
      }
      return Promise.resolve({ data: { field_id: args.p_field_id }, error: null });
    });

    const { rerender } = render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();
    const originalKey = callsTo('save_field')[0][1].p_idempotency_key;
    // The row still counts as imported (it bills on measured acres) and warns.
    expect(screen.getByText(/couldn't be set as the billable acres/i)).toBeInTheDocument();

    // The operator retries the row to get the billable acreage right.
    rpc.mockImplementation((fn: string, args: Record<string, unknown>) =>
      Promise.resolve(fn === 'save_field'
        ? { data: args.p_idempotency_key === originalKey ? 'field-A' : 'field-B-DUPLICATE', error: null }
        : { data: { field_id: args.p_field_id }, error: null }));

    await closeModal();
    rerender(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    const saves = callsTo('save_field');
    expect(saves).toHaveLength(2);
    // The unfinished row must still replay onto field-A, not insert a second field.
    expect(saves[1][1].p_idempotency_key).toBe(originalKey);
    const boundaries = callsTo('set_field_boundary');
    expect(boundaries[boundaries.length - 1][1].p_field_id).toBe('field-A');
  });

  // Codex finding 19: every test imported exactly one row, so the occurrence counter —
  // the highest-risk new logic — had no behavioral coverage at all. Two rows that are
  // IDENTICAL in every save_field column must still become two separate fields.
  // The FIRST row must fail, or this test is vacuous. Verified by mutation: with both
  // rows succeeding, row 1 RETIRES its scope at row completion before row 2 starts, so
  // row 2 mints a fresh key regardless and two fields appear even with the counter
  // neutered. The counter only does work while an earlier identical row's key is still
  // RETAINED — i.e. after that row failed. Confirmed by dumping both payloads: they are
  // byte-identical, so the digest alone cannot separate them.
  it('gives a second identical row its OWN key while the first row failed and kept its key', async () => {
    rowCount = 2;
    const issued: string[] = [];
    let boundaryCalls = 0;
    rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'save_field') {
        const key = args.p_idempotency_key as string;
        // Model the server: one field per distinct key, replay for a repeat key.
        if (!issued.includes(key)) issued.push(key);
        return Promise.resolve({ data: `field-${issued.indexOf(key)}`, error: null });
      }
      if (fn === 'set_field_boundary') {
        boundaryCalls += 1;
        // Row 1's boundary fails, so row 1 never completes and RETAINS its save key.
        if (boundaryCalls === 1) {
          return Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } });
        }
      }
      return Promise.resolve({ data: { field_id: args.p_field_id }, error: null });
    });

    render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    const saves = callsTo('save_field');
    expect(saves).toHaveLength(2);
    // Both rows are byte-identical in every column save_field writes.
    expect(saves[0][1].p_field_payload).toEqual(saves[1][1].p_field_payload);
    // Without the occurrence counter both rows share one scope; row 2 would replay
    // row 1's RETAINED key, receive row 1's field id, and the operator would end up
    // with ONE field where the file asked for two — and row 2's boundary would be
    // written onto row 1's field.
    const keys = saves.map((c) => c[1].p_idempotency_key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(issued).toHaveLength(2);
    expect(saves[1][1].p_field_id).toBeNull();
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
