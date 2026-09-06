## 2026-09-05 - the retired 2026-08-12 maintenance producer is removed, with its harness, inputs, CI step and pins

Follows `2026-09-05-retire-20260812-maintenance-producer.md`, which recorded Mason's decision on its
own so the producer's retire lane had a reviewed commit to run against.

**What changed.**
- `scripts/apply-live-testdata-maintenance-20260812.mjs` was deleted by running its exact
  `--retire-producer` command against the docs-only commit `3ce6068af` (rebased to `c870e4aba`
  after PR #621 landed on `main`) under a fresh exact-head `gpt-5.6-sol` proof, which is the only
  way the shell guards and the script itself allow it. The
  lane performs a single local `rmSync`; the script has no Supabase client, no network call and no
  SQL in any lane, so the live database was never involved.
- Removed with it, because nothing else uses them: the producer's regression harness
  (`scripts/apply-live-testdata-maintenance-20260812.test.mjs`), the three
  `docs/maintenance/2026-08-12-live-testdata-*.snippet.txt` inputs, the CI step that ran the harness
  (it would fail on a missing file), the two `.gitattributes` LF pins for the deleted scripts, and
  the block in `.codex/hooks/production-action-guard.test.mjs` that shelled out to the harness and
  asserted on its exact assertion count. The by-name denial assertions in that test stay.
- `docs/manual/KNOWN_ISSUES.md` flips the entry from CLOSING to CLOSED, and
  `docs/reference/agent-guardrails.md` notes that editing the Codex production guard no longer
  requires a blob re-pin.

**Claude shell guard fails closed on the retired path (Codex P1, 2026-09-05 20:53Z).** The exact-SHA
review of the first deletion candidate found that `.claude/hooks/bash-safety-lib.mjs` still
allow-listed the producer's four exact invocations. That allowlist was safe only while the script
itself enforced the committed-blob and exact-head-proof checks; with the script deleted, a
replacement file at the same path could have run through the old spellings with no proof at all.
The allowlist is removed and every mention of the producer path is now denied, with a message that
names the retirement; the four former "allowed" assertions in `bash-safety.test.mjs` are inverted.
This is the one guard edit in the change, and it will conflict with the parked by-name guard rewrite
on `claude/maintenance-producer-guard-by-name`, which rewrites the same function; that rebase should
keep the fail-closed behaviour.

**Deliberately unchanged.** `.claude/hooks/codex-push-lib.mjs` (`RISKY_PATH_RES`) and
`.codex/hooks/production-action-guard.mjs` still name the retired path. The Codex-side gate already
fails closed without the file (it cannot bind the producer to a committed HEAD blob), and keeping
the push guard's risky-path entry means any future re-addition of that path needs an exact-head
Codex proof to push.

**Proof.** Retire-lane output, the Claude shell-guard, MCP-guard and Codex production-guard test
suites and `npm run test:agent-workflows` run green with the files gone, `check-doc-drift` passes,
and the push carried a second exact-head Codex proof because the producer path is in
`RISKY_PATH_RES`. Details in the PR.

**Not verified.** The `live-testdata-lib.mjs` classifier false positives (2026-09-02 family) remain
open; this change repairs nothing there.
