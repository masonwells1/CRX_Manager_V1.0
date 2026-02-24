import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRowSelection } from './useRowSelection';

interface TestRow {
  id: string;
  name: string;
  status: string;
}

const mockData: TestRow[] = [
  { id: '1', name: 'Alpha', status: 'active' },
  { id: '2', name: 'Beta', status: 'active' },
  { id: '3', name: 'Gamma', status: 'inactive' },
  { id: '4', name: 'Delta', status: 'active' },
];

const getId = (row: TestRow) => row.id;

describe('useRowSelection', () => {
  it('starts with empty selection', () => {
    const { result } = renderHook(() =>
      useRowSelection({ data: mockData, getId })
    );
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.selected.size).toBe(0);
    expect(result.current.selectedRows).toHaveLength(0);
    expect(result.current.allSelected).toBe(false);
  });

  it('toggleSelect adds and removes a single ID', () => {
    const { result } = renderHook(() =>
      useRowSelection({ data: mockData, getId })
    );

    act(() => result.current.toggleSelect('1'));
    expect(result.current.selected.has('1')).toBe(true);
    expect(result.current.selectedCount).toBe(1);

    act(() => result.current.toggleSelect('1'));
    expect(result.current.selected.has('1')).toBe(false);
    expect(result.current.selectedCount).toBe(0);
  });

  it('toggleAll selects all rows when none selected', () => {
    const { result } = renderHook(() =>
      useRowSelection({ data: mockData, getId })
    );

    act(() => result.current.toggleAll());
    expect(result.current.selectedCount).toBe(4);
    expect(result.current.allSelected).toBe(true);
  });

  it('toggleAll deselects all when all selected', () => {
    const { result } = renderHook(() =>
      useRowSelection({ data: mockData, getId })
    );

    act(() => result.current.toggleAll());
    expect(result.current.selectedCount).toBe(4);

    act(() => result.current.toggleAll());
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.allSelected).toBe(false);
  });

  it('toggleAll respects isSelectable filter', () => {
    const { result } = renderHook(() =>
      useRowSelection({
        data: mockData,
        getId,
        isSelectable: (row) => row.status === 'active',
      })
    );

    act(() => result.current.toggleAll());
    // Only 3 active rows should be selected (ids 1, 2, 4)
    expect(result.current.selectedCount).toBe(3);
    expect(result.current.selected.has('3')).toBe(false);
    expect(result.current.allSelected).toBe(true);
  });

  it('clearSelection empties the set', () => {
    const { result } = renderHook(() =>
      useRowSelection({ data: mockData, getId })
    );

    act(() => result.current.toggleSelect('1'));
    act(() => result.current.toggleSelect('2'));
    expect(result.current.selectedCount).toBe(2);

    act(() => result.current.clearSelection());
    expect(result.current.selectedCount).toBe(0);
  });

  it('selectedRows returns matching data objects', () => {
    const { result } = renderHook(() =>
      useRowSelection({ data: mockData, getId })
    );

    act(() => result.current.toggleSelect('2'));
    act(() => result.current.toggleSelect('4'));
    expect(result.current.selectedRows).toEqual([
      { id: '2', name: 'Beta', status: 'active' },
      { id: '4', name: 'Delta', status: 'active' },
    ]);
  });

  it('preserves selection across data reference changes when IDs still exist', () => {
    const { result, rerender } = renderHook(
      ({ data }) => useRowSelection({ data, getId }),
      { initialProps: { data: mockData } }
    );

    act(() => result.current.toggleSelect('1'));
    expect(result.current.selectedCount).toBe(1);

    // Simulate refetch — new array reference but same IDs
    const newData = [...mockData];
    rerender({ data: newData });
    // Selection should persist (id '1' still exists in new data)
    expect(result.current.selectedCount).toBe(1);
    expect(result.current.selected.has('1')).toBe(true);
  });

  it('prunes selectedCount when selected IDs no longer in data', () => {
    const { result, rerender } = renderHook(
      ({ data }) => useRowSelection({ data, getId }),
      { initialProps: { data: mockData } }
    );

    act(() => {
      result.current.toggleSelect('1');
      result.current.toggleSelect('3');
    });
    expect(result.current.selectedCount).toBe(2);

    // Simulate filter change — remove id '3' from visible data
    const filteredData = mockData.filter((r) => r.status === 'active');
    rerender({ data: filteredData });

    // selectedCount reflects only rows still visible (id '1' is active, '3' is not)
    expect(result.current.selectedCount).toBe(1);
    expect(result.current.selectedRows).toHaveLength(1);
    expect(result.current.selectedRows[0].id).toBe('1');
    // Raw Set still has '3' but it's effectively invisible
    expect(result.current.selected.has('3')).toBe(true);
  });

  it('allSelected is false when data is empty', () => {
    const { result } = renderHook(() =>
      useRowSelection({ data: [] as TestRow[], getId })
    );
    expect(result.current.allSelected).toBe(false);
  });

  it('handles multiple rapid toggles correctly', () => {
    const { result } = renderHook(() =>
      useRowSelection({ data: mockData, getId })
    );

    act(() => {
      result.current.toggleSelect('1');
      result.current.toggleSelect('2');
      result.current.toggleSelect('3');
    });
    expect(result.current.selectedCount).toBe(3);

    act(() => {
      result.current.toggleSelect('2');
    });
    expect(result.current.selectedCount).toBe(2);
    expect(result.current.selected.has('2')).toBe(false);
  });
});
