## 2026-09-02 — the Codex GitHub App reviewed every PR and nothing read it; both merge gates now do

**Files:** `.claude/hooks/codex-bot-review-lib.mjs` (new), `.claude/hooks/codex-bot-review-lib.test.mjs` (new), `.claude/hooks/pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`, `.codex/hooks/production-action-guard.test.mjs`, `.claude/commands/ship.md`, `package.json`, `scripts/apply-live-testdata-maintenance-20260812.mjs`

### What was wrong

The Codex GitHub App (`chatgpt-codex-connector`) has been reviewing every pull
request in this repo since it was enabled in the ChatGPT Codex cloud settings.
**Nothing in this repository read a word of it.** A grep for the App's login
across hooks, skills, commands, scripts and docs returned zero hits.

That was survivable while `main` required an approval CodeRabbit had to grant.
It stopped being survivable earlier the same day, when the merge guard
downgraded "no current approval" from a deny to a printed notice. An automated
review nobody reads is worse than no review: it renders a green check on the PR
page that reads as coverage.

### What changed

`pr-merge-guard.mjs` and the Codex-side `production-action-guard.mjs` now read
the App's review threads before allowing a merge into `main`:

- **DENY** when the App has an **unresolved** comment raised against the **exact
  commit** being merged. It flagged this code and nobody answered.
- **NOTICE** (never a deny) when its findings are on an older commit, when it
  left none, or when the lookup fails.

The check runs before the green-pipeline gate, so an unanswered review comment
is the message the reader gets rather than "wait for CI". `/ship` now reads the
App's findings during the review pass instead of meeting them at the gate.

### Why it reads threads, not review objects

The first cut blocked on "the App submitted a review whose commit oid is the
head". Run against all 10 open PRs, that flagged **six** of them. The reason:
the App's own documentation lists its triggers as PR-opened, draft-ready and
`@codex review` — but it actually re-reviews on essentially every push (#547 had
13 review objects, #530 19, #516 23). A review object on the head is the
*ordinary* state of an active PR, and it has no exit — you cannot resolve one,
the App just posts another next push. A gate keyed to it could never be
satisfied, which is the deadlock that got `main`'s required review relaxed the
day before.

Review **threads** carry `isResolved`, and people really do work them: #449 had
24 Codex threads with 1 unresolved, #547 19 with 1. Same six PRs measured at
thread level reduce to **1–2 standing items each**, with a clear exit — fix it,
or resolve the thread with a reason.

### Deliberate fail-open

Unlike its neighbours, this predicate does **not** fail closed. Every
uncertainty — lookup failure, missing head, unreadable data — degrades to a loud
notice. The hard gates are unchanged and elsewhere: CI's required checks, and
the exact-SHA `gpt-5.6-sol` proof for a risky diff. This layer is an
honest-mistake net for an advisory reviewer, so it must never become a locked
door. The reasoning is recorded in the library header; read it before
"hardening" the file.

### Verification

- 62 unit assertions; **10/10 mutation tests caught** (drop either spelling of
  the bot's login, ignore `isResolved`, let unknown oids match, stop filtering to
  the App's own threads, unwire the call site, silence the fetch-failure notice).
  Two of those mutations initially **survived** and exposed real gaps: an
  emptiness check made unreachable by an early return (now split into
  `oidMatchesHead`), and a wiring assertion that a bare import satisfied.
- Real-path proof against live PRs, driving the hook with a genuine PreToolUse
  payload: **#556 and #544 deny with this gate's own message**; **#361 emits the
  "none" notice** and is then denied by a later gate; **#516** is correctly denied
  earlier by `CHANGES_REQUESTED`, so this check stays silent.
- The `stale` notice has no unmasked PR on the board today, so it is covered by
  the unit suite rather than live data. Stated rather than glossed.
- `npm run test:correction-guards` and `npm run test:agent-workflows` green;
  the Codex guard's protected-blob pins re-pinned (input
  `8497cee3…`, output `b975a0a6…`).
