## 2026-09-06 — one test replaces twelve rounds of protected-path arguments (PR #605)

Twelve review rounds on PR #605 all had the same shape: a path named in one of the three by-name
lists and missing from another. This lands the coverage test that makes that disagreement a CI
failure, and decides every remaining `.claude/` and `.codex/` entry on traced evidence.

### The test

`.claude/hooks/protected-surface-parity.test.mjs`, wired into `npm run test:agent-workflows`
(`package.json`), so `.github/workflows/ci.yml:468` and `.husky/pre-commit` both run it. It asserts:

- every `permissions.ask` pattern in `.claude/settings.json` names all four native editors
  (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`) — the guard exempts all four, so an unnamed one is
  auto-approved under `acceptEdits`;
- every tracked path the `ask` tier protects is also shell-denied and path-field-denied by
  `review-proof-guard.mjs`, and present in `codex-push-lib.mjs`'s `RISKY_PATH_RES`, and vice versa;
- the real hook actually denies a write and stays silent on a read, probed per pattern;
- every tracked top-level entry under `.claude/` and `.codex/` is either protected or recorded in
  `OPEN_BY_DECISION` with a written reason.

It does NOT refactor the three lists into one constant: settings is JSON a permission resolver
reads, the hook regex judges command text, and the risky set judges diff paths. Three consumers,
three shapes; agreement is the invariant, not a shared literal.

Proof it is load-bearing, run at this head against three checkouts:

| checkout | result |
| --- | --- |
| `main` (`d47b364fa`) | exit 1, 56 divergences |
| PR head before this commit (`45d80321e`) | exit 1, 13 divergences |
| this tree | exit 0 |

### What the test forced us to decide, and why

`OPEN_BY_DECISION` is now empty: every tracked entry is protected. Each was traced to what reads or
executes it.

- **`.claude/schema-registry.json`** — parsed at runtime by four registered PreToolUse hooks
  (`generated-column-check.mjs:46`, `session-staleness.mjs:110`, `sql-safety.mjs:137`,
  `status-enum-check.mjs:95`), by CI checks `check-doc-drift.mjs:25` and
  `check-migration-hard-rules.mjs:72`, and copied into the migration review packet by
  `write-apply-proofs-lib.mjs:77`. `sql-safety.mjs` wraps its read in a fail-open `catch`: doctor the
  file and four hooks believe a false schema; corrupt it and at least one stops guarding silently.
- **`.claude/caller-graph.json`** — `grant-change-guard.mjs:218` reads it for caller analysis on
  REVOKE migrations. Missing or unreadable plus a risky REVOKE denies (fails closed); a graph older
  than seven days only warns. So the guard trusts the CONTENT, and a freshness gate catches stale,
  never wrong.
- **`.claude/commands/**`, `.claude/skills/**`, `.claude/workflows/**`** — all three reach CI.
  `package.json:57` (`test:agent-workflows`) runs `.claude/workflows/gauntlet-sections-loop.test.mjs`,
  `.claude/workflows/truthful-review-states.test.mjs` and `scripts/check-agent-workflows.mjs`, which
  reads six `.claude/commands/*.md` files by name; `.github/workflows/ci.yml:468` and
  `.husky/pre-commit:43` execute it; `scripts/check-agent-guidance.mjs:39,45,157` reads
  `commands/preflight.md`, `commands/ship.md` and `skills/graphify/SKILL.md`. Weaken one of those
  tests and the CI row still turns green — the gate does not fail, it lies. The equivalent test
  files under `.claude/hooks/`, run by the same npm script, were already protected; same role, same
  command, different protection. That asymmetry is what makes this an omission rather than a
  decision. Protected by directory shape, not by the file that got caught: a carve-out for
  `*.test.mjs` would leave the next file added there outside it.
- **`.codex/**`** — matched by shape, the way `.husky` always was. `config.toml`, `hooks/` and
  `hooks.json` were already covered; `sync-from-claude.ps1` was the last entry and is genuinely NOT
  reachable from CI, husky, or any registered hook (`agent-health-check.mjs:64` only asserts that
  `.codex/hooks.json` does not reference it). It is protected because one pattern removes a whole
  directory from the problem, and because everything it writes lands in `.codex/hooks/**`, which is
  protected and risky-path reviewed.
- **`scripts/agent-manifest-parity.mjs`, `scripts/sync-agent-workflows.mjs`, `package.json`** — the
  reverse divergence: already shell-denied by `review-proof-guard.mjs` but with no `ask` entry, so a
  native editor rewrote them silently under `acceptEdits`.

**Caveat, labelled honestly:** the reachability trace matched path STRINGS in `package.json` scripts
walked from `.github/workflows/*.yml` and `.husky/*`, plus hooks registered in `.claude/settings.json`
and `.codex/hooks.json`. A script that assembles one of these paths dynamically would have been
missed. None was seen in the grep set — a negative grep, not a proof.

### Cost, stated plainly

- Editing a slash-command, skill, or workflow file now prompts on a native edit, and its diff needs
  the exact-SHA review before merge. That is the same bar `.claude/hooks/` already carried.
- `.codex/sync-from-claude.ps1` can no longer be RUN from the Bash tool: `.codex` is now an
  enforcement surface and `pwsh` is not a read-only head. Its outputs are protected either way.
- Reads are untouched everywhere: `cat`, `grep`, `ls`, `jq`, `git show`, and the `Read` tool all stay
  silent on every one of these paths.

### Also in this commit

- `NotebookEdit` joins the `Write|Edit|MultiEdit` matcher on the nine content-inspecting PreToolUse
  hooks in `.claude/settings.json`. Honest scope: those hooks read `tool_input.file_path`/`content`/
  `new_string`, and `NotebookEdit` sends `notebook_path`/`new_source`, so they still fail open on its
  payload. The matcher is correct now and the payload gap is recorded rather than hidden; it is
  narrow because `NotebookEdit` can only write `.ipynb` files.
- `.codex/hooks/**`, `.codex/hooks.json` and `.codex/config.toml` collapse into `.codex/**` in the
  settings `ask` tier and into `/(^|\/)\.codex\//i` in `RISKY_PATH_RES` — a strict superset of what
  they matched, with the individual paths still pinned by test.

### Verification

- `node .claude/hooks/protected-surface-parity.test.mjs` → ok: 25 patterns × 4 editors = 100 ask
  entries; 3212 tracked paths agree; 14 top-level `.claude`/`.codex` entries decided, 0 open.
- `review-proof-guard.test.mjs`, `codex-push-lib.test.mjs`, `mcp-tool-guard.test.mjs`,
  `hook-router.test.mjs`, `migration-apply-guard.test.mjs`, `agent-manifest-parity.mjs`,
  `check-ledger-update.test.mjs` all pass; `npm run test:agent-workflows` and `npm run check:docs`
  pass.
