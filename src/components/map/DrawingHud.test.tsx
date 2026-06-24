/**
 * DrawingHud.test.tsx — the on-map guided-drawing overlay (SOW-F1).
 * Purely presentational, so it renders from plain props with no map dependency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DrawingHud from './DrawingHud';

describe('DrawingHud', () => {
  const baseProps = {
    isDrawing: false,
    partCount: 0,
    acres: 0,
    corners: 0,
    onStartDrawing: vi.fn(),
    onReplace: vi.fn(),
    onDone: vi.fn(),
    onStartOver: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a "Draw field boundary" entry point when nothing is drawn yet', () => {
    render(<DrawingHud {...baseProps} />);
    const btn = screen.getByRole('button', { name: /draw field boundary/i });
    fireEvent.click(btn);
    expect(baseProps.onStartDrawing).toHaveBeenCalledTimes(1);
  });

  it('offers a single-boundary "Redraw boundary" (replace) at exactly 1 part', () => {
    render(<DrawingHud {...baseProps} partCount={1} />);
    const btn = screen.getByRole('button', { name: /redraw boundary/i });
    fireEvent.click(btn);
    expect(baseProps.onReplace).toHaveBeenCalledTimes(1);
    expect(baseProps.onStartDrawing).not.toHaveBeenCalled();
  });

  it('offers an ADDITIVE "Draw another part" at 2+ parts (never wipes existing parts)', () => {
    render(<DrawingHud {...baseProps} partCount={3} />);
    // Must NOT be a destructive replace/start-over at multi-part.
    expect(screen.queryByRole('button', { name: /redraw/i })).not.toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /draw another part/i });
    fireEvent.click(btn);
    expect(baseProps.onStartDrawing).toHaveBeenCalledTimes(1);
    expect(baseProps.onReplace).not.toHaveBeenCalled();
    expect(baseProps.onStartOver).not.toHaveBeenCalled();
  });

  it('renders the corner-tapping instructions ONLY while drawing', () => {
    const { rerender } = render(<DrawingHud {...baseProps} />);
    expect(screen.queryByText(/tap each corner of the field/i)).not.toBeInTheDocument();

    rerender(<DrawingHud {...baseProps} isDrawing partCount={1} corners={1} />);
    expect(screen.getByText(/tap each corner of the field/i)).toBeInTheDocument();
  });

  it('shows the live acreage as the shape forms', () => {
    render(<DrawingHud {...baseProps} isDrawing partCount={1} acres={82.4} corners={4} />);
    expect(screen.getByText(/~ 82\.4 ac/i)).toBeInTheDocument();
    expect(screen.getByText(/4 corners placed/i)).toBeInTheDocument();
  });

  it('disables "Done" until at least 3 corners are placed, and prompts for more', () => {
    render(<DrawingHud {...baseProps} isDrawing partCount={1} acres={0} corners={2} />);
    const done = screen.getByRole('button', { name: /done/i });
    expect(done).toBeDisabled();
    expect(screen.getByText(/need 3 to finish/i)).toBeInTheDocument();
    fireEvent.click(done);
    expect(baseProps.onDone).not.toHaveBeenCalled();
  });

  it('enables "Done" at 3+ corners and finishes the polygon', () => {
    render(<DrawingHud {...baseProps} isDrawing partCount={1} acres={50.2} corners={3} />);
    const done = screen.getByRole('button', { name: /done/i });
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(baseProps.onDone).toHaveBeenCalledTimes(1);
  });

  it('offers "Start over" while drawing (abandons just the in-progress polygon)', () => {
    render(<DrawingHud {...baseProps} isDrawing partCount={1} corners={4} />);
    fireEvent.click(screen.getByRole('button', { name: /start over/i }));
    expect(baseProps.onStartOver).toHaveBeenCalledTimes(1);
  });
});
