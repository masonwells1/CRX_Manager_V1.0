import { describe, it, expect } from 'vitest';
import { moveItem, moveUp, moveDown } from './routeOrder';

describe('routeOrder.moveItem', () => {
  it('moves an item forward to a later position', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item backward to an earlier position', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves an item to the very end', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('moves an item to the very front', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('returns an unchanged copy when from === to', () => {
    const input = ['a', 'b', 'c'];
    const out = moveItem(input, 1, 1);
    expect(out).toEqual(['a', 'b', 'c']);
    expect(out).not.toBe(input); // new array, never mutate the input
  });

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c', 'd'];
    moveItem(input, 0, 3);
    expect(input).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clamps an out-of-range source index into the array', () => {
    // from past the end is treated as the last item
    expect(moveItem(['a', 'b', 'c'], 99, 0)).toEqual(['c', 'a', 'b']);
  });

  it('clamps an out-of-range destination index into the array', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
  });

  it('handles a single-item list as a no-op copy', () => {
    const input = ['only'];
    const out = moveItem(input, 0, 0);
    expect(out).toEqual(['only']);
    expect(out).not.toBe(input);
  });

  it('handles an empty list as a no-op copy', () => {
    expect(moveItem([], 0, 1)).toEqual([]);
  });

  it('preserves object references when reordering (no clobbering of row data)', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = moveItem(rows, 2, 0);
    expect(out.map((r) => r.id)).toEqual([3, 1, 2]);
    expect(out[0]).toBe(rows[2]); // same object instance, just reordered
  });
});

describe('routeOrder.moveUp', () => {
  it('moves an item one slot earlier', () => {
    expect(moveUp(['a', 'b', 'c'], 2)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op copy at the top of the list', () => {
    const input = ['a', 'b', 'c'];
    expect(moveUp(input, 0)).toEqual(['a', 'b', 'c']);
  });
});

describe('routeOrder.moveDown', () => {
  it('moves an item one slot later', () => {
    expect(moveDown(['a', 'b', 'c'], 0)).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op copy at the bottom of the list', () => {
    expect(moveDown(['a', 'b', 'c'], 2)).toEqual(['a', 'b', 'c']);
  });
});

describe('routeOrder — simulating the save renumbering (sort_order = array index)', () => {
  it('a drag-then-save renumbers sort_order to the new 0..n sequence', () => {
    // Mirror JobDetail: rows carry a stale sort_order; on save we map to index.
    type Row = { field_id: string; sort_order: number };
    const rows: Row[] = [
      { field_id: 'north', sort_order: 0 },
      { field_id: 'south', sort_order: 1 },
      { field_id: 'east', sort_order: 2 },
    ];
    // Drag "east" to the front.
    const reordered = moveItem(rows, 2, 0);
    const payload = reordered.map((f, i) => ({ field_id: f.field_id, sort_order: i }));
    expect(payload).toEqual([
      { field_id: 'east', sort_order: 0 },
      { field_id: 'north', sort_order: 1 },
      { field_id: 'south', sort_order: 2 },
    ]);
  });
});
