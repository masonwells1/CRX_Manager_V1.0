/**
 * BulkFieldImport.perCallKey.test.tsx — RUNTIME proof of the settled 2026-09-08 decision
 * that this screen mints a FRESH idempotency key for every RPC call.
 *
 * gauntletFrontendSafetyGuards.test.ts pins that decision by SOURCE TEXT (three literal
 * `crypto.randomUUID()` calls, no retained-key form). Source-text pins cannot show what
 * the component actually DOES with a lost response, so this file drives the real
 * component through the real handleUpload against a save_field fixture that behaves the
 * way the real RPC does: a repeated idempotency key replays the first receipt.
 *
 * Adapted (Claude, 2026-09-08) from Codex's
 * `keeps different field boundaries separate when metadata matches` regression test,
 * which was written against the WITHDRAWN retained-key candidate and failed there.
 * Changes from Codex's version are listed in the scratchpad report:
 *   - dropped `expect(screen.queryByText(/identical to an earlier row/i))`; that string
 *     belonged to the withdrawn collision map and no longer exists anywhere in src/, so
 *     the assertion can never fail and proves nothing.
 *   - added a positive assertion that the two save_field calls carry DIFFERENT keys —
 *     that is the property under test, and asserting it directly is what makes a
 *     reintroduced retained key fail here rather than only failing downstream.
 *   - added the deliberate-duplicate test, which states the decision as a requirement
 *     instead of only ruling out the corruption.
 *
 * Codex's other added test (`replays an uncertain row when an earlier source row becomes
 * invalid`) is NOT carried over: it asserts `retrySaves[0].p_idempotency_key ===
 * originalSaves[1].p_idempotency_key`, i.e. it pins the retained key that commit
 * 63e468b59 removed. Its premise no longer exists.
 *
 * Mocked: the network boundary, auth, toast, the child steps and the file parser.
 * NOT proof against the real PostgreSQL RPCs or in a browser.
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
  // Mirrors the REAL contract in src/lib/db.ts, which THROWS on null/undefined.
  assertRpcResult: (data: unknown, rpcName: string) => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data — operation may have been denied`);
    }
    return data;
  },
  rpcAuthErrorMessage: () => null,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1' } }),
}));

vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock('./ImportPreviewMap', () => ({ default: () => <div /> }));
vi.mock('./AttributeMappingStep', () => ({
  default: ({ onMappingChange }: { onMappingChange: (m: Record<string, string>) => void }) => (
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

function square(): Polygon {
  return {
    type: 'Polygon',
    coordinates: [[
      [-88.0, 40.0], [-88.0, 40.01], [-87.99, 40.01], [-87.99, 40.0], [-88.0, 40.0],
    ]],
  };
}

let rowCount = 1;
/** Every row carries the SAME mapped metadata; only the ground underneath differs. */
let distinctBoundariesWithSameMetadata = false;

/** Row 0 keeps the original square; later rows are shifted east, so the geometry differs. */
function rowGeometry(index: number): Polygon {
  const geometry = square();
  if (distinctBoundariesWithSameMetadata && index > 0) {
    geometry.coordinates = geometry.coordinates.map((ring) => ring.map(([lng, lat]) => [lng + 0.1, lat]));
  }
  return geometry;
}

vi.mock('../../lib/fieldImportParser', () => ({
  parseShapefileBundle: vi.fn(),
  parseShapefileZip: vi.fn(),
  parseKMLFile: vi.fn(),
  parseGeoJSONFile: () => ({
    featureCollection: {
      type: 'FeatureCollection',
      features: Array.from({ length: rowCount }, (_, i) => ({
        type: 'Feature',
        geometry: rowGeometry(i),
        properties: { NAME: `North ${distinctBoundariesWithSameMetadata ? 1 : i + 1}`, ACRES: '40' },
      })),
    },
    attributeKeys: ['NAME', 'ACRES'],
    crsDetected: 'EPSG:4326',
    warnings: [],
    featureCount: rowCount,
    fullGeometries: Array.from({ length: rowCount }, (_, i) => rowGeometry(i)),
  }),
  calculateFieldMetrics: () => ({ acres: 40, centroid: { type: 'Point', coordinates: [-88, 40] } }),
  validateFullGeometry: () => [],
  geometryAcres: () => 40,
}));

import BulkFieldImport from './BulkFieldImport';

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
  await click(/stub-map-acres/i);
  await click(/^next$/i);          // step 3 -> 4
  await click(/stub-assign/i);
  await click(/^next$/i);          // step 4 -> 5
  await click(new RegExp(`import ${rowCount} field`, 'i'));
  await waitFor(() => expect(screen.getByText(/import complete/i)).toBeInTheDocument());
}

/**
 * A save_field fixture that behaves like the real RPC's idempotency contract:
 * the FIRST call for a key mints a field id and stores the receipt; any LATER call
 * carrying that same key replays the stored id instead of creating a second field.
 * This is what makes a retained client key observable in a unit test.
 */
function makeSaveFieldFixture() {
  const receipts = new Map<string, string>();
  return {
    receipts,
    idFor(key: string) {
      if (!receipts.has(key)) receipts.set(key, `field-${receipts.size + 1}`);
      return receipts.get(key)!;
    },
  };
}

describe('BulkFieldImport — a fresh idempotency key per RPC call', () => {
  beforeEach(() => {
    rpc.mockReset();
    rowCount = 1;
    distinctBoundariesWithSameMetadata = false;
  });

  it.each([false, true])(
    'keeps two same-metadata rows with different ground on separate fields (first reply lost: %s)',
    async (loseFirstReply) => {
      rowCount = 2;
      distinctBoundariesWithSameMetadata = true;
      const fixture = makeSaveFieldFixture();
      let firstReply = true;
      rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
        if (fn === 'save_field') {
          const id = fixture.idFor(String(args.p_idempotency_key));
          if (firstReply && loseFirstReply) {
            firstReply = false;
            // status 0 = the answer never came back. The row committed in the fixture.
            return Promise.resolve({ data: null, error: { message: 'Failed to fetch', code: '' }, status: 0 });
          }
          firstReply = false;
          return Promise.resolve({ data: id, error: null, status: 200 });
        }
        return Promise.resolve({ data: { field_id: args.p_field_id }, error: null, status: 200 });
      });

      render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
      await runImport();

      const saveCalls = rpc.mock.calls.filter(([fn]) => fn === 'save_field');
      expect(saveCalls).toHaveLength(2);
      // THE PROPERTY UNDER TEST: the second row must not reuse the first row's key.
      // A retained content-derived key makes these equal, because the two rows differ
      // only in geometry, which no sound client scope can include.
      expect(saveCalls[0][1].p_idempotency_key).not.toBe(saveCalls[1][1].p_idempotency_key);
      // Two distinct keys means two distinct receipts, so no replay happened.
      expect(fixture.receipts.size).toBe(2);

      const boundaryCalls = rpc.mock.calls.filter(([fn]) => fn === 'set_field_boundary');
      // A lost save_field response stops that row before its boundary write.
      expect(boundaryCalls).toHaveLength(loseFirstReply ? 1 : 2);
      if (!loseFirstReply) {
        expect(boundaryCalls[0][1].p_boundary_geojson).not.toBe(boundaryCalls[1][1].p_boundary_geojson);
        expect(boundaryCalls[0][1].p_field_id).not.toBe(boundaryCalls[1][1].p_field_id);
      }
      // The corruption this guards: row 2's ground written onto the field row 1 created.
      // Indexed rather than `.at(-1)`: the pre-push type check targets a lib without
      // Array.prototype.at, and it is the stricter of the two configs.
      const lastBoundary = boundaryCalls[boundaryCalls.length - 1][1];
      expect(lastBoundary.p_field_id).toBe('field-2');
      expect(lastBoundary.p_boundary_geojson).toBe(JSON.stringify(rowGeometry(1)));
    },
  );

  it('re-importing a row whose answer was lost creates a SECOND field, never a replay', async () => {
    // The settled decision, stated positively. A duplicate field is visible in the field
    // list and an admin can delete it; a replayed receipt silently rewrites the boundary
    // of a field that imported correctly. This test fails if a retained key comes back.
    rowCount = 1;
    const fixture = makeSaveFieldFixture();
    let loseResponse = true;
    rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'save_field') {
        const id = fixture.idFor(String(args.p_idempotency_key));
        if (loseResponse) {
          return Promise.resolve({ data: null, error: { message: 'Failed to fetch', code: '' }, status: 0 });
        }
        return Promise.resolve({ data: id, error: null, status: 200 });
      }
      return Promise.resolve({ data: { field_id: args.p_field_id }, error: null, status: 200 });
    });

    render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();
    // The operator is told the outcome is unknown rather than that the row is safe to retry.
    // The banner and the per-row error line both say it, so match on "at least one".
    expect(screen.getAllByText(/outcome unknown/i).length).toBeGreaterThan(0);
    const firstSave = rpc.mock.calls.filter(([fn]) => fn === 'save_field');
    expect(firstSave).toHaveLength(1);

    // The operator reopens the still-mounted dialog and re-imports the same file.
    await act(async () => { fireEvent.click(screen.getByLabelText('Close')); });
    loseResponse = false;
    rpc.mockClear();
    await runImport();

    const retrySave = rpc.mock.calls.filter(([fn]) => fn === 'save_field');
    expect(retrySave).toHaveLength(1);
    // Same payload, DIFFERENT key — so the server mints a second field rather than
    // handing back the first one's id for this row's boundary to overwrite.
    expect(retrySave[0][1].p_field_payload).toEqual(firstSave[0][1].p_field_payload);
    expect(retrySave[0][1].p_idempotency_key).not.toBe(firstSave[0][1].p_idempotency_key);
    expect(fixture.receipts.size).toBe(2);
    expect(rpc.mock.calls.find(([fn]) => fn === 'set_field_boundary')?.[1].p_field_id).toBe('field-2');
  });
});
