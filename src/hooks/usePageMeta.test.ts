import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock useLocation before importing the hook
const mockPathname = { pathname: '/' };

vi.mock('react-router-dom', () => ({
  useLocation: () => mockPathname,
}));

// Import after mock setup
import { usePageMeta } from './usePageMeta';

describe('usePageMeta', () => {
  it('returns Operational Dashboard meta for / path', () => {
    mockPathname.pathname = '/';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Operational', accent: 'Dashboard' });
  });

  it('returns Product meta for /products path', () => {
    mockPathname.pathname = '/products';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Product', accent: 'Master' });
  });

  it('returns Customer meta for /customers path', () => {
    mockPathname.pathname = '/customers';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Customer', accent: 'Database' });
  });

  it('returns Quote meta for /quotes path', () => {
    mockPathname.pathname = '/quotes';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Quote', accent: 'Builder' });
  });

  it('returns Order meta for /orders path', () => {
    mockPathname.pathname = '/orders';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Order', accent: 'Management' });
  });

  it('returns Team meta for /team-board path', () => {
    mockPathname.pathname = '/team-board';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Team', accent: 'Board' });
  });

  it('returns Reports meta for /reports path', () => {
    mockPathname.pathname = '/reports';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Reports', accent: 'Dashboard' });
  });

  it('extracts base path from nested routes like /products/123', () => {
    mockPathname.pathname = '/products/123';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Product', accent: 'Master' });
  });

  it('extracts base path from deeply nested routes like /orders/456/details', () => {
    mockPathname.pathname = '/orders/456/details';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Order', accent: 'Management' });
  });

  it('returns default fallback for unknown paths', () => {
    mockPathname.pathname = '/unknown-page';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Crop RX', accent: 'Solutions' });
  });

  it('returns Settings meta for /settings path', () => {
    mockPathname.pathname = '/settings';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'App', accent: 'Settings' });
  });

  it('returns Notifications meta with empty accent', () => {
    mockPathname.pathname = '/notifications';
    const { result } = renderHook(() => usePageMeta());
    expect(result.current).toEqual({ title: 'Notifications', accent: '' });
  });
});
