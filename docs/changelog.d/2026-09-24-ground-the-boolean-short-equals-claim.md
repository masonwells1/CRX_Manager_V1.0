## 2026-09-24 - ground the "a boolean short carrying `=` is refused" claim in a measurement

Follow-up to `2026-09-23-push-guard-bundled-short-option-cluster.md`, on the same branch.

CodeRabbit reviewed PR #784 at its frozen head `544d80f60` and returned CHANGES_REQUESTED with
one finding, which was correct. Both the code comment in `.claude/hooks/codex-push-lib.mjs` and
the changelog body asserted that git "rejects `-f=o` outright" as established fact, while that
same changelog's **Not verified** section said the shape had never been measured against git. An
unmeasured claim stated as fact is precisely what that section exists to prevent.

### Measured rather than softened

    git push --dry-run -q=o <throwaway local bare repo> HEAD:main
    error: unknown switch `='
    usage: git push [<options>] [<repository> [<refspec>...]]

Git refuses a boolean short that carries `=`, so ending the cluster at a non-alphanumeric — which
is what `pushShortCluster` does — matches git's own parse rather than merely being the cautious
choice. Added as a fourth row to that entry's proof table.

### The honest limit, now stated in the right place

The measurement used `-q=o`, not the `-f=o` spelling the comment named: the force-push guard denies
every `-f` spelling before git can run, which is itself the stronger gate on that form. `-q` and
`-f` are both boolean shorts on the same parse-options path, so this covers the shape — but it is a
generalization from one spelling, not a direct measurement of `-f=o`, and the **Not verified**
section now says exactly that instead of contradicting the body.

### Scope

Comment and documentation only. `pushShortCluster` and all three call sites are byte-identical to
the reviewed head; no guard behaviour changed. Re-ran `codex-push-lib.test.mjs` (pass),
`pr-merge-guard.test.mjs` (159 assertions), and `npm run check-doc-drift` (pass).

Because this moves the head, the CodeRabbit review bound to `544d80f60` no longer describes the
candidate: #784 is superseded and a fresh PR carries the final head once the Codex rounds can run
(credits return 2026-09-26 08:40).
