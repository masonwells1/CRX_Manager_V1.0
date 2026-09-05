## 2026-09-05 - Three exact-SHA Codex rounds on the review-proof guard narrowing, and what they settled

Each `scripts/write-codex-push-proof.mjs` run on a candidate of
`2026-09-05-review-proof-guard-read-only-narrowing.md` returned `CODEX_PROOF_VERDICT: BLOCKERS`
with findings that were all confirmed by reproducing them against the candidate:

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

The two command-text narrowings were withdrawn after round 3: each round produced a real bypass in
the previous round's fix, which is the recorded "a command-text guard never converges" failure
mode. Their behaviour is the base guard's, every reproduced bypass is a pinned deny case, and each
over-block is pinned as a recorded choice with a workaround. Round 4, on the withdrawn shape, found
the alias hole in the one exemption that survived; the fix is a canonicalization the base guard
never had, so a proof read through an 8.3 alias or a symlink now denies for every native reader,
whether or not the path spells `session-state`. A fifth round runs on that shape.
