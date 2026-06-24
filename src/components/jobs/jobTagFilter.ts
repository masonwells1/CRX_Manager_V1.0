/**
 * Field-app parity #4: pure tag-filter predicate, kept separate so it is unit-
 * testable and so the Full filter set (#6) can compose it with the other
 * AND-combined filters without duplicating the logic.
 *
 * Semantics: a job passes when it carries AT LEAST ONE of the selected tags
 * (multi-select OR within the tag filter). When no tags are selected the
 * filter is inert (everything passes), so it AND-combines cleanly with the
 * status / customer / date filters already on the list.
 */
export function jobMatchesTagFilter(
  jobTagIds: Iterable<string> | undefined,
  selectedTagIds: string[]
): boolean {
  if (selectedTagIds.length === 0) return true;
  if (!jobTagIds) return false;
  const set = jobTagIds instanceof Set ? jobTagIds : new Set(jobTagIds);
  return selectedTagIds.some((id) => set.has(id));
}
