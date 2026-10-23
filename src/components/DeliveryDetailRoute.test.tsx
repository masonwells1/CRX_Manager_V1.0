/**
 * DeliveryDetailRoute — the route element for `deliveries/:id` (readability report B4).
 *
 * DeliveryDetail never resets its edit state on a change of record, so the route must remount
 * it. The page is replaced by a stand-in that holds its own state: if the stand-in keeps that
 * state across `/deliveries/a` -> `/deliveries/b`, the page would too.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

vi.mock('../pages/DeliveryDetail', () => ({
  default: function FakeDeliveryDetail() {
    const [editing, setEditing] = useState(false);
    const navigate = useNavigate();
    return (
      <div>
        <span data-testid="mode">{editing ? 'editing' : 'viewing'}</span>
        <button onClick={() => setEditing(true)}>Edit</button>
        <button onClick={() => navigate('/deliveries/b')}>Next</button>
      </div>
    );
  },
}));

import DeliveryDetailRoute from './DeliveryDetailRoute';

describe('DeliveryDetailRoute', () => {
  it('drops an open edit when another delivery is opened', async () => {
    render(
      <MemoryRouter initialEntries={['/deliveries/a']}>
        <Routes>
          <Route path="/deliveries/:id" element={<DeliveryDetailRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByTestId('mode').textContent).toBe('editing');
    await act(async () => { fireEvent.click(screen.getByText('Next')); });
    expect(screen.getByTestId('mode').textContent).toBe('viewing');
  });

  it('is the element the page list routes deliveries/:id to', () => {
    const src = readFileSync('src/appPages.tsx', 'utf8');
    expect(src).toMatch(/\{ path: 'deliveries\/:id', element: <DeliveryDetailRoute \/> \}/);
  });
});
