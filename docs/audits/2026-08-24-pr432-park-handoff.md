# PR #432 — PARKED at the exact-review gate (2026-08-24)

**Status: PARKED.** Nothing pushed. Production untouched. All work is committed on
`codex/pr432-final-followup-20260820`; the branch is 0 behind `origin/main` as of
`3a53e9c4`.

Mason's decision, 2026-08-24: park with a handoff rather than run a fourth
fix-and-review round. This document is the resume point.

## Why it is parked

Three consecutive exact-SHA `gpt-5.6-sol` high-effort reviews returned BLOCKED.
The rounds did **not** re-find the same defects — each round's findings were fixed
and confirmed closed by the next review. The branch is 99 commits of guard
hardening, and each review moved to a different part of that surface and found
more. There was no evidence of convergence, so the round budget was spent rather
than extended.

The gate behaved correctly throughout. It refused to mint a proof three times, and
each refusal was a real defect in this branch's own hardening.

## What the blocker was, and how it was cleared

The branch could not mint its own review proof: the exact-review bootstrap
exception trusts `scripts/write-codex-push-proof.mjs` only while it byte-matches
its protected-`main` blob, and commit `5b3dbeed` on this branch hardened that
wrapper. That is deliberate anti-self-certification, not a bug.

**Resolved.** The wrapper hardening was split out and landed on `main` as
[PR #455](https://github.com/masonwells1/CRX_Manager_V1.0/pull/455), merged
`4b8ef10f`. `origin/main` now carries blob
`0668316a67097b8fb63bcfe73151ae302e12a45c`, identical to this branch's copy, so
the exemption is restored and the wrapper runs here. PR #454 was an equivalent
earlier attempt, closed as superseded.

Do not re-open this blocker. It is closed.

## Fixed and confirmed closed by a later review

Round 1 (three Highs) and round 2 (one High) are all fixed. Round 3 explicitly
re-verified the round-2 pin and did not re-raise any of them.

| Defect | Fix | Commit |
|---|---|---|
| `protected-identity-guard.mjs` discarded any non-object `tool_input`; `apply_patch` sends a bare STRING, so the real shape extracted no destination and fell through to **allow** | Raw string treated as a patch body; JSON-encoded object decoded first | `fb9a4fee` |
| The patch tests wrapped every body in `{patch: …}` — a shape the tool never emits — so the suite was green against an open route | Every patch case also drives the bare-string form, including the forgery payload | `fb9a4fee` |
| `mcp-tool-guard.mjs` never applied `protectedProofCreationReason`; an MCP write through a junction could mint trusted review JSON | Both write routes now call the shared `protected-identity-lib` functions | `fb9a4fee` |
| That guard's Git-control list omitted the `.git` POINTER of a linked worktree | Same shared-rule fix | `fb9a4fee` |
| `extractPatchDestinations()` required `File:` after every verb, so it never parsed the `*** Move to:` rename header `apply_patch` really emits — forgery by rename | Extractor parses `*** Move to:`; older spellings still work | `3a53e9c4` |
| `review-proof-guard.mjs` was blind to bare-string `tool_input` for the same reason, so it gave no backstop | Shared `normalizeToolInput()` in `codex-push-lib.mjs` used by both guards | `3a53e9c4` |

Every one of these had the same root cause: **a rule written down in more than one
place, where one copy learned something the others did not.** Three such
duplications were collapsed into shared code rather than patched per copy. Keep
that discipline when resuming — a new rule belongs in `protected-identity-lib.mjs`
or `codex-push-lib.mjs`, called from both routes, never restated per hook.

Assertion counts moved with the fixes: `protected-identity-guard` 40 → 52,
`mcp-tool-guard` 489 → 494, and `codex-push-lib` gained extractor and normalizer
cases. All committed through the full pre-commit gate; none used `--no-verify`.

## OPEN — the two findings that must be closed to resume

From the round-3 capture, 2026-08-24T21:19:22Z. Both High. Neither has been
touched. The reviewer named the fixes.

### 1. Git hooks bypass the exact-HEAD execution boundary

The Git classifier in `.claude/hooks/bash-safety-lib.mjs` (~line 2809) allowlists
`git hook`, while its executable-configuration check (~line 2877) omits
`core.hooksPath` and config includes. So this passes inspection:

```
git -c core.hooksPath=output/hooks hook run pre-commit
```

The hook file can be untracked and agent-written; Git then executes it with no
further tool guard, which permits forging review state, modifying protected files,
or invoking live-maintenance actions. Related: `protected-identity-lib.mjs`
(~lines 143, 182) protects Git config and attributes but **not** Git hook
directories.

Prescribed fix: deny executable Git configuration indirection — `core.hooksPath`,
`include.path`, and `includeIf.*.path` — and remove or argument-gate Git
subcommands that execute hooks or helpers.

### 2. The fail-closed provenance check can expire open

The canonical-GitHub lookup lets its inner `git ls-remote` consume 5,000 ms
(`bash-safety-lib.mjs` ~line 419), while the outer Codex Bash and MCP guards each
have exactly a five-second deadline (`.codex/hooks.json` lines 64 and 114). During
GitHub latency or an outage the host can kill the guard before it emits its
denial, so an ignored wrapper executes without the exact-HEAD/proof check
precisely when provenance cannot be established.

Prescribed fix: the outer deadline must exceed every cumulative subprocess
deadline with meaningful margin, or the lookup must terminate early enough to
return a denial before the host timeout.

**Both need regressions covering the demonstrated shapes**, not just the fix.

## Also open, deliberately not fixed here

The Codex PR bot's P2 on `scripts/write-codex-push-proof.mjs` (raised on PR #455):
stripping global and system configuration also strips a `safe.directory` entry, so
a checkout owned by a different UID — a root-owned bind mount used from a
container account — cannot mint a proof at all. Real, but an availability
limitation rather than a hole, it does not affect the Windows single-user checkout
in use, and the naive remedy re-admits configuration into the process the change
just isolated. Git also honors `safe.directory` only from protected configuration,
not the environment-backed form the wrapper could inject, so the suggested fix may
not even work as described. Needs its own design pass.

## How to resume

1. `git -C <worktree> fetch origin --prune`, then merge `origin/main` — the branch
   goes stale quickly and the review packet diffs two directory snapshots, so any
   commit `main` gained renders as a deletion you caused.
2. Fix the two open findings above, with regressions.
3. Re-run the review. It must be started **from the worktree**, foreground, as one
   exact command with nothing chained: `node scripts/write-codex-push-proof.mjs`.
4. Only a terminal `CODEX_PROOF_VERDICT: CLEAN` writes the proof. Push within 30
   minutes of it — the proof binds head and base SHAs and expires.

### Traps that cost time this session

- **The proof wrapper must be raw-byte identical to HEAD on disk.** `scripts/**`
  is not pinned to `eol=lf` and `core.autocrlf=true`, so it sits CRLF on disk
  while its blob is LF, and the guard compares raw bytes — while `git status` and
  `git diff` both report it clean. Diagnose with `git hash-object --no-filters`
  versus `git rev-parse HEAD:<path>`. Fix with `sed -i 's/\r$//'`, then `git add`
  the file to refresh the stat cache, or `git status` keeps reporting it modified
  and the wrapper refuses on a dirty tree.
- **The wrapper requires a completely clean tree**, untracked files included.
- **Guard tests cannot be run before committing** — the harness refuses any
  file-backed interpreter whose worktree bytes differ from exact HEAD, and the
  modified test file is the executor. The pre-commit gate is the test run. Budget
  12+ minutes per commit and batch changes; run it backgrounded, since it can
  exceed a 10-minute foreground limit.
- **Changing `.claude/hooks/codex-push-lib.mjs` breaks a hash pin.**
  `scripts/apply-live-testdata-maintenance-20260812.mjs` pins its blob in both
  `EXPECTED_PROTECTED_INPUT_BLOBS` and `EXPECTED_PROTECTED_OUTPUT_BLOBS`. Re-pin
  following the comment block's precedent, and verify first that the
  apply-live-testdata risky-path anchor is still present exactly once and that
  `RISKY_PATH_RES` is untouched.
- **Shell commands may not name the maintenance producer or review-proof files.**
  Staging the producer needs `git add -u` after checking `git status`; reading it
  needs a file tool, not `sed`/`cat`.
- **`main` moved four times during this session.** Re-fetch immediately before
  minting, or the proof binds a base that has already moved and the push is
  rejected.

## Related

- `docs/audits/2026-08-24-claude-to-codex-pr432-ci-handoff.md` — the earlier CI handoff.
- `docs/audits/2026-08-24-pr432-shutdown-checkpoint.md` — Codex's own checkpoint; stale, describes HEAD `b4917171`.
- `docs/CHANGELOG.md` — the 2026-08-24 entries describe every fix above.
