import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FieldSetup from './FieldSetup';

const {
  mockCheckMutationResult,
  mockDrawLayer,
  mockFrom,
  mockInsert,
  mockRpc,
  mockToast,
  mockUseAuth,
  mockUseParams,
} = vi.hoisted(() => ({
  mockCheckMutationResult: vi.fn(),
  mockDrawLayer: vi.fn(),
  mockFrom: vi.fn(),
  mockInsert: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUseParams: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => mockUseParams(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T,>(data: unknown): T => data as T,
  checkMutationResult: mockCheckMutationResult,
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../lib/fieldsGeojsonCache', () => ({
  getCachedFieldsGeojson: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/plssLookup', () => ({
  lookupPlss: vi.fn(),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-key', resetKey: vi.fn() }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }),
}));

vi.mock('../components/map/CRXMap', () => ({
  default: ({
    children,
    onMapClick,
  }: {
    children: ReactNode;
    onMapClick?: (longitude: number, latitude: number) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onMapClick?.(-89.04, 39.16)}>Mock map click</button>
      {children}
    </div>
  ),
}));

vi.mock('../components/map/DrawLayer', () => ({
  default: ({
    disabled = false,
    onDrawingStateChange,
  }: {
    disabled?: boolean;
    onDrawingStateChange?: (isDrawing: boolean) => void;
  }) => {
    mockDrawLayer({ disabled, onDrawingStateChange });
    return (
      <button
        type="button"
        data-testid="mock-draw-layer"
        onClick={() => onDrawingStateChange?.(true)}
      >
        Start mock boundary drawing
      </button>
    );
  },
}));
vi.mock('../components/map/AddressSearch', () => ({ default: () => null }));
vi.mock('../components/map/FieldBoundaryLayer', () => ({ default: () => null }));
vi.mock('../components/map/FieldObstacleLayer', () => ({ default: () => null }));
vi.mock('../components/ui/UnsavedChangesModal', () => ({ default: () => null }));
vi.mock('../components/ui/ConfirmModal', () => ({
  default: ({
    open,
    onConfirm,
    confirmLabel = 'Confirm',
  }: {
    open: boolean;
    onConfirm: () => void;
    confirmLabel?: string;
  }) => open ? <button type="button" onClick={onConfirm}>{confirmLabel}</button> : null,
}));

const savedObstacle = {
  id: 'obstacle-1',
  field_id: 'field-1',
  kind: 'oil_well',
  label: 'West well',
  point_geojson: { type: 'Point', coordinates: [-89.05, 39.15] },
  created_by: 'user-1',
  created_at: '2026-07-11T12:00:00Z',
  updated_at: '2026-07-11T12:00:00Z',
};

const insertedObstacle = {
  ...savedObstacle,
  id: 'obstacle-2',
  kind: 'windmill',
  label: 'North windmill',
  point_geojson: { type: 'Point', coordinates: [-89.04, 39.16] },
};

function listChain(data: unknown, error: unknown = null): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = (resolve: (result: { data: unknown; error: unknown }) => void) => resolve({ data, error });
  return chain;
}

function configureSupabase(obstacleReadError: unknown = null): void {
  mockRpc.mockImplementation((name: string) => {
    if (name === 'get_field_geojson' || name === 'get_field_polygons') {
      return Promise.resolve({ data: [], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  mockFrom.mockImplementation((table: string) => {
    if (table === 'fields') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: {
                id: 'field-1',
                customer_id: 'customer-1',
                field_name: 'North 40',
                state: 'IL',
                total_acres: 40,
                measured_acres: null,
                override_acres: null,
                irrigation: false,
                is_active: true,
                customer: { farm_name: 'Smith Farm' },
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'customers' || table === 'field_billing_defaults') {
      return listChain([]);
    }
    if (table === 'field_obstacles') {
      return {
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({
              data: obstacleReadError ? null : [savedObstacle],
              error: obstacleReadError,
            }),
          }),
        }),
        insert: (payload: unknown) => {
          mockInsert(payload);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: insertedObstacle, error: null }),
            }),
          };
        },
        delete: () => ({
          eq: (_column: string, id: string) => ({
            select: () => Promise.resolve({ data: [{ id }], error: null }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

describe('FieldSetup field obstacles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseParams.mockReturnValue({ id: 'field-1' });
    mockUseAuth.mockReturnValue({ profile: { id: 'user-1', role: 'admin' } });
    configureSupabase();
  });

  it('loads, adds, and confirms deletion of obstacle pins', async () => {
    render(<FieldSetup />);

    expect(await screen.findByText(/West well/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add obstacle' }));
    expect(screen.getByText('Click the map where the obstacle is located.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mock map click' }));
    fireEvent.change(screen.getByLabelText('Obstacle type'), { target: { value: 'windmill' } });
    fireEvent.change(screen.getByLabelText('Obstacle label (optional)'), { target: { value: 'North windmill' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save obstacle' }));

    await waitFor(() => expect(mockInsert).toHaveBeenCalledWith({
      field_id: 'field-1',
      kind: 'windmill',
      label: 'North windmill',
      point_geojson: { type: 'Point', coordinates: [-89.04, 39.16] },
      created_by: 'user-1',
    }));
    expect(mockCheckMutationResult).toHaveBeenCalledWith(
      expect.objectContaining({ data: insertedObstacle, error: null }),
      'Add field obstacle',
    );
    expect(await screen.findByText(/North windmill/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete obstacle North windmill' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete obstacle' }));

    await waitFor(() => expect(screen.queryByText(/North windmill/)).not.toBeInTheDocument());
    expect(mockCheckMutationResult).toHaveBeenLastCalledWith(
      { data: [{ id: 'obstacle-2' }], error: null },
      'Delete field obstacle',
    );
  });

  it('shows an empty section and toast when the obstacle read fails', async () => {
    configureSupabase(new Error('read failed'));
    render(<FieldSetup />);

    expect(await screen.findByText('No obstacles marked for this field.')).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('error', 'Could not load field obstacles.');
  });

  it('keeps the draw layer mounted and blocks obstacle mode during an active boundary sketch', async () => {
    render(<FieldSetup />);

    await screen.findByText(/West well/);
    expect(screen.getByTestId('mock-draw-layer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add obstacle' }));
    expect(screen.getByTestId('mock-draw-layer')).toBeInTheDocument();
    expect(mockDrawLayer).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel obstacle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start mock boundary drawing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add obstacle' }));

    expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Finish or cancel the boundary before adding an obstacle.',
    );
    expect(mockDrawLayer).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: false }));
  });

  it('keeps obstacle write controls hidden from applicators', async () => {
    mockUseAuth.mockReturnValue({ profile: { id: 'applicator-1', role: 'applicator' } });
    render(<FieldSetup />);

    expect(await screen.findByText(/West well/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add obstacle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete obstacle West well' })).not.toBeInTheDocument();
  });
});
