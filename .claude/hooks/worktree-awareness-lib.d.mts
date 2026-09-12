/** Typed access to the canonical pure history parser from repository contract tests. */
export function localCandidateMigrationPathsFromHistory(historyText: string): {
  state: 'known' | 'unknown';
  paths: Set<string>;
  sha256ByPath?: Map<string, string>;
  reason: string;
};
