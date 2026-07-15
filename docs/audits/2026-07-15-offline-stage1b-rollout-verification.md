# Offline Stage 1B Rollout Verification — 2026-07-15

## Verdict

**PR #124 browser rollout: LANDED IN CURRENT MAIN.** This is proven by
local Git ancestry and the checked-in implementation. The phone/browser
reconnect checklist has **not** run and remains parked. No production endpoint,
live mutation, or production E2E fixture was used in this verification.

The report branch is one docs-only commit ahead of current `origin/main`;
`origin/main` itself already contains the PR #124 browser rollout:

```text
HEAD        9bb87a32427bbf6f9ff3c0aee23f060045c04336
origin/main 259d7c6610cd8854f32fa0b25e12b109f63bbc64
origin/main...HEAD  0 1
```

`git merge-base --is-ancestor 2abb33fcdf9e79e0d46406c835a170f56f100a10 origin/main`
returned exit code `0`.
The first-parent history contains:

```text
2abb33fcdf9e79e0d46406c835a170f56f100a10
Merge pull request #124 from masonwells1/codex/offline-receipt-activation-guards
feat(offline): durable receipt recovery (DB rollout required)
```

The merge's PR side is `a456e004b5770cbaf47d3a966dfc2254111eda77` and includes
the browser rollout sequence beginning at `0725add6`:

```text
0725add6 feat(offline): activate durable receipt recovery
2d0fe672 test(offline): cover review page smoke path
99747843 fix(offline): preserve pre-upgrade saved work
77fa2630 fix(offline): recover missing native snapshots
a6ca2fee test(offline): verify live receipt rollout
9854e763 fix(offline): preserve office-visible recovery
826ade09 fix(offline): close reconnect concurrency gaps
141f9369 docs(offline): align proof with review handling
```

The PR merge contains `src/lib/offlineQueue.ts`, `src/lib/offlineSync.ts`,
`src/lib/offlineReceipts.ts`, `OfflineWorkPanel.tsx`, `OfflineWorkReview.tsx`,
their tests, field/delivery integration, and the four receipt migrations.

## Shipped scope proved on disk

The implementation and July 14 evidence prove the following scope:

- durable `complete_delivery` and `complete_job` receipt staging, processing,
  status lookup, stable client action IDs, and local retention until a server
  `succeeded` result;
- reconnect handling for lost responses, retry/backlog and daily-cap outcomes,
  target-snapshot conflict handling, missing-snapshot legacy review, and
  blocked IndexedDB upgrades;
- sanitized admin/sales review queue and audited office resolutions of
  `already_completed` or `abandoned`, with required note/resolver/audit data;
- same-receipt and same-key serialization, target-row locking through the
  canonical mutation, and no duplicate business mutation on exact replay;
- the Saved Offline Work panel, offline banner, route wiring, and focused
  component/unit coverage.

The July 14 retained disposable-database reports record successful proof for
RLS/grants, RPC-only writes, exact replay, concurrent delivery/job processing,
pre-commit termination rollback, post-commit lost-response recovery, office
resolution races, backlog release, and the 250/day plus 500-unresolved guards.
Those are prior retained local-database results, not a new live or phone run in
this session.

## Deferred or still parked

The following remain intentionally outside this rollout or lack the required
phone/browser evidence:

- signature/photo persistence and replay;
- idempotent email/notification replay;
- cross-tab Web Locks/BroadcastChannel leasing and general duplicate-action
  policy;
- operation-specific conflict preconditions beyond the implemented delivery/
  job contract;
- automatic device discovery of an office resolution;
- retention/redaction automation for successful receipt payloads;
- real authenticated route rendering on a phone/browser, radio/network
  interruption behavior, and the final user-visible reconnect checklist.

`docs/manual/KNOWN_ISSUES.md` still says the browser rollout is pending branch
merge. That sentence is stale relative to the ancestry above and the checked-in
PR #124 merge; this ticket records the correction without editing the manual.
The same entry correctly retains the deferred-feature list and the device-local
loss risk before reconnect.

## Verification run in this worktree

Dependencies were already present from the locked install (`package-lock.json`
and `node_modules/`); no dependency mutation was needed.

| Command | Result |
|---|---|
| focused Vitest: OfflineBanner, OfflineWorkPanel, offlineQueue, offlineReceipts, offlineSync, OfflineWorkReview, rpcContracts | **PASS** — 7 files, 164 passed |
| `node scripts/smoke/prove-offline-action-receipt-failures.mjs` | **PASS** — rate-limit locking, delivery/job concurrency, concurrent target edits, interrupted-before-commit retry, lost-response-after-commit replay, and exactly one business effect |
| `node scripts/smoke/prove-offline-action-review-resolution.mjs` | **PASS** — primary/race resolution `already_completed` and four audit resolution events |
| `npm run check:docs` | **PASS** |
| `npm run typecheck` | **PASS** |
| `git diff --check` | **PASS** |

Luna's first workspace sandbox attempt was blocked by path permissions. The
orchestrator reran the focused checks and both smoke runners successfully and
observed the results recorded above.

No production E2E command was run.

## Phone / future `[E2E]` checklist — parked, not run

These are concrete later fixture names and acceptance steps. They are a plan
for a credentialed staging/disposable session, not evidence from this run.
Every future phone or browser fixture is restricted to a disposable or staging
environment. Production is categorically prohibited. Staging credentials must
be present before execution; every created record must use an `[E2E]` prefix;
cleanup and teardown are required. A phone may point only at that staging or
disposable environment.

### `[E2E]-offline-lost-response-recovery`

1. On an authenticated test device pointed only at the approved staging or
   disposable environment, queue one supported offline delivery and
   record its displayed client action ID.
2. Reconnect through the approved disposable/staging harness and force the
   response to be dropped **after** the server commit.
3. Reload the app; confirm the local action remains until status lookup returns
   the matching `succeeded` receipt.
4. Confirm exactly one delivery completion/inventory effect and that replay
   returns the same receipt, with no second business mutation.

### `[E2E]-offline-two-tab-replay`

1. In the approved staging or disposable environment, prepare one supported
   offline delivery or job action owned by the signed-in test user and open two
   tabs for that same user.
2. Reconnect both tabs and trigger replay concurrently.
3. Confirm both tabs converge on one receipt/result, only one business effect
   is visible, and neither tab deletes local work before server success.
4. Repeat the same-ID replay once more and confirm it is an exact replay.

### `[E2E]-offline-office-already-completed-resolution`

1. In the approved staging or disposable environment, create a retained
   `needs_review` action whose target was completed outside the offline
   processor; keep the original device action local.
2. In a separate credentialed admin/sales office session, open
   `/offline-work-review` and verify only sanitized metadata is shown.
3. Resolve it as `already_completed` with a required note; expect receipt
   `status=needs_review`, `review_resolution=already_completed`, exactly one
   audit event, and zero canonical mutation.
4. Return to the original device and use the UI's **Retry saved work** action,
   which must force a status lookup before acknowledgement. Ordinary sync is
   insufficient. Confirm the permanent decision is acknowledged and local
   deletion occurs only after acknowledgement.
5. Verify applicator/anonymous sessions cannot list or resolve the office item,
   then perform the required cleanup and teardown for all `[E2E]` records.

## Release disposition

**OFFLINE-ONLY VERIFICATION COMPLETE.** The report is the
only intended file change. The phone checklist, authenticated browser route
proof, and credentialed staging phone/browser validation remain outstanding.
No push, deploy, migration apply, live-data change, or production E2E mutation
was performed.
