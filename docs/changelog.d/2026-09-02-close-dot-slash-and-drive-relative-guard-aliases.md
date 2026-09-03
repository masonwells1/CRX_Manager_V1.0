## 2026-09-02 — `./` and `C:`-relative aliases still reached every protected guard file

Third round of the same hole, from the exact-SHA `gpt-5.6-sol` review of PR #563
(`VERDICT: BLOCKED`, HIGH). The round-2 fix canonicalized direct file-tool paths
and sniffed shell commands for `../`. Codex walked past it twice.

**Files:** `.codex/hooks/production-action-guard.mjs`, `.codex/hooks/production-action-guard.test.mjs`, `scripts/apply-live-testdata-maintenance-20260812.mjs`

### What still got through

Codex confirmed by read-only execution that all of these returned `blocked:false`:

```
Set-Content .claude/hooks/./codex-push-lib.mjs ...
Set-Content scripts/./write-codex-push-proof.mjs ...
Set-Content .codex/./hooks.json ...
Write to C:.claude/hooks/codex-bot-review-lib.mjs
```

Two distinct causes:

1. **Interior `./`** — the shell check looked for a literal `../`. A single-dot
   segment is just as effective and was not in the pattern.
2. **Windows drive-RELATIVE prefix** — `C:.claude/...` has no slash after the
   colon, so the canonicalizer's `^[A-Za-z]:\/` never matched, the prefix
   survived, and `.claude` ended up preceded by `:` where the protected anchor
   (`^` or a separator) could not see it.

### The lesson, and the actual fix

Sniffing for spellings does not terminate. Round 2 blocked `../`; round 3 used
`./`. Round 4 would have used something else.

So the shell check no longer looks for dot-segments at all. It splits the command
into candidate path tokens, **canonicalizes each one**, and tests the canonical
result against the protected-path matcher. `./`, `../`, `C:`-relative,
backslashes and any combination collapse to the same string, so one rule covers
spellings nobody has enumerated yet. The canonicalizer now drops a Windows drive
prefix entirely — deliberately over-inclusive, since no legitimate workflow needs
to write a harness file through a drive-qualified alias.

### Proof — the guard itself, not the tests

The unit tests are mine and could encode the same misunderstanding that caused
the bug, so the fix was exercised by driving `evaluateProductionAction` with
**Codex's verbatim payloads**:

```
=== Codex round-2 payloads (expect blocked=true) ===
PASS  blocked=true  Write        .claude/hooks/../hooks/codex-bot-review-lib.mjs
PASS  blocked=true  apply_patch  .claude/hooks/../hooks/codex-bot-review-lib.mjs
=== Codex round-3 payloads (expect blocked=true) ===
PASS  blocked=true  PowerShell   Set-Content .claude/hooks/./codex-push-lib.mjs
PASS  blocked=true  PowerShell   Set-Content scripts/./write-codex-push-proof.mjs
PASS  blocked=true  PowerShell   Set-Content .codex/./hooks.json
PASS  blocked=true  Write        C:.claude/hooks/codex-bot-review-lib.mjs
=== must stay allowed (expect blocked=false) ===
PASS  blocked=false Write        src/components/Label.tsx
PASS  blocked=false Write        .claude/hooks/codex-bot-review-lib.test.mjs
PASS  blocked=false Write        .claude/hooks/../hooks/some-other-lib.mjs
PASS  blocked=false PowerShell   cat .claude/hooks/./codex-push-lib.mjs
PASS  blocked=false PowerShell   npm run test:correction-guards
```

Codex is the independent witness that those first six returned `blocked:false`
before this change. The last five matter as much: a guard that blocks everything
is not a fix — an unrelated file reached through a detour, the module's own test
file, and a READ through a detour all stay allowed.

### On the review's other finding

It also reported that actor-forgery protections were "substantially rolled back"
with tests deleted from `package.json`. **False positive from a stale base** —
#564 landed that work on `main` after this branch's last merge, so the packet
compared main-with-#564 against a candidate without it. `git rev-list
--left-right --count` showed one commit behind, and that commit was #564.
Nothing was deleted. This is the third such phantom on this PR (the others
claimed a deleted `TODO.md` deadline from #566); on a `main` moving this fast it
is a systematic artifact of packet timing, not bad luck.
