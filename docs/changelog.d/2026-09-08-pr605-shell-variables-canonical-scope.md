## 2026-09-08 — PR #605: shell variables in write destinations, canonical scope for every content guard, `.. ` traversal, launcher `--fix`

Three GitHub Codex P1 threads and three CodeRabbit findings on head `60910c005`, all closed by class.

**Shell variables in a write destination** (Codex P1 on `6e3f1bd36`, probe-confirmed: `d=.claude; printf x >
"$d/hooks/review-proof-guard.mjs"` and `n=package; printf '{}' > "$n.json"` passed the whole registered Bash hook
chain; the previous hook is silent on both by direct probe).

The first attempt RESOLVED same-command assignments before matching, and Codex (`gpt-5.6-sol`, exact-SHA review of
`5f69ecc2d`) returned High CRX-SEC-002 against it: the parser read raw text, so assignment-shaped text the shell
never executes — inside single quotes, a comment, an argument — forged a value, and the guard substituted the
HARMLESS one while the real destination still reached the shell. Reproduced on the committed hook:
`printf ' d=/tmp/x' ; printf x > "$d/hooks/review-proof-guard.mjs"` was silent. A parser that must model quoting,
execution position and scope to stay safe is the wrong shape for a deny guard, because every gap in it is an allow.

So there is no parser. The substitution feature is deleted (the fix is ~40 lines SMALLER than the attempt it
replaces): an expansion in a write destination is simply unreadable, and unreadable fails closed — a redirect target
carrying any expansion, or, in a segment whose head is not a recognised reader or a shell control word, a computed
expansion (`$(…)`, backtick, `${x:0:3}`) or a plain variable glued to a path shape (`$d/hooks/x.mjs`, `$n.json`,
`%d%\x`). Reads through variables are untouched (`echo "$d/…"`, `cat "$(git rev-parse --show-toplevel)/README.md"`,
`for f in $(git ls-files)`). Accepted cost, on the file's standing rule that a false refusal is the cheaper failure:
`printf x > "$LOG"` and `d=/tmp/s; printf x > "$d/out.log"` are refused — spell the destination out. Stated
residual: a plain variable NOT glued to a path shape (`cp /tmp/evil "$dst"`) is an environment variable by
construction and is not judged.

**DOS 8.3 short names** (Codex High CRX-SEC-001 on `5f69ecc2d`, confirmed on the review host's filesystem:
`CLAUDE~1` → `.claude`, `GITHUB~1` → `.github`, `HUSKY~1` → `.husky`, `PACKAG~2.JSO` → `package.json`,
`supabase\MIGRAT~1` → `supabase\migrations`, each resolving to identical bytes). Windows keeps these aliases for
every long name, so `CLAUDE~1/hooks/review-proof-guard.mjs` opened the guard while matching no protected pattern,
and `supabase\MIGRAT~1\x.sql` fell outside every migration check. EXPANDING an alias needs the filesystem and a
resolver for paths that do not exist yet; REFUSING one needs neither, and nothing legitimate spells a path this way.
A `~<digit>` segment is therefore refused wherever a path is judged: the shared `hasShortNameSegment()` in
autopilot-lib, `protectedSurfacePath()` while armed, review-proof-guard's native-editor rule, its MCP path-field
rule, its shell write destinations, and all eight content-guard scopes. A trailing-`~` backup name (`plan.md~`) and
a home-directory `~` are not short names and stay allowed, pinned in the tests.

**Canonical path before every content guard's scope predicate** (Codex P1 on `60910c005`: an alias spelling that
resolves to the real file fell outside the raw `includes()` predicate, so a MultiEdit creating a table without RLS
answered allow under the new auto-accept). Measured on this machine 2026-09-09: `x.sql::$DATA` opens the real file
through Node's fs (the native editors) and through PowerShell, and the committed `rls-on-new-tables` answered
`allow` to a MultiEdit through `migrations./x.sql`; `migrations.\x.sql` opens the real file through PowerShell (the
shell channel) but not through Node's fs; a `.. ` or trailing-space directory opens it through neither. The fix is
deny-only and by class, so every spelling the Win32 normaliser would fold is judged as the file it folds onto. All
eight PreToolUse content guards (`rls-on-new-tables`, `money-safety`, `generated-column-check`, `sql-safety`,
`status-enum-check`, `idempotency-body-check`, `actor-binding-check`, `grant-change-guard`) now scope on
`canonicalToolPath()`; the three `src/` predicates are anchored to a segment boundary so a repo-relative
`src/lib/x.ts` is in scope as well (the old `/src/` substring never matched it — alignment, stated). Known residual:
a UNC spelling (`//server/share/…`) collapses its leading separator in the canonical form, so a read of the on-disk
file for splice reconstruction can fail there; the guards' documented fragment-only fallback applies.

**`.. ` (dot-dot-space) traversal** (CodeRabbit Major on `60910c005`; the canonical output was runtime-observed):
`canonicalToolPath()` and both review-proof-guard resolvers tested for `..` before trimming, so a `.. ` segment
became empty and vanished — `.claude/worktrees/.. /hooks/review-proof-guard.mjs` canonicalised to
`.claude/worktrees/hooks/…`, matched nothing, and armed autopilot returned `allow`. Measured 2026-09-09: neither
Node's fs nor PowerShell opens a `.. ` segment as `..` on this machine, so this is consistency of the canonical form,
fail-closed, not a reproduced file write. The segment rule is now one exported `trimWin32Segment()`
(spaces trimmed and stream suffix cut BEFORE the dot check) used by autopilot-lib and by review-proof-guard's single
resolver; the shell rule also judges quote-aware tokens, because a quoted argument with a space inside it is one
path to the shell.

**One resolver, not two** (CodeRabbit Trivial): review-proof-guard's `resolveDotSegments` and `resolvePathCandidate`
were identical copies; the shell rule and the path-field rule now call one hoisted function with the same output
contract (trailing separator removed, so `Write .claude/hooks/` still denies as the existing test requires).

**Launcher `--fix`** (CodeRabbit Minor): `classifyFrom` checked the FIX word before the launcher rule, so
`npm exec -- eslint --fix` and `pnpm exec eslint --fix` were refused. Launchers are classified first; a nested
manifest write (`npm exec -- npm pkg fix`, `npm exec -- npm audit fix`, `pnpm exec yarn constraints --fix`) still
denies through the writing-word rule and the per-token manager classification.

Proof: 29 deny + 13 allow shell-variable and forgery cases, 5 short-name deny + 3 `~`-is-fine allow cases, 5
short-name path-field/editor cases, 3 allow + 3 deny launcher cases and 4 dot-dot-space cases in
`review-proof-guard.test.mjs`; 20 assertions in `autopilot-lib.test.mjs`; 22 alias cases (`migrations.`,
`migrations `, `src.`, `::$DATA`, repo-relative `src/`, `MIGRAT~1`, `SRC~1`) across all eight guards in
`content-guards-multiedit.test.mjs`. Both Codex blockers reproduced on the committed hook and closed:
the forged-assignment payload and the `CLAUDE~1` / `PACKAG~2.JSO` / `supabase/MIGRAT~1` payloads were
silent-or-allow at `5f69ecc2d` and deny after the fix, each with the previous file swapped in place and restored
sha-verified. Backwards, each
hook swapped in place with its committed version and restored sha-verified: review-proof-guard fails at
`must deny (shell variable in a write destination): d=.claude; printf x > "$d/hooks/review-proof-guard.mjs"`;
autopilot-lib fails at `PROVEN BYPASS: armed autopilot refuses the `.. ` traversal`; rls-on-new-tables, money-safety,
generated-column-check, sql-safety and status-enum-check each fail at their `migrations.` / `src.` alias case. Direct
probe of the committed hook: silent on the two Codex payloads, on `read d <<< .claude; cp /tmp/evil "$d/hooks/x.mjs"`,
and on the `.. ` Edit and `cp`; deny on `npm exec -- eslint --fix` (now silent). Real filesystem, this machine:
PowerShell `Get-Content` opens `migrations.\x.sql` and `x.sql::$DATA` as the real file; Node's fs opens `::$DATA`
only. Not verified: Codex's own editor channel (Rust std passes paths straight to Win32, so the trailing-period
forms are expected to fold there as they do in PowerShell) — the canonical forms are asserted for every spelling
regardless.
