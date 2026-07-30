# CRX Governed Delivery Pipeline V1

Date: 2026-07-30
Status: IMPLEMENTED — ninth Sol/high publication-blocker repair pass awaiting fresh exact-SHA acceptance
Owner: Mason Wells
Implementation driver: Codex
Independent reviewer: trusted `gpt-5.6-sol` at high reasoning effort
Publication gate: fresh exact-SHA Sol high-effort acceptance before the authorized feature-branch push and draft PR; no merge, deploy, live migration, or live-data change

## Goal

Extend the existing CRX `/ship`, `/run-loop`, `/fleet`, worktree, proof, and production-guard machinery into a first usable factory lane without creating a second delivery system.

Mason uses exactly two zero-training surfaces:

1. Input and approvals happen in ordinary Claude or Codex chat.
2. Output appears on one read-only Factory Board page.

Mason never runs commands, edits ticket files, reviews code, or operates a separate control tool.

## Definition of done

- A factory-managed job begins from Mason's plain-English chat request.
- The session drafts and presents one plain-English mission ticket, including the exact repository
  files or directory prefixes the lane may change.
- An unambiguous owner reply is recorded verbatim with timestamp, session identity, ticket ID, and ticket SHA-256.
- Changing the ticket after approval changes its hash and invalidates the approval.
- A deterministic lane-start guard refuses an unapproved, stale, ambiguous, held, or conflicting job.
- Claude and Codex use one shared event ledger and ticket store resolved from Git's common directory, not per-worktree or per-tool copies.
- The pilot permits one active build lane. Multi-lane dispatch remains disabled until pilot metrics justify it.
- One read-only local Factory Board shows job title, current plain-English stage, last activity, behavior summary, blocker/owner need, and attached evidence.
- Approval or rejection of a finished job happens in chat; the board has no write controls.
- Existing `/ship`, review, push, merge, migration, edge-function, deletion, secret, permission, and production gates are preserved.
- Focused tests, agent-workflow parity tests, board rendering, and an independent `gpt-5.6-sol` high-effort review of the exact candidate pass.
- Work stops before commit for Mason.

## Non-goals

- No standalone owner application.
- No ticket form or ticket-editing UI.
- No buttons that approve, reject, start, merge, deploy, migrate, or mutate state.
- No replacement release controller.
- No autonomous push, merge, production deploy, edge-function deploy, destructive operation, or live-data mutation.
- No multi-lane scheduler in V1.
- No claim of token/dollar enforcement until a trustworthy per-job telemetry source exists. V1 records configured budgets and enforces existing review-round and elapsed-time limits; multi-lane scale remains blocked without hard cost enforcement.
- No CRX production route for the Factory Board. V1 is local/read-only so internal engineering state is not exposed to customers.

## Owner flow

### Touchpoint 1 — chat input and ticket approval

1. Mason describes work naturally in Claude or Codex.
2. Existing natural-language routing recognizes a factory/overnight build request.
3. The session drafts a compact ticket containing:
   - plain-English title;
   - business goal;
   - definition of done;
   - must-not-change behaviors;
   - proof requirements;
   - the exact fixed-allowlist repository harness name that will produce machine proof;
   - delivery gate;
   - worked business example and forbidden outcome for money, inventory, commission, security, or lifecycle work.
4. The session presents exactly one pending ticket and asks one plain-English yes/no question.
5. The next unambiguous owner response is bound to the presented ticket hash:
   - affirmative -> approved;
   - negative -> rejected;
   - qualified or changed request -> not approved; the session must revise and present a new ticket hash.
6. Once the ticket is presented, the session may ask no other question until Mason answers that ticket. The presentation event records the canonical approval-question fingerprint. The owner-input hook verifies from the session transcript that the immediately preceding assistant question is that exact ticket question. Any intervening assistant question, missing transcript evidence, second pending ticket, or cross-session reply voids automatic binding and requires the ticket to be re-presented in the current chat.

### Touchpoint 2 — Factory Board and chat disposition

1. The Factory Board shows the completed business behavior and machine-attached proof.
2. Mason approves, rejects, or changes direction in ordinary chat.
3. The session resolves the referenced job, echoes the intended state change in plain English, and records it in the same shared ledger.
4. The board remains read-only.

## Shared-state architecture

### Canonical location

Resolve `git rev-parse --git-common-dir`, then store runtime state under:

`<git-common-dir>/crx-factory/`

All registered worktrees share this directory. It is outside tracked source and cannot create per-worktree drift.

The implementation must resolve `git rev-parse --git-common-dir` relative to the repository root and normalize it to an absolute Windows-safe path before adding `crx-factory`. No hook or board code may assume the command returns an absolute path.

Tracked repository code defines the schema, validation, rendering, and hooks. Runtime tickets, events, evidence, locks, and generated board snapshots stay in the shared untracked state directory.

### Event log

Use an append-only JSONL event log plus immutable ticket versions and evidence files. Derive current state by replaying validated events.

Every event includes:

- schema version;
- event ID;
- event type;
- timestamp;
- job/ticket ID;
- actor tool and session ID when available;
- ticket hash when applicable;
- payload validated for that event type.

Writes use an exclusive cross-process lock, bounded retry, append, flush, and release. A malformed event fails closed and is not appended.

The event log is hash-chained: every event records the prior accepted event hash and its own canonical hash. Replay fails closed on an invalid interior event, broken chain, duplicate event ID, or invalid schema. A single incomplete trailing JSONL line caused by process interruption is ignored and reported as degraded state; it cannot advance a job or create approval.

Direct mutation of the shared state directory is forbidden. A new PreToolUse state-integrity guard denies `Write`, `Edit`, shell redirection, copy/move/delete, and ad hoc scripting that explicitly targets the resolved `crx-factory` directory. Only the narrowly recognized `node scripts/factory.mjs ...` mutation commands may write there. The board is read-only. Hash-chain verification remains mandatory because command guards reduce accidental/model bypass but are not a cryptographic defense against an actor with unrestricted filesystem authority.

### Ticket approval receipt

An approval receipt binds:

- ticket ID and version;
- SHA-256 of the exact ticket bytes shown to Mason;
- the exact owner reply;
- timestamp;
- source session/thread identifier;
- tool surface (`claude` or `codex`);
- approval scope;
- freshly fetched `origin/main` base SHA;
- expiry timestamp, no more than 24 hours after approval.

The lane-start validator recomputes the ticket hash and refuses a mismatch. It refuses missing/unknown session identity, an approval recorded in another session, an expired receipt, or a current `origin/main` different from the receipt's base SHA. There is no normal fallback that erases session binding.

If Mason answers from the other tool or a new chat, the owner-input hook records no approval. Mason
may explicitly ask that chat to take over the named factory job. Only the real owner-prompt hook can
record this custody transfer; it revokes any prior approval/question fingerprint, after which the
session re-presents the canonical ticket or morning question and Mason still answers in ordinary words.

### Durable closeout

Active runtime state stays under the shared Git common directory. Before a job may reach `live`, the factory must generate a content-hashed, human-readable closeout packet under `docs/audits/factory/jobs/<job-id>.md` containing the ticket hash, approval receipt summary, behavior result, proof manifest, reviewer verdicts, landing commit/base, machine-checked production verification, and the pre-closeout ledger checkpoint hash. The checkpoint is the last ledger event before packet preparation; a final-event hash cannot be embedded in the packet without creating a circular content hash. The exact packet bytes must then be committed into `origin/main`, after which the factory rechecks the exact-SHA Production deployment and canonical production endpoint before recording `live`. This deliberately makes closeout a two-phase, follow-up documentation landing so the packet survives a re-clone and cannot disappear with a worktree. The shared active-state directory will also be added to the existing off-site CRX backup inventory before multi-lane activation.

## Pilot stages

V1 board stages:

- `needs-ticket-ok`
- `queued`
- `building`
- `verifying`
- `in-review`
- `awaiting-morning-review`
- `parked`
- `approved-to-land`
- `live`
- `rejected`
- `superseded`

Only deterministic events may move a job forward. Missing proof cannot produce
`awaiting-morning-review`; missing production verification cannot produce `live`. A qualifying
harness name must be in the immutable ticket and fixed factory allowlist, its npm script body must
match `origin/main`, and its script/package/base/output hashes are captured and rechecked. The
production harness runs without inherited credentials or network in a pinned container dependency
layer built from `origin/main`; only a disposable copy of tracked/non-ignored bytes is writable, and
trusted bootstrap initializes sanitized Git metadata inside that copy before the shared Git mount is
removed. Branch-controlled harness code cannot read shared Git objects/configuration, other worktrees,
or factory state, and the workspace is deleted after the run. While the single pilot lane is active, other and fresh chats
cannot perform build writes.

## Planned repository changes

### Core shared state and CLI

- `scripts/factory-state-lib.mjs`
  - shared path resolution;
  - canonical serialization and SHA-256;
  - lock and append-only event writing;
  - event replay and stage derivation;
  - ticket and evidence validation.
- `scripts/factory.mjs`
  - agent-facing commands for draft, present, inspect, lane start, stage, allowlisted harness evidence, packet validate, disposition, recovery, and board snapshot/server;
  - every mutating command writes validated events; owner never runs it.
- `scripts/factory-state-lib.test.mjs`
- `scripts/factory-cli.test.mjs`

### Hard hooks

- `.claude/hooks/factory-owner-input.mjs`
  - ignores machine-generated prompts;
  - records only unambiguous approval/rejection when exactly one ticket is pending for that session and the immediately preceding transcript question matches the recorded presentation fingerprint;
  - treats qualifications or changed scope as revision requests, never approval;
  - refuses cross-session, missing-transcript, stale-base, or expired approval binding;
  - transfers eligible ticket/review custody only after Mason explicitly asks through a real owner prompt,
    revoking the old approval/fingerprint before re-presentation;
  - handles natural-language global factory hold/resume.
- `.claude/hooks/factory-lane-guard.mjs`
  - applies only to sessions explicitly bound to a factory job;
  - blocks build writes when ticket approval/hash, global hold, lane ownership, or worktree/base requirements fail;
  - canonicalizes every structured mutation target and rejects worktree escapes, symlink escapes,
    `.git`, ignored/secret-bearing paths, hidden targets, and paths outside the approved ticket scope;
  - restricts governed reads to stable, non-secret paths inside the worktree and rejects secret-shaped
    added content;
  - does not weaken or replace any existing guard.
- `.claude/hooks/factory-state-integrity-guard.mjs`
  - blocks direct writes, rewrites, deletion, or ad hoc script access to the shared factory state directory;
  - permits only the exact validated `scripts/factory.mjs` mutation entrypoint;
  - is defense in depth with hash-chain validation, not a claim of secrecy from unrestricted local administrators.
- focused hook tests, including ambiguous `yes, but ...`, stale hash, wrong session, machine prompt, duplicate pending ticket, and global hold.

### Existing workflow integration

- `.claude/commands/ship.md`
  - factory-managed substantial jobs must draft/present/validate a ticket before implementation;
  - the existing trivial/substantial split remains;
  - uncommitted V1 work parks before commit in this implementation session.
- `.claude/commands/fleet.md`
  - status requests lead with Factory Board state and keep existing worktree/parked-migration evidence.
- `.claude/hooks/ship-intent-reminder.mjs`
  - natural language continues to route to `/ship`;
  - factory/overnight intent additionally instructs the session to create and present the ticket automatically.
- `.claude/settings.json` and `.codex/hooks.json`
  - invoke the same canonical prompt and lane guards for both tools.
- `scripts/agent-manifest-parity.mjs` coverage
  - declares and verifies the new hooks on both Claude and Codex surfaces so neither tool silently loses a gate.
- generated `.agents/` adapters refreshed from `.claude/`.

### Factory Board

- `scripts/factory-board.mjs`
  - read-only local HTTP server;
  - binds to loopback only;
  - no state-changing endpoints;
  - HTML escapes every ticket/evidence field;
  - auto-refreshes;
  - clear empty, loading, held, parked, stale, and error states;
  - shows friendly labels rather than internal jargon;
  - provides evidence links only to files inside the shared factory evidence directory.
- `scripts/factory-board.test.mjs`
  - rendering, escaping, stage labels, empty state, proof visibility, and rejection of path traversal.
  - a partially written final JSONL line produces a visible degraded warning while all previously verified events remain readable.
- package scripts:
  - `factory:board`
  - `factory:status`
  - focused factory test command.

### Documentation and evidence

- `docs/workflows/GOVERNED_DELIVERY_PIPELINE.md`
- `docs/reference/agent-guardrails.md`
- `docs/CHANGELOG.md`
- a dated implementation evidence packet under `docs/audits/`

## Verification

Run at minimum:

1. Focused factory state, CLI, hook, and board tests.
2. `npm run test:agent-workflows`.
3. `npm run test:correction-guards`.
4. `npm run check:docs`.
5. `npm run typecheck`.
6. `npm run lint`.
7. `npm run build`.
8. `npm run test`.
9. Start the Factory Board on loopback, open it in a browser, and inspect:
   - empty state;
   - pending ticket;
   - approved/queued job;
   - parked job;
   - completed job with behavior proof;
   - narrow viewport without horizontal overflow.
10. Run `git diff --check`.
11. Run `gpt-5.6-sol` at high effort against the exact candidate SHA. Fix every confirmed BLOCKER/HIGH/MED/LOW, rerun affected proof, and re-review before publication.

## Pilot activation and scaling rule

V1 ends with one active lane and no autonomous landing.

After 10 real jobs, consider enabling one unattended overnight lane only if:

- zero unsupported completion claims, measured when Mason accepts/rejects each morning packet and recorded as a ledger metric;
- zero out-of-scope changes;
- zero lane/worktree collisions;
- zero reviews bound to the wrong ticket/head/base;
- at least 8 of 10 packets accepted;
- typical owner behavior review is five minutes or less.

Multi-lane work remains disabled until the single overnight lane meets those standards and trustworthy hard per-job cost enforcement exists.
