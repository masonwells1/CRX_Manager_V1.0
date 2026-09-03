## 2026-09-03 - "unknown" is no longer allowed to mean "fine" anywhere in the sync check

**Class:** the root shape behind three consecutive findings, fixed once instead of a fourth time.
**Outcome:** every provenance source in `scripts/sync-agent-workflows.mjs` reports whether it could
actually answer, and the importer exemption is withheld unless all of them did.

## Why this entry exists

Six review rounds on PR #565 each found a genuine defect - none of them were churn or nitpicks. But
the last three were one defect wearing three costumes: **a check that could not determine something
answered with the most permissive value available.**

| Round | The thing that could not be determined | What it answered instead |
|---|---|---|
| 4 | does the manifest still own this directory, after `--write` rewrote it? | "no" - so the survivor was litter |
| 5 | is this importer path tracked in git, when git will not run? | "not tracked" - so it was exempt |
| 6 | what does the ownership record say, when the manifest will not parse? | "nothing is owned" - so everything was exempt |

Reviewers finding a third instance is the design emitting them, not reviewer thoroughness. So the
fix from round 5 - return an explicit `known` flag and force the caller to handle it - was applied to
every remaining source in the module rather than to the one instance that was reported.

## What changed

- `previousManifest()` now separates **absent** from **unreadable**. No manifest at all is a real
  answer (nothing generated yet, nothing owned, exemption may apply, `known: true`). A manifest that
  exists but cannot be read or parsed is not an answer at all (`known: false`). Returning `[]` for
  both is what let a corrupt manifest silently exempt every importer directory.
- `checkExpected()` grants the exemption only when **both** provenance sources answered
  (`gitKnown.known && prior.known`), and prints a distinct stderr note naming which one could not.
- `classifyExtras()` keeps a single `trackingKnown` gate, so an unknown from either source produces
  the identical, conservative outcome: importer paths are reported as ordinary drift.

## Verification

Attacked, not reasoned about.

**Live, on this repo.** Planted an untracked `skills/source-command-probe/SKILL.md`, then corrupted
`generated-manifest.json` to a truncated JSON fragment:

| Manifest state | Result for the planted litter |
|---|---|
| valid | `WARNING: ignoring 1 foreign ... directory` then `PASS - 37` — exempt, as designed |
| corrupt, **fix in place** | `NOTE ... ownership record is unavailable` then `FAIL skills/source-command-probe/SKILL.md is not generated from .claude`, exit 1 |
| corrupt, **fix mutated off** (`known: true` in the catch) | back to `WARNING: ignoring 1 foreign ... directory` — the litter is exempted again |

That third row is the proof the fix is load-bearing: flipping one boolean restores the hole. The
probe directory and the corrupt manifest were both removed afterwards and `--check` returns
`PASS - 37` on a clean tree.

`npm run test:agent-workflows` and `npm run test:correction-guards` both exit 0.

## Operative rule

In this module, a helper that answers a yes/no question about provenance returns the answer **and**
whether it could determine it. A falsy default must never stand in for "could not determine" - that
is the exact substitution that produced rounds 4, 5 and 6. New callers must handle the unknown
explicitly and fail closed.
