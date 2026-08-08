# Handoff: cloud permissions overhaul follow-ups (2026-08-08, PR #352 merged)

PR #352 shipped the cloud permissions overhaul: `.claude/settings.json` now uses
`defaultMode: "dontAsk"` with a broad allow list, production deploys/merges stay
on the ask list, destructive commands stay denied, and the deterministic guards
(`bash-safety-lib.mjs`, `live-testdata-lib.mjs`) were hardened through six rounds
of Codex + CodeRabbit review. This file lists what was deliberately left for a
follow-up session, in priority order. All items are ordinary reversible code
work except where noted.

## 1. Close the two round-6 guard findings (small, do first)

Codex's final review round posted after the merge; both findings are real and
un-fixed on `main`:

- **`preview_` prefix is still trusted as read-only.** `READONLY_FN_PREFIX_RE`
  in `.claude/hooks/live-testdata-lib.mjs` trusts `preview_`, but
  `preview_product_cost_basis_changes` performs durable inserts/updates
  (`supabase/migrations/20260722091359_supplier_pricing_workbook_v2_product_info.sql:426-443,575-586,815-940`).
  Codex's standing recommendation — adopted in principle when `check_` was
  dropped in 50f287a70 — is to stop trusting prefixes entirely and rely on the
  explicit `READONLY_FN_NAMES` allowlist (audited entries only). Removing all
  prefix trust ends this whack-a-mole class; the cost is that read-style RPCs
  (`get_*`, etc.) deny until individually allowlisted. Decide scope with Mason
  if the full removal feels too aggressive; at minimum drop `preview_`,
  `validate_`, and `verify_` (behavior-shaped names, unproven).
- **`git read-tree --reset -u HEAD` discards uncommitted work** and passes
  `bash-safety.mjs`. (The tree-ish argument is required — without `HEAD` the
  command errors out harmlessly — so the regression test must use the full
  spelling.) Add a `DANGEROUS_CMD_CHECKS` pattern (options tolerated anywhere,
  per the round-1 lesson); `git checkout-index -f -a` is the sibling plumbing
  spelling worth covering in the same pattern sweep.

Both have the same shape as the merged fixes — pattern + spot-check + entry in
`guards.test.mjs` (`node --test .claude/hooks/*.test.mjs`, 22 passing today).

## 2. Authoritative read-only function catalog (design follow-up)

The durable fix for item 1's class: extend `/regen-schema-registry` to record
function volatility/mutation data from the live DB (`pg_proc`, or a static scan
of migration bodies) into `.claude/schema-registry.json`, then have
`findNonReadFunctionCall()` consult that instead of name heuristics. Registry
regeneration already has a freshness-flag pipeline; this rides it.

## 3. Cloud-session tooling gaps found this session (guards misfiring)

- **`pr-merge-guard.mjs` fails closed in cloud containers** because it shells to
  the `gh` CLI, which isn't installed there. Result: a cloud session cannot
  self-merge *through the guard* when `gh` is unavailable, even for a fully green
  PR — this session had to fall back to Mason clicking merge / GitHub auto-merge,
  which is legitimate only because this diff is not risky. Fix: resolve PR head/base SHAs + checks via the
  GitHub MCP tools or REST when `gh` is absent, keeping fail-closed only when
  neither source resolves. Note the guard's Codex-proof requirement also depends
  on the Codex CLI, which is likewise absent in cloud — parking risky merges for
  Mason remains correct there.
- **`hold-latch-prompt.mjs` false positives.** It latched on the phrase
  "non stop" in Mason's own request and again on a Codex bot comment titled
  "Stop trusting…" arriving as webhook text. Note a word boundary does **not**
  fix the first case: `HOLD_RE` (`.claude/hooks/hold-latch-lib.mjs:10`) already
  matches `\bstop\b`, and "stop" is a whole word inside "non stop". The fix
  needs both (a) source awareness — only latch on real user prompts, not
  webhook-delivered bot content — and (b) imperative-sentence context (or an
  explicit "non stop"/"nonstop" exclusion) for the user-prompt case.
- **`codex-push-guard.mjs` false positives on commit-message text.** Twice this
  session it blocked ordinary commits because the message body contained words
  like "push"/"path" alongside punctuation. It should parse only the command
  segments that are actually git invocations, not `-m` string contents.
- **`bash-safety.mjs` self-matching**: the guard matches its own patterns when
  they appear inside test commands or commit messages (heredocs, `git commit -m`
  text). Same fix direction: exclude quoted `-m`/heredoc payloads from matching,
  or accept the annoyance (workaround used: write test files via the Write tool).

## 4. Standing items (not code)

- **The `/backup-db` dump is stale, not missing, and it is not off-site.**
  `/backup-db` has run: `backups/LATEST-OK.json` recorded
  `completed_at: 2026-07-21` over 150 tables / 7,887 rows
  (`docs/audits/gauntlet/2026-07-25-section-14-testing-prevention-refresh.md:42`).
  The "no backup exists yet" warning seen this session is the known
  linked-worktree false positive from LOW-14.3 — `session-staleness.mjs`
  resolves the marker under the current worktree. Note `/backup-db` writes a
  **local gitignored dump** (`.claude/commands/backup-db.md:35-48`); the
  encrypted GitHub Action in `docs/manual/CURRENT_STATE.md:129-130` is the
  separate off-site mechanism. Action: re-run `/backup-db` (the dump is weeks
  old) and fix the LOW-14.3 worktree resolution so the warning stops lying.
  Predates and is unrelated to PR #352.
- **CodeRabbit free-tier rate limits** blocked its incremental reviews for most
  of this PR's lifetime (its one full review was read and addressed; the
  execute_sql objection was formally withdrawn after verification). If PR
  volume stays this high, consider the label-based review opt-in its rate-limit
  notice suggests, or usage-based reviews.

## 5. Default-deny DML coverage (execute_sql's second hole)

`classifySql()` matches DML against a hand-maintained `BUSINESS_TABLES` list
(`.claude/hooks/live-testdata-lib.mjs:11-23`). Any table present in
`.claude/schema-registry.json` but absent from that list is unguarded —
`classifySql("UPDATE public.profiles SET role = 'admin' WHERE id = '…'")`
returns `{block: false}` today, which is a live privilege-escalation path.
Same whack-a-mole shape as item 1, same durable fix direction: classify
INSERT/UPDATE/DELETE against **any** table default-deny, with an explicit
allowlist of throwaway/test tables, rather than enumerating business tables.
Interim cheap fix: reconcile `BUSINESS_TABLES` against the schema registry and
add a test that fails when the registry contains a table the list doesn't.

`MERGE` must be part of this item, not just INSERT/UPDATE/DELETE: `classifySql()`
has no execute_sql `MERGE` branch at all (the existing `MERGE` rule serves only
`destructiveMigrationCheck()`), so
`MERGE INTO public.invoices … WHEN MATCHED THEN UPDATE SET total_cents = 1`
returns `{block: false}` today — verified — even against a table already in
`BUSINESS_TABLES`. Add `MERGE` coverage plus a regression test before treating
the guard as mutation-complete.

## 6. The two textual-marker bypasses (same contingency as items 1 and 5)

Both verified against current source this session; both survive items 1 and 5.

- **Smoke-abort marker is matched textually, not structurally.** `classifySql()`
  gates raw DDL/GRANT on `rolledBack`, and `smokeAbort`
  (`.claude/hooks/live-testdata-lib.mjs:359`) is a plain regex over the raw query
  for `raise exception 'SMOKE_PASS_ROLLBACK`. It does not require that match to be
  inside an actual `DO` block, so
  `ALTER TABLE public.profiles ADD COLUMN guard_bypass text; -- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'`
  returns `{block: false}` — real, committed DDL past the migration gauntlet on the
  strength of a comment. The 2026-07-05 fix (recorded in the comment at lines
  350-356) made the *transaction* case structural but left this one textual. Fix:
  require the marker to sit inside a `DO $$ … $$` body that actually raises, or
  parse the batch instead of regexing it.
- **`[E2E]` exempts the whole batch unconditionally.** The marker short-circuits
  ahead of the DML checks wherever it appears, so
  `UPDATE public.invoices SET total_cents = 1 WHERE id = '…' /* [E2E] */`
  returns `{block: false}` — verified against a table already in
  `BUSINESS_TABLES`, so this is independent of item 5's coverage hole. Fix: bind
  the exemption to demonstrably synthetic targets (an e2e-prefixed row/tenant
  predicate), and make it per-statement rather than per-batch so a mixed batch
  cannot smuggle a real mutation alongside a test one.

## Context that carries over

- The `execute_sql` auto-allow is **deliberate and settled** (CodeRabbit
  withdrew its objection, learning recorded): `live-testdata-guard` denies
  mutating SQL deterministically, with `REAL-DATA-OK` as the only override —
  **contingent on closing items 1, 5, and 6**. The settled part is the design
  (guard-enforced allow, not an ask entry), not a claim that the guard is
  currently gap-free. Don't re-litigate the design without new evidence.
- Guard changes are classified risky by `codex-push-lib.mjs` (`.claude/hooks/`
  path). That means items 1–3, 5, and 6 **cannot** land from a cloud session at all:
  a risky diff requires a fresh exact-SHA `gpt-5.6-sol` proof, the cloud
  container has no Codex CLI, and `pr-merge-guard.mjs:213-221` explicitly says
  to park rather than self-certify. Merging through the GitHub UI or auto-merge
  bypasses the local hook but **not** the policy — it is not an alternate
  landing path for these items. Do them in a local session that can mint the
  proof (this docs-only PR is not risky, which is why it can land from cloud).
