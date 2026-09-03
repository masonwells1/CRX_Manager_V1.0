## 2026-09-02 - Stop the Codex CLI's imported adapters from blocking every commit

**Class:** toolchain deadlock. **Outcome:** the workflow-parity check now quarantines foreign
importer directories instead of failing on them; commits in `C:/CRX_Manager` are unblocked.

## What was broken

The Codex CLI's "Import from other apps" (`/import`) writes its own adapters into
`.agents/skills/` as `source-command-<name>/SKILL.md`. Twenty-four of them landed in
`C:/CRX_Manager` on 2026-09-02 at 01:38:50 (one burst, ~13ms apart). They are not ours and never
can be: the importer rewrites the instruction text with a case-insensitive `claude` -> `Codex`
substitution, so thirteen of them point at a `.Codex/hooks/` path that does not exist, and one
sentence in the imported `/ship` copy collapses `CLAUDE.md` and `AGENTS.md` into the same name.

`sync-agent-workflows.mjs --check` reported all 24 as `is not generated from .claude` and exited 1.
That check runs in the pre-commit workflow-parity gate, so **every commit in the main checkout was
blocked** while the directories were present. `.gitignore` could not help — the check walks the
filesystem with `readdirSync`, not the git index — and the Codex binary has no off-switch, so they
come back after any future import.

## What changed

`scripts/sync-agent-workflows.mjs`

- New exported `classifyExtras()` splits the not-in-`expected` sweep into real drift and foreign
  importer directories. The verdict is computed from drift alone.
- Classification is by **region, not enumeration**: `^skills\/(source-command-[^/]+)\//`, applied
  only to paths the generator does not itself emit. A path the generator DOES emit stays in
  `expected` and is still held to the missing/stale checks, so this cannot silently drop a real
  adapter — even one named `source-command-*`.
- Foreign directories are **reported, not muted** (Mason's 2026-09-02 decision: keep them visible,
  do not delete them). The report is printed to stdout ahead of the verdict, because
  `check-agent-workflows.mjs` surfaces only the first stdout line as its note — which is what keeps
  the litter visible through `npm run agent-health` as well. Its `/^PASS - \d+ .../m` matcher still
  finds the verdict line below.

## Verification

Ran, not inferred. All against the real generator in a worktree seeded with the actual 24
directories copied from `C:/CRX_Manager`:

| Check | Result |
|---|---|
| `--check` before the fix, one importer directory present | `FAIL skills/source-command-ship/SKILL.md is not generated from .claude`, exit 1 — the live blocker reproduced |
| `--check` after the fix, all **24** real directories present | warning naming all 24, then `PASS - 37 Codex workflow file(s) match .claude sources.` |
| `node scripts/check-agent-workflows.mjs` | `PASS Codex workflow adapters are synced - WARNING: ignoring 24 foreign …` — visible through the wrapper |
| Stray `skills/NOT-OURS.md` alongside an importer directory | still `FAIL … is not generated from .claude`, exit 1 — the exemption did not widen |
| `node scripts/sync-agent-workflows.test.mjs` | passes |

Each new assertion was mutation-proved load-bearing:

| Mutation | Check that went red |
|---|---|
| `[^/]+` -> `[^/]*` (allow a bare `source-command-` directory) | "near-miss shapes stay checked" |
| Drop the trailing `/` (match a file, not a directory) | "near-miss shapes stay checked" |
| Remove the classification entirely | "importer directories must not count as drift" |

## Not fixed here

The importer still runs and still writes the directories; there is no configuration key to disable
it. They are inert — nothing in this repo invokes them — but the mangled text remains a hazard if a
human or agent ever reads one as instructions. Tracked in
`docs/manual/KNOWN_ISSUES.md`.
