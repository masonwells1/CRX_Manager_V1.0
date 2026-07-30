# Governed Delivery Pipeline V1 — Pre-Commit Evidence

Date: 2026-07-30
Branch: `claude/autonomous-factory-review-275248`
Base at start: `aee913df43ca1321ce1060fdb8f3dc2a89bbc790`
Current `origin/main` at exact-proof freeze: `886fa4591dd72c82d9e8c8f0b09fd3c8b7355053`
State: rebased onto current `origin/main`; ninth Sol/high publication-blocker repair candidate is unpushed

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
- Exact ticket approval requires the immediately preceding assistant transcript message to match the
  canonical question generated from the immutable ticket. That question includes the ticket goal,
  completion conditions, prohibitions, exact allowed repository paths, proof, delivery gate, and any
  high-risk example/forbidden outcome.
  The same session, ticket hash, freshly fetched `origin/main`, and a receipt no older than 24 hours are required.
- The morning question is likewise canonical and includes the exact behavior summary, harness receipts,
  independent-review receipt, ticket hash, and a warning that acceptance is not merge/deploy/live.
- Qualified yes, side-question yes, missing transcript, cross-session reply, machine prompt, moved base,
  changed ticket, global hold, and second active lane do not start work.
- State writes are restricted to canonical process/call-stack entrypoints; direct paths, state-library
  imports, inline-code bypasses, and governance self-edits in an active lane are denied. This is
  defense-in-depth inside the supported agent tool boundary, not a same-Windows-user cryptographic
  security boundary. The ledger/Board never authorizes merge, deploy, migration, live-data, or
  production actions; existing `/ship`, GitHub, and owner hard gates remain authoritative.
- Legal stage transitions and evidence writes are bound to the lane-start session. Every mutating
  CLI permit is bound to the terminal ledger hash observed by the hook, and every resulting append
  uses that expected-last-event compare-and-swap under the exclusive ledger lock. A stale command,
  simultaneous start, or parallel session therefore cannot overwrite or rewind newer state. Ticket
  revision/presentation and morning-review presentation also enforce eligible stages and current
  custody during both command handling and ledger replay. Cross-tool transfer requires Mason's
  explicit plain-English request through the real owner-input hook and revokes the old decision
  fingerprint/approval before re-presentation. Successful output from every
  CLI-executed repository harness named in the ticket is required before morning review. Each name is bound into the
  immutable ticket and fixed allowlist; its resolved script body must equal `origin/main`, and the
  command/body/package/base/output hashes plus the full tracked/non-ignored repository content
  fingerprint are rechecked. The production broker runs the harness without inherited credentials or
  network in a pinned Docker image whose dependency layer is built only from `origin/main` with
  install scripts disabled. The container root and trusted dependency layer are read-only,
  capabilities are dropped, resources are bounded, and the harness receives only a disposable copy
  of tracked and non-ignored repository bytes plus a newly initialized sanitized Git snapshot.
  Ignored files, the original checkout, and the shared Git common directory are unavailable while
  branch-controlled harness code runs. The broker fingerprints both repository and shared factory state around the run,
  emergency-holds on indirect host mutation, refuses secret-shaped stdout/stderr before persistence,
  and deletes the disposable workspace. Source or test edits after the harness invalidate it. The
  arbitrary local-file evidence route has been removed. A separate fixed-prompt, read-only Codex run
  must then return one terminal CLEAN verdict bound to the exact base and repository fingerprint;
  branch harness success alone cannot advance the job to morning review.
- Throughout factory custody—from ticket decision through the morning decision—native edits,
  MCP filesystem tools, shell writes/redirection, Git mutations, unknown repository scripts, and
  opaque helper execution from other or fresh chats are denied. The winning lane
  uses structured target-visible edits and read-only shell inspection; opaque shell/helper/MCP process
  execution is denied, and fixed harnesses run only through the permit-bound factory CLI broker.
  Structured mutation targets are canonicalized and must remain in-worktree, non-ignored, non-secret,
  non-`.git`, symlink-contained, and within the ticket's exact allowed paths. Structured and shell
  reads are separately constrained to stable, non-secret, non-ignored paths inside the worktree;
  wildcard/dynamic shell reads fail closed, and secret-shaped added content is refused.
- A stale lock can be removed only after five minutes when its process is gone, with a backup retained.
  A torn final line has a backup-first repair path, and a failed ledger pause creates an emergency hold
  that still blocks lane writes.
- Morning chat acceptance produces only `approved-to-land`, never `live`.
- `approved-to-land` releases factory custody so the ordinary `/ship` commit, push, PR, and production
  guards can run; the factory cannot deadlock its own landing lifecycle.
- Live closeout requires an accepted job, a landing commit contained in `origin/main`, a successful
  GitHub `Production` deployment for that exact SHA, HTTP 200 from the fixed canonical app URL, proof
  still bound to the job's immutable original base, and a durable content-hashed packet under
  `docs/audits/factory/jobs/`. Caller-authored production proof is not accepted. The named landing
  commit's content fingerprint must equal the harness-proven bytes; every harness/review artifact is
  reopened and re-hashed; and the packet records approved base, reviewer verdicts, and the
  pre-closeout ledger checkpoint.
- A chat can clear its recorded factory intent and return to the normal guarded workflow without
  starting a lane or abandoning the chat.
- Only a real owner chat prompt can resume a global or emergency hold. The agent CLI has no
  hold/resume command, and direct agent invocation of the owner-input hook is denied.
- “Run the factory overnight” records governed intent without needing an additional build/ship verb;
  explanatory factory questions do not.
- Board process wording never changes the global hold, and the Board API omits owner/lane session IDs
  plus internal ticket/base fields.
- Closeout is idempotent across a packet-written/ledger-failed interruption. Packet preparation leaves
  the job `approved-to-land`; `live` is refused until those exact bytes are committed into
  `origin/main`, then production is rechecked and the packet-containing commit is recorded. An
  already-live retry returns the verified packet, and conflicting landing/packet retries are refused.
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
  permit read/set/forward routes fail closed. The permit includes the exact terminal ledger hash and
  becomes invalid after any intervening event. Status JSON exposes no session or ticket identity.

## Automated proof

| Check | Result |
|---|---|
| `npm run test:factory` | PASS — 5 files, 318 focused assertions after ninth Sol/high blocker remediation |
| contained `npm run test:factory` | PASS — pinned image, no network, disposable workspace |
| contained `npm run build` | PASS — pinned image, no network, 4,235 modules transformed |
| `npm run test:agent-workflows` | PASS — factory tests plus shared hook/workflow/parity checks |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS — 4,235 modules transformed |
| `npm run test` | PASS — 307 files; 4,079 passed, 123 skipped |
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
  identity permits.
- Trusted Codex exact-head publication re-review `2026-07-30T16:04:45Z`: `BLOCKERS`; it found three
  HIGH issues (landing commit not bound to proven bytes, indirect helper execution, and arbitrary
  local evidence/proof files) plus one MED concurrent lane-start race. The current repair candidate
  binds the landing commit fingerprint, removes arbitrary-file evidence, rejects secret-shaped
  production text, denies opaque execution in active lanes, and makes lane start compare-and-swap
  atomic.
- Trusted Codex exact-head publication re-review `2026-07-30T16:41:12Z`: `BLOCKERS`; it found two
  HIGH execution-boundary gaps: command substitution could receive a factory permit, and
  branch-modified harness dependencies executed on the credentialed workstation. The current repair
  uses a strict argument grammar and a credential-free, no-network Docker harness with pinned trusted
  dependencies and a disposable source workspace.
- Trusted Codex exact-head publication re-review `2026-07-30T17:22:43Z`: `BLOCKERS`; it found four
  gaps: the same-user ledger boundary was overstated, ticket approval wording was not derived from
  ticket content, branch-controlled harness proof lacked mandatory independent review, and moving-main
  checks could use a stale local ref. The current repair states the ledger's real trust boundary,
  extends cross-session custody, requires the canonical scope-complete ticket question, adds an
  exact-content independent Codex CLEAN gate, and fetches `origin/main` at critical decisions.
- Trusted Codex exact-head publication re-review `2026-07-30T17:51:45Z`: `BLOCKERS`; it found two
  HIGH tool-boundary bypasses (`git --output` and raw orchestration tools) plus one MED secret-filter
  gap for raw JWTs and other persisted fields. The current repair strictly allowlists Git read
  tokens/options, defaults unknown non-read tools to opaque mutation, recognizes raw execution
  surfaces, expands common cloud-token detection, and scans all ticket and event payloads.
- Trusted Codex exact-head publication re-review `2026-07-30T18:09:29Z`: `BLOCKERS`; it found four
  HIGH gaps: ripgrep preprocessing could execute a helper, morning presentation could rebind stale
  proof to a moved base, one of multiple required harnesses could satisfy the ticket, and
  `approved-to-land` remained locked inside factory custody. The current repair removes shell ripgrep
  from read allowances, revalidates fresh base plus all proof at presentation, requires every named
  harness and lists them in the independent-review prompt, and hands accepted jobs to `/ship`.
- Trusted Codex exact-head publication re-review `2026-07-30T18:25:01Z`: `BLOCKERS`; it found that
  arbitrary closeout prose could self-certify `live`, the post-land packet was not required to enter
  Git and omitted approved-base/reviewer/ledger-checkpoint data, and proof files were not re-hashed
  before acceptance. The current repair uses exact-SHA GitHub Production status plus a fixed HTTP
  check, makes closeout two-phase with an exact packet-in-`origin/main` gate, expands the packet
  manifest, and reopens/re-hashes every harness and independent-review artifact.
- Trusted Codex exact-head publication re-review `2026-07-30T18:50:19Z`: `BLOCKERS`; it found that a
  real pre-commit code change could never match its later commit SHA at closeout, structured edits
  were not worktree/ticket constrained, the independent prompt omitted approved ticket fields, and
  the reviewer inherited the full environment while raw output was persisted. The current repair
  binds review acceptance to the complete content fingerprint rather than mutable commit identity,
  tests a real changed-and-committed file through closeout, enforces exact ticket path scope plus
  escape/ignored/secret/Git-internal checks, sends the full canonical ticket and hash, supplies a
  minimal reviewer environment, and persists only a bounded summary plus output hashes/counts.
  Publication remains parked until fresh exact-SHA `gpt-5.6-sol` high-effort acceptance passes.
- Active adversarial-review policy is now Sol-only: factory acceptance, risky push/merge proof,
  unattended review, and migration review charters explicitly pin `gpt-5.6-sol` at high effort.
  Claude/Fable is not required and no Claude credits are consumed by these gates.
- Trusted Codex exact-SHA Sol/high acceptance of commit `1dad1709` returned `BLOCKERS`: the factory
  imported its reviewer arguments from a wrapper that an active lane could edit, project hooks were
  still loadable inside the reviewer, and the repository's old cross-model wording contradicted
  Mason's explicit Sol/high decision. The repair disables project hooks, protects the complete
  reviewer/proof trust chain from lane self-editing, and records the new owner policy. A fresh
  acceptance must evaluate the repaired commit before publication.
- Trusted Codex exact-SHA Sol/high acceptance of commit `799b8797` returned `BLOCKERS`: revised
  tickets could inherit old receipts, the migration consumer did not require recorded Sol/high
  identity, patch-shaped edits could hide governance destinations, and the factory broker was absent
  from the risky/protected registry. The repair clears active receipts on revision, binds every
  harness/review artifact to the exact ticket hash, validates Sol/high at migration consumption,
  inspects patch/input/raw/move destinations, and protects the authoritative factory broker. Fresh
   exact-commit acceptance is still required.
- Trusted Codex exact-SHA Sol/high acceptance of commit
  `ffa549fc7c1307d3786c918e8a6623b641055583` returned `BLOCKERS`: a parallel chat could obtain a
  permit and rewind/take over an existing job, governed lanes could read secret-bearing files and
  copy secret-shaped material into approved output, and branch-controlled harness code could see the
  entire shared Git directory. The current repair binds every permit/append to the exact terminal
  ledger hash, validates custody plus eligible transitions in the hook, CLI, and replay layer,
  preserves cross-tool operation only through an explicit owner-chat transfer event, constrains
  reads and added content, and gives runtime harnesses only a sanitized disposable Git snapshot.
  Fresh exact-commit acceptance is still required.
- Trusted Codex exact-SHA Sol/high acceptance of commit
  `2e9ef43fec1761693e416257322c65fa7c3ff192` returned `BLOCKERS`: PowerShell's non-filesystem
  providers remained reachable through otherwise read-only `Get-Content`, `Get-Item`, and
  `Get-ChildItem` commands, so `Env:` could expose inherited credentials without touching a
  secret-shaped filesystem path. The repair rejects provider-qualified names, named PowerShell
  drives, and drive-relative paths before resolving any shell read. Regression coverage includes
  `Env:`, `Registry::`, `HKCU:`, `Cert:`, and `C:relative` forms. Fresh exact-commit acceptance is
  still required.
- Trusted Codex exact-SHA Sol/high acceptance of commit
  `f9e7c7ddda88e101ddcc7ba4d20feceda6b13043` returned `BLOCKERS`: a lane could begin with
  unrelated pre-existing changes, and independent review still ran inside the real host checkout
  where ignored secrets and session state were readable. Lane start now requires a clean checkout
  exactly at the approved base. Evidence validation, owner review, and closeout independently
  recompute all committed, working-tree, and untracked changes and reject any path outside the
  ticket. Both factory and push-proof reviewers now run from disposable Git-free packets containing
  only exact base bytes, tracked/non-ignored candidate bytes, a precomputed diff, and a SHA manifest;
  ignored `.env`, session-state, host profile paths, and repository Git metadata are absent. Fresh
  exact-commit acceptance is still required. The first real sanitized-packet launch failed closed
  because Codex correctly refused a Git-free directory; the trusted wrapper now supplies
  `--skip-git-repo-check` while retaining read-only sandboxing, disabled hooks, and fixed stdin.
- Trusted Codex exact-SHA Sol/high acceptance of commit
  `7e08a4beb6dc2d45e00b883ff029f060500a5e25` returned `BLOCKERS`: failed intent append could
  leave an autonomous chat ungoverned, `git -C` and relative shell operands could escape read
  controls, and exact-content fingerprints omitted Git mode/type. Intent routing now writes a
  separate durable per-session fail-closed latch before attempting the ledger append and clears it
  only after success; the lane guard honors it for writes and mutating factory commands. Governed
  Git reads cannot redirect with `-C`, every literal shell operand passes worktree/ignored/secret/
  symlink checks, and fingerprints bind path, mode, object type, and blob identity. Fresh
  exact-commit acceptance is still required.
- Trusted Codex exact-SHA Sol/high acceptance of commit
  `da0b71c65d731f8185c464193305b2b891484133` returned `BLOCKERS`: permit-bound CLI
  `--summary-file`/`--blocker-file` inputs could read arbitrary host files, and closeout could accept
  a historical successful deployment after rollback. All caller-selected factory file inputs are
  removed; ticket, summary, blocker, and recovery text now use bounded canonical base64 arguments,
  with secret-shaped operational text rejected before persistence. Production verification selects
  the newest Production deployment, requires its newest status to be `success`, and uses GitHub's
  compare result to prove the currently deployed SHA is the landing commit or a descendant. Fresh
  exact-commit acceptance is still required.
- Trusted Codex exact-SHA Sol/high acceptance of commit
  `042afe2482e7a0571cb7df16784e9ad70219c1e6` returned `BLOCKERS`: the read-only Factory Board and
  `package.json` test wiring were absent from the risky/protected trust-chain registries, and the
  sanitized review diff still disclosed the host's absolute temporary/profile path in its headers.
  The repair classifies and protects both surfaces, generates review diffs from fixed relative
  snapshot names, and tests that packet artifacts contain neither the source checkout nor temporary
  review-root/profile path. Commit-bound closeout evidence now also reads `package.json` from the
  frozen landing commit, so staged caller changes cannot mask evidence-freshness checks. Scratch
  review-packet tests strip hook-inherited repository-local Git variables before `git init`, so they
  cannot target or reinitialize the caller's real worktree metadata. Fresh exact-commit acceptance
  is still required.
- Trusted Codex exact-SHA Sol/high acceptance of commit
  `10f862901495ca65c46ffe43f0a1cd0d3969783e` returned `BLOCKERS`: relative shell commands could
  receive a governed permit or pass read checks while a caller-selected `cwd`/`workdir` executed
  them in another checkout; the factory-intent failure latch could persist a secret-bearing raw
  prompt; and negated resume language could clear the global hold. Shell actions now validate an
  explicit working directory against the exact governed root, every recognized factory invocation
  is rewritten to the canonical absolute broker path, latches retain only a prompt SHA-256 plus
  rejection flag after a pre-persistence secret scan, and negated resume/restart phrases remain
  paused. Fresh exact-commit acceptance is still required.

The latest review capture is
`.claude/session-state/codex-review-latest.txt` (`CODEX_PROOF_VERDICT: BLOCKERS`). The acceptance
verdicts for the repair candidate will be recorded in new immutable captures after all tracked bytes
and tests are frozen.

## Moving-main check

`origin/main` advanced from `aee913d` through `db9b5ef`, `c0d90ed`, `31cf0abe`, and `886fa459`.
The feature
commits were rebased onto each current base before exact-SHA publication proof. The latest upstream
vendor-bill accounting-period close work overlaps only policy/changelog/package surfaces; both
entries and harness definitions were retained during reconciliation.

## Remaining gate

The latest repair pass remains unpushed. Full host verification and the real contained Docker
factory harness are green at the repaired bytes. The next gate is fresh exact-SHA `gpt-5.6-sol`
high-effort acceptance, then the explicitly authorized feature-branch push and draft PR. Merge,
board installation/startup, deployment, migration, and all production actions remain undone.
