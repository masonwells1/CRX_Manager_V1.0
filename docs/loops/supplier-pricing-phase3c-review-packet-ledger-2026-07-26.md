# Supplier Pricing Phase 3C Review-Packet Overnight Ledger — July 26, 2026

## Mission

- Mission doc:
  `docs/loops/supplier-pricing-phase3c-review-packet-loop-2026-07-26.md`
- Worktree:
  `C:\Users\mason\.codex\worktrees\phase3c-overnight-20260726\CRX_Manager`
- Branch: `codex/phase3c-overnight-20260726`
- Created from: `origin/main` /
  `052b2171821dc7ffd965b4edb4b6de4ef8fda511`
- Fixed trusted CI bootstrap ancestry floor:
  `d787b7e0e1c9cb5eb85c86b448e68b1ca43fce9c` (#255 after #251/#253;
  confirmed to lack both the
  checker and trusted target workflow; protected `main` descendants remain
  eligible without repinning).
- Final allowed state: `PARKED — PR #246 OPEN; ACCEPTANCE REQUIRES ITS CURRENT
  HEAD TO MATCH A RECORDED EXACT-REVIEWED SHA, REQUIRED CHECKS/CODERABBIT, AND
  EXTERNAL TRUSTED-WORKFLOW/RULESET ACTIVATION PLUS PROOF`
- Forbidden interpretation: neither this ledger nor an agent verdict approves
  Product classifications or authorizes a Stage C migration/live apply.

## Current exact review acceptance contract

Historical `SHIP-WITH-FOLLOWUPS` records below remain provenance only. The
current candidate qualifies for proof only when the resolved Opus review ends
with exactly `FINAL_VERDICT: SHIP` and contains no actionable
BLOCKER/HIGH/MED/LOW finding or required fix/follow-up. NIT-only polish remains
nonblocking. Any different terminal token or contradictory structured prose
invalidates the proof and starts a new exact-SHA correction cycle.

## Owner-review packet closeout — 2026-07-27

### PR #246 containment correction — still PARKED

Current containment-correction provenance is fail-closed:

- `b30769b381d80b901aed73c254f5b9242f933e5a` is rejected. Its recorded
  containment proof checked 51,841 paths, 58 commits, 52,264 candidates, and
  823,721,338 logical bytes, but the GitHub Node 24 Linux job then exposed a
  deterministic glibc allocator abort in the 128 KiB embedded-Base64 boundary
  case.
- `ce16574b02ec9c4e40c351f69ba3e237caf2e9c4` is also rejected. It corrected
  only the three-file allocator-crash path; follow-up review still required
  PEM EOF finalization, bounded embedded whitespace and canonical padding,
  tri-state/over-bound gzip parsing with exact maximum-header overlap,
  authoritative alternate-index scanning, a commit-message hook, and fatal
  exact UTF-8 semantic parsing.
- A later literal Opus 5 review of exact `b30769b3` ran as
  `2026-07-27T23-29-35-252Z-3ef35b3a`. Statements later in this append-only
  historical ledger that no Opus 5 review had run refer to their older cycles
  and do not supersede this later exact-SHA provenance. Literal Opus 5 later
  reviewed exact `fa78c4f7` as `SHIP-WITH-FOLLOWUPS`; subsequent
  transfer-alignment and bounded-read corrections superseded that head.
  Acceptance always requires the current PR head to match a fresh exact-SHA
  wrapper capture.
- `49eb3f011da17d541bcd81cdd437da29db0c707e` contains the separately reviewed
  moving-main bootstrap/CI invariants only. It is an intermediate base, not an
  accepted containment candidate. The successor containing all bounded
  corrections remains pending its exact SHA, full proof, and fresh required
  reviews.
- Pre-freeze bounded-successor proof used synthetic data only. Three Node
  syntax checks passed; the focused Windows suite passed in 167.5 seconds; a
  clean disposable `node:24-bookworm` repository on Node 24.18.0 passed the
  same focused suite; and the real full worktree containment sweep passed for
  51,845 paths, 51,854 candidates, and 793,364,183 logical bytes. The focused
  suite includes real alternate-index and commit-message Git commits, exact
  gzip-boundary splits, Base64 boundary/fuzz/non-recursion cases, and fatal
  UTF-8 rejection. Local docs, shared-agent guidance, workflow, and mission-doc
  checks also passed. These are pre-commit proof facts, not an exact-SHA review
  or acceptance verdict.

No private packet was recaptured, regenerated, opened, or displayed during
this correction. No classification, flag, migration, live-data, deployment, or
merge authority changed.

Two real PR review findings are under bounded correction: ignored ordinary
non-regular filesystem entries (including tooling symlinks) must not be
dereferenced, while forbidden Phase 3C paths remain a fail-closed violation;
and future PR containment must run from `pull_request_target` using only the
trusted base workflow/checker while scanning fetched candidate Git objects, not
candidate files. The new target workflow has read-only `contents` permission,
no secret use, no candidate checkout, no candidate dependency/config loading,
and a 12-minute bound. The object fetch disables local Git hooks; candidate
Git configuration/hooks cannot enter a commit object and are never loaded.

This is intentionally a **future-PR guard**. PR #246 is open, and its
historical base `0e058804090b84f9a14024a6666021a271bb1f71` predates this workflow, so GitHub
does not evaluate it for this PR. The existing `pull_request` job remains
bootstrap/defense-in-depth only and cannot be represented as a trusted-base
hard gate for PR #246. This record remains `PARKED`; it does not authorize a
packet review, classification, Stage C action, live mutation, flag enablement,
deployment, or merge.

External enforcement remains absent even after this local workflow correction.
Live GitHub `protect-main` ruleset `18904218` does **not** require the new
trusted containment workflow. Ordinary required status checks are not bound to
an immutable workflow/event identity, so they do not by themselves provide
non-spoofable `pull_request_target` enforcement. This remains `PARKED` pending
an organization/enterprise required-workflow mechanism or equivalent external
App/ruleset enforcement, followed by real post-activation proof. This record
does not represent that external control as configured or PR #246 as protected
by it.

Historical #245 reconciliation was repeated normally: merge
`c6c5ea3ae0e2af5c67f8c55d64d930877e5c6cc1` has parents
`28425be514a8f30225189533c88b108d807b58bd` and
`0e058804090b84f9a14024a6666021a271bb1f71` (`#245`), with no conflicts or
containment-file overlap. `#245` changes only production-health skill guidance,
Dependabot, changelog, and dependency metadata. Exact Git object checks prove
that new base lacks both the checker and trusted target workflow, so the
candidate-controlled bootstrap pin was updated to that then-current SHA. The
ruleset gap above remains unresolved; this reconciliation does not mark the PR
ready. Historical #247 reconciliation then merged `origin/main`
`07a3d4833cf8517ea53831a6ff0976b4a6c4c67f` (#247) through normal merge
`98969765030d8ada43566fad606f4d74057d1e17` without conflicts. #247 changes
only the active-profile RLS migration and reference docs; it has no Phase 3C
containment overlap. Exact object checks proved that #247's `07a3` base lacked
both guard files, so its then-active one-time CI bootstrap pin was
`07a3d4833cf8517ea53831a6ff0976b4a6c4c67f`. Historical #248 reconciliation merged
the docs-only `origin/main` `d3bac970804bf6130b6bf6259eed05fad0367a9c` through
normal merge `d0ff8e0b5ee59cd56f1c093fea92dba266fd17f3` without conflicts.
Exact object checks confirmed that historical base also lacked both guard files.
Historical #250 base `3ca289c5c5b91c800a350ab828a6000bd3d399e6`
followed #249 and was incorporated through normal merge
`35ec8fde0dc1d0ebce956f64d4320dc4d5536820`. Historical #253 base
`dd33f162365913867ff3aefd0b7e540a531d102f` was incorporated through merge
`8de484afe9eb4f4e2c50ce9611538535caf533d8`. Historical #251
baseline-refresh base `2a9e9252a62642e51b71c248c8c2f149a9a434d9` was followed
by #253. Current floor: #255 base
`d787b7e0e1c9cb5eb85c86b448e68b1ca43fce9c`, the sole current fixed trusted
bootstrap ancestry floor, also lacks both guard files.

Published `f3b636590a784b2cf9bf4e03bc47da55adbc4e60` arrived concurrently as
provenance-unattributed publication-parent hardening. It was adopted only after
this bounded review confirmed its held-directory descriptor/path inode
revalidation, and the POSIX relocation fixture now requires the exact safe
`private artifact parent changed before publication` failure. It does not close
the external trusted-workflow/ruleset gap; PR #246 remains `PARKED`.

The published PR head `bc305778037fe064b272ebae0aca567ed5f2f8e3` received a
technical Sol `CLEAN` review. This is technical evidence only: acceptance
requires the PR's current head to match a recorded exact-reviewed SHA, and any
later head change invalidates prior head-bound evidence and requires a fresh
exact proof/review cycle.

### Reviewed packet commit `d38d41f63e68971f08f7158bf5a104af62d232aa` — PARKED

`d38d41f63e68971f08f7158bf5a104af62d232aa` has immutable parent
`07813f698e4cf12e09fd4378837f5134ed5c3850`, the engineering candidate whose
Graphify evidence reports 8,389 nodes and 17,472 edges. The parent focused
packet proof passed in 58.9 seconds; parent containment passed for 51,820
paths, 11 commits, 51,888 candidates, and 795,308,573 logical bytes. Normal
`07813f69` commit hooks passed: 302 test files, 3,985 passed, 118 skipped;
lint/typecheck/build/workflows/guards/docs/dependency integrity were green, with
four existing lint warnings.

- Orchestrator read-only capture recorded count 604 at
  `2026-07-27T11:14:57.085929Z`. Guard evidence is aggregate-only: correct
  project, Stage A ledger present, valid migration high-water,
  `product_families_count=0`, and `supplier_cost_basis_enabled=false`.

| Artifact | Semantic SHA-256 | Byte proof |
|---|---|---|
| Snapshot | `b1e61596d3f7b0a1059fb8c57457bca351cffce6374e57d2771ce642ed7a074f` | 359,426 bytes; `1f85d0d3af40b9740bcb0961beaa0d3eb122e8eea021a2209d056b0b24fec934` |
| Manifest | `4f2977b1ef8058266f3e1c80448ba09506816d94079d4f563d17fbadbfb788b0` | 1,580,465 bytes; `706ec4bc57e5c971e56e71bdff29ab0d7a16a824e84f2dd2946b968871082507` |
| Owner decision sheet | `4eff9c27ee8d61345c328e0130a2fe26926bb809436f1c95d3c46ceb9fe4a3c8` | 123,853 bytes; `c976bd8b3aa02b49b269b4674906cf0067725aa802c776ac85e57c9f1992b276` |

- Manifest verify and reproducibility passed at count 604 with the same
  semantic hash. Owner-sheet write/verify passed at count 604 with the same
  semantic hash. These are the only current owner-review packet values; every
  older packet hash below is historical and invalidated. The packet has been
  regenerated and verified, but owner review remains closed until PR #246's
  current head matches a recorded exact-reviewed SHA, required checks and
  CodeRabbit are resolved, and external trusted-workflow/ruleset activation is
  proven.
- Exact `d38d41f` reviews: independent Sol returned `FIX` for documentation
  status/provenance findings only (HIGH: premature READY claim; MEDIUM: stale
  uncommitted/no-self-SHA and regeneration wording). Sol found code sound:
  focused proof, syntax, `check:docs`, and `git diff --check` passed; containment
  passed for 51,825 paths, 12 commits, 51,895 candidates, and 795,855,426
  logical bytes, with no private content inspected. Luna `gpt-5.6-luna`,
  session `019fa353-0229-74a0-a350-d24e700437b7`, returned `PASS`; containment
  passed for 51,827 paths, 12 commits, 51,897 candidates, and 796,622,451
  logical bytes. Its sandbox `EPERM` temporary-fixture limitation was disclosed.
- Claude wrapper run `2026-07-27T11-31-40-990Z-ebe70a0a` reviewed exact
  `d38d41f` at `xhigh`: requested `opus`, resolved helper
  `claude-haiku-4-5-20251001` and reviewer `claude-opus-4-8`, and returned
  `SHIP-WITH-FOLLOWUPS` with no BLOCKER/HIGH finding. No literal Opus 5 review
  is claimed. Its conditional MEDIUM bootstrap mismatch is historical review
  evidence only: a fresh fetch then confirmed `origin/main` at
  `052b2171821dc7ffd965b4edb4b6de4ef8fda511`; this branch was 0 behind / 12
  ahead. The LOW stale-provenance follow-up agreed with Sol; its fetch-depth
  cost was harmless and did not warrant a change then.
- Exact `a2002c3c35d78be07690ff643d8d4c7dfceee0cb` review: Sol returned `FIX`
  solely for stale present-tense historical provenance in these public records.
  Luna `gpt-5.6-luna`, session `019fa36b-2f16-7390-b080-9f7808474f82`, returned
  `PASS`. Claude wrapper run `2026-07-27T11-58-55-371Z-99f2ff2b` reviewed exact
  `a2002c3c` at `xhigh`: requested `opus`, resolved helper
  `claude-haiku-4-5-20251001` and reviewer `claude-opus-4-8`, and returned
  `SHIP-WITH-FOLLOWUPS` with no unresolved BLOCKER/HIGH/MED finding.
- Exact `a7506a01a9d65849a160ee608cdb36b4d60501ba` review: Sol returned `FIX`
  for two MEDIUM current-document contradictions and accepted LOW follow-ups;
  its focused, syntax, documentation, workflow, and containment proof was
  green for 51,838 paths, 14 commits, 51,912 candidates, and 799,476,952
  logical bytes. Luna `gpt-5.6-luna`, session
  `019fa381-40b5-77e0-964f-d7aafc35b7fd`, returned `FIX` for MEDIUM summary
  provenance; its focused fixture sandbox limitation was `EPERM` only. Claude
  VERIFIED run `2026-07-27T12-30-09-152Z-663c4f7b` reviewed exact `a7506a01`
  at `xhigh`: requested `opus`, resolved helper
  `claude-haiku-4-5-20251001` and reviewer `claude-opus-4-8`, and returned
  `SHIP-WITH-FOLLOWUPS` with no BLOCKER/HIGH finding. The conditional
  bootstrap-base drift disposition was fail-closed: fetch `origin/main` again
  before publication. No CI/code change was warranted while that historical
  base remained pinned to `052b2171821dc7ffd965b4edb4b6de4ef8fda511`.
- Exact `3c156065680fb2cc3efc6a35c0d78158e84da924` non-final exact review
  cycle: Sol returned `CLEAN` with no unresolved BLOCKER/HIGH/MEDIUM finding,
  and Luna `gpt-5.6-luna`, session
  `019fa399-ea5b-7b93-953d-f27f42eef3d4`, returned `PASS`. Sol's retained LOW
  follow-ups are historical imperative plan wording, a fresh bootstrap refetch
  before publication, and the Ubuntu protected-PR CI requirement. Accepted
  conservative generic-signature false-positive and precommit-cost LOWs require
  no containment-code change. Git ownership/temp `EPERM` and a missing Graphify
  Python runtime were environment-only limitations. Claude VERIFIED run
  `2026-07-27T12-49-03-719Z-95010716` reviewed exact `3c156065680fb2cc3efc6a35c0d78158e84da924`
  at `xhigh`: requested `opus`, resolved helper `claude-haiku-4-5-20251001`
  and reviewer `claude-opus-4-8`, and returned `SHIP-WITH-FOLLOWUPS` with no
  BLOCKER/HIGH finding. Its MEDIUM finding was this summary's stale
  `a200`/`d38` correction-cycle provenance; the ledger's `a750`/`a200`
  provenance is the corrected source of truth. The combined `3c156065` cycle
  was not final because that resolved Opus MEDIUM required the `a10bad90`
  correction.
- Exact `a10bad90e990e83a2c650ee66a44828f317797a7` is the immediate reviewed
  source for this correction, not a final acceptance claim. Independent Sol
  returned `FIX` for one MEDIUM incomplete `3c156065` durable-review chain.
  Luna `gpt-5.6-luna`, session `019fa3ae-40b6-7ff1-92c1-282bdac567d3`, returned
  `FIX` for one MEDIUM stale active loop charter that still directed SAFE PREP,
  595-active, and capture/materialization work. Claude VERIFIED run
  `2026-07-27T13-11-06-599Z-9df51ac6` reviewed exact `a10bad90` at `xhigh`:
  requested `opus`, resolved helper `claude-haiku-4-5-20251001` and reviewer
  `claude-opus-4-8`, and returned `SHIP-WITH-FOLLOWUPS` with no BLOCKER/HIGH
  finding. Its operational bootstrap-pin MEDIUM was mitigated by the fresh
  refetch but must be rechecked immediately before any push. Accepted LOWs are
  the 100,000-candidate ceiling/precommit cost and the unreachable current
  `ZERO_SHA` push nit; neither warrants a code change. A final exact review of
  this correction's containing SHA remains pending.
- Exact `80741157bb6b127f88d26cd1b4c8c0d5d33bd357` is the reviewed source for
  this publication-reconciliation correction, not a final acceptance claim.
  Sol returned `FIX` for a HIGH publication blocker: `origin/main` advanced and
  the loop omitted the validator's exact `## Definition of done` heading. Luna
  `gpt-5.6-luna`, session `019fa3c4-0937-7fc0-a83c-2bbdb9af113a`, returned
  `FIX` for the validator issue and external-base drift. Claude VERIFIED run
  `2026-07-27T13-36-27-572Z-3b602557` reviewed exact `80741157` at `xhigh`:
  requested `opus`, resolved helper `claude-haiku-4-5-20251001` and reviewer
  `claude-opus-4-8`, and returned `SHIP-WITH-FOLLOWUPS` with no BLOCKER/HIGH
  finding. Its operational bootstrap MEDIUM requires the current base to be
  rechecked immediately before any push; engineering and privacy evidence were
  otherwise clean.
- Historical first branch reconciliation: normal non-rebased merge
  `a9817b05d35bc39e13bad94d7680181461b6fcb7` incorporated current
  `origin/main` `48bd1982c9553c2022fe96be771974ad699be12e` without conflicts
  and preserved feature history. That historical main lacked the containment
  checker, so its then-current one-time CI bootstrap pin was exactly
  `48bd1982c9553c2022fe96be771974ad699be12e`. It was later superseded by the
  current-base reconciliation below.
- Historical #245 branch reconciliation was superseded by the current #247
  base: normal non-rebased
  merge `c6c5ea3ae0e2af5c67f8c55d64d930877e5c6cc1` incorporated
  `origin/main` `0e058804090b84f9a14024a6666021a271bb1f71` without conflicts.
  That historical base lacked both containment guard files. Historical #247
  normal
  merge `98969765030d8ada43566fad606f4d74057d1e17` incorporates
  `origin/main` `07a3d4833cf8517ea53831a6ff0976b4a6c4c67f`, which likewise
  lacks both guard files; its then-active bootstrap pin was
  `07a3d4833cf8517ea53831a6ff0976b4a6c4c67f`. Historical #248 docs-only base
  was `d3bac970804bf6130b6bf6259eed05fad0367a9c`. Historical #250 base and pin
  were `3ca289c5c5b91c800a350ab828a6000bd3d399e6`, incorporated through normal
  merge `35ec8fde0dc1d0ebce956f64d4320dc4d5536820` after #249. Historical #253 base
  and pin were `dd33f162365913867ff3aefd0b7e540a531d102f`,
  incorporated through merge `8de484afe9eb4f4e2c50ce9611538535caf533d8`.
  Historical #251 baseline-refresh base and pin were
  `2a9e9252a62642e51b71c248c8c2f149a9a434d9`. Current #255 base is the fixed
  trusted ancestry floor `d787b7e0e1c9cb5eb85c86b448e68b1ca43fce9c`.
  Refetch and verify current `main` descends from that floor before publication; the external
  trusted-workflow/ruleset enforcement gap remains `PARKED`.
- Owner gate: Mason must not review the private owner sheet yet. All decisions
  remain `PENDING` across all 604 rows; no Product classification is approved.
  Acceptance requires PR #246's current head to match a recorded exact-reviewed
  SHA; any later head change invalidates that evidence. Before any future
  publication, freshly refetch `origin/main` and verify it descends from
  bootstrap floor `d787b7e0e1c9cb5eb85c86b448e68b1ca43fce9c`. Required checks —
  including Ubuntu PR CI — real CodeRabbit findings resolved, and external
  trusted-workflow/ruleset activation plus post-activation proof remain
  mandatory. Only afterward may Mason review every
  decision field and unresolved acknowledgment before a separate Stage C design
  mission is considered. No Stage C SQL/migration/apply, live mutation, flag
  enablement, deploy, or merge is authorized here.
- SHA ledger rule: this correction cycle was produced by reviewed source
  `a7506a01a9d65849a160ee608cdb36b4d60501ba` with parent `a2002c3c`.
  That durable review-cycle anchor is not a claim about any containing
  correction commit's immediate parent. Identify each containing/final SHA only
  through Git and PR metadata, never by guessing it here, and never
  mechanically roll the anchor forward in a later documentation correction.
  Any future model alias must record its resolved model truthfully.

### Prior rejected implementation `c1b54a5b603ee6f5dc5a6edc79979326a40dfdd8` — historical correction cycle

`c1b54a5b603ee6f5dc5a6edc79979326a40dfdd8` is rejected. Its immutable parent
is `3695f42e3ec6f57dae4d07d534a4a191bfa2a46d`; `c1b54a5b` was the implementation
SHA for the preceding correction, not a passing release.

- Graphify was refreshed at exact rejected `c1b54a5b`: 8,390 nodes and 17,479
  edges. It confirmed the atomic writer's direct packet consumers; current
  source remains the authority for those edges.
- Independent Sol returned `PASS` at `c1b54a5b`, but that pass was invalidated
  by Luna `gpt-5.6-luna`, session
  `019fa313-ee55-7042-9074-08b0be3dd747`, returning `FIX`: the atomic writer
  opened and wrote its temporary artifact before acquiring the stable parent,
  so a POSIX parent relocation could strand intended private temp bytes in the
  moved original directory.
- Its accepted correction captured the initial parent identity, acquired the
  nonreentrant stable-parent CWD lease before creating a temp file, and retained
  it through relative-basename writing, validation, publication, readback,
  descriptor close, and owned-temp cleanup.

### Earlier rejected implementation `3695f42e3ec6f57dae4d07d534a4a191bfa2a46d` — historical correction cycle

`3695f42e3ec6f57dae4d07d534a4a191bfa2a46d` is rejected. Its immutable parent
is `2adff51bfa27ea50274230845bb4c89f4037313e`; `3695f42e` was the implementation
SHA for the preceding correction, not a passing release.

- Graphify was refreshed at exact rejected `3695f42e`: 8,382 nodes and 17,446
  edges. It confirmed the GitHub-event containment entry point, its packet-test
  caller, and the atomic writer's capture/manifest/owner-sheet consumers;
  current source remains the authority for these edges.
- Independent Sol returned `FIX`: owner CSV headers could cross CR/LF/VT/FF,
  NEL, U+2028/U+2029, and C0 record boundaries that direct and streaming
  detectors handled differently.
- Luna `gpt-5.6-luna`, session
  `019fa2e4-9bc8-71a3-a64a-a5baef795e78`, returned `FIX`: textual CI
  compatibility could accept a dead marker, `rev-list` materialized an
  unbounded history before rejection, and final parent-path revalidation left
  a publication TOCTOU, and ledger/summary bookkeeping was stale.

At that historical point, this rejected correction was
`PARKED — TOOLING CORRECTION; HISTORICAL PACKET REGENERATION REQUIRED` pending
a frozen successor with exact-SHA proof and reviews. That superseded status
does not override the current parked status at the top of this ledger.

### Exact rejected candidate `2adff51bfa27ea50274230845bb4c89f4037313e` — historical SAFE PREP correction

This candidate is rejected. The private packet remains historical and
invalidated; nothing in this correction approves a Product, creates Stage C
SQL, changes the flag, accesses private rows, or changes a live system.

- Exact base: `052b2171821dc7ffd965b4edb4b6de4ef8fda511`.
- Graphify was refreshed at the rejected HEAD: `2adff51b` / 8,360 nodes and
  17,396 edges. It confirmed the containment checker imports the private
  artifact helper and is reached by the packet test; the atomic writer is used
  by capture, manifest, and owner-sheet entry points. Current source remains
  the authority for those edges.
- Luna `gpt-5.6-luna` session `019fa291-ede9-7ab0-8491-5c20f605d3d9`
  returned `FIX`: PR containment executed candidate-controlled code; worktree
  link/reparse rejection happened after the non-file skip; and large ignored
  owner sheets could bypass the ASCII-only stream matcher with Unicode
  whitespace.
- Fresh independent Sol returned `FIX`: UTF-16 (BOM/no-BOM and chunk
  boundaries), Git type changes/modes, in-place final-target truncation, CI
  ordering, bounded large Git blobs, and deterministic cap behavior all needed
  correction. The review also required no diagnostic content disclosure.
- Accepted local correction scope: post-bootstrap trusted-base checker
  execution for PR events with a validated candidate-root handoff;
  runner-bundled Node before any candidate Node configuration;
  UTF-8/UTF-16LE/UTF-16BE stream scanning at both UTF-16 byte alignments;
  mode/type rejection; 64 MiB per candidate, 2 GiB logical candidate-byte,
  and 100,000-candidate fail-closed caps; a 4,096 checked-commit cap
  (calibrated above this candidate's 2,073 commits) plus a
  remaining-candidate-budget history-path cap before per-path tree resolution;
  and fsynced-temp atomic replacement rather than live-target truncation.
- Bootstrap truth: exact base `052b2171821dc7ffd965b4edb4b6de4ef8fda511`
  has no containment checker. Therefore this introducing PR uses only its
  exact-base-SHA-gated, exact committed-head-blob/path-verified candidate
  checker; that coverage is explicitly candidate-controlled. After bootstrap,
  the CI workflow uses the exact trusted-base checker only when it contains
  the declared handoff protocol. A present-but-incompatible checker, or a
  missing checker on any later base, fails closed rather than falling back.
- Historical SHA bookkeeping: this earlier correction was later frozen as the
  rejected implementation `3695f42e`. Its introducing-workflow limitation is
  retained as historical context; current-cycle SHA bookkeeping is defined in
  the `3695f42e` section above.

At that historical point, this cycle was
`PARKED — TOOLING CORRECTION; HISTORICAL PACKET REGENERATION REQUIRED` until
focused/full proof and exact-SHA Graphify, Luna, independent-Sol, and
resolved-Opus reviews completed on a frozen candidate. That historical gate was
superseded by later correction cycles.

The bounded post-PARK safety recovery materialized a new packet, but both fresh
exact-SHA reviewers then returned `FIX` for the containment tooling. The packet
is therefore historical only and is not delivery-ready. This does **not** amend
or conceal the mission's six-cycle cap: the earlier candidate cycles remain
historical, and no packet approves Product classifications or a Stage C
migration/live apply.

- Rewritten-provenance candidate before this documentation update:
  `4f4b863b53596088d58162f44e2a6e2e43e58f79`. Every post-setup commit on that
  local candidate is authored `Mason <mason@croprxsolutions.com>`; its tree was
  checked against the local backup and matched. No remote branch exists.
- Fresh Luna exact-SHA review: session
  `019fa229-bc19-77b2-92bf-7f270e1cddc8`, verdict `FIX`.
- Fresh independent Sol exact-SHA review: candidate
  `d01a8f099394e8c7882736ac52fd81c6d2de8c15`, verdict `FIX`.
  Both reviews required fail-closed Git-root admission, structural/index/large
  ignored-file containment, full identity/read stability, and descriptor-safe
  writer corrections. Their findings are addressed by the new bounded local
  correction set, but that then-uncommitted set had not yet received exact-SHA
  reviews. Later successor cycles superseded that historical state.
- Prior Sol `FIX` findings being remediated: arbitrary external directories
  (including a sibling linked worktree) were admitted; tip-only containment
  missed a packet committed then deleted; filename/signature checks missed
  minified renamed packet structures; CI ran containment after other content
  processors; and synthetic Git fixtures did not prove real repository Git
  identity preservation.
- Follow-on orchestrator audit correction: a then-uncommitted recovery patch
  preserved the opened temporary file identity through the pre-rename boundary,
  scanned merge-resolution blobs with a merge-aware Git diff, and rejected BOM-
  prefixed packet structures or a worktree candidate whose identity/size changed
  while it was being scanned. Focused synthetic regressions covered all three;
  independent review was then required before freeze or packet regeneration.
- Blocked-freeze correction: the first historical commit-hook freeze attempt exposed that
  inherited Git hook variables could redirect the checker away from its explicit
  root, producing an invalid fixture range. Checker Git subprocesses now strip
  every `GIT_*` variable and use their supplied working root. The focused packet
  suite and the full correction-guard suite both pass under representative
   `GIT_DIR`/work-tree/index/common/object redirection variables; no commit was
  made by that recovery writer.
- Historical pre-freeze local proof for the then-uncommitted bounded correction:
  focused
  packet suite PASS in 29.3 seconds; full correction-guard suite PASS in 38.9
  seconds; typecheck PASS in 21.1 seconds; production build PASS in 18.2
  seconds; lint PASS with zero errors and four pre-existing warnings. The full
  containment range
  `052b2171821dc7ffd965b4edb4b6de4ef8fda511..d01a8f099394e8c7882736ac52fd81c6d2de8c15`
  PASSed in 22.4 seconds (`checked_paths=51810`, `checked_commits=6`). This is
  local tooling evidence only, not a substitute for then-required exact-SHA
  reviews or packet regeneration. Documentation drift and whitespace validation
  also PASSed on that pre-freeze record.
- A fresh live read-only capture completed at `2026-07-27T05:53:04.476876Z`:
  604 Products (595 active, 9 inactive), one active-return conflict, all 604
  unresolved, zero family assignments, and zero standalone classifications.
  The Stage A ledger row `20260723193312` is present, migration high-water is
  `20260726223520`, `product_families_count` is 0, and
  `supplier_cost_basis_enabled` is `false`.
- The prior capture, external count/hash binding, manifest write/verify/compare,
  and owner-sheet write/verify passed, but their resulting hashes below are
  **historical and invalidated** by this tooling correction. No private rows or
  identifiers are recorded in this repository.
- Full commit-hook proof passed on the earlier rewritten candidate: 302 files checked;
  3,985 tests passed and 118 skipped; lint had zero errors and four warnings;
  typecheck, build, agent workflows, correction guards, docs, and dependency
  checks passed.
- At that historical point, Graphify, Luna, independent-Sol, and
  latest-available Opus exact-SHA reviews were required after a correction
  freeze; the packet then needed regeneration and re-verification before
  protected-PR/CodeRabbit handling. That historical state was superseded and
  does not describe the current regenerated-and-verified packet.

### Position-sensitive containment correction

The next frozen candidate,
`2c56085d1ecee3ca223efb3ec0da58fa6ef858db`, was also rejected. Fresh
independent Sol returned `FIX` for three position-sensitive containment
classes: a non-comment/non-whitespace prefix before private JSON; a private
Product/manifest row later in a valid JSON wrapper or array; and an authentic
owner-sheet header after comments or late padding. Luna session
`019fa26f-821d-7611-b7d6-82d90ac35fb9` independently returned `FIX` and
required the adjacent nested/wrapped, escaped/malformed, beyond-first-1-KiB,
chunk-boundary, and greater-than-8-MiB ignored-file variants to be closed.

A then-uncommitted Terra sole-writer correction historically iterated over
every node in bounded valid JSON, applies decoded position-independent strong
property signatures to malformed or prefixed content, recognizes the exact
owner header on any line, and scans every byte of modified, untracked, and
ignored worktree candidates twice through a descriptor-bound reader with
complete stat identity and SHA-256 equality checks. The real repository
containment baseline passed across 51,810 paths in 64.4 seconds; the expanded
synthetic packet suite passed in 39.1 seconds. These are local correction
proofs only. The exact rejected SHA remains rejected and the historical packet
hashes remain invalidated. Its then-outstanding freeze/review/regeneration
requirements were superseded by later correction cycles.

Broader pre-freeze proof also passed: correction guards, typecheck, production
build, agent-workflow tests, documentation drift, dependency consistency, and
the five-slot mission-document validator. Lint reported zero errors and the
same four pre-existing warnings. Exact containment across
`052b2171821dc7ffd965b4edb4b6de4ef8fda511..2c56085d1ecee3ca223efb3ec0da58fa6ef858db`
passed after checking 51,810 paths and all 7 commits in 73.3 seconds.
`git diff --check` also passed. This was a then-uncommitted, unreviewed
correction and was not a final packet proof; later successor cycles superseded
it.

## Cycle table

| Cycle | Status | Exact SHA | Writer | Proof | Luna | Independent Sol | Resolved Opus review | PR / CodeRabbit | Next |
|---|---|---|---|---|---|---|---|---|---|
| 0 — preflight | DONE | `9bf567bf` | none | PASS | n/a | n/a | n/a | n/a | Cycle 2 bounded capture/generator work. |
| 1 — design adversary | DONE | `9bf567bf` | none | SHIP | n/a | n/a | `opus` → `claude-opus-4-8` | n/a | Cycle 2 accepts both LOW findings. |
| 2 — final correction 6 | HISTORICAL — invalidated by later FIX reviews | `d01a8f099394e8c7882736ac52fd81c6d2de8c15` reviewed; its then-uncommitted local correction was later superseded | historical `gpt-5.6-terra` recovery writer | earlier full proof PASS; latest bounded correction focused proof PASS | historical `FIX` session `019fa229-bc19-77b2-92bf-7f270e1cddc8` | historical `FIX` on `d01a8f099394e8c7882736ac52fd81c6d2de8c15` | exact-SHA review was then pending and later superseded | n/a | Historical freeze/Graphify/review requirements were superseded by later cycles. |
| 3 — private materialization | PARKED — packet regenerated/verified; owner gate closed | 604-row aggregate-only packet | orchestrator-supplied evidence | capture/manifest reproducibility/owner write-verify PASS | exact `d38` PASS; `EPERM` fixture limitation disclosed | exact `d38` FIX for docs-only status/provenance | `SHIP-WITH-FOLLOWUPS`, no BLOCKER/HIGH | PR #246 open; current head must match recorded exact-reviewed SHA | Wait for accepted protected PR and external enforcement proof before Mason reviews rows. |
| 4 — full review | DONE for reviewed `d38` packet and `a200`/`a750` provenance cycles; `3c156065` was non-final, `a10bad90` is a correction-review source, and `80741157` is the publication-reconciliation review source | `d38d41f63e68971f08f7158bf5a104af62d232aa`; later exact `a2002c3c`, `a7506a01`, `3c156065680fb2cc3efc6a35c0d78158e84da924`, `a10bad90e990e83a2c650ee66a44828f317797a7`, `80741157bb6b127f88d26cd1b4c8c0d5d33bd357`, and technical Sol `CLEAN` for `bc305778037fe064b272ebae0aca567ed5f2f8e3` | reviewer evidence | `a750` Sol focused/syntax/docs/workflows/containment green; 51,838 paths / 14 commits / 51,912 candidates / 799,476,952 logical bytes | `d38`/`a200` PASS; `a750` FIX session `019fa381-40b5-77e0-964f-d7aafc35b7fd`; `3c156065` PASS session `019fa399-ea5b-7b93-953d-f27f42eef3d4`; `a10bad90` FIX session `019fa3ae-40b6-7ff1-92c1-282bdac567d3`; `80741157` FIX session `019fa3c4-0937-7fc0-a83c-2bbdb9af113a` | `d38` docs-gate FIX; `a200` stale-history FIX; `a750` two MED contradictions; `3c156065` CLEAN but non-final due Opus MED; `a10bad90` FIX for one MED durable chain; `80741157` FIX for HIGH publication blocker; `bc305778` technical Sol CLEAN | `opus` resolved helper `claude-haiku-4-5-20251001` + reviewer `claude-opus-4-8`; `3c156065`, `a10bad90`, and `80741157` `SHIP-WITH-FOLLOWUPS`, no BLOCKER/HIGH | PR #246 open; later head change invalidates prior evidence | Re-fetch/recheck current `d787b7e0` bootstrap before future publication; the current head must then have recorded exact review. |
| 5 — protected PR | PARKED external gate | containing commit identified by Git/PR metadata | none | recorded exact review required for current PR head | pending current-head review | technical Sol CLEAN recorded for `bc305778`; any alias must resolve truthfully; no Opus 5 claim | pending current-head resolved Opus review | PR #246 open; required checks, CodeRabbit, and external enforcement remain mandatory | Do not merge or deploy; prove post-activation enforcement before acceptance. |
| 6 — closeout | PARKED — OPEN PR AND EXTERNAL GATES PENDING | aggregate-only packet values recorded above | Mason after gates | owner action blocked until external gates complete | `d38`/`a200` PASS, `a750` FIX, `3c156065` PASS but non-final, `a10bad90` FIX, `80741157` HIGH publication-blocker evidence, and `bc305778` technical Sol CLEAN recorded | `d38` docs-gate, `a200` stale-history, `a750` contradiction, `a10bad90` durable-chain, and `80741157` current-base/validator findings corrected; a later PR head requires fresh proof | exact `d38`/`a200`/`a750`/`3c156065`/`a10bad90`/`80741157` reviews recorded | PR #246 open; current head must match recorded exact-reviewed SHA | Re-fetch/recheck current `d787b7e0` bootstrap before future publication; private-sheet review only after checks, CodeRabbit, and external enforcement proof. |

## Cycle 0 — preflight

### Repository and collision evidence

- Base at mission creation: `052b2171821dc7ffd965b4edb4b6de4ef8fda511`.
- Mission setup candidate: `9bf567bf`.
- Aggregate preflight: 604 Products / 595 active; zero family assignments,
  non-`unknown` policies, packaging variants, tote flags, and Product families;
  one Product in an active return; Stage A ledger present; live high-water
  `20260726223520`; `supplier_cost_basis_enabled = false`.

### Graphify evidence

- Graphify refreshed from build `052b2171`.

### Live read-only evidence

Pre-setup aggregate check observed:

- Product count: 604
- Active Products: 595
- Family assigned: 0
- Non-`unknown` policy: 0
- Packaging variant set: 0
- Tote-only set: 0
- Product families: 0
- Products in an active return: 1
- Stage A ledger row: present as server version `20260723193312`
- Live migration high-water: `20260726223520`
- `supplier_cost_basis_enabled`: `false`

These were historical preflight observations, not a captured or approved
classification packet. They were superseded by the current regenerated-and-
verified packet and are not an instruction to refresh or materialize again.

### Agent and harness evidence

- `npm run agent-health` returned green during mission setup.
- Design-adversary review run
  `2026-07-27T02-32-15-864Z-687a8c46`: requested alias `opus` resolved to
  `claude-opus-4-8`; verdict `SHIP`. This is the latest available resolved
  Opus provenance for the run. No Opus 5 review ran; a literal Opus 5 rerun is
  optional if that backend becomes available.

### PROOF

- `PROOF — Ran:` aggregate preflight, Graphify refresh, and agent-health during mission setup.
- `PROOF — Saw:` values and provenance recorded above; no private Product rows entered the repository.
- `Not verified at original preflight:` Cycle 2 final candidate/review proof and
  all later cycles; that historical limitation is superseded by the records above.

## Findings and correction lessons

### Historical correction 6 — superseded Terra writer

- Exact reviewed candidate: `ee9183eef017affb8170fa8cdb7c4cb84e87c7c1`.
- Independent Sol: `gpt-5.6-sol`, session `019fa1b9-5cfb-7e33-81fd-23cb72636875`, verdict `FIX`.
- Luna bookkeeping review: `gpt-5.6-luna`, session
  `019fa1b9-5cf2-7023-aff1-0d79befd6b1d`, verdict `FIX` only for circular
  historical pending-review bookkeeping.
- Resolved Opus review: run `2026-07-27T04-03-37-498Z-1eab779e`, requested
  alias `opus` resolved to `claude-opus-4-8`, verdict `SHIP-WITH-FOLLOWUPS`;
  no Opus 5 review ran or is claimed.
- Historical writer: `gpt-5.6-terra`; its fix patch was then-uncommitted.
- Sol dispositions: clean-checkout Git-native containment and bounded worktree
  scan — implemented; pre-push/CI fail-closed wiring — implemented; v2 external
  hash/count binding for every consumer — implemented; exact Supabase warning
  envelope — implemented; parent-junction reader/writer safeguards and safe
  temp cleanup — implemented; malformed-manifest categorical JSON failure —
  implemented; claimed regression restoration — in focused proof; no finding
  was weakened or dismissed.
- Opus follow-ups: runtime enum allowlists/schema-registry equality —
  implemented; bounded Git/native scan and synthetic fake-repository isolation
  — implemented; live-hash provenance remains an orchestrator proof item and
  is not self-certified here.
- Sol regenerated the historical private packet at `2026-07-27T05:53:04.476876Z`
  after the rewritten safety-tooling candidate. Capture, external count/hash
  binding, manifest write/verify and deterministic compare, and owner-sheet
  write/verify all passed. The aggregate hashes below are historical. At that
  time exact final-SHA Graphify and Luna/independent-Sol/latest-available Opus
  reviews were pending. Both later exact-SHA reviews returned `FIX`, so this
  materialization was superseded by the current packet rather than a current
  regeneration obligation.
- Graphify had been refreshed after those then-uncommitted edits: 8,309 nodes /
  17,245 edges. Its report recorded HEAD `ee9183ee`; because Graphify records a
  committed HEAD rather than an uncommitted patch, an exact final-SHA refresh
  was then pending after a later freeze. That historical pending state is
  superseded.

| ID | Source | Severity | Exact evidence | Disposition | Owner | Fix SHA | Regression proof |
|---|---|---:|---|---|---|---|---|
| C2-LOW-1 | Pre-edit Claude review | LOW | Eliminate private-row stdout modes from the generator. | Was accepted and implemented in a then-uncommitted historical Cycle 2 candidate; focused synthetic regression passed. Final candidate proof/review was then pending and was later superseded. | Terra (historical) | then-uncommitted historical patch | `npm run test:supplier-pricing-phase3c-packet` PASS |
| C2-LOW-2 | Pre-edit Claude review | LOW | Add a hard Git containment guard for private artifacts. | Was accepted and implemented in a then-uncommitted historical Cycle 2 candidate; focused synthetic regression and containment check passed. Final candidate proof/review was then pending and was later superseded. | Terra (historical) | then-uncommitted historical patch | `npm run test:supplier-pricing-phase3c-packet` + `npm run check:phase3-private-artifacts` PASS |
| C2-LUNA-1 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | HIGH | Final output names could follow a link into the repository; private directory validation accepted relative input after resolution. | FIX in correction 1: require an absolute private directory before resolution; canonicalize existing parents; validate final output through the hardened artifact validator; reject final symlinks/reparse points and dangling links. | historical `gpt-5.6-terra` | then-uncommitted historical patch | `npm run test:supplier-pricing-phase3c-packet` PASS; file-symlink creation is unsupported on this host, while linked/junction-parent containment passed. |
| C2-LUNA-2 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | HIGH | Git containment comparison was case-sensitive and ignored files were outside the scan. | FIX in correction 1: fold path segments and private basenames to lowercase; add narrow case-insensitive ignored-file Git pathspecs for private basenames and `private-artifacts/**`. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Focused disposable mixed-case staged and ignored-artifact checker regression PASS. |
| C2-LUNA-3 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | HIGH | Capture proof did not assert the complete fixed Supabase CLI argv. | FIX in correction 1: assert the complete fixed argv including `CAPTURE_SQL`, with no obsolete `--sql`, no extra flags, and `shell: false`/bounded buffer retained. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Focused exact-argv regression PASS. |
| C2-LUNA-4 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | HIGH | Capture checked nonexistent `supabase/config.toml` instead of the linked-project marker. | FIX in correction 1: strictly read and validate `supabase/.temp/project-ref` as exactly `rhyzpcqhnizqbxphqdkr`; absent, malformed, and other-project markers fail closed. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Synthetic correct, wrong, empty, and multiline marker regressions PASS. |
| C2-LUNA-5 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | MEDIUM | Proposed array envelope did not match installed CLI evidence. | FIX in correction 1: require the observed non-array `{ boundary, rows, warning }` envelope, exactly one row, and that row's `phase3_snapshot`; malformed alternatives fail closed without raw output logging. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Focused valid and malformed-envelope regressions PASS. |
| C2-LUNA-6 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | MEDIUM | Capture ignored stderr despite known harmless CLI status output. | FIX in correction 1: accept only empty stderr or complete documented status lines; reject all other stderr without retaining raw output. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Focused stderr allowlist regressions PASS. |
| C2-LUNA-7 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | MEDIUM | Metadata validation accepted coercible family counts and loose UTC timestamps. | FIX in correction 1: require numeric safe-integer `product_families_count === 0` and a six-fractional-digit UTC timestamp, while retaining the existing default/ledger checks. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Focused invalid-count and invalid-timestamp regressions PASS. |
| C2-LUNA-8 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | MEDIUM | `unresolved_acknowledgment` started blank and the test did not validate every decision cell. | FIX in correction 1: make every decision cell literal `PENDING`, leaving only `owner_note` blank; parse every synthetic CSV row and assert each decision column. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Focused CSV parser-level regression PASS. |
| C2-LUNA-9 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | MEDIUM | Pre-commit integration lacked static and real-checker execution proof. | FIX in correction 1: statically assert the early hook order and execute the exported checker in disposable benign, staged mixed-case, and ignored-artifact repositories. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Focused hook/checker regression PASS; `npm run test:agent-workflows` PASS. |
| C2-SOL-1 | Sol live materialization cycle | HIGH | Read-only capture failed closed before writing an artifact. Aggregate-only follow-up: total Products: 604; malformed generic UUID text shape: 0; UUID version-nibble counts: 601 with nibble `4`, 3 with nibble `0`. | FIX in correction 2: validate the database-guaranteed canonical hexadecimal UUID text shape only; preserve strict sorted-order and duplicate rejection. Private materialization was then `PENDING` and is historical. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Synthetic version-`0`, malformed-shape/non-hex, sorted-order, and duplicate regressions PASS via `npm run test:supplier-pricing-phase3c-packet`; containment PASS via `npm run check:phase3-private-artifacts`. |
| C3-LUNA-1 | Luna cycle 2 (`gpt-5.6-luna`, session `019fa190-1cb7-73a0-8ba9-77c2eb3cf50b`) | HIGH | Snapshot format was read before approved absolute external basename/containment validation. | FIX: shared validated snapshot loader admits only the two exact approved basenames, validates containment/link/hard-link state before read, and binds basename to format. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Synthetic relative, repository, case, symlink, and hard-link regressions. |
| C3-LUNA-2 | same provenance | HIGH | Rehashed v2 snapshots could evade incomplete saved-snapshot checks. | FIX: one strict saved-v2 validator now enforces exact root/metadata/Product contracts, safety defaults, UUID/order, statuses, and self-hash. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Rehashed adversarial contract mutations reject through loader and consumer. |
| C3-LUNA-3 | same provenance | HIGH | Verification errors interpolated Product identifiers. | FIX: all manifest verification row failures use one-based index plus categorical reason only. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Spawned synthetic malformed-manifest output contains no UUID/name/SKU. |
| C3-LUNA-4 | same provenance | HIGH | Existing hard links and replacement races could endanger writes. | FIX: shared exclusive same-directory atomic writer rejects links, syncs a restrictive temporary file, revalidates before rename, and cleans only its own temporary file. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Deterministic repository hard-link and injected replacement-race regressions. |
| C3-LUNA-5 | same provenance | MEDIUM | CLI envelope row accepted unexpected keys. | FIX: exact singleton `phase3_snapshot` row-key contract. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Extra-key envelope regression. |
| C3-LUNA-6 | same provenance | MEDIUM | Generator CLI allowed ambiguous flag combinations. | FIX: strict exactly-one-mode parser with duplicate, unknown, missing-value, and positional-junk rejection; v2 environment default. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Spawned invalid-combination and synthetic valid-mode regressions. |
| C3-LUNA-7 | same provenance | MEDIUM | Public materialization disclosure was required. | FIX: aggregate-only owner-review summary added; it states correction-3 invalidation and owner gate. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Public-document review; no row content included. |
| C3-LUNA-8 | same provenance | MEDIUM | Ledger needed Correction 3 provenance and invalidation. | FIX: the historical ledger then recorded all dispositions, supplied aggregate hashes only, a historical Terra writer, and then-pending final reviews/proof/commit/PR. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Ledger review was then pending final proof. |
| C4-SOL-1 | Sol orchestrator cycle 4 | HIGH | Validated pathname then direct pathname read left a replacement window. | FIX: open read-only with no-follow where supported; compare descriptor and fresh pathname identities, require one regular link before consuming bytes, recheck after reading, and close in `finally`. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Synthetic injected replacement-race regression proves repository target content is neither returned nor changed. |
| C4-SOL-2 | Sol orchestrator cycle 4 | HIGH | Approved basenames did not contain a private snapshot, manifest, or owner-sheet payload renamed to a benign path. | FIX: bounded Git-change candidate inspection checks staged index and worktree candidates for exact approved JSON-format or owner-CSV-header signatures without logging content. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Disposable Git regressions cover renamed staged snapshot/manifest content, staged/worktree divergence, untracked content, and benign public text. |
| C4-SOL-3 | Sol orchestrator cycle 4 | MEDIUM | Several packet entry points tolerated duplicate, unknown, missing-value, or positional CLI input. | FIX: capture accepts no CLI input; manifest and owner entry points use strict named-path option parsing while preserving the generator's exactly-one-mode parser and v2 environment default. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Spawned synthetic invalid-input regressions cover every packet CLI without exposing synthetic identifiers. |
| C4-SELF-1 | Real Husky pre-commit pipeline | HIGH | The staged candidate's real `git commit` ran Husky; all earlier gates passed until `npm run test:correction-guards`. The disposable fixture inherited hook-local Git variables, so fixture `git init` targeted the shared Git directory, set common `core.bare=true`, and fixture `git add README.md` failed: `fatal: this operation must be run in a work tree`. No commit was created. | FIX: sanitize all case-insensitive `GIT_*` variables for every disposable fixture Git command, including injected checker Git calls. Regression injects hostile `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_COMMON_DIR`, proves the fixture initializes, adds and commits its README in its own worktree, and proves the real repository remains a worktree with common `core.bare=false` before and after. Shared repository common `core.bare=false` was repaired and reverified. A later historical materialization established hashes later superseded by the current aggregate hashes; exact final-SHA reviews were then pending. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Focused hostile-hook-context regression PASS; later full commit-hook proof PASS. |
| C5-SOL-1 | Historical independent Sol review of `2c56085d1ecee3ca223efb3ec0da58fa6ef858db` | BLOCKER | Any non-whitespace/comment prefix before otherwise exact private JSON bypassed staged, history, pre-push, and CI range containment. | FIX in a then-uncommitted historical Terra correction: decoded exact format key/value and strong private property signatures are position-independent and do not require JSON at byte zero. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Staged, deleted-history, real pre-push, pull-request event, push event, untracked, ignored, escaped-malformed, and benign public-source regressions PASS. |
| C5-SOL-2 | same historical provenance | HIGH | A benign first row hid a later private Product/manifest row because only the first row/root was inspected. | FIX in a then-uncommitted historical Terra correction: an iterative bounded walk inspects every object and array element, including arbitrary wrappers and nesting, with a fail-closed node bound. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Later Product and manifest row fixtures PASS across staged, ignored, history, pre-push, and CI event layers. |
| C5-SOL-3 | same historical provenance | HIGH | A commented/late owner CSV header, including a greater-than-8-MiB ignored file, bypassed containment. | FIX in a then-uncommitted historical Terra correction: the normalized exact ordered header is recognized on any line; the streaming detector retains state and signatures across chunks. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Late/commented staged/history/event fixtures and greater-than-8-MiB whitespace/header chunk-boundary fixtures PASS. |
| C5-LUNA-1 | Luna (`gpt-5.6-luna`, session `019fa26f-821d-7611-b7d6-82d90ac35fb9`) | HIGH | Luna returned `FIX` and required adjacent arrays/wrappers/nesting, escaped or malformed prefixed JSON, signatures beyond 1 KiB, later incomplete-root rows, and streaming chunk boundaries to fail closed. | FIX in a then-uncommitted historical Terra correction without filename or path allowlists; modified/untracked files above the structural bound remain unconditionally rejected and all ignored bytes are streamed. | historical `gpt-5.6-terra` | then-uncommitted historical patch | Expanded focused suite PASS in 39.1 seconds; real 51,810-path containment baseline PASS in 64.4 seconds. |

## Private artifacts — current aggregate-only owner-review packet

Only paths, sizes, hashes, timestamps, formats, and counts may be recorded here.
Never paste Product rows. These values supersede the historical packet hashes
recorded elsewhere in this historical ledger.

| Artifact | Private path | Format | Rows | Bytes | Byte SHA-256 | Semantic SHA-256 | Verified |
|---|---|---|---:|---:|---|---|---|
| Post-Stage-A snapshot | private external path (not recorded) | `crx-supplier-pricing-phase3-post-stage-a-product-snapshot-v2` | 604 | 359426 | `1f85d0d3af40b9740bcb0961beaa0d3eb122e8eea021a2209d056b0b24fec934` | `b1e61596d3f7b0a1059fb8c57457bca351cffce6374e57d2771ce642ed7a074f` | captured `2026-07-27T11:14:57.085929Z`; capture and external binding PASS |
| Proposed manifest | private external path (not recorded) | `crx-supplier-pricing-phase3-post-stage-a-proposed-classification-manifest-v2` | 604 | 1580465 | `706ec4bc57e5c971e56e71bdff29ab0d7a16a824e84f2dd2946b968871082507` | `4f2977b1ef8058266f3e1c80448ba09506816d94079d4f563d17fbadbfb788b0` | write/verify and reproducibility PASS |
| Owner decision sheet | private external path (not recorded) | `crx-supplier-pricing-phase3-owner-decision-sheet-v1` | 604 | 123853 | `c976bd8b3aa02b49b269b4674906cf0067725aa802c776ac85e57c9f1992b276` | `4eff9c27ee8d61345c328e0130a2fe26926bb809436f1c95d3c46ceb9fe4a3c8` | write/verify and containment PASS |

## Owner gate after this mission

The packet has been regenerated and verified. Mason must not review any private
row yet: PR #246's current head must match a recorded exact-reviewed SHA, and
any later head change invalidates prior head-bound evidence. Before any future
publication, freshly refetch `origin/main` and verify it descends from
bootstrap floor `d787b7e0e1c9cb5eb85c86b448e68b1ca43fce9c`. Required checks,
including Ubuntu PR CI, must be green, any real CodeRabbit finding resolved,
and external trusted-workflow/ruleset activation plus post-activation proof
complete before acceptance. Only
then must Mason review every row disposition, proposed family, packaging,
tote-only, and policy change; explicitly acknowledge every unresolved row; and
approve the exact current aggregate-bound packet. All decisions remain
`PENDING` and no classification is approved. Only then may a separate Stage C
design mission be considered; this record authorizes no Stage C migration/apply,
live mutation, flag enablement, deploy, or merge.

## Closeout

- `DONE:` exact `07813f69` engineering proof, aggregate-only capture, manifest reproducibility, owner-sheet verification, normal merges `a9817b05` of historical main `48bd1982`, `c6c5ea3` of historical #245 main `0e058804`, and `98969765` of historical #247 main `07a3d483`, and exact `d38d41f`/`a2002c3c`/`a7506a01`/`3c156065`/`a10bad90`/`80741157` review outcomes are recorded above; technical Sol returned `CLEAN` for published `bc305778`; `3c156065` was non-final, `a10bad90` is a correction-review source, and `80741157` is the publication-reconciliation source; older packet hashes are invalidated.
- `NOW:` PR #246's current head must match a recorded exact-reviewed SHA. Before publication, re-fetch `origin/main` and verify it descends from bootstrap floor `d787b7e0e1c9cb5eb85c86b448e68b1ca43fce9c`. Required PR checks and CodeRabbit resolution are pre-merge gates. Trusted-workflow/ruleset activation and post-activation proof are immediate post-merge gates before any later PR or private-sheet review. Mason must not begin private-sheet review.
- `REMAINING:` protected PR #246 acceptance after all those gates, then Mason's row-by-row private-sheet review and explicit approval of the exact aggregate-bound packet. Any future model alias must record its resolved model truthfully; the accepted review must remain bound to the current PR head.
- `GUARD:` no Stage C SQL/migration/apply, live mutation, flag enablement, deploy, or merge is authorized by this packet record.
- `NEEDS MASON:` no action until the external gates complete; afterward, row-by-row private-sheet review and explicit packet approval.
- `VERDICT:` PARKED — PR #246 OPEN; CURRENT HEAD MUST MATCH A RECORDED EXACT-REVIEWED SHA, REQUIRED CHECKS/CODERABBIT, AND EXTERNAL TRUSTED-WORKFLOW/RULESET ACTIVATION PLUS PROOF PENDING
