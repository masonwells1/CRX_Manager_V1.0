## 2026-09-08 — PR #605: Codex BLOCKED on `fdce1aa53` — canonical protected-surface match; env-guard scans the raw content

Codex (`gpt-5.6-sol`, exact-SHA push proof on `fdce1aa53`) returned two Highs, both probe-confirmed:

1. **Protected enforcement files editable through non-canonical paths.** `protectedSurfacePath()` folded
   backslashes but resolved neither `..` nor repeated separators, so armed autopilot auto-approved
   `.claude/worktrees/../hooks/review-proof-guard.mjs` (review-proof-guard exempts native editors by
   design, so nothing else stood in the way). Fixed: the surface and the `.env` rule are judged on the
   raw spelling AND the canonical path (`canonicalToolPath()`), and a path that still escapes the tree
   after normalisation is never auto-approved while armed. Seven new armed cases, and
   `protected-surface-parity.test.mjs` now checks a `./` prefix, a `zz/../` traversal, a doubled
   separator and Windows separators for every protected sample; the previous lib fails at
   `PROVEN BYPASS: a traversal into .claude/hooks is judged on the canonical path`.
2. **JSX text defeated the comment stripper.** `const banner = <div>/*</div>;` opened a block comment
   that never closed, and the key lookup after it vanished before the scan; a nested template literal
   (`${`/*`}`) does the same. This was the third valid input to defeat comment stripping in one
   day, so the stripper is removed: the `SUPABASE_SERVICE_ROLE_KEY` and `'service_role'` scans judge
   the raw content, comments included, and the refusal message says to reword a comment that merely
   names the key (`src/` carries no such comment). Eight former allow cases flip to deny by design;
   three new deny cases; the previous hook, swapped in place, fails first at the flipped comment case,
   and probed directly with the JSX payload it answered `allow` where the new hook answers `deny`. The two earlier CodeRabbit threads about regex handling inside the stripper are
   moot by removal.
