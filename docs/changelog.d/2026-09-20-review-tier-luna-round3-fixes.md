## 2026-09-20 — round 3 hardening of the Luna advisory review, and the residuals deliberately left open

Continues `2026-09-20-review-tier-luna-round2-fixes.md`. Round 3 returned `LUNA_REVIEW: FINDINGS 11`
and **echoed the canary**, so this is the first round where the harness itself proved the reviewer
received the diff. Eight findings were fixed; three were judged not worth the change and are
recorded below rather than silently dropped.

### Fixed

- **The header canary was insufficient** (HIGH). Echoing a token from the *header* shows the message
  arrived; it does not show the reviewer read the patch. A second canary now sits **after** the
  diff, and the validation requires the trailing one, so a reviewer that answered from the
  instructions alone fails the check.
- **The post-run checks only printed warnings** (HIGH). They now **fail closed** — each exits
  non-zero — because a warning in a transcript is something a later step reads past. The set also
  now requires a `LUNA_REVIEW:` terminator, catching a truncated run.
- **Git could execute an arbitrary helper before the sandbox existed** (HIGH). Diff generation runs
  *outside* Codex's read-only sandbox, and a repo-level or global `diff.external` / textconv filter
  would have run as part of building the payload. All git invocations now pass `--no-ext-diff`
  with `-c diff.external=` and `-c core.pager=cat`.
- **`--uncommitted` could silently yield a partial diff** (MED). `set -e` now aborts extraction on
  a failing `git diff HEAD`, instead of proceeding with untracked files only and a non-empty file
  that passes the emptiness check.
- **"Clean" still meant two different things** (MED) — round 2 fixed the skill but left `ship.md`
  and `AGENTS.md` saying "after Luna is clean". All three now say the bar is **no BLOCKER or HIGH**,
  with deferred MED/LOW explicitly not blocking the Sol pass.
- **The early-Sol escape hatch read as a contradiction** (MED) of "exactly one Sol / Sol runs last".
  Clarified: an early Sol round is on the *advisory* path and mints nothing, so a risky change that
  uses it needs a second Sol pass at Step 3B — roughly double the Sol spend, which is the reason to
  use it sparingly.
- **`review-workflow` never stated the Step 3B requirement** (HIGH). It now says a Luna-validated
  risky finding must never be reported to Mason as "reviewed and ready".
- **`--sol` could escalate spend silently** (LOW). `overnight-codex-gate.mjs` now **refuses `--sol`
  without `--reason "<why>"`** and logs the reason to the trace. Enforcing it at the moment of
  escalation is the only reliable capture point; a rule that says "write the reason in the report
  afterwards" is unauditable in an unattended loop.

### Deliberately NOT fixed — recorded so the next round does not re-raise them

- **"The diff itself is attacker-controlled text that could instruct the reviewer"** (raised as
  HIGH, twice). True, and not removable: reviewing a change requires showing the reviewer the
  change. The mitigations that exist — commit message stripped, diff fenced under an explicit
  header, reviewer sandboxed read-only with no connectors — are in place. Treat this as inherent to
  code review, not as an open defect.
- **`overnight-codex-gate.mjs` still runs with `-C repoRoot` and has no canary** (HIGH). Real, and
  **pre-existing** — not introduced by the Luna default. Changing the cwd of the wrapper that
  unattended loops depend on is a behaviour change with its own blast radius, and it belongs in its
  own reviewed change rather than riding along here. Owner: that wrapper. See the precise scoping
  note in `.claude/skills/codex-review/SKILL.md` for why it has not recursed in practice.
- **The `fix-glance` name still says "gate"** (LOW). The name is historical and used in existing
  ledgers and reports; renaming it would break continuity for a naming nit. The surrounding text now
  states plainly that it mints no proof and authorizes a debug-branch commit only.

**Stopping here.** Round 3's findings were materially weaker than rounds 1 and 2 — several re-raised
items already answered or consciously accepted — which is the signal that the loop has converged.
Three Luna rounds cost ~330K Codex tokens total, versus the single Sol round this replaced.

**Proof:** `overnight-codex-gate.mjs` executed after each change. `--sol` without `--reason` exits
**2** and refuses; `--sol --reason "…"` runs and the trace records
`tier: gpt-5.6-sol / high (--sol; reason: …)`; the default run records
`tier: gpt-5.6-luna / xhigh (default)`, with the verdict on stdout and the tier on stderr so the two
never mix. Adapter sync, `test:agent-workflows` and `check-doc-drift` green. The guard files and
`write-codex-push-proof.mjs` remain byte-identical to `main`.
