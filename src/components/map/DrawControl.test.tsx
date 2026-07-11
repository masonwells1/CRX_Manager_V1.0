import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DrawControl from './DrawControl';

const {
  mockChangeMode,
  mockDrawConstructor,
  mockMap,
} = vi.hoisted(() => {
  const mockChangeMode = vi.fn();
  const mockDrawInstance = {
    add: vi.fn(),
    changeMode: mockChangeMode,
    deleteAll: vi.fn(),
    getAll: vi.fn(() => ({ features: [] })),
    getMode: vi.fn(() => 'simple_select'),
    trash: vi.fn(),
  };
  const mockDrawConstructor = vi.fn(function MockDraw(_options?: unknown) {
    return mockDrawInstance;
  });
  Object.assign(mockDrawConstructor, {
    modes: {
      draw_line_string: {},
      draw_polygon: {},
      draw_point: {},
      direct_select: {},
      simple_select: {},
    },
  });
  const mockMap = {
    getContainer: () => document.createElement('div'),
    off: vi.fn(),
    on: vi.fn(),
  };

  return { mockChangeMode, mockDrawConstructor, mockDrawInstance, mockMap };
});

vi.mock('@mapbox/mapbox-gl-draw', () => ({ default: mockDrawConstructor }));

vi.mock('react-map-gl/mapbox', () => ({
  useControl: (create: () => object, onAdd: ({ map }: { map: typeof mockMap }) => void) => {
    const draw = create();
    onAdd({ map: mockMap });
    return draw;
  },
}));

describe('DrawControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests static mode during obstacle placement and restores simple_select afterward', () => {
    const { rerender } = render(<DrawControl disabled={false} />);
    mockChangeMode.mockClear();

    rerender(<DrawControl disabled />);
    expect(mockChangeMode).toHaveBeenCalledWith('static');

    mockChangeMode.mockClear();
    rerender(<DrawControl disabled={false} />);
    expect(mockChangeMode).toHaveBeenCalledWith('simple_select');
  });

  it('registers the handler-free static mode that keeps boundary features visible', () => {
    render(<DrawControl />);

    const options = mockDrawConstructor.mock.calls[0][0] as {
      keybindings: boolean;
      modes: Record<string, {
        onSetup: () => Record<string, never>;
        toDisplayFeatures: (
          state: unknown,
          geojson: unknown,
          display: (feature: unknown) => void,
        ) => void;
      }>;
    };
    const staticMode = options.modes.static;
    const feature = { type: 'Feature' };
    const display = vi.fn();

    expect(options.keybindings).toBe(false);
    expect(staticMode.onSetup()).toEqual({});
    staticMode.toDisplayFeatures({}, feature, display);
    expect(display).toHaveBeenCalledWith(feature);
    expect(staticMode).not.toHaveProperty('onClick');
    expect(staticMode).not.toHaveProperty('onDrag');
  });

  it('restores static mode when a modechange tries to enter polygon drawing while disabled', () => {
    render(<DrawControl disabled />);
    mockChangeMode.mockClear();

    const modeChangeHandler = mockMap.on.mock.calls.find(
      ([event]) => event === 'draw.modechange',
    )?.[1] as ((event: { mode: string }) => void) | undefined;

    expect(modeChangeHandler).toBeDefined();
    modeChangeHandler?.({ mode: 'draw_polygon' });

    expect(mockChangeMode).toHaveBeenCalledWith('static');
  });
});
