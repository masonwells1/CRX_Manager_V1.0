## 2026-09-05 - Review-proof guard: JSON in the state directory is evidence by shape, listed or not

**Why.** The eleventh exact-SHA `gpt-5.6-sol` round on
`2026-09-05-review-proof-guard-read-only-narrowing.md` (the first run on the head that merged
`main` at #610) found that `migration-review-<name>.json` — the migration reviewer proof that
`scripts/write-apply-proofs.mjs` mints and `migration-apply-lib.mjs` consumes — was never in
`reviewProofPathMentioned()`, so the native single-file `Read` exemption that branch adds would have
let an agent open it. The base guard denied every non-ack file in the directory; the exemption's
name-listed carve-out inherited the list's omissions.

**What changed** (`.claude/hooks/review-proof-guard.mjs`, `review-proof-guard.test.mjs`). The read
target gains a fifth verdict, "evidence": any `.json` real name inside `.claude/session-state` fails
closed whether or not the proof-name rule lists it. Every wrapper writes its evidence as JSON, and
the reads the exemption exists for are flags and `.txt` captures — of 25 refused native reads in the
audit window, 13 were `OVERNIGHT-INTENT.flag`, 9 `codex-review-latest.txt`, 2 reviewer `.txt`
captures, and 1 a proof JSON that was rightly refused. Pinned: the migration proof by absolute and
relative path, `codex-review-mig-*.json`, `claude-review-push.json`, `applied-migrations.json`,
`hold.json`, an unlisted future `*.json`, and a NotebookRead of the migration proof all deny; a
reviewer `.txt` capture still allows. The round record is
`2026-09-05-review-proof-guard-codex-round.md`; `docs/manual/KNOWN_ISSUES.md` (OPEN 2026-09-05)
states the rule alongside the shell-side alias hole it does not close.
