## 2026-09-11 - PR #648 merged without a CodeRabbit review

PR #648 (sweep predicates recognised by fingerprint) merged at 00:44:26Z as squash commit `6b9efeae1`, pinned to head `fcf78e554`. **CodeRabbit never reviewed any commit of #648.** The only CodeRabbit comment on #648 is the one it posts when a PR opens, saying review was skipped. No `@coderabbitai review` request was ever posted on #648. Checked 2026-09-11: #648 has no request comment from any person, and CodeRabbit left no reviews there. This record itself, PR #650, is a separate matter: Mason approved its CodeRabbit request, which was posted at 00:59:12Z and confirmed as triggered at 00:59:17Z.

This was Mason's decision in chat, not an oversight. At the time CodeRabbit was rationed to two reviews an hour, and #648 was waiting in that queue. Asked whether to wait for CodeRabbit or merge on the Sol result, he chose "Let Sol finish, merge now". The option he picked read: *"Skip CodeRabbit for this guards-only PR. If Sol comes back clean and tests are green, I merge within 30 minutes. Fastest, uses only this one Sol run, but breaks the 'CodeRabbit reviews every PR' convention this once."* Once Sol came back clean and the tests were green, the PR was merged. The convention in `AGENTS.md` still stands: CodeRabbit reviews every frozen candidate before it merges. This is a recorded exception for one guards-only PR, not a change to that convention.

What #648 did have at the merged head:

- a `gpt-5.6-sol` high-effort proof from `node scripts/write-codex-push-proof.mjs`, verdict clean at `fcf78e554` against base `9a648f566`;
- a Codex GitHub App review of `fcf78e5` that finished with a 👍 and no findings;
- `mergeStateStatus` CLEAN, no `CHANGES_REQUESTED`, and every required check green (E2E Smoke Tests skipped);
- no `--admin` and no `--auto`.

The change touched only agent guard files, scripts and docs, so production behaviour is unchanged. Vercel production for `6b9efeae1` deployed successfully, and https://croprxsolutions.app answered 200.

No revert is proposed. If a CodeRabbit pass on this code is still wanted, the natural place is the next PR that touches `.claude/hooks/live-testdata-lib.mjs` or `scripts/db-invariant-sweeps/`.
