/** A saved field boundary cannot be cleared through the single-section map action. */
export function canRemoveSingleBoundary(hasSavedBoundary: boolean): boolean {
  return !hasSavedBoundary;
}

/** Reloading persisted features while this mode is active would discard its in-progress sketch. */
export function shouldSyncInitialDrawFeatures(mode: string | null | undefined): boolean {
  return mode !== 'draw_polygon';
}
