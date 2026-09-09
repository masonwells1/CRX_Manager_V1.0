## 2026-09-08 — PR #605: the four content guards now see a MultiEdit

Codex (`gpt-5.6-sol`, high effort) reviewed `233dbf3c8` for the exact-SHA push proof and returned
BLOCKED with one High: `money-safety.mjs`, `rls-on-new-tables.mjs`, `generated-column-check.mjs` and
`env-guard.mjs` each read `tool_input.content || tool_input.new_string`, so a `MultiEdit` payload
(whose text lives in `edits[].new_string`) produced empty content and every one of them emitted
`allow`. This PR routes `MultiEdit` through those hooks and runs under `acceptEdits`, so an
auto-accepted MultiEdit could have landed float cents math, a table without RLS, a write to a
GENERATED column, or service_role material without the guard firing. Probe-confirmed before the fix:
identical payloads — Edit deny, MultiEdit allow — on all four.

### Fix, by class

- `edit-splice-lib.mjs` gains `judgedContent(filePath, toolInput)`: a Write's `content` is the
  post-edit file; an Edit or MultiEdit is spliced onto the on-disk file with the existing
  `applyEditsForAnalysis` (line-ending-safe), and when the file cannot be read the fragments —
  every `edits[i].new_string` — are judged instead. The `edits` array is never invisible.
- The four guards judge that text. Judging the full post-edit file also means a fragment edit that
  DELETES the `ENABLE ROW LEVEL SECURITY` line, or swaps an anon key for the service_role key, is
  seen for what it produces, and a file-level `-- rls-check: exempt` marker elsewhere in the file is
  visible to a fragment edit. `src/` holds no pre-existing match for any of the four patterns
  (checked), so full-file judging cannot deadlock an unrelated edit.
- Their fail-open charter is unchanged: no content at all still allows; only the shape of "content"
  changed.

### Proof

- `content-guards-multiedit.test.mjs` (wired into `test:correction-guards`): 23 assertions — per
  guard, Edit deny, MultiEdit deny (fragment form and spliced-onto-disk form, CRLF included), Write
  deny, clean MultiEdit allow, exempt-marker allow. Against the previous hooks it fails at
  `must deny (money-safety.mjs, MultiEdit): MultiEdit fragment, second edit`.
- `schema-registry-loud-failopen.test.mjs` copies `edit-splice-lib.mjs` into its isolated
  `generated-column-check` scaffold (as it already did for `status-enum-check`); 17 assertions pass.
  `test:correction-guards`, `test:agent-workflows`, `check:docs`, typecheck, lint, build pass.
