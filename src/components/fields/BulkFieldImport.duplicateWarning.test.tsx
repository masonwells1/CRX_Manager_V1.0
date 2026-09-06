/**
 * BulkFieldImport.duplicateWarning.test.tsx — the results screen must warn against
 * re-importing the file, and must count rows the way the DATABASE sees them.
 *
 * save_field COMMITS before set_field_boundary runs, so a row counted as FAILED can
 * still have created a field. Re-importing that row creates a duplicate the operator
 * cannot delete (fields_delete RLS is admin-only). The warning therefore has to be
 * driven by `created` — every row whose save_field landed — not by `success`.
 *
 * These tests drive the real component through the real handleUpload. Only the network
 * boundary, auth, toast, the child steps and the file parser are mocked.
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
  // Mirrors the REAL contract in src/lib/db.ts, which THROWS on null/undefined rather
  // than returning a boolean. Mocking it as a predicate would describe a contract the
  // app does not have.
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

vi.mock('../../lib/fieldImportParser', () => ({
  parseShapefileBundle: vi.fn(),
  parseShapefileZip: vi.fn(),
  parseKMLFile: vi.fn(),
  parseGeoJSONFile: () => ({
    featureCollection: {
      type: 'FeatureCollection',
      features: Array.from({ length: rowCount }, (_, i) => ({
        type: 'Feature',
        geometry: square(),
        properties: { NAME: `North ${i + 1}`, ACRES: '40' },
      })),
    },
    attributeKeys: ['NAME', 'ACRES'],
    crsDetected: 'EPSG:4326',
    warnings: [],
    featureCount: rowCount,
    fullGeometries: Array.from({ length: rowCount }, () => square()),
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

/** The warning's count sentence, with JSX whitespace normalised. */
function warningText() {
  return screen
    .getByText(/already exist/i, { selector: 'p' })
    .textContent?.replace(/\s+/g, ' ')
    .trim();
}

describe('BulkFieldImport — re-import duplicate warning', () => {
  beforeEach(() => {
    rpc.mockReset();
    rowCount = 1;
  });

  it('counts a row whose field was created but whose boundary failed', async () => {
    // The ONLY row: save_field commits, then the boundary call fails. The screen
    // reports 0 imported / 1 failed — but a field EXISTS, so re-importing duplicates.
    rpc.mockImplementation((fn: string) => {
      if (fn === 'save_field') return Promise.resolve({ data: 'field-A', error: null });
      if (fn === 'set_field_boundary') {
        return Promise.resolve({ data: null, error: { message: 'degenerate geometry', code: 'XX000' } });
      }
      return Promise.resolve({ data: {}, error: null });
    });

    render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    // Scoped to the row's own error line — the warning below deliberately quotes the
    // same phrase so the operator can match the two up, so a bare match is ambiguous.
    expect(screen.getByText(/North 1.*boundary measurement failed/i)).toBeInTheDocument();
    // Supabase rejects with a PLAIN OBJECT, not an Error. String()-ing it printed
    // "[object Object]" and the operator saw no reason at all — on the very line the
    // warning below tells them to read.
    const errorLine = screen.getByText(/North 1.*boundary measurement failed/i).textContent ?? '';
    expect(errorLine).toContain('degenerate geometry');
    expect(errorLine).not.toContain('[object Object]');
    // Nothing "succeeded", so a warning driven by `success` would be absent here —
    // and the operator would re-import and duplicate the field.
    expect(screen.getByText(/do not re-import this whole file/i)).toBeInTheDocument();
    expect(warningText()).toContain('1 field from this file already exists here.');
  });

  it('counts BOTH a fully-imported row and a boundary-failed row', async () => {
    rowCount = 2;
    let saves = 0;
    rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'save_field') {
        saves += 1;
        return Promise.resolve({ data: `field-${saves}`, error: null });
      }
      if (fn === 'set_field_boundary' && args.p_field_id === 'field-2') {
        return Promise.resolve({ data: null, error: { message: 'degenerate geometry', code: 'XX000' } });
      }
      return Promise.resolve({ data: { field_id: args.p_field_id }, error: null });
    });

    render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    // 1 succeeded, 1 failed — but TWO fields exist.
    expect(screen.getByText(/successfully imported 1 field/i)).toBeInTheDocument();
    expect(warningText()).toContain('2 fields from this file already exist here.');
  });

  it('does NOT warn when every row imported cleanly', async () => {
    rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'save_field') return Promise.resolve({ data: 'field-A', error: null });
      return Promise.resolve({ data: { field_id: args.p_field_id }, error: null });
    });

    render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    expect(screen.queryByText(/do not re-import this whole file/i)).not.toBeInTheDocument();
  });

  it('does NOT warn when the server explicitly rejected the row', async () => {
    // PostgreSQL answered (a real HTTP status), so the transaction rolled back and no
    // field exists. This row genuinely is safe to re-import.
    rpc.mockImplementation((fn: string) => {
      if (fn === 'save_field') {
        return Promise.resolve({
          data: null,
          error: { message: 'permission denied', code: '42501' },
          status: 403,
        });
      }
      return Promise.resolve({ data: {}, error: null, status: 200 });
    });

    render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/do not re-import this whole file/i)).not.toBeInTheDocument();
  });

  it('WARNS when the response was lost, because the row may have committed anyway', async () => {
    // postgrest-js reports status 0 when fetch itself failed and no response ever arrived.
    // The request may still have reached PostgreSQL and committed, so this row must NOT be
    // presented as safe to retry — the retry mints a fresh key and would duplicate it.
    rpc.mockImplementation((fn: string) => {
      if (fn === 'save_field') {
        return Promise.resolve({
          data: null,
          error: { message: 'TypeError: Failed to fetch', code: '' },
          status: 0,
        });
      }
      return Promise.resolve({ data: {}, error: null, status: 200 });
    });

    render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    // Nothing is confirmed created, so a warning gated only on `created` would be absent.
    expect(screen.getByText(/do not re-import this whole file/i)).toBeInTheDocument();
    const p = screen.getByText(/never came back with a clear answer/i, { selector: "p" });
    expect(p.textContent?.replace(/\s+/g, ' ')).toContain(
      '1 row never came back with a clear answer',
    );
    // It must not claim the field exists — only that we cannot tell.
    expect(screen.queryByText(/already exist/i, { selector: 'p' })).not.toBeInTheDocument();
  });

  it('WARNS when save_field answered with no id, because that outcome is ambiguous too', async () => {
    // A 200 carrying null data makes assertRpcResult throw. The server answered, but not
    // with an id, so whether anything committed is unknowable from here — the row must be
    // treated the same as a lost response, not as a clean rejection.
    rpc.mockImplementation((fn: string) => {
      if (fn === 'save_field') return Promise.resolve({ data: null, error: null, status: 200 });
      return Promise.resolve({ data: {}, error: null, status: 200 });
    });

    render(<BulkFieldImport open onClose={vi.fn()} onSuccess={vi.fn()} />);
    await runImport();

    expect(screen.getByText(/do not re-import this whole file/i)).toBeInTheDocument();
    expect(screen.getByText(/never came back with a clear answer/i, { selector: "p" })).toBeInTheDocument();
  });
});
