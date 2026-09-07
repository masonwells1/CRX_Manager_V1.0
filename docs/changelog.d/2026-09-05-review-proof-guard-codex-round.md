## 2026-09-05 - Eleven exact-SHA Codex rounds on the review-proof guard narrowing, and what they settled

The first six `scripts/write-codex-push-proof.mjs` runs on candidates of
`2026-09-05-review-proof-guard-read-only-narrowing.md` returned `CODEX_PROOF_VERDICT: BLOCKERS`
with findings that were all confirmed by reproducing them against the candidate; rounds 7 to 10
returned `CLEAN`; round 11, the first on the head that merged `main` at #610, found one more real
hole, which is fixed and pinned:

| round | finding | disposition |
|---|---|---|
| 1 | home `.claude` mask ran before `..` was resolved: `rm -rf ~/.claude/projects/../worktrees/x` | fixed, then superseded by withdrawal |
| 1 | `function Get-Content # comment\n{` is a legal definition; the `(`/`{` requirement missed it | fixed, then superseded by withdrawal |
| 1 | native `Grep` over `session-state` reads proof JSON line by line | fixed: only `Read`/`NotebookRead` are exempt |
| 2 | `worktrees` excluded only before `/` or end of string, not before a space, `./`, or a glob | fixed by allowlisting child folders, then superseded by withdrawal |
| 2 | `function global:Get-Content <#note#> {` (scoped name, block comment) | fixed by reading a quotes-removed view, then superseded by withdrawal |
| 3 | `find ~/.claude/history.jsonl -exec cat {} + > ~/.claude/history.jsonl` truncates before the read | withdrawal |
| 3 | `x="a\""; function cat {` defeats the quoted-span remover | withdrawal |
| 4 | a native `Read` of `.claude/session-state/CODEX-~1.JSO` — the Windows 8.3 short alias of a proof — was allowed, because the exemption trusted the basename it was given | fixed: the exemption resolves the target through the OS (`realpathSync.native`) and re-runs the proof-file rule on the real name; a target that does not resolve to a regular file fails closed |
| 4 | `notebook_path` was not a path candidate, so the `NotebookRead` test cases never reached the guard | fixed: `notebook_path`/`notebookPath` join the candidates; a NotebookRead of a proof is a pinned deny |
| 5 | through the SHELL, an 8.3 alias lets an agent hard-link a proof to a harmless name outside the state directory, rewrite it there, and have the push guard accept it — the KNOWN_ISSUES entry had called the alias a read-only exposure | the claim was corrected: it is a forge, it is reachable on `main` unchanged, and its durable fix (authenticated proof content) is a design change recorded there, not a text rule for this PR |
| 5 | the 8.3 test failed outright on a volume with short names turned off, which is the mitigation the docs recommend | fixed: skipped with a note when the volume generates no aliases at all; still fails when the directory has one and the proof does not |
| 6 | the draft folded "more than one hard link" into "unresolvable" BEFORE checking the resolved name, so an outside symlink to a hard-linked proof was allowed — and the Linux CI run of the test, which creates exactly that, would have failed | fixed: the read target is classified into four explicit verdicts (proof, aliased, unresolvable, clear) with the name check first; the exact shape is pinned |
| 6 | the KNOWN_ISSUES edit dropped the "OPEN 2026-09-04" heading of the entry below it | fixed |
| 7 | none | `CODEX_PROOF_VERDICT: CLEAN` |
| 8–10 | none; re-binds after `main` moved (#606) and after the Codex GitHub App's doc corrections (this record's round count; the `fsutil` strip called reversible; the retained scoped-name hardening left unrecorded) | `CLEAN` each time |
| 11 | HIGH: `migration-review-<name>.json` — the migration reviewer proof minted by `scripts/write-apply-proofs.mjs` and consumed by `migration-apply-lib.mjs` — is not in `reviewProofPathMentioned()`, so a native `Read` of it reached the new exemption and was allowed; the base guard denied every non-ack file in the directory | fixed: the read target gains a fifth verdict, "evidence" — any `.json` real name inside the state directory fails closed whether or not the name rule lists it (all wrapper evidence is JSON; the legitimate reads are flags and `.txt` captures); pinned for the migration proof by absolute and relative path, `codex-review-mig-*.json`, `claude-review-push.json`, `applied-migrations.json`, `hold.json`, an unlisted future `*.json`, and NotebookRead of the migration proof; a reviewer `.txt` capture stays readable |
| Codex GitHub App on the round-11 head (P1) | when `.claude/session-state` is ITSELF a junction or symlink to an external directory, `realpathSync.native` strips the protected components from every file under it, so the resolved-path test said "outside" and an unlisted proof classified as clear again | fixed: membership is decided three ways — resolved path spells the state directory, the lexical path the tool was given spells it, or the resolved file's directory is the real location of this checkout's own state directory; the proof-name and `.json` rules run on both paths; pinned with a real junction fixture (absolute, cwd-relative, and external-real-path reads of the migration proof deny; the intent flag through the junction allows) |

The two command-text narrowings were withdrawn after round 3: each round produced a real bypass in
the previous round's fix, which is the recorded "a command-text guard never converges" failure
mode. Their behaviour is the base guard's, every reproduced bypass is a pinned deny case, and each
over-block is pinned as a recorded choice with a workaround. Round 4, on the withdrawn shape, found
the alias hole in the one exemption that survived; the fix is a canonicalization the base guard
never had, so a proof read through an 8.3 alias or a symlink now denies for every native reader,
whether or not the path spells `session-state`. Rounds 5 and 6 corrected the KNOWN_ISSUES claim
and the classification order; rounds 7 to 10 returned `CLEAN`. Round 11 shows why a re-bind after
`main` moves is a real review and not a formality: a fresh reviewer on the same five files found a
proof shape ten earlier rounds had not named. The lesson recorded with the fix is that a
NAME-listed carve-out inherits the list's omissions, so the exemption now allows by SHAPE (a
non-JSON regular file) and denies everything else in the directory.
