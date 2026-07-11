/**
 * Presentation-safe helpers for saved loader worksheets. These stay separate
 * from loaderWorksheet.ts so the calculation engine remains purely about the
 * per-load math while list, completion, and condensed-display behavior can be
 * tested without rendering React.
 */
import type { LoaderLoad } from './loaderWorksheet';
import { LOAD_ACRES_TOLERANCE } from './loaderWorksheet';

export type LoaderWorksheetDisplayMode = 'individual' | 'condensed';

export interface CondensedLoaderLoadGroup {
  key: string;
  loads: LoaderLoad[];
  done: boolean;
}

/**
 * A condensed group still describes one tank mix. Its count/range tells the
 * loader how many identical tanks to make; it must never imply summed chemical
 * amounts.
 */
export function condensedLoaderLoadLabel(group: Pick<CondensedLoaderLoadGroup, 'loads'>): string {
  const firstLoad = group.loads[0]?.load_number;
  const lastLoad = group.loads[group.loads.length - 1]?.load_number;
  if (firstLoad == null || lastLoad == null) return 'Load';
  if (group.loads.length === 1) return `Load ${firstLoad}`;
  return `${group.loads.length} × Loads ${firstLoad}–${lastLoad}`;
}

/** Keep only completed-load indexes that exist in the current computed plan. */
export function validLoaderLoadDone(loadsDone: readonly number[], loadsCount: number): number[] {
  return [...new Set(loadsDone.filter((index) => Number.isInteger(index) && index >= 0 && index < loadsCount))]
    .sort((left, right) => left - right);
}

/** Toggle a zero-based completed-load index and keep the persisted array stable. */
export function toggleLoaderLoadDone(loadsDone: readonly number[], loadIndex: number, loadsCount: number): number[] {
  const current = new Set(validLoaderLoadDone(loadsDone, loadsCount));
  if (!Number.isInteger(loadIndex) || loadIndex < 0 || loadIndex >= loadsCount) {
    return [...current];
  }
  if (current.has(loadIndex)) {
    current.delete(loadIndex);
  } else {
    current.add(loadIndex);
  }
  return [...current].sort((a, b) => a - b);
}

/** PostgREST reports a concurrent selected-row collision with PostgreSQL 23505. */
export function isLoaderWorksheetSelectionConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: unknown }).code === '23505';
}

/** True when a draft can safely be persisted as a manual load-acres override. */
export function hasValidPerLoadAcres(
  acres: readonly number[],
  expectedLoads: number,
  totalAcres: number,
): boolean {
  if (acres.length !== expectedLoads || acres.some((value) => !Number.isFinite(value) || value < 0)) return false;
  const total = acres.reduce((sum, value) => sum + value, 0);
  return Math.abs(total - totalAcres) <= LOAD_ACRES_TOLERANCE + Number.EPSILON * Math.max(1, Math.abs(totalAcres));
}

function loadsMatch(left: LoaderLoad, right: LoaderLoad): boolean {
  if (Math.abs(left.volume - right.volume) >= 0.0005 || left.is_partial !== right.is_partial || left.products.length !== right.products.length) return false;
  return left.products.every((product, index) => {
    const other = right.products[index];
    return product.product_name === other?.product_name
      && Math.abs(product.amount - (other?.amount ?? Number.NaN)) < 0.0005
      && product.unit === other.unit;
  });
}

/**
 * Collapse adjacent identical loads for the condensed view. Completion state is
 * part of the grouping key so every rendered group has a truthful done mark.
 */
export function condenseLoaderLoads(loads: readonly LoaderLoad[], loadsDone: readonly number[]): CondensedLoaderLoadGroup[] {
  const done = new Set(validLoaderLoadDone(loadsDone, loads.length));
  const groups: CondensedLoaderLoadGroup[] = [];

  loads.forEach((load, index) => {
    const isDone = done.has(index);
    const previous = groups[groups.length - 1];
    if (previous && previous.done === isDone && loadsMatch(previous.loads[0], load)) {
      previous.loads.push(load);
      return;
    }
    groups.push({ key: `${load.load_number}-${isDone ? 'done' : 'open'}`, loads: [load], done: isDone });
  });

  return groups;
}
