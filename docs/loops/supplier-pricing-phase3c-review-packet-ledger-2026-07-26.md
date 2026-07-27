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

## Resumed post-PARK recovery and final materialization — 2026-07-27

The bounded post-PARK safety recovery resolved the reproduced containment gaps
before a new packet was materialized. This does **not** amend or conceal the
mission's six-cycle cap: the earlier candidate cycles remain historical, and
the current packet is not an approval to classify Products or create/apply a
Stage C migration.

- Rewritten-provenance candidate before this documentation update:
  `4f4b863b53596088d58162f44e2a6e2e43e58f79`. Every post-setup commit on that
  local candidate is authored `Mason <mason@croprxsolutions.com>`; its tree was
  checked against the local backup and matched. No remote branch exists.
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
- A fresh live read-only capture completed at `2026-07-27T05:53:04.476876Z`:
  604 Products (595 active, 9 inactive), one active-return conflict, all 604
  unresolved, zero family assignments, and zero standalone classifications.
  The Stage A ledger row `20260723193312` is present, migration high-water is
  `20260726223520`, `product_families_count` is 0, and
  `supplier_cost_basis_enabled` is `false`.
- Fresh capture, external count/hash binding, manifest write/verify/compare,
  and owner-sheet write/verify all passed. The aggregate-only resulting hashes
  are recorded below; no private rows or identifiers are recorded in this
  repository.
- Full commit-hook proof passed on the rewritten candidate: 302 files checked;
  3,985 tests passed and 118 skipped; lint had zero errors and four warnings;
  typecheck, build, agent workflows, correction guards, docs, and dependency
  checks passed.
- This documentation change necessarily creates a later SHA. Graphify refresh,
  fresh exact-SHA Luna, independent-Sol, and latest-available Opus reviews, and
  protected-PR/CodeRabbit handling remain pending. Current state:
  `FINAL PACKET MATERIALIZED — EXACT-SHA REVIEWS/PR PENDING`.

## Cycle table

| Cycle | Status | Exact SHA | Writer | Proof | Luna | Independent Sol | Resolved Opus review | PR / CodeRabbit | Next |
|---|---|---|---|---|---|---|---|---|---|
| 0 — preflight | DONE | `9bf567bf` | none | PASS | n/a | n/a | n/a | n/a | Cycle 2 bounded capture/generator work. |
| 1 — design adversary | DONE | `9bf567bf` | none | SHIP | n/a | n/a | `opus` → `claude-opus-4-8` | n/a | Cycle 2 accepts both LOW findings. |
| 2 — final correction 6 | DONE — rewritten candidate proven | `4f4b863b53596088d58162f44e2a6e2e43e58f79` before this docs update | fresh `gpt-5.6-terra` recovery writer | full commit-hook proof PASS (302 files; 3,985 passed / 118 skipped; lint 0 errors / 4 warnings; typecheck, build, workflows, guards, docs, deps PASS) | superseded by final-SHA review gate | superseded by final-SHA review gate | superseded by final-SHA review gate | n/a | Freeze the documentation SHA, refresh Graphify, and obtain exact-SHA reviews. |
| 3 — private materialization | DONE — regenerated | `4f4b863b53596088d58162f44e2a6e2e43e58f79` before this docs update | Sol orchestrator | capture, external count/hash binding, manifest write/verify/compare, and owner write/verify PASS | pending exact final SHA | pending exact final SHA | pending latest-available Opus exact final SHA | n/a | Preserve current aggregate packet record; no owner approval yet. |
| 4 — full review | PENDING — exact-SHA reviews | documentation SHA pending freeze | none | final Graphify refresh pending because this docs update changes SHA | pending | pending | pending | pending | Reconcile fresh reviews before PR. |
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
  remain pending because this documentation update changes the candidate SHA.
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

## Private artifacts

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

- `DONE:` recovery tooling was proven, rewritten provenance was checked, and the final aggregate-only packet was regenerated and verified
- `NOW:` freeze this documentation SHA, refresh Graphify, and run fresh exact-SHA Luna, independent-Sol, and latest-available Opus reviews
- `REMAINING:` reconcile review findings, open the protected PR, pass required checks, and read/resolve CodeRabbit before any owner-review state
- `PARKED:` no owner approval, Product classification, Stage C SQL/migration, flag enablement, deployment, or live mutation is authorized by this packet
- `NEEDS MASON:` nothing during the unattended preparation run
- `VERDICT:` FINAL PACKET MATERIALIZED — EXACT-SHA REVIEWS/PR PENDING
