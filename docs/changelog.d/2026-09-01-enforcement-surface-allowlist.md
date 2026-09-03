## 2026-09-01 — the enforcement-surface rule becomes a fail-closed allowlist after Codex found it trivially bypassable

Follow-up to the guarded-surface lock removal earlier the same day. The replacement rule shipped as a
**blocklist of destructive verbs**, and an exact-SHA `gpt-5.6-sol` review returned HIGH with
parser-confirmed bypasses: `cp … .husky/pre-push`, `tee .husky/pre-push`, `sed -i … .husky/pre-push`,
`Set-Content .codex/hooks.json`, `Copy-Item … .claude/hooks/…`, and `echo x >| .husky/pre-push` were
all allowed. Native `apply_patch` and MCP path-field writes were uncovered too.

That is the failure mode this repo already had a rule about — a blocklist reopens every time someone
learns a new verb — and the deleted lock had the shape right. Losing it in the port was a real
regression, not a scope decision.

**Now:** a shell segment naming `.husky`, `.github/workflows`, `.claude/hooks`, `.claude/settings.json`,
`.claude/settings.local.json`, `.codex/hooks*`, `.codex/config.toml`, or `.coderabbit.yaml` must have a
recognized read-only head or it denies. `git checkout|restore|apply|am|rm|mv`, `git clean`, `patch`,
`python`, `perl`, `install`, `dd`, and anything invented later are refused without being enumerated.
Path-field writers (MCP filesystem tools, move/copy tools, `apply_patch` destinations) deny as well.

**Native `Write`/`Edit` are deliberately exempt and stay with the `ask` tier.** There is no unlock any
more, so denying them would permanently strand hook maintenance — the exact failure that removed the
lock. That tier is mode-dependent (`dontAsk` makes it a real denial; bypass-permissions mode honours
nothing), so this is recorded as a stated residual in the guard's own comment, not presented as a
boundary. Branch protection remains the boundary.

`cd`/`pushd`/`Set-Location` are on the read-only list: they write nothing, and `cd .claude/hooks &&
node review-proof-guard.test.mjs` is how the suite runs. The cwd-persistence residual that creates is
stated in the code rather than hidden.

One pre-existing assertion was deliberately reversed: an MCP move of a hook file used to be asserted
ALLOWED (true while the lock caught it) and now denies.

Verified live against the real hook, not only in tests: `tee .husky/pre-push` and
`cp … .husky/pre-push` are both refused; `cat .husky/pre-push` and `git diff` on a hook file still
pass. The guard also refused this change's own `sed -i` edit to itself, which is the rule working.
