# Supplier Pricing Phase 3C Owner Review Summary

## Status

`PARKED — TOOLING CORRECTION; PACKET REGENERATION REQUIRED`

This is not completion and not approval. A prior private packet was
materialized and verified, then fresh exact-SHA Luna and independent-Sol
reviews returned `FIX` on the containment tooling. The prior packet hashes are
therefore historical only and cannot identify an owner-review packet. The
bounded local correction must be frozen, receive fresh exact-SHA reviews, and
then regenerate and re-verify the packet before a protected PR.

The correction is limited to private-path admission, Git-history containment,
structural packet detection, CI ordering, and isolated test-fixture safety. It
does not classify Products, create Stage C SQL, enable cost basis, query live
data, or approve any owner decision. The mission's earlier six-cycle cap
remains recorded in the durable ledger; this is a separate post-PARK correction
pass, not a claim that the cap was changed.

The current rejected implementation is
`3695f42e3ec6f57dae4d07d534a4a191bfa2a46d`, whose immutable parent is
`2adff51bfa27ea50274230845bb4c89f4037313e`. Graphify at that exact SHA reports
8,382 nodes and 17,446 edges. Independent Sol returned `FIX` for the owner CSV
record-boundary bypass only. Luna `gpt-5.6-luna` session
`019fa2e4-9bc8-71a3-a64a-a5baef795e78` returned `FIX` for CI trusting text
rather than behavior, history enumeration not bounded at `rev-list`, and final
parent validation leaving an atomic-publication race, and stale ledger/summary
bookkeeping. The bounded replacement uses shared explicit
record delimiters, behavioral protocol/event-head attestation, a 4,097-result
`rev-list` request before parsing, and a stable-parent relative-basename
publication lease. It remains tooling-only and does not access private rows,
classify Products, create Stage C SQL, change flags, or change live state.

For truthful provenance, `3695f42e` is the rejected `implementation_sha` and
also the `current_head_at_start` for this mutable correction. The worktree has
no self-SHA. A future frozen commit must name `3695f42e` as parent; only the
SHA Git creates may receive fresh graph/proof/review claims. Earlier
“uncommitted correction” wording below is historical, not current status.

The later exact candidate
`2c56085d1ecee3ca223efb3ec0da58fa6ef858db` is also rejected. Fresh
independent Sol found that private JSON could hide behind an ordinary prefix,
that a private-shaped Product or manifest row could hide later in a JSON
wrapper, and that the owner-sheet header could hide after comments or padding.
Luna session `019fa26f-821d-7611-b7d6-82d90ac35fb9` returned `FIX` and
required the adjacent nested, escaped/malformed, beyond-first-1-KiB, and large
streaming variants to be covered. A fresh uncommitted Terra correction now has
focused synthetic proof and a 51,810-path local containment pass, but it still
requires a frozen exact SHA and fresh independent reviews. The historical
packet hashes below remain invalidated throughout.

The prior rejected candidate was
`2adff51bfa27ea50274230845bb4c89f4037313e` (base
`052b2171821dc7ffd965b4edb4b6de4ef8fda511`). Graphify was refreshed at that
exact rejected HEAD (8,360 nodes / 17,396 edges). Luna `gpt-5.6-luna` session
`019fa291-ede9-7ab0-8491-5c20f605d3d9` returned `FIX` for candidate-controlled
PR containment, link/reparse ordering, and Unicode-whitespace large-owner
sheet detection. A fresh independent Sol also returned `FIX` for UTF-16
coverage, Git type/mode coverage, atomic publication, CI ordering, and
deterministic scan bounds. The accepted local correction is limited to those
tooling safeguards: post-bootstrap trusted-base PR execution, validated candidate-root
handoff, UTF-8/UTF-16 streaming, non-regular Git-mode rejection, 64 MiB per
candidate / 2 GiB logical bytes / 100,000 candidates, a 4,096 checked-commit
ceiling (above the current 2,073 commits), a remaining-candidate-budget
history-path ceiling before per-path tree resolution, and temp-file atomic
replace. It does not access private artifacts or Product rows, classify a
Product, create Stage C SQL, enable cost basis, or change live state.

That prior correction was frozen as rejected `3695f42e`; its old bootstrap
description is historical only. Exact base
`052b2171821dc7ffd965b4edb4b6de4ef8fda511` had no checker, so the introducing
PR used its exact-base-SHA-gated, committed-head-blob/path-verified candidate
checker. The current behavioral protocol replaces textual compatibility;
post-bootstrap PRs use their trusted compatible base checker, while a missing
or incompatible future base fails closed. Status remains
`PARKED — TOOLING CORRECTION; PACKET REGENERATION REQUIRED`.

## Unattended v2 binding sequence

Capture prints only the product count and semantic snapshot SHA-256. The
orchestrator exports those exact values as
`CRX_PHASE3_EXPECTED_PRODUCT_COUNT` and
`CRX_PHASE3_EXPECTED_SNAPSHOT_SHA256` before every v2 manifest/sheet generate
or verify command. Missing, malformed, or mismatched bindings fail closed.

## Historical aggregate-only materialization record — invalidated

- Linked project marker: `rhyzpcqhnizqbxphqdkr`
- Products: 604 total; 595 active; 9 inactive
- Products involved in an active return: 1; all 604 remain unresolved
- Family assignments: 0; standalone classifications: 0; Product families: 0
- Stage A ledger version: `20260723193312`
- Migration high-water: `20260726223520`
- Cost-basis flag: `false`
- Capture timestamp: `2026-07-27T05:53:04.476876Z`

| Artifact | Format | Count | Semantic hash | Byte SHA-256 | Bytes |
|---|---|---:|---|---|---:|
| Snapshot | `crx-supplier-pricing-phase3-post-stage-a-product-snapshot-v2` | 604 | `b49566e63c53bcd4355f70c9374a2738b1654faafc5a746472323e4d4175fd5c` | `b80e000beaff06bc012570986e95b6beec73b1b8f8e51cba51ab32b01ce62933` | 359426 |
| Manifest | `crx-supplier-pricing-phase3-post-stage-a-proposed-classification-manifest-v2` | 604 | `31ba2f61834e53469879f4a4891d93524438bbb2fe3774eab36758261671b172` | `1e439e53cdc2e71ab111a1d8801e61960a03c17c75f5d4225a82fe79412d2382` | 1580465 |
| Owner sheet | `crx-supplier-pricing-phase3-owner-decision-sheet-v1` | 604 | `4eff9c27ee8d61345c328e0130a2fe26926bb809436f1c95d3c46ceb9fe4a3c8` | `c976bd8b3aa02b49b269b4674906cf0067725aa802c776ac85e57c9f1992b276` | 123853 |

Historical materialization evidence: capture PASS; external count/hash binding
PASS; manifest write/verify and deterministic compare PASS; owner-sheet
write/verify PASS. Full commit-hook proof on the rewritten candidate also
passed: 302 files checked, 3,985 tests passed and 118 skipped; lint had zero
errors and four warnings; typecheck, build, agent workflows, correction guards,
docs, and dependency checks passed. The candidate before this documentation
update was `4f4b863b53596088d58162f44e2a6e2e43e58f79`; all post-setup commits
there were authored `Mason <mason@croprxsolutions.com>`, its tree matched the
local backup, and no remote branch exists. Fresh Luna review session
`019fa229-bc19-77b2-92bf-7f270e1cddc8` and fresh independent-Sol review of
`d01a8f099394e8c7882736ac52fd81c6d2de8c15` both returned `FIX` for packet
tooling containment. The bounded correction has focused proof but is not yet a
frozen/reviewed candidate. Fresh Graphify, exact-SHA Luna, independent-Sol, and
latest-available Opus reviews, packet regeneration/verification, protected PR,
and CodeRabbit review are all still required.

Current pre-freeze local proof for that uncommitted correction: the focused
packet suite passed in 29.3 seconds; correction guards passed in 38.9 seconds;
typecheck passed in 21.1 seconds; production build passed in 18.2 seconds; and
lint passed with zero errors and four pre-existing warnings. The complete
containment range
`052b2171821dc7ffd965b4edb4b6de4ef8fda511..d01a8f099394e8c7882736ac52fd81c6d2de8c15`
passed in 22.4 seconds after checking 51,810 paths across 6 commits. This is
tooling proof only: it does not revive the historical packet or permit
classification, Stage C work, a deployment, or live data changes. Documentation
drift and whitespace validation also passed on this pre-freeze record.

Additional pre-freeze proof for the position-sensitive correction: the expanded
synthetic packet suite passed in 39.1 seconds across staged, deleted-history,
real pre-push, pull-request event, push event, modified, untracked, ignored, and
greater-than-8-MiB streaming cases. The real worktree containment baseline
passed after scanning 51,810 paths in 64.4 seconds. It uses iterative all-node
JSON inspection, position-independent decoded structural signatures, any-line
owner-header matching, and two descriptor-bound full-content passes with
complete stat identity plus SHA-256 equality. This remains tooling evidence
only; it does not revive the packet or authorize owner decisions.

The broader pre-freeze gates also passed: correction guards, typecheck,
production build, agent-workflow checks, documentation drift, dependency
consistency, and mission-document validation. Lint had zero errors and four
pre-existing warnings. Exact base-to-rejected-head containment passed across
51,810 paths and 7 commits in 73.3 seconds, and `git diff --check` passed. The
correction is still uncommitted and has not received fresh exact-SHA review.

## Exact owner gate

After the corrected packet is regenerated, fully proven, and accepted through
the protected PR, Mason must review every row and decision field, explicitly
acknowledge unresolved rows, and approve that exact regenerated packet checksum
before any separate Stage C migration can be designed.
