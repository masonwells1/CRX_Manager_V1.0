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
- **`git read-tree --reset -u` discards uncommitted work** and passes
  `bash-safety.mjs`. Add a `DANGEROUS_CMD_CHECKS` pattern (options tolerated
  anywhere, per the round-1 lesson); `git checkout-index -f -a` is the sibling
  plumbing spelling worth covering in the same pattern sweep.

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
  the `gh` CLI, which isn't installed there. Result: a cloud session can never
  merge, even a fully green PR (this session had to fall back to Mason clicking
  merge / GitHub auto-merge). Fix: resolve PR head/base SHAs + checks via the
  GitHub MCP tools or REST when `gh` is absent, keeping fail-closed only when
  neither source resolves. Note the guard's Codex-proof requirement also depends
  on the Codex CLI, which is likewise absent in cloud — parking risky merges for
  Mason remains correct there.
- **`hold-latch-prompt.mjs` false positives.** It latched on the phrase
  "non stop" in Mason's own request and again on a Codex bot comment titled
  "Stop trusting…" arriving as webhook text. Trigger needs word-boundary + 
  source awareness (only latch on real user prompts, not webhook-delivered bot
  content), or an explicit-phrase list ("stop", "pause", "hold on" as whole
  imperative sentences).
- **`codex-push-guard.mjs` false positives on commit-message text.** Twice this
  session it blocked ordinary commits because the message body contained words
  like "push"/"path" alongside punctuation. It should parse only the command
  segments that are actually git invocations, not `-m` string contents.
- **`bash-safety.mjs` self-matching**: the guard matches its own patterns when
  they appear inside test commands or commit messages (heredocs, `git commit -m`
  text). Same fix direction: exclude quoted `-m`/heredoc payloads from matching,
  or accept the annoyance (workaround used: write test files via the Write tool).

## 4. Standing items (not code)

- **No database backup exists.** Supabase Free tier has no point-in-time
  recovery; `/backup-db` has never been run. Mason says "back up the database"
  to create the first snapshot. This predates and is unrelated to PR #352 but
  the session-staleness hook flags it every session.
- **CodeRabbit free-tier rate limits** blocked its incremental reviews for most
  of this PR's lifetime (its one full review was read and addressed; the
  execute_sql objection was formally withdrawn after verification). If PR
  volume stays this high, consider the label-based review opt-in its rate-limit
  notice suggests, or usage-based reviews.

## Context that carries over

- The `execute_sql` auto-allow is **deliberate and settled** (CodeRabbit
  withdrew its objection, learning recorded): `live-testdata-guard` denies all
  mutating SQL deterministically; `REAL-DATA-OK` is the only override. Don't
  re-litigate without new evidence.
- Guard changes are classified risky by `codex-push-lib.mjs` (`.claude/hooks/`
  path), so landing items 1–3 from a cloud session means branch → PR → Vercel
  check → Mason merges (or auto-merge); a local session with the Codex CLI can
  use the normal proof path.
