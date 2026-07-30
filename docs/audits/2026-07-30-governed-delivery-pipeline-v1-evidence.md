# Governed Delivery Pipeline V1 — Pre-Commit Evidence

Date: 2026-07-30
Branch: `claude/autonomous-factory-review-275248`
Base at start: `aee913df43ca1321ce1060fdb8f3dc2a89bbc790`
Current `origin/main`: `db9b5efc7a3c5ef0d9e9b1171ad8f5d0863c2544`
State: rebased onto current `origin/main`; publication-blocker repairs are uncommitted and unpushed

## Owner-facing result

The pilot adds exactly two owner surfaces:

1. ordinary Claude or Codex chat for job description, ticket approval, morning accept/reject, pause, resume, and revisions;
2. one loopback-only, read-only Factory Board for status, behavior summary, blocker, and attached proof.

There is no owner command, ticket editor, form, or second factory application. The existing `/ship`
pipeline remains the delivery engine and all of its landing and production gates remain in force.

## Hard controls proven

- One absolute Git-common-dir state path is shared across worktrees and tools.
- Tickets are immutable, canonically serialized, and content-hashed.
- Events are append-only, schema-checked, duplicate-checked, and hash-chained under an exclusive lock.
- One torn final JSONL line is visible as degraded but cannot advance a job; interior corruption fails closed.
- Exact ticket approval requires the immediately preceding assistant transcript message to match the stored
  question, plus the same session, ticket hash, fresh `origin/main`, and a receipt no older than 24 hours.
- Qualified yes, side-question yes, missing transcript, cross-session reply, machine prompt, moved base,
  changed ticket, global hold, and second active lane do not start work.
- State writes are restricted to canonical process/call-stack entrypoints; direct paths, state-library
  imports, inline-code bypasses, and governance self-edits in an active lane are denied. This is
  defense-in-depth inside the agent tool boundary, not a claim of operating-system cryptographic isolation.
- Legal stage transitions and evidence writes are bound to the lane-start session. A successful
  CLI-executed repository harness is required before morning review. Its name is bound into the
  immutable ticket and fixed allowlist; its resolved script body must equal `origin/main`, and the
  command/body/package/base/output hashes plus the full tracked/non-ignored repository content
  fingerprint are rechecked. Source or test edits after the harness invalidate it. Copied or
  self-labeled files do not qualify.
- While one lane is active, native edits, MCP filesystem tools, shell writes/redirection, Git
  mutations, and unknown repository scripts from other or fresh chats are denied.
- A stale lock can be removed only after five minutes when its process is gone, with a backup retained.
  A torn final line has a backup-first repair path, and a failed ledger pause creates an emergency hold
  that still blocks lane writes.
- Morning chat acceptance produces only `approved-to-land`, never `live`.
- Live closeout requires an accepted job, a landing commit contained in `origin/main`, production-verification
  text, proof still bound to the job's immutable original base, and a new durable content-hashed packet
  under `docs/audits/factory/jobs/`. The successful closeout path is exercised end-to-end.
- A chat can clear its recorded factory intent and return to the normal guarded workflow without
  starting a lane or abandoning the chat.
- Only a real owner chat prompt can resume a global or emergency hold. The agent CLI has no
  hold/resume command, and direct agent invocation of the owner-input hook is denied.
- “Run the factory overnight” records governed intent without needing an additional build/ship verb;
  explanatory factory questions do not.
- Board process wording never changes the global hold, and the Board API omits owner/lane session IDs
  plus internal ticket/base fields.
- Closeout is idempotent across a packet-written/ledger-failed interruption, an already-live retry
  returns the verified existing packet, and conflicting retry proof is refused.
- A governed lane cannot edit any trusted writer hook, imported hook library, hook manifest, Codex
  adapter, factory implementation, or npm harness definition. This includes the local Claude settings
  manifest that can disable all hooks, plus in-place and opaque Git shell mutation routes.
- Corrupt state blocks repository mutations but leaves reads and the canonical status/recovery route
  available for diagnosis; unsupported interior repair remains parked for an owner decision.
- Pre-ticket intent clearing exists only in owner chat, and only explicit resume/restart language lifts
  a hold.
- Natural unqualified “yes, ship it” binds to the exact presented decision, while decision-like replies
  that are still ambiguous fail closed with a plain-English explanation.
- Every mutating factory CLI invocation consumes a short-lived, single-use permit minted from the real
  PreToolUse session. Direct CLI execution, forged `--session`/`--tool`, direct hook invocation, and
  permit read/set/forward routes fail closed. Status JSON exposes no session or ticket identity.

## Automated proof

| Check | Result |
|---|---|
| `npm run test:factory` | PASS — 5 files, 170 focused assertions after publication-blocker remediation |
| `npm run test:agent-workflows` | PASS — factory tests plus shared hook/workflow/parity checks |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS — 4,235 modules transformed |
| `npm run test` | PASS — 305 files; 4,011 passed, 118 skipped |
| `npm run check-doc-drift` | PASS — all 38 wired hooks documented |
| `node scripts/verify-deps.mjs` | PASS — lockfile unchanged; installed versions match |
| `node scripts/agent-manifest-parity.test.mjs` | PASS — 18 assertions |
| `node scripts/windows-hook-command.test.mjs` | PASS — 11 assertions |
| `node scripts/sync-agent-workflows.mjs --check` | PASS — 36 Codex adapters match Claude sources |
| `git diff --check` | PASS |

The full Vitest run prints intentional `ErrorBoundary` and missing-JSDOM-canvas diagnostics while its
negative-path tests run; the command exits 0 with every test file passing.

## Real browser proof

The Factory Board was served from a temporary isolated factory ledger and opened in the real in-app
browser at a 390×844 viewport.

- title: `CRX Factory Board`;
- one governed job card rendered;
- stage: `Ready for your review`;
- behavior summary rendered from the verified ledger;
- zero forms;
- zero buttons/inputs/selects/textareas;
- document width 390px and scroll width 390px (no horizontal overflow);
- footer explicitly states read-only and no merge/deploy/migration/data controls;
- zero browser console warnings or errors.

The temporary server was stopped after verification. Its isolated fixture directory remains only in the
Windows temporary directory because the repository's destructive-command guard correctly refused a
recursive force-delete cleanup command.

## Independent review

- Fable-low design review round 1: `NEEDS-WORK`; two HIGH, three MED, one LOW, and two NIT items were
  incorporated into the plan before implementation.
- Fable-low design re-review: `SHIP`; no BLOCKER/HIGH/MED/LOW findings.
- Final exact-diff Fable-low implementation review round 1: `NEEDS-WORK`; one HIGH, three MED, and two
  LOW findings were accepted and remediated (writer bypass, self-declared proof, lane-session binding,
  recovery/emergency hold, morning freshness/race binding, and Codex hook timeouts).
- Final exact-diff Fable-low implementation review round 2: `NEEDS-WORK`; one HIGH, one MED, and two
  LOW findings were remediated (ticket/allowlist/body-bound harnesses, production-filtered test
  overrides, fresh-chat one-lane enforcement, and negative harness tests).
- Final exact-diff Fable-low implementation review round 3: `NEEDS-WORK`; it explicitly confirmed every
  round-2 repair, then found one new HIGH closeout deadlock, one LOW missing intent-clear path, and one
  NIT pause false-positive. All three are remediated in the current bytes. Regression proof now covers
  a moved post-land base, a successful CLI closeout to `live`, its durable packet, intent clearing, and
  board-server wording that does not pause the factory.
- The original three-round review-loop cap was exhausted, so no fourth review ran in that loop.
  Mason then explicitly authorized a separate fresh acceptance review against current `origin/main`.
- Fresh Fable-low acceptance `2026-07-30T13:59:43Z`: `NEEDS-WORK`; it confirmed every earlier repair,
  then found one HIGH agent-runnable resume path, two MED wording/routing gaps, one LOW non-idempotent
  closeout retry, and one NIT Board session-ID exposure. All five are repaired in this candidate and
  covered by focused regression tests.
- Fresh Fable-low acceptance `2026-07-30T14:17:59Z`: `NEEDS-WORK`; it confirmed those five repairs,
  then found three MED gaps (trusted-writer self-edit coverage, overbroad corrupt-state denial, and
  agent-runnable intent clear) plus one LOW ambiguous `continue` resume phrase. All four are repaired
  in this candidate and covered by focused regression tests.
- Fresh Fable-low acceptance `2026-07-30T14:28:17Z`: `NEEDS-WORK`; it confirmed those four repairs,
  then found one MED residual self-edit route through `.claude/settings.local.json` and additional
  shell mutators, plus one NIT involving “yes, ship it.” Both are repaired in this candidate and
  covered by focused regression tests.
- Fresh Fable-low acceptance `2026-07-30T14:35:44Z`: `SHIP`; no BLOCKER/HIGH/MED/LOW findings.
- Mandatory generated-map scope refresh `2026-07-30T14:44:09Z`: `SHIP`; no findings. The accepted
  candidate was committed, then rebased cleanly onto current `origin/main`.
- Trusted Codex exact-head publication review `2026-07-30T15:30:43Z`: `BLOCKERS`; it found three HIGH
  issues: shell writes bypassed ticket/pause/one-lane enforcement, harness proof did not bind source
  content, and mutating CLI identity trusted caller flags. The current repair candidate closes all
  three with broad write classification, repository-content-bound proof, and hook-minted one-time
  identity permits. Publication remains parked until fresh exact-SHA Codex and Fable acceptance pass.

The latest review capture is
`.claude/session-state/codex-review-latest.txt` (`CODEX_PROOF_VERDICT: BLOCKERS`). The acceptance
verdicts for the repair candidate will be recorded in new immutable captures after all tracked bytes
and tests are frozen.

## Moving-main check

`origin/main` advanced once from `aee913d` to `db9b5ef`. The feature commit was rebased onto that
current base before publication repair began. The duplicate generated map-date hunk disappeared;
the upstream Phase 3 smoke-prover change does not overlap the factory implementation.

## Remaining gate

The repair remains uncommitted and unpushed. The next gates are full verification, a repair commit,
fresh exact-SHA Codex and Fable acceptance, then the explicitly authorized feature-branch push and
draft PR. Merge, board installation/startup, deployment, migration, and all production actions remain
undone.
