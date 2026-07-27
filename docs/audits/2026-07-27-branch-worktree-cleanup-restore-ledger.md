# Branch / worktree cleanup — restore ledger (2026-07-27)

Restore a branch:  `git branch <name> <sha>`
Restore a worktree: `git worktree add <path> <branch-or-sha>`

## Branches deleted (tip SHA recorded)
- `dc90cb0935f76b5ea7c9ccb91d4155f89c695a60` — claude/rls-inline-role-require-active
- `e8c9f9e0594dbb3633e45a2aa7d1570d26925669` — docs/correct-split-billing-status
- `b0f3bf7fecdd2a18af30281ebd86f69915854cf1` — claude/vendor-reactivate-2026-07-26
- `3b011489699ce2d9bd82f3f32369351da46d4eb4` — feat/supplier-pricing-cutover
- `7212b13279f4da18104ee7feb2488d345c2e5b9d` — docs/phase1b-review-handoff-2026-07
- `9b97668d676f8e00e93de95f7e7a7eead99d0a02` — fix/pr196-conflict
- `90a0c09582dc0c8827d45d9b5b2d1554eebce81d` — codex/section4-lifecycle-audit-final
- `b4212da38711cba3633b3e8536ca3c82ebf17d0e` — claude/priceless-brahmagupta-b419d5
- `a7a85493b442e7784d0306109b342342d864cc64` — claude/billing-splits-plan-8ih4jg
- `0bd680501682736e074a14343125d344dd899f82` — claude/split-billing-phase2-calculator
- `5b92c7165aee7c19a4a5e2e15610017e66e11cde` — claude/split-billing-phase3-rpc
- `dcedc765bcf159b9e60bb39bd047bbd6d731073b` — claude/split-billing-phase4-ui
- `b078389a987a05bb84e0eb8991c4c35744c9d522` — claude/split-billing-phase4-ui-stacked-backup
- `99f296826bc8762c58bd256fd2722953e3ffcccb` — codex/per-line-split-billing-phase3-rpc
- `e2418796e089e28c280323dca3a116b066169a4a` — codex/per-line-split-billing-phase4-ui
- `8bcb5fc1d7f0dcd96566b4bfc55e3afea46b12f3` — codex/supplier-pricing-phase3-stage-a
- `a0ee40667c753d49bedadf3d599d80658a4a93b9` — codex/supplier-pricing-phase3-stage-a-pr221
- `1eeabd59e6c1f56b08ef4de9e30838981c9d345b` — codex/supplier-pricing-phase3-stage-a-sanitized
- `e897f7e7c6fe7b16a1362e0839f7bf3c5bad3713` — codex/money-inventory-gauntlet-fixes
- `742541c868c24333fcf68f71c590c54e59f697be` — codex/money-inventory-gauntlet-release
- `09235aaac08a6ca49d56365da39a40619f45df0e` — claude/supplier-pricing-strategy-9c6129
- `3ff01138dbf6f0866927fa8fe930e7443e4a5654` — docs/gauntlet-refresh-2026-07

## Remote branches deleted from GitHub (Mason approved 2026-07-27)

Restore a remote branch: `git push origin <sha>:refs/heads/<name>`

- `b078389a987a05bb84e0eb8991c4c35744c9d522` — claude/split-billing-phase4-ui-stacked-backup
  Superseded: PRs #182 and #187 both CLOSED; PR #164 is what landed. `main` carries the live
  per-line calculator (`20260720214000`) and save RPC (`20260720233000`); the branch's
  `20260720230000/231000/232000/233000/234000` drafts are the pre-renumber rewrites.
- `f4571a3c9b8c657b61bd27e8daa60cb7acf628c0` — claude/usage-analysis-feedback-d171ad
- `074e453a10718ba430e31597cfce40d56fc10197` — codex/supplier-pricing-phase1a-closeout
- `1eeabd59e6c1f56b08ef4de9e30838981c9d345b` — codex/supplier-pricing-phase3-stage-a-sanitized
  Superseded: PR #222 CLOSED — the "sanitized" approach was rejected in favour of the
  private-artifact approach shipped by #223 → #224 → #225 (all merged). Its
  `20260722222743_product_families_return_policy_foundation.sql` shipped as `20260723193312_...`;
  its `verify-supplier-pricing-phase3-sanitized-privacy.mjs` scripts only ever verified the
  rejected design.
- `3ff01138dbf6f0866927fa8fe930e7443e4a5654` — docs/gauntlet-refresh-2026-07
- `7212b13279f4da18104ee7feb2488d345c2e5b9d` — docs/phase1b-review-handoff-2026-07

## Detached worktree HEADs removed
- `d8a17601` — C:/CRX_CRM (Fix bulk quote import lifecycle path)
- `408bc63f` — C:/CRX_Layer2 (Update offline known issue status)
- `b4212da3` — .claude/worktrees/priceless-brahmagupta-b419d5
- `476f21fa` — .claude/worktrees/stoic-heyrovsky-ebaaf6
- `29486b5e` — .codex/worktrees/pr231-exact-review

## Kept (unlanded unique work)
- `codex/phase3c-overnight-20260726` — open PR #246 (worktree kept)
- `backup/phase3c-pre-provenance-rewrite-20260727` — backup of PR #246
- `codex/section1-security-hardening-20260725` — PARKED migration 20260725234503 + smoke scripts, not in main
- `claude/gauntlet-s3-s4-and-phase3-artifacts-2026-07-26` — section-04 gauntlet refresh doc, not in main
- `codex/section9-mismatch-design-20260725`, `codex/section10-blend-ocr-refresh-20260725`, `codex/section11-pdf-compliance-refresh-20260725`, `codex/section12-edge-functions-refresh-20260725`, `codex/section14-testing-prevention-refresh-20260725`, `codex/noninterference-queue-ledger-20260725`, `codex/overnight-safe-loop-20260725`, `codex/protected-pr-readiness-20260726` — each carries an audit/ledger doc not in main
