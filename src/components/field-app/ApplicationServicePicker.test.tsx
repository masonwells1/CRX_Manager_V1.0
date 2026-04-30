/**
 * ApplicationServicePicker.test.tsx — Phase 1 (2026-04-29)
 *
 * Picker drives the per-acre fee leg of save_field_app_invoice. Tests pin:
 *   - Hydration from supabase('application_services').select(active=true).order(sort_order, name)
 *   - "No service fee" sentinel option (value='') maps to onChange(null)
 *   - Selecting a service emits its uuid
 *   - disabled prop disables the select element
 *
 * Supabase is mocked at the lib/db seam — tests verify the call shape, not
 * the network. Real-DB behavior is covered by E2E.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import ApplicationServicePicker from './ApplicationServicePicker';

const { mockFrom, mockOrderInner, mockSelect, mockEq, mockOrderOuter } = vi.hoisted(() => {
  const mockOrderInner = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockOrderOuter = vi.fn().mockReturnValue({ order: mockOrderInner });
  const mockEq = vi.fn().mockReturnValue({ order: mockOrderOuter });
  const mockSelect = vi.fn().mockReturnValue({ eq: mockEq });
  const mockFrom = vi.fn().mockReturnValue({ select: mockSelect });
  return { mockFrom, mockOrderInner, mockOrderOuter, mockEq, mockSelect };
});

vi.mock('../../lib/db', () => ({
  supabase: { from: mockFrom },
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

describe('ApplicationServicePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrderInner.mockResolvedValue({ data: [], error: null });
  });

  async function renderPicker(props: Partial<React.ComponentProps<typeof ApplicationServicePicker>> = {}) {
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(<ApplicationServicePicker value={null} onChange={vi.fn()} {...props} />);
    });
    return result;
  }

  it('queries application_services filtered by is_active=true and sorted by sort_order then name', async () => {
    await renderPicker();
    expect(mockFrom).toHaveBeenCalledWith('application_services');
    expect(mockSelect).toHaveBeenCalledWith('id, name, default_rate_per_acre_cents, is_active');
    expect(mockEq).toHaveBeenCalledWith('is_active', true);
    expect(mockOrderOuter).toHaveBeenCalledWith('sort_order');
    expect(mockOrderInner).toHaveBeenCalledWith('name');
  });

  it('shows "Loading services..." until the query resolves, then "No service fee"', async () => {
    let resolveQuery!: (v: { data: unknown; error: unknown }) => void;
    mockOrderInner.mockReturnValueOnce(new Promise((res) => { resolveQuery = res; }));

    let unmount: () => void;
    await act(async () => {
      const r = render(<ApplicationServicePicker value={null} onChange={vi.fn()} />);
      unmount = r.unmount;
    });
    expect(screen.getByRole('option', { name: /loading services/i })).toBeInTheDocument();

    await act(async () => {
      resolveQuery({ data: [], error: null });
    });
    expect(screen.getByRole('option', { name: /no service fee/i })).toBeInTheDocument();
    unmount!();
  });

  it('renders one option per active service with its name and per-acre default rate', async () => {
    mockOrderInner.mockResolvedValueOnce({
      data: [
        { id: 'svc-1', name: 'Hagie Y-Drop', default_rate_per_acre_cents: 1300, is_active: true },
        { id: 'svc-2', name: 'Airplane', default_rate_per_acre_cents: 1500, is_active: true },
      ],
      error: null,
    });
    await renderPicker();
    expect(screen.getByRole('option', { name: /Hagie Y-Drop \(\$13\.00\/ac default\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Airplane \(\$15\.00\/ac default\)/ })).toBeInTheDocument();
  });

  it('emits onChange(null) when the empty "No service fee" sentinel is picked', async () => {
    mockOrderInner.mockResolvedValueOnce({
      data: [{ id: 'svc-1', name: 'Hagie Y-Drop', default_rate_per_acre_cents: 1300, is_active: true }],
      error: null,
    });
    const onChange = vi.fn();
    await renderPicker({ value: 'svc-1', onChange });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('emits onChange(uuid) when a service is selected', async () => {
    mockOrderInner.mockResolvedValueOnce({
      data: [{ id: 'svc-1', name: 'Hagie Y-Drop', default_rate_per_acre_cents: 1300, is_active: true }],
      error: null,
    });
    const onChange = vi.fn();
    await renderPicker({ value: null, onChange });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'svc-1' } });
    expect(onChange).toHaveBeenCalledWith('svc-1');
  });

  it('disables the select when disabled=true', async () => {
    await renderPicker({ disabled: true });
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('falls back to an empty list (no crash) when the query errors', async () => {
    mockOrderInner.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await renderPicker();
    expect(screen.getByRole('option', { name: /no service fee/i })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});
