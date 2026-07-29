# Branch / worktree cleanup — restore ledger (2026-07-29)

**Every tip removed below is preserved by a real tag on `origin`, not by the SHA written here.** A
SHA in a Markdown file keeps nothing alive: once the last ref is gone the commit is unreferenced,
`git gc` may prune it, and a fresh clone never had it. The tags are the safety net. Do not delete
them without deciding the work is gone for good.

Two prefixes, with different meanings:

```text
archive/2026-07-29-cleanup/<branch-name>     # 31 deleted branches
archive/2026-07-29-cleanup/detached-<sha7>   # 16 distinct detached worktree HEADs
preserve/2026-07-29/<branch-name>            # 2 KEPT branches holding unlanded code
```

The `preserve/` pair is belt-and-braces: those branches were **not** deleted, but each holds work
that exists nowhere else (see [Kept](#kept-unlanded-unique-work)), so they are tagged anyway.

List them: `git ls-remote --tags origin 'refs/tags/archive/2026-07-29-cleanup/*'`

Restore (read-only preflight first — confirm the checkout is clean and the tag really exists **on
`origin`**, since a local tag can be stale or absent from the remote):

```bash
git status --short --branch                                  # 1. inspect before any write
git ls-remote --tags origin \
  'refs/tags/archive/2026-07-29-cleanup/<name>'              # 2. prove the tip exists on origin
git fetch origin \
  'refs/tags/archive/2026-07-29-cleanup/<name>:refs/tags/archive/2026-07-29-cleanup/<name>'
git branch <name> archive/2026-07-29-cleanup/<name>          # 3. local branch
git worktree add <path> <name>                               # 3b. or a worktree
git push --dry-run origin <name>                             # 4. dry-run first
```

To read one file without creating a branch at all (`MSYS_NO_PATHCONV=1` is required on Windows/Git
Bash, or the colon path is mangled):

```bash
MSYS_NO_PATHCONV=1 git show archive/2026-07-29-cleanup/<name>:<path/to/file.md>
```

Compare the SHA from step 2 against the tables below before restoring; if they differ, the local tag
is stale and `origin` is authoritative.

**This restore path was proven by running it on 2026-07-29**, not merely written down: a branch was
recreated from its tag, 7,579 bytes of unique document content read back, the drill branch deleted,
and the tag confirmed still present on `origin` afterwards.

Re-publishing a restored branch to `origin` is an outward-facing write — get Mason's OK before
dropping `--dry-run`.

## Why ancestry was not used to decide what was safe to delete

`git merge-base --is-ancestor` reports a **fully landed** branch as unmerged whenever its PR was
squash-merged, because the squash commit shares no ancestry with the branch tip. Every branch below
was therefore classified by **file content**, not ancestry — for each file the branch adds, does an
identical path exist in `origin/main`?

```bash
git ls-tree -r origin/main --name-only | grep -qxF "$f"     # correct
git cat-file -e "origin/main:$f"                            # DO NOT USE
```

`git cat-file -e origin/main:<path>` false-negatives on dot-prefixed paths (`.github/`, `.claude/`),
which manufactures fake "unlanded work" and would have blocked this cleanup on phantom findings.

## Documents recovered onto `main` before deletion (PR for this cleanup)

Nine branches held review/design documents that no PR ever tracked. Deleting them would have
destroyed the only working copy, so all ten files were copied onto `main` first:

| File | Bytes | Came from |
|---|---|---|
| `docs/audits/gauntlet/2026-07-26-section-04-quote-order-delivery-invoice-payment-lifecycle-refresh.md` | 12,506 | `claude/gauntlet-s3-s4-and-phase3-artifacts-2026-07-26` |
| `docs/audits/2026-07-25-section9-quantity-on-order-reconciliation-design.md` | 35,118 | `codex/section9-mismatch-design-20260725` |
| `docs/audits/2026-07-25-governed-noninterference-queue-ledger.md` | 11,257 | `codex/noninterference-queue-ledger-20260725` |
| `docs/audits/2026-07-26-sections-1-11-12-protected-pr-readiness.md` | 11,269 | `codex/protected-pr-readiness-20260726` |
| `docs/loops/overnight-safe-noninterference-ledger-2026-07-25.md` | 10,232 | `codex/overnight-safe-loop-20260725` |
| `docs/loops/overnight-safe-noninterference-loop-2026-07-25.md` | 4,922 | `codex/overnight-safe-loop-20260725` |
| `docs/audits/gauntlet/2026-07-25-section-10-blend-ticket-ocr-refresh.md` | 10,235 | `codex/section10-blend-ocr-refresh-20260725` |
| `docs/audits/gauntlet/2026-07-25-section-11-pdfs-compliance-documents-refresh.md` | 8,237 | `codex/section11-pdf-compliance-refresh-20260725` |
| `docs/audits/gauntlet/2026-07-25-section-12-edge-functions-refresh.md` | 7,579 | `codex/section12-edge-functions-refresh-20260725` |
| `docs/audits/gauntlet/2026-07-25-section-14-testing-prevention-refresh.md` | 10,222 | `codex/section14-testing-prevention-refresh-20260725` |

**Two of these are history, not current state**, and `docs/audits/gauntlet/live-foundation-gauntlet-index.md`
was edited in the same change to say so:

- The four `2026-07-25` section refreshes (10, 11, 12, 14) are **superseded** by the 2026-07-28
  reports already on `main` from PR #268. They are committed so the intermediate findings survive,
  not as evidence about current state.
- The `2026-07-26` Section 4 refresh reports 0 findings but **ran on a detached checkout behind
  `origin/main`** and says so itself. A clean pass on stale code does not supersede the 2026-07-22
  report, so gauntlet index row 4 was deliberately left pointing at 2026-07-22.

The gauntlet index also carried two live pointers at `codex/section9-mismatch-design-20260725` —
a branch deleted here. Both were repointed at the now-landed file in the same change; had they been
left, the index would instruct a future run to read a branch that no longer exists.

## Uncommitted work copied out (no tag can save this)

Tags preserve commits. **Uncommitted work is in no commit**, so removing a worktree destroys it
permanently. Only 3 of the 39 removed worktrees had anything uncommitted at all; all three were
copied to `C:/Users/mason/CRX_Manager_archive/2026-07-29-cleanup/` before removal.

### `overnight-20260728` → `overnight-20260728-untracked/`

| File | Bytes | Status |
|---|---|---|
| `2026-07-28-codex-overnight-report.md` | 5,433 | report of work already landed by PR #263 |
| `20260728185739_secure_profile_public_directory.sql` | 3,774 | superseded — landed live under a renamed version |
| `20260728185827_revoke_anon_security_definer_execute.sql` | 12,999 | superseded — landed live under a renamed version |
| `20260728185913_pin_contact_sync_search_path.sql` | 2,703 | superseded — landed live under a renamed version |

All three SQL drafts were verified against the live migration ledger as already applied under their
renamed filenames before the worktree was removed.

### `gauntlet-10-15-refresh-20260728` → `gauntlet-10-15-refresh-uncommitted/`

One modified file, `docs/manual/CURRENT_STATE.md`, adding a 7-line "Recent production deployments"
section that existed nowhere on `main`. It records that PR #268 deployed the `process-document` Edge
Function v20 → v21 and that the signed-in upload/OCR path still needs a real-app smoke test.

**This one was landed, not just archived.** Its claim was re-verified live before landing — read-only
`list_edge_functions` reports `process-document` at version **21**, status `ACTIVE`,
`verify_jwt=true` — so the section is now on `main` with that verification noted inline. The
outstanding smoke test is real and still open.

### `phase3c-bootstrap-reconcile` → `phase3c-bootstrap-reconcile-uncommitted/`

Five modified files (patch + full copies archived), **deliberately not landed**. The edits rewrite
`phase3_bootstrap_base` in `.github/workflows/ci.yml` from `d3bac970…` to `3ca289c5…`, which is that
worktree's *own* commit — a self-referential scratch experiment from the abandoned bootstrap-reconcile
attempt. Landing it would point the CI containment gate's trusted base at a throwaway commit and
break the check. Archived for the record only.

## Branches deleted (31)

### Landed via a merged PR (17)

| Tip SHA | Branch | PR |
|---|---|---|
| `0262654a` | `chore/b7-rename-anon-revoke-closeout` | #266 |
| `9179fb1a` | `chore/b7-rename-directory-migrations` | #269 |
| `6fe72461` | `chore/profile-directory-hardening-20260729` | #278 |
| `0a564e10` | `claude/deactivation-lockout-and-active-reads` | #249 |
| `79efc903` | `claude/gauntlet-section-runner-20260727` | #252 |
| `201c035b` | `claude/secdef-pricing-guard-20260728` | #257 |
| `e0c86dbd` | `codex/gauntlet-10-15-refresh-20260728` | #268 |
| `5ea8ef99` | `codex/inventory-net-position-closeout-20260729` | #280 |
| `188ea1fd` | `codex/lint-warning-cleanup-20260728` | #270 |
| `dd9e8fb4` | `codex/phase3c-overnight-20260726` | #246 |
| `ddf4ad05` | `codex/reconcile-migrations-20260729` | #272 |
| `4dfa7be2` | `codex/section9-live-race-refresh-20260729` | #271 |
| `1e3afe3d` | `fix/application-service-cost-admin-only` | #267 |
| `77243a49` | `fix/apply-guard-worktree-proofs` | #273 |
| `96280cbc` | `fix/revoke-anon-execute-rls-role-helpers` | #263 |
| `11d408aa` | `fix/secdef-pricing-explicit-grant-set` | #261 |
| `c7562a4d` | `fix/secure-profile-directory-and-contact-sync` | #264 |

### Nothing unique — every file already on `main` (5)

| Tip SHA | Branch | Note |
|---|---|---|
| `65716b1c` | `chore/migration-ledger-reconcile-20260729` | PR #275 **CLOSED**; superseded by #272 |
| `3ca289c5` | `codex/phase3c-bootstrap-3ca` | scratch bootstrap copy |
| `35ec8fde` | `codex/phase3c-bootstrap-reconcile` | scratch bootstrap copy |
| `eaa2c45e` | `codex/security-invoker-profile-view` | landed via #263 |
| `31b0d3e3` | `wt` | throwaway name |

### Doc-only, documents landed first (9)

Each corresponds to a row in the recovered-documents table above.

| Tip SHA | Branch |
|---|---|
| `29486b5e` | `claude/gauntlet-s3-s4-and-phase3-artifacts-2026-07-26` |
| `c30c50dc` | `codex/noninterference-queue-ledger-20260725` |
| `9e0282f3` | `codex/overnight-safe-loop-20260725` |
| `1741881f` | `codex/protected-pr-readiness-20260726` |
| `b536ce0f` | `codex/section9-mismatch-design-20260725` |
| `8622e1c1` | `codex/section10-blend-ocr-refresh-20260725` |
| `b754bf8d` | `codex/section11-pdf-compliance-refresh-20260725` |
| `a94ef7f1` | `codex/section12-edge-functions-refresh-20260725` |
| `cf5728cb` | `codex/section14-testing-prevention-refresh-20260725` |

## Detached worktree HEADs removed (39 worktrees, 16 distinct commits)

Detached means no branch was attached — the HEAD commit was the only reference, so each distinct
commit is tagged. Many worktrees shared a HEAD (the `phase3c-review-*` fan-out ran three reviewer
models against the same commit), which is why 39 removals map to 16 tags. Full 40-character SHAs:

| Tag suffix | Full SHA |
|---|---|
| `detached-12f19cb5` | `12f19cb583343bd890f5d8e65f6c9b204954c2be` |
| `detached-149c8b00` | `149c8b00f1c4163e8d61be4d63805e640e04ddbc` |
| `detached-1cba5b0f` | `1cba5b0fb8dc4eea306994860c0de8ca8f12447a` |
| `detached-1d1b120e` | `1d1b120e5d8cb8a04229cd3770752d30cc2c5105` |
| `detached-2c59a7b8` | `2c59a7b8da797f892e15679c125a88bb21bdf511` |
| `detached-523d4412` | `523d4412c7ca7f6c739297eb62a4e9de7e5da696` |
| `detached-68907fd1` | `68907fd1dc6583153b62f297c1fcef8582bff9c5` |
| `detached-7334639c` | `7334639cfa0dd1a3801ccbaec544120048beb2d7` |
| `detached-7c096444` | `7c096444fe98df8283f95e3076ec433c6422c506` |
| `detached-9734b002` | `9734b0020ef86e80590156fce225634d16cc5c98` |
| `detached-a5a66753` | `a5a6675312971904a16a475ee1efef89df9f072b` |
| `detached-b2d55f77` | `b2d55f77b198a844b380da8c2b19a58a015ef8f1` |
| `detached-b931af68` | `b931af68ec07c5e6f5023900cfffa5064f0588ca` |
| `detached-c8a7e12a` | `c8a7e12a72736f72c0df3c51e0b6594246c93fb9` |
| `detached-eaa2c45e` | `eaa2c45e54bf86158fd23c74dcc5b1bb57986c43` |
| `detached-f1d9d220` | `f1d9d22023611b3f376d1e97d2dd854a887156e7` |

Removing a worktree never touches its branch. Every removed worktree had **zero uncommitted tracked
changes**; the only untracked files anywhere were the four listed above.

## Kept (unlanded unique work)

| Tip SHA | Branch | Why kept |
|---|---|---|
| — | `main` | trunk |
| — | `claude/cleanup-branches-worktrees-d14686` | this cleanup's own branch |
| — | `claude/crx-manager-roadmap-7d54e0` | **live Claude session** running on it |
| — | `chore/retire-dispatch-backfill-draft` | open PR #279 |
| — | `claude/schema-baseline-refresh-20260727` | checked out in the primary checkout (31 dirty files) |
| `53f6177e` | `codex/section1-security-hardening-20260725` | **parked security migration** `20260725234503` + smoke scripts, not on `main` |
| `e6f12a0e` | `codex/pricing-rpc-live-ledger-closeout` | guard-hook fan-out tooling — 8 files absent from `main`, **and no remote branch at all** |

`codex/pricing-rpc-live-ledger-closeout` is the most fragile ref in the repo: PR #265 landed
similar work from a *differently named* branch (`codex/pricing-live-closeout-clean`), which made this
one look superseded, but content comparison found 8 files on it that `main` does not have —
including five `.claude/hooks/patch-*.mjs`. `git ls-remote origin` confirms it has **never been
pushed**, so those files exist only on this machine. That is why it carries a `preserve/` tag.

**Worktrees kept (7):**

| Path | Why |
|---|---|
| `C:/CRX_Manager` | primary checkout — live Claude session **and** live Codex session, 31 dirty files |
| `C:/CRX_Manager/.claude/worktrees/session-prompt-file-5368af` | live Claude session (roadmap planning) |
| `C:/CRX_Manager/.claude/worktrees/cleanup-branches-worktrees-d14686` | this session |
| `C:/Users/mason/.claude/worktrees/secdef-pricing-guard/CRX_Manager` | open PR #279 **and** a live Codex cwd |
| `C:/Users/mason/.codex/worktrees/6354/CRX_Manager` | **live Codex cwd** — appeared mid-cleanup |
| `C:/Users/mason/.codex/worktrees/2cb6/CRX_Manager` | appeared mid-cleanup alongside `6354`, same fleet |
| `C:/Users/mason/.codex/worktrees/supplier-pricing-operational-20260729/CRX_Manager` | appeared mid-cleanup, new branch |

The last three did not exist when this sweep's inventory was taken — Codex created them while the
cleanup was in progress, which is why the inventory grew from 43 worktrees to 46 mid-run. All three
sit at the then-current `main` tip. Only `6354` is provably a live cwd; `2cb6` and
`supplier-pricing-operational-20260729` were kept anyway on the principle that removing an in-flight
Codex worktree can break a running job, and keeping three cheap directories costs nothing. **Re-take
the worktree inventory immediately before removing anything** — a list minutes old can already be
wrong while Codex is running.

## Remote needed no cleanup

GitHub auto-deletes merged PR heads on this repo. `origin` held only 13 refs at cleanup time —
`main`, one open-PR head, and eleven unlanded heads — so **no remote branch was deleted** in this
sweep. Unlike 2026-07-27, this cleanup was local-only apart from pushing the tags.

## How live work was identified (do not use index mtimes)

Sorting worktrees by `.git/index` mtime is **not** a reliable activity signal: the SessionStart
`worktree-awareness.mjs` hook runs `git status` across every worktree at session start and rewrites
stale indexes, so dozens of dormant checkouts share a recent timestamp. The authoritative sources:

- **Claude:** `mcp__ccd_session_mgmt__list_sessions`, field `isRunning`.
- **Codex:** `~/.codex/sessions/**/*.jsonl` file mtime plus the `"cwd"` recorded inside.

For Codex, only the `"cwd"` field counts. **Grepping session transcripts for a worktree name proves
nothing** — every session that runs `git worktree list` records all 46 names in its transcript, so a
substring match makes every dormant checkout look busy. Extract `"cwd"` from each transcript and
dedupe by newest mtime; across all of 2026-07-29 that yielded just six distinct working directories,
four of them touched in the final ten minutes.

Live during this cleanup and untouched: two Claude sessions and four Codex working directories (one
of them `C:\FarmRx`, a different repository).

## Operational notes for the next sweep

- `git worktree remove` is slow on Windows because it deletes each `node_modules` tree. Budget 600s,
  expect the loop to time out partway through a long list, and simply re-run it.
- `git push` from a `cd`-ed shell is blocked by the CODEX GATE. Use `git -C "<literal path>" push`;
  a shell variable inside the path makes the gate fail with `spawnSync git ENOENT`.
- Pushing tags fires the full pre-push hook (typecheck + Vite build + graphify, ~2–3 min).
- A fresh worktree needs its own `npm ci`, or the pre-commit hook dies on
  `'eslint' is not recognized`.
