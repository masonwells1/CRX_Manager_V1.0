<!-- Copied verbatim from the efficiency-review session's approved plan (2026-09-11). Status: IN FORCE. Section 8 is the running follow-up log; later edits go through a normal PR. -->

# CRX Manager backlog plan — approved 2026-09-11

Status: Astra (gpt-6-astra, read-only) round 2 verdict APPROVE WITH CHANGES; all ten changes are folded in below. Mason's standing rule for this plan: "send to astra; if it approves I agree with it all." Two items still need Mason's own words (marked MASON).

Main at approval: 71761db7d. Open PRs (15): 650, 647, 646, 638, 635, 634, 631, 630, 626, 624, 612, 605, 599, 544, 449.

## 0. Ground rules

- ONE owner per PR (a named session + checkout). ONE coordinator (the fleet orchestrator session) owns the landing queue. Workers never merge; they hand a frozen head to the coordinator. Replacing an owner needs an explicit handoff message.
- LANDING CHECKLIST (every PR):
  1. Update branch to current main.
  2. All CI checks green and the repo's own pre-review gates satisfied BEFORE a CodeRabbit slot is spent.
  3. Freeze the head. CodeRabbit review of THAT head, requested by Mason or by the one session he authorized in chat.
  4. Resolve every finding, including outside-diff items in review BODIES. A zero thread count is not "no findings".
  5. RESTART RULE: any corrective commit restarts checks, freezes a new head, and needs review of the new head. Any main change invalidates the base-bound proof and requires re-integration.
  6. Fresh exact-SHA gpt-5.6-sol/high proof matching head AND current main, no older than 30 minutes, from the sanctioned proof producer. (Stronger than the repo's risk-based rule; deliberately kept for every PR in this queue and budgeted for.)
  7. Immediately before merge: recheck head, main, checks, review objections, proof age, auto-merge off. Exact-head merge.
  8. For a runtime-changing merge: confirm the Vercel deployment maps to that commit and run the accepted verification card before the queue advances.
- VERIFICATION/RECOVERY CARD (before each runtime landing; worker writes, coordinator accepts): operator, deployment reference, rollback reference and owner, safe data scope (no production test transactions without exact authorized scope), expected results, stop conditions. Fault scenarios (lost responses, concurrency, retries on money/inventory) run in an isolated environment reproducing the installed server contract; production gets safe observation only. Invoice reconciliation uses affected record ids and the exposure interval, not invoice date alone.
- Review budget: one CodeRabbit request per hour (Mason's budget) until Mason changes it. The provider's "5 per hour" message is not authorization. Coordinator keeps one fleet-wide reservation record: candidate SHA, requester, request time, delivery state, next eligible slot. An uncertain delivery is reconciled before another request is spent.
- Ledger/doc conflicts (migration-history, KNOWN_ISSUES, CURRENT_STATE): reconcile by full migration filename against the live ledger; never take one side wholesale; row numbers assigned only against the latest integrated ledger; preserve other branches' pending entries; update cross-references together.
- Migrations: this plan applies NO migration. Already-applied artifacts keep their verified applied status (#646's 20260908120000; #599's 20260904180000 and 20260906120000). Currently unapplied migrations stay unapplied. The rollout manifest (section 5) maps original filenames to renamed/restamped successors so no logical migration is listed twice.

## 1. Business outcomes (priority order)

A. Invoices created the evening of 2026-09-30 (Chicago) price at the 2026 season, and preview matches save. Done = #599 deployed and observed for: Sept 30 / Oct 1 boundary (controlled clock cases in isolation, safe observation on production), a browser outside Chicago, new vs existing vs split invoices, preview change while a request is pending, blank date, invoice-date-based due dates. Deadline: deployed and observed by 2026-09-26; coordinator checkpoint 2026-09-22 with time for one more repair/review cycle.
B. Retry protection for the job-to-invoice transfer UI flow against the installed server: a retried transfer from the named screen does not create an additional invoice set beyond the intended one. Server-side guarantees stay separately open (section 5).
C. Retry protection for the inventory hold/adjustment UI flow against the installed server, plus receiving and vendor-payment consumers of the shared hook, plus a written, tested staff procedure for the locked-request states that never asks staff to inspect browser storage or SQL. Server-side authorization defects stay separately open with a dated owner.
D. The repo's record of applied migrations is true: #646 merged with bytes identical to the live ledger artifact (md5 verified), applied status recorded outside the SQL file, role prerequisites of the supported environment VERIFIED (or the unsupported boundary documented with an owned forward remedy).
E. A dated, owned disposition for deleted-customer-document access (#635).

## 2. FINISH — scheduling rule and per-PR work

Scheduling rule (coordinator): a READY #599 takes the next product landing slot ahead of everything else. #650 lands only if it does not consume a slot a ready #599 needs. Otherwise the next slot goes to ready #638, then #646, then #624. #630 and #631 come after ready product work; #631 is last. The wording PR (section 4) fits into the same queue. Nothing waits behind an unready candidate.

1. #599 — owner: this review session (new checkout on the PR branch). Update to main; reconcile the 3 doc conflicts per the ledger rule; diagnose the REAL failing assertion in worktree-awareness-lib.test.mjs and reproduce its cause before claiming CI fixed; reply to the moot CodeRabbit thread with the live ledger version; keep #637's delivery-signature changes intact; completion standard = outcome A; checklist + card.
2. #650 docs — coordinator; checklist.
3. #638 — owner: existing live session. Adjudicate the 2026-09-11 00:28Z CodeRabbit outside-diff Major (comment mask per scan window + multiline regression cases, or a reasoned reply); list every migration in the diff (20260908130800 new; 20260908130900 renamed from 20260905210000; parked 20260905200200 edited) and label the merge SOURCE/UI-ONLY in PR and changelog; prove the UI against the INSTALLED RPC contract AND the future parked contract; checklist + card.
4. #646 — owner: existing session. Verify branch bytes = live artifact (md5 7f080ba8…, 20,875 bytes); reply to the has_function_privilege Major with role-prerequisite documentation AND verification for the supported environment; get the reviewer's explicit disposition (do not resolve the thread to hide it); applied status + qualifications outside the SQL; whole-PR proof; checklist.
5. #624 — owner: its existing checkout/session. Update to main; compatibility matrix against OLD (installed) and NEW (parked) server contracts: overlapping same-key requests, lost responses, existing receipts, reloads, multiple tabs, cleanup failures; regression proof for the other consumers of useUncertainMutationIntent and isDefinitiveRpcRejection (receiving, vendor payment), mounted cross-tab and storage-divergence cases; staff recovery procedure; renumber ledger row against the integrated ledger; Codex review on final SHA; merge SOURCE-ONLY. Open a KNOWN_ISSUES entry with an owner and a near-term exposure-assessment date (2026-09-18) for the server defects the parked migration fixes (null-force bypass, deactivated-staff holds).
6. #630 — owner: existing live session. Multi-target rejection BEFORE any network call; the two-reading parse never drops a version containing --admin; single-request path bounded (executable fallback, git/proof reads); subprocess test with delayed successful responses; checklist. After it lands and its tests pass on resulting main: close #626 with a comment linking the replacement; keep the branch.
7. #631 — owner: a new small session, LAST. Bounded repair of cluster() so a flag followed by ; && | || & ) or a redirection is still recognized. Preservation criterion: run main vs candidate over the existing deny/allow corpus plus the reproduced boundary cases (`git clean -fd; echo done`, `git clean -fd&& echo done`, `git clean -fd| cat`) and the alias cases (rm -Rf, rm -r -f, Remove-Item -Recurse -Force, git branch -Df, git clean --force -d): zero lost existing denials, every changed allow explained. Real-hook subprocess proof. No shell-parser rewrite. Checklist.

## 3. PARK (owner acknowledges custody in chat; coordinator removes from queue; resume condition in the PR comment)

- #612: resume only if the 2026-09-25 measurement shows session-state Reads still a top blocker. Its current worker stops after acknowledging.
- #647: resume only after the coordinator recommends a CodeRabbit request strategy in cost/reliability terms and Mason authorizes it; the coordinator performs the setup. Mason is not asked to design the mechanism.
- #605: parked. A settings.json-only extraction is a SEPARATE decision for Mason with exact scope and behavioral allow/deny proof; not pre-authorized.
- #544: parked. Owner task due 2026-09-18: classify its 5 open Codex P1s "present on main today" vs "introduced by this candidate"; only the former go to KNOWN_ISSUES with an owner. Do not delete the branch.
- #635: parked with a dated disposition (owner: a new session; due 2026-09-17). The disposition distinguishes: future authenticated requests, direct signed-URL creation, existing bearer URLs, CDN-cached responses after expiry, and already-downloaded copies; verifies the applicable expiry/cache behavior; recommends a supported mitigation or an escalation path (revocation via provider support is possible per current docs). It does not authorize contacting support, deleting objects, rotating keys, or applying policy. The narrow subset (remove the permanent uploader exception + UI helper that never mints signed URLs) is assessed separately with an accurate "reduces, not revokes" claim. MASON then accepts the residual risk or authorizes the mitigation.

## 4. CLOSE (branch kept; comment links the reason)

- #634: closed now. Replacement: ONE focused PR (owner: one session; implementation timebox 1 hour; goes through the normal checklist) that corrects the pr-merge-guard message strings and the runbook to the ACTUAL authorized CodeRabbit request path, removes the reference to the disabled hourly job, and carries the section-6 guidance: only TESTED tool/path examples that current guards actually accept, distinguishing ordinary protected source (native Read works) from wrapper-owned proof/state files (no supported direct read on main; say so). Denial texts verified through the actual hook. No decision logic changes. Memory destination: project memory `feedback_mason-wants-fewer-guards-more-product-work-2026-09-10.md`.
- #626: close after #630 lands (section 2 item 6).
- #449: MASON must accept this sentence before it is closed: "Retire the 3,700-line actor-binding parser rewrite; main keeps the capped best-effort hook; exact-SHA Codex review and CodeRabbit remain the pre-merge controls; any concrete live-function actor-binding finding is tracked as its own owned item; this is a change from 'fix #449', not housekeeping." Before closing: inventory C:\CRX_Manager\.codex\worktrees\pr449 and C:\CRX_land449 for unpushed work and push or archive it; keep the bypass corpus reference in the closing comment. If Mason does not accept, #449 is PARKED.

## 5. Server rollout follow-up (no apply now)

Owner: assigned by the coordinator to one session; manifest due 2026-09-24. Lists every unapplied migration in these PRs with dependencies and original→successor filename mapping: the stranded 20260905* commission/invoice-number cohort (7 files absent from live), #638's 20260908130800/130900, #624's 20260908130000, #635's (to be restamped), and the ordering guard's name-based refusal. Per item, three separate states: "source merged", "production UI verified", "server fix live". Each apply needs Mason's fresh explicit approval after its business effect, verification, and recovery path are explained.

## 6. Guard policy, 2026-09-11 to 2026-09-25

- No change to any guard's DECISION logic except #630 and #631 above.
- Wording/runbook PR per section 4 (#634 replacement) is the only guard-adjacent PR.
- "Work around" means the same legitimate READ or ordinary permitted operation in a form the guard accepts. It never means packaging a refused protected-path write, proof write, or production action into a script.
- Baseline captured at freeze start (2026-09-11) by a read-only session using scripts/claude-usage-report.mjs: attempted operations, denials per category (all categories), repeated identical failures, successful supported alternatives, estimated time lost, missing data noted.
- 2026-09-25 measurement by a read-only session: same fields against the baseline, plus outcomes A–E status. Outcome A reported as on-track or at-risk against 2026-09-26, not "failed" merely because it has not shipped. No guard change is proposed from denial counts alone.

## 7. Not in this plan

Worktree/branch cleanup (126 worktrees, 64 remote branches): separate reversible task after the queue drains. Any live migration apply. Any change to settings.json.

## 8. Follow-ups discovered during execution (2026-09-11)

- PRODUCT (not guard, not frozen): expired pending-request records leave a locked dialog that cannot be closed and reopens on every visit once the 23-hour safe-retry window passes. Pre-existing on main for Inventory Receive, QuickReceive, ReceivingHub, NewVendorBill; #624 extends it to Adjust and Hold. Interim: the staff recovery procedure in INVENTORY_RULES (ships with #624). Fix: an admin "verified, clear this request" control. Owner: unassigned; coordinator to assign a session and a queue slot. Recorded in KNOWN_ISSUES by the #624 lane.
- #612: PARKED by Mason's own answer in the #612 lane's chat (~02:10Z). Lane closed; head f415258e0; two codex-connector threads answered in prose and left open for the 09-25 resume.
- #624 sequencing: #599 first, then #624 with its docs batch (staff procedure, KNOWN_ISSUES owner + 09-18 date, compatibility note, stale-line fix, PR description) in ONE push, one review slot (14:22Z earliest), SOURCE-ONLY merge. Pending Mason's answer in the #624 lane's chat.
- Coordinator decisions outstanding: KNOWN_ISSUES owner for the 09-18 exposure assessment (suggested: #624 lane, reassignable); #624 vs #638 landing order (decides who renumbers ledger row 924).
