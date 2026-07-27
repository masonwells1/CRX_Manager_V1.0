# Supplier Pricing Phase 3C Review-Packet Overnight Ledger — July 26, 2026

## Mission

- Mission doc:
  `docs/loops/supplier-pricing-phase3c-review-packet-loop-2026-07-26.md`
- Worktree:
  `C:\Users\mason\.codex\worktrees\phase3c-overnight-20260726\CRX_Manager`
- Branch: `codex/phase3c-overnight-20260726`
- Created from: `origin/main` /
  `052b2171821dc7ffd965b4edb4b6de4ef8fda511`
- Final allowed state: `READY FOR OWNER REVIEW`
- Forbidden interpretation: neither this ledger nor an agent verdict approves
  Product classifications or authorizes a Stage C migration/live apply.

## Post-review tooling correction and packet invalidation — 2026-07-27

### Current rejected implementation `3695f42e3ec6f57dae4d07d534a4a191bfa2a46d` — Terra correction cycle active

`3695f42e3ec6f57dae4d07d534a4a191bfa2a46d` is rejected. Its immutable parent
is `2adff51bfa27ea50274230845bb4c89f4037313e`; `3695f42e` is the implementation
SHA for the prior correction, not a passing release. Current branch HEAD at
the start of this correction is also `3695f42e`. The mutable worktree is not
an implementation SHA and must not be described as one.

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
  a publication TOCTOU, and ledger/summary bookkeeping was stale. Neither
  review authorizes a packet,
  Product classification, Stage C SQL, flag change, private-artifact access,
  or live action.
- Accepted correction disposition: one explicit CSV record-delimiter set used
  by direct and streaming scanners; behavioral GitHub handoff attestation from
  the trusted checker; `rev-list --max-count=4097` before commit-list parsing;
  and a nonreentrant stable-parent CWD lease with relative basename-only final
  publication. Regression coverage includes UTF-8/UTF-16 owner headers across
  staged, ignored, deleted-history, and chunk-boundary paths; dead/comment-only
  and root-ignoring CI checkers; bounded range/new-ref argv; and a final-race
  Windows/POSIX publication fixture.
- SHA ledger rule: `implementation_sha` names only an immutable Git object.
  Until the next commit exists, this correction is recorded as
  `implementation_base_sha=3695f42e...` and `current_head_at_start=3695f42e...`.
  The next commit must record parent `3695f42e...`; only Git's resulting SHA
  may be used for exact-SHA graph/proof/review claims. Historical mentions of
  an “uncommitted correction” below describe their original cycles only.

`PARKED — TOOLING CORRECTION; HISTORICAL PACKET REGENERATION REQUIRED` remains
the only status until a frozen successor has fresh exact-SHA proof and reviews.

### Exact rejected candidate `2adff51bfa27ea50274230845bb4c89f4037313e` — SAFE PREP correction pending

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

`PARKED — TOOLING CORRECTION; HISTORICAL PACKET REGENERATION REQUIRED` until
the focused/full proof, fresh exact-SHA Graphify, Luna, independent-Sol, and
resolved-Opus reviews complete on a frozen candidate.

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
  correction set, but that uncommitted set has not received fresh exact-SHA
  reviews.
- Prior Sol `FIX` findings being remediated: arbitrary external directories
  (including a sibling linked worktree) were admitted; tip-only containment
  missed a packet committed then deleted; filename/signature checks missed
  minified renamed packet structures; CI ran containment after other content
  processors; and synthetic Git fixtures did not prove real repository Git
  identity preservation.
- Follow-on orchestrator audit correction: the uncommitted recovery patch now
  preserves the opened temporary file identity through the pre-rename boundary,
  scans merge-resolution blobs with a merge-aware Git diff, and rejects BOM-
  prefixed packet structures or a worktree candidate whose identity/size changes
  while it is being scanned. Focused synthetic regressions cover all three;
  independent review remains required before any freeze or packet regeneration.
- Blocked-freeze correction: the first commit-hook freeze attempt exposed that
  inherited Git hook variables could redirect the checker away from its explicit
  root, producing an invalid fixture range. Checker Git subprocesses now strip
  every `GIT_*` variable and use their supplied working root. The focused packet
  suite and the full correction-guard suite both pass under representative
   `GIT_DIR`/work-tree/index/common/object redirection variables; no commit was
   made by this recovery writer.
- Current pre-freeze local proof for the uncommitted bounded correction: focused
  packet suite PASS in 29.3 seconds; full correction-guard suite PASS in 38.9
  seconds; typecheck PASS in 21.1 seconds; production build PASS in 18.2
  seconds; lint PASS with zero errors and four pre-existing warnings. The full
  containment range
  `052b2171821dc7ffd965b4edb4b6de4ef8fda511..d01a8f099394e8c7882736ac52fd81c6d2de8c15`
  PASSed in 22.4 seconds (`checked_paths=51810`, `checked_commits=6`). This is
  local tooling evidence only, not a substitute for fresh exact-SHA reviews or
  packet regeneration. Documentation drift and whitespace validation also PASS
  on this pre-freeze record.
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
- Fresh Graphify, Luna, independent-Sol, and latest-available Opus exact-SHA
  reviews are required after the correction is frozen. The packet must then be
  regenerated and re-verified before protected-PR/CodeRabbit handling. Current
  state: `PARKED — TOOLING CORRECTION; PACKET REGENERATION REQUIRED`.

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

A fresh Terra sole-writer correction is uncommitted. It iteratively inspects
every node in bounded valid JSON, applies decoded position-independent strong
property signatures to malformed or prefixed content, recognizes the exact
owner header on any line, and scans every byte of modified, untracked, and
ignored worktree candidates twice through a descriptor-bound reader with
complete stat identity and SHA-256 equality checks. The real repository
containment baseline passed across 51,810 paths in 64.4 seconds; the expanded
synthetic packet suite passed in 39.1 seconds. These are local correction
proofs only. The exact rejected SHA remains rejected, the historical packet
hashes remain invalidated, and fresh freeze/review/regeneration is still
required.

Broader pre-freeze proof also passed: correction guards, typecheck, production
build, agent-workflow tests, documentation drift, dependency consistency, and
the five-slot mission-document validator. Lint reported zero errors and the
same four pre-existing warnings. Exact containment across
`052b2171821dc7ffd965b4edb4b6de4ef8fda511..2c56085d1ecee3ca223efb3ec0da58fa6ef858db`
passed after checking 51,810 paths and all 7 commits in 73.3 seconds.
`git diff --check` also passed. This remains an uncommitted, unreviewed
correction and is not a final packet proof.

## Cycle table

| Cycle | Status | Exact SHA | Writer | Proof | Luna | Independent Sol | Resolved Opus review | PR / CodeRabbit | Next |
|---|---|---|---|---|---|---|---|---|---|
| 0 — preflight | DONE | `9bf567bf` | none | PASS | n/a | n/a | n/a | n/a | Cycle 2 bounded capture/generator work. |
| 1 — design adversary | DONE | `9bf567bf` | none | SHIP | n/a | n/a | `opus` → `claude-opus-4-8` | n/a | Cycle 2 accepts both LOW findings. |
| 2 — final correction 6 | HISTORICAL — invalidated by later FIX reviews | `d01a8f099394e8c7882736ac52fd81c6d2de8c15` reviewed; local correction uncommitted | fresh `gpt-5.6-terra` recovery writer | earlier full proof PASS; latest bounded correction focused proof PASS | `FIX` session `019fa229-bc19-77b2-92bf-7f270e1cddc8` | `FIX` on `d01a8f099394e8c7882736ac52fd81c6d2de8c15` | pending fresh exact SHA | n/a | Freeze corrected SHA, refresh Graphify, and obtain fresh reviews. |
| 3 — private materialization | PARKED — historical hashes invalidated | prior materialization only | Sol orchestrator | historical capture/binding/write/verify evidence only; regeneration required | n/a | n/a | n/a | n/a | Do not use the listed hashes for owner review; regenerate after fresh reviews. |
| 4 — full review | IN PROGRESS — bounded correction uncommitted | pending corrected freeze | fresh `gpt-5.6-terra` recovery writer | packet suite PASS 29.3s; correction guards PASS 38.9s; typecheck PASS 21.1s; build PASS 18.2s; lint 0 errors/4 pre-existing warnings; exact 6-commit range PASS: 51,810 paths in 22.4s | pending fresh exact SHA | pending fresh exact SHA | pending latest-available Opus exact SHA | pending | Reconcile fresh reviews, then regenerate packet before PR. |
| 5 — protected PR | PENDING | pending | Terra only if correction needed | pending | pending | pending | pending | pending | Open PR, resolve real findings, park before merge. |
| 6 — closeout | PENDING | pending | none | pending | pending | pending | pending | pending | Record READY FOR OWNER REVIEW and the exact approval packet. |

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

These are preflight observations, not a captured or approved classification
packet. They must be refreshed inside the loop before materialization.

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
- `Not verified:` Cycle 2 final candidate/review proof and all later cycles.

## Findings and correction lessons

### Final correction 6 — current fresh Terra writer

- Exact reviewed candidate: `ee9183eef017affb8170fa8cdb7c4cb84e87c7c1`.
- Independent Sol: `gpt-5.6-sol`, session `019fa1b9-5cfb-7e33-81fd-23cb72636875`, verdict `FIX`.
- Luna bookkeeping review: `gpt-5.6-luna`, session
  `019fa1b9-5cf2-7023-aff1-0d79befd6b1d`, verdict `FIX` only for circular
  pending-review bookkeeping.
- Resolved Opus review: run `2026-07-27T04-03-37-498Z-1eab779e`, requested
  alias `opus` resolved to `claude-opus-4-8`, verdict `SHIP-WITH-FOLLOWUPS`;
  no Opus 5 review ran or is claimed.
- Writer: final fresh `gpt-5.6-terra`; fix SHA: `uncommitted`.
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
- Sol regenerated the private packet at `2026-07-27T05:53:04.476876Z` after
  the rewritten safety-tooling candidate. Capture, external count/hash binding,
  manifest write/verify and deterministic compare, and owner-sheet write/verify
  all passed. Fresh aggregate hashes are recorded below. Exact final-SHA
  Graphify refresh and fresh Luna/independent-Sol/latest-available Opus reviews
  were pending. Both later exact-SHA reviews returned `FIX`, so this
  materialization is now historical and must be regenerated after correction.
- Graphify was refreshed after these uncommitted edits: 8,309 nodes / 17,245
  edges. Its report records HEAD `ee9183ee`; because Graphify records committed
  HEAD rather than an uncommitted patch, an exact final-SHA refresh remains
  pending after a later freeze.

| ID | Source | Severity | Exact evidence | Disposition | Owner | Fix SHA | Regression proof |
|---|---|---:|---|---|---|---|---|
| C2-LOW-1 | Pre-edit Claude review | LOW | Eliminate private-row stdout modes from the generator. | Accepted and implemented in the uncommitted Cycle 2 candidate; focused synthetic regression passed. Final candidate proof/review remains pending. | Terra | uncommitted | `npm run test:supplier-pricing-phase3c-packet` PASS |
| C2-LOW-2 | Pre-edit Claude review | LOW | Add a hard Git containment guard for private artifacts. | Accepted and implemented in the uncommitted Cycle 2 candidate; focused synthetic regression and containment check passed. Final candidate proof/review remains pending. | Terra | uncommitted | `npm run test:supplier-pricing-phase3c-packet` + `npm run check:phase3-private-artifacts` PASS |
| C2-LUNA-1 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | HIGH | Final output names could follow a link into the repository; private directory validation accepted relative input after resolution. | FIX in correction 1: require an absolute private directory before resolution; canonicalize existing parents; validate final output through the hardened artifact validator; reject final symlinks/reparse points and dangling links. | `gpt-5.6-terra` | uncommitted | `npm run test:supplier-pricing-phase3c-packet` PASS; file-symlink creation is unsupported on this host, while linked/junction-parent containment passed. |
| C2-LUNA-2 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | HIGH | Git containment comparison was case-sensitive and ignored files were outside the scan. | FIX in correction 1: fold path segments and private basenames to lowercase; add narrow case-insensitive ignored-file Git pathspecs for private basenames and `private-artifacts/**`. | `gpt-5.6-terra` | uncommitted | Focused disposable mixed-case staged and ignored-artifact checker regression PASS. |
| C2-LUNA-3 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | HIGH | Capture proof did not assert the complete fixed Supabase CLI argv. | FIX in correction 1: assert the complete fixed argv including `CAPTURE_SQL`, with no obsolete `--sql`, no extra flags, and `shell: false`/bounded buffer retained. | `gpt-5.6-terra` | uncommitted | Focused exact-argv regression PASS. |
| C2-LUNA-4 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | HIGH | Capture checked nonexistent `supabase/config.toml` instead of the linked-project marker. | FIX in correction 1: strictly read and validate `supabase/.temp/project-ref` as exactly `rhyzpcqhnizqbxphqdkr`; absent, malformed, and other-project markers fail closed. | `gpt-5.6-terra` | uncommitted | Synthetic correct, wrong, empty, and multiline marker regressions PASS. |
| C2-LUNA-5 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | MEDIUM | Proposed array envelope did not match installed CLI evidence. | FIX in correction 1: require the observed non-array `{ boundary, rows, warning }` envelope, exactly one row, and that row's `phase3_snapshot`; malformed alternatives fail closed without raw output logging. | `gpt-5.6-terra` | uncommitted | Focused valid and malformed-envelope regressions PASS. |
| C2-LUNA-6 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | MEDIUM | Capture ignored stderr despite known harmless CLI status output. | FIX in correction 1: accept only empty stderr or complete documented status lines; reject all other stderr without retaining raw output. | `gpt-5.6-terra` | uncommitted | Focused stderr allowlist regressions PASS. |
| C2-LUNA-7 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | MEDIUM | Metadata validation accepted coercible family counts and loose UTC timestamps. | FIX in correction 1: require numeric safe-integer `product_families_count === 0` and a six-fractional-digit UTC timestamp, while retaining the existing default/ledger checks. | `gpt-5.6-terra` | uncommitted | Focused invalid-count and invalid-timestamp regressions PASS. |
| C2-LUNA-8 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | MEDIUM | `unresolved_acknowledgment` started blank and the test did not validate every decision cell. | FIX in correction 1: make every decision cell literal `PENDING`, leaving only `owner_note` blank; parse every synthetic CSV row and assert each decision column. | `gpt-5.6-terra` | uncommitted | Focused CSV parser-level regression PASS. |
| C2-LUNA-9 | Luna cycle 1 (`gpt-5.6-luna`, session `019fa178-5410-7273-a0a6-d3b12e064625`) | MEDIUM | Pre-commit integration lacked static and real-checker execution proof. | FIX in correction 1: statically assert the early hook order and execute the exported checker in disposable benign, staged mixed-case, and ignored-artifact repositories. | `gpt-5.6-terra` | uncommitted | Focused hook/checker regression PASS; `npm run test:agent-workflows` PASS. |
| C2-SOL-1 | Sol live materialization cycle | HIGH | Read-only capture failed closed before writing an artifact. Aggregate-only follow-up: total Products: 604; malformed generic UUID text shape: 0; UUID version-nibble counts: 601 with nibble `4`, 3 with nibble `0`. | FIX in correction 2: validate the database-guaranteed canonical hexadecimal UUID text shape only; preserve strict sorted-order and duplicate rejection. Private materialization remains PENDING. | fresh `gpt-5.6-terra` | uncommitted | Synthetic version-`0`, malformed-shape/non-hex, sorted-order, and duplicate regressions PASS via `npm run test:supplier-pricing-phase3c-packet`; containment PASS via `npm run check:phase3-private-artifacts`. |
| C3-LUNA-1 | Luna cycle 2 (`gpt-5.6-luna`, session `019fa190-1cb7-73a0-8ba9-77c2eb3cf50b`) | HIGH | Snapshot format was read before approved absolute external basename/containment validation. | FIX: shared validated snapshot loader admits only the two exact approved basenames, validates containment/link/hard-link state before read, and binds basename to format. | fresh `gpt-5.6-terra` | uncommitted | Synthetic relative, repository, case, symlink, and hard-link regressions. |
| C3-LUNA-2 | same provenance | HIGH | Rehashed v2 snapshots could evade incomplete saved-snapshot checks. | FIX: one strict saved-v2 validator now enforces exact root/metadata/Product contracts, safety defaults, UUID/order, statuses, and self-hash. | fresh `gpt-5.6-terra` | uncommitted | Rehashed adversarial contract mutations reject through loader and consumer. |
| C3-LUNA-3 | same provenance | HIGH | Verification errors interpolated Product identifiers. | FIX: all manifest verification row failures use one-based index plus categorical reason only. | fresh `gpt-5.6-terra` | uncommitted | Spawned synthetic malformed-manifest output contains no UUID/name/SKU. |
| C3-LUNA-4 | same provenance | HIGH | Existing hard links and replacement races could endanger writes. | FIX: shared exclusive same-directory atomic writer rejects links, syncs a restrictive temporary file, revalidates before rename, and cleans only its own temporary file. | fresh `gpt-5.6-terra` | uncommitted | Deterministic repository hard-link and injected replacement-race regressions. |
| C3-LUNA-5 | same provenance | MEDIUM | CLI envelope row accepted unexpected keys. | FIX: exact singleton `phase3_snapshot` row-key contract. | fresh `gpt-5.6-terra` | uncommitted | Extra-key envelope regression. |
| C3-LUNA-6 | same provenance | MEDIUM | Generator CLI allowed ambiguous flag combinations. | FIX: strict exactly-one-mode parser with duplicate, unknown, missing-value, and positional-junk rejection; v2 environment default. | fresh `gpt-5.6-terra` | uncommitted | Spawned invalid-combination and synthetic valid-mode regressions. |
| C3-LUNA-7 | same provenance | MEDIUM | Public materialization disclosure was required. | FIX: aggregate-only owner-review summary added; it states correction-3 invalidation and owner gate. | fresh `gpt-5.6-terra` | uncommitted | Public-document review; no row content included. |
| C3-LUNA-8 | same provenance | MEDIUM | Ledger needed Correction 3 provenance and invalidation. | FIX: this ledger records all dispositions, supplied aggregate hashes only, fresh Terra writer, and pending final reviews/proof/commit/PR. | fresh `gpt-5.6-terra` | uncommitted | Ledger review pending final proof. |
| C4-SOL-1 | Sol orchestrator cycle 4 | HIGH | Validated pathname then direct pathname read left a replacement window. | FIX: open read-only with no-follow where supported; compare descriptor and fresh pathname identities, require one regular link before consuming bytes, recheck after reading, and close in `finally`. | fresh `gpt-5.6-terra` | uncommitted | Synthetic injected replacement-race regression proves repository target content is neither returned nor changed. |
| C4-SOL-2 | Sol orchestrator cycle 4 | HIGH | Approved basenames did not contain a private snapshot, manifest, or owner-sheet payload renamed to a benign path. | FIX: bounded Git-change candidate inspection checks staged index and worktree candidates for exact approved JSON-format or owner-CSV-header signatures without logging content. | fresh `gpt-5.6-terra` | uncommitted | Disposable Git regressions cover renamed staged snapshot/manifest content, staged/worktree divergence, untracked content, and benign public text. |
| C4-SOL-3 | Sol orchestrator cycle 4 | MEDIUM | Several packet entry points tolerated duplicate, unknown, missing-value, or positional CLI input. | FIX: capture accepts no CLI input; manifest and owner entry points use strict named-path option parsing while preserving the generator's exactly-one-mode parser and v2 environment default. | fresh `gpt-5.6-terra` | uncommitted | Spawned synthetic invalid-input regressions cover every packet CLI without exposing synthetic identifiers. |
| C4-SELF-1 | Real Husky pre-commit pipeline | HIGH | The staged candidate's real `git commit` ran Husky; all earlier gates passed until `npm run test:correction-guards`. The disposable fixture inherited hook-local Git variables, so fixture `git init` targeted the shared Git directory, set common `core.bare=true`, and fixture `git add README.md` failed: `fatal: this operation must be run in a work tree`. No commit was created. | FIX: sanitize all case-insensitive `GIT_*` variables for every disposable fixture Git command, including injected checker Git calls. Regression injects hostile `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_COMMON_DIR`, proves the fixture initializes, adds and commits its README in its own worktree, and proves the real repository remains a worktree with common `core.bare=false` before and after. Shared repository common `core.bare=false` was repaired and reverified. A later fresh materialization establishes the current aggregate hashes below; exact final-SHA reviews remain pending. | fresh `gpt-5.6-terra` | uncommitted | Focused hostile-hook-context regression PASS; later full commit-hook proof PASS. |
| C5-SOL-1 | Fresh independent Sol review of `2c56085d1ecee3ca223efb3ec0da58fa6ef858db` | BLOCKER | Any non-whitespace/comment prefix before otherwise exact private JSON bypassed staged, history, pre-push, and CI range containment. | FIX in the uncommitted Terra correction: decoded exact format key/value and strong private property signatures are position-independent and do not require JSON at byte zero. | fresh `gpt-5.6-terra` | uncommitted | Staged, deleted-history, real pre-push, pull-request event, push event, untracked, ignored, escaped-malformed, and benign public-source regressions PASS. |
| C5-SOL-2 | same provenance | HIGH | A benign first row hid a later private Product/manifest row because only the first row/root was inspected. | FIX in the uncommitted Terra correction: an iterative bounded walk inspects every object and array element, including arbitrary wrappers and nesting, with a fail-closed node bound. | fresh `gpt-5.6-terra` | uncommitted | Later Product and manifest row fixtures PASS across staged, ignored, history, pre-push, and CI event layers. |
| C5-SOL-3 | same provenance | HIGH | A commented/late owner CSV header, including a greater-than-8-MiB ignored file, bypassed containment. | FIX in the uncommitted Terra correction: the normalized exact ordered header is recognized on any line; the streaming detector retains state and signatures across chunks. | fresh `gpt-5.6-terra` | uncommitted | Late/commented staged/history/event fixtures and greater-than-8-MiB whitespace/header chunk-boundary fixtures PASS. |
| C5-LUNA-1 | Luna (`gpt-5.6-luna`, session `019fa26f-821d-7611-b7d6-82d90ac35fb9`) | HIGH | Luna returned `FIX` and required adjacent arrays/wrappers/nesting, escaped or malformed prefixed JSON, signatures beyond 1 KiB, later incomplete-root rows, and streaming chunk boundaries to fail closed. | FIX in the uncommitted Terra correction without filename or path allowlists; modified/untracked files above the structural bound remain unconditionally rejected and all ignored bytes are streamed. | fresh `gpt-5.6-terra` | uncommitted | Expanded focused suite PASS in 39.1 seconds; real 51,810-path containment baseline PASS in 64.4 seconds. |

## Private artifacts — historical and invalidated

Only paths, sizes, hashes, timestamps, formats, and counts may be recorded here.
Never paste Product rows.

| Artifact | Private path | Format | Rows | Bytes | Byte SHA-256 | Semantic SHA-256 | Verified |
|---|---|---|---:|---:|---|---|---|
| Post-Stage-A snapshot | private external path (not recorded) | `crx-supplier-pricing-phase3-post-stage-a-product-snapshot-v2` | 604 | 359426 | `b80e000beaff06bc012570986e95b6beec73b1b8f8e51cba51ab32b01ce62933` | `b49566e63c53bcd4355f70c9374a2738b1654faafc5a746472323e4d4175fd5c` | captured `2026-07-27T05:53:04.476876Z`; capture and external binding PASS |
| Proposed manifest | private external path (not recorded) | `crx-supplier-pricing-phase3-post-stage-a-proposed-classification-manifest-v2` | 604 | 1580465 | `1e439e53cdc2e71ab111a1d8801e61960a03c17c75f5d4225a82fe79412d2382` | `31ba2f61834e53469879f4a4891d93524438bbb2fe3774eab36758261671b172` | write/verify and deterministic compare PASS |
| Owner decision sheet | private external path (not recorded) | `crx-supplier-pricing-phase3-owner-decision-sheet-v1` | 604 | 123853 | `c976bd8b3aa02b49b269b4674906cf0067725aa802c776ac85e57c9f1992b276` | `4eff9c27ee8d61345c328e0130a2fe26926bb809436f1c95d3c46ceb9fe4a3c8` | write/verify and containment PASS |

## Owner gate after this mission

Pending final packet. Mason must review every row disposition, every proposed
family, packaging, tote-only, and policy change, explicitly acknowledge every
unresolved row, and approve the exact packet checksum. Only then may a separate
Stage C migration mission be designed.

## Closeout

- `DONE:` earlier materialization and proof are preserved as historical evidence; Luna and Sol `FIX` findings are remediated in the bounded local correction set
- `NOW:` freeze the correction, refresh Graphify, and obtain fresh exact-SHA Luna, independent-Sol, and latest-available Opus reviews
- `REMAINING:` regenerate the private packet with new aggregate evidence, rerun packet proof, reconcile reviews, then open the protected PR and handle CodeRabbit
- `PARKED:` the prior hashes are invalidated; no owner approval, Product classification, Stage C SQL/migration, flag enablement, deployment, or live mutation is authorized
- `NEEDS MASON:` nothing during the unattended preparation run
- `VERDICT:` PARKED — TOOLING CORRECTION; PACKET REGENERATION REQUIRED
