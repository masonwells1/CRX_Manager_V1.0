## 2026-09-07 - the armed-mode option matcher is described by shape, not by a list of spellings

Follow-up to `2026-09-05-autopilot-guard-global-options.md`, on the same PR (#607). That fix taught
the armed-mode deny-set to see global options between `git`/`gh` and the subcommand, but it did so by
**enumerating the option spellings it knew** — `(?:-[cC]\s+\S+|--\S+)` for git,
`(?:-[RFf]\s+\S+|--repo\s+\S+|--\S+)` for gh. A name-listed carve-out inherits the list's omissions,
and this one did. Codex raised it as a P1; both cases below were then confirmed by **running**
`autopilotDecision()` against a corpus, not by re-reading the regex.

## The two holes

| Command | Old verdict | Why it leaked |
|---|---|---|
| `git -C "C:/CRX Manager/wt" push origin HEAD:feature` | **allow** | `\S+` stops at the first space, so a quoted value ended the match. CRX worktrees genuinely sit under a path with a space, so this is an ordinary command here. |
| `gh -Rmasonwells1/CRX_Manager_V1.0 pr merge 625` | **allow** | `-[RFf]\s+` required a *detached* value; an attached short-option value is standard POSIX/`gh` usage. |

The unquoted control `git -C C:/CRX_Manager/wt push …` and the detached control
`gh -R masonwells1/… pr merge …` were denied correctly, so only the quoting and the attachment broke.
Eleven more commands of the same two shapes leaked with them — `--git-dir="C:/CRX Manager/.git" push`,
a backslash-escaped space, `-C"a b"`, `-CC:/path`, and the quoted forms of `reset --hard`,
`clean -fd`, `worktree remove` and `branch -D`.

## What changed

`.claude/hooks/autopilot-lib.mjs` now describes the option region by **shape**, with two token
classes and no per-option knowledge:

- **`OPT_TOKEN`** — a shell word starting with `-`. Everything after the dash is just "more word", so
  `--force`, `-Rowner/repo`, `--repo=owner/repo` and `-C"C:/CRX Manager/wt"` are each one token with
  no special case per spelling.
- **`VAL_TOKEN`** — a shell word *not* starting with `-`: an option's detached value.

A shell word is a run of quoted sections (which may contain spaces), backslash-escaped characters and
ordinary characters. That closes the quoting hole for every option at once instead of for the ones
someone remembered to list.

This is still not `.*`. The region ends at the first word that is neither an option nor an option's
value — and that word is the subcommand. `git commit -m "fix the push bug"` opens with `commit`,
which is not an option token, so the region is empty and the pattern then needs `push` where `commit`
stands; the `push` inside the quoted message is unreachable from that `git`. Only a leading `-` opens
the region at all.

**Known, asserted over-denial:** a valueless global option immediately followed by the subcommand can
swallow that subcommand as its "value", so `git --no-pager log --grep push` is denied. Telling those
apart needs per-option arity — another name list. For a deny-set an occasional extra denial is the
safe side of the trade, and the four benign controls are unaffected.

**Known residual, not fixed here:** the binary is still matched as `\bgit\b` / `\bgh\b`, so the
Windows spellings `git.exe push` and `gh.exe pr merge 1` are not seen. That is a different axis from
the option region and outside this PR's subject; it is unchanged from before either fix.

## Proof

- A 33-case corpus (both bypasses, 11 same-shape spellings, 4 named controls, 12 benign commands) run
  against the **old** library: **19/33**, with all 14 failures on the deny side and every benign
  command already correct. The same corpus against the **new** library: **33/33**.
- The corpus now lives in `.claude/hooks/autopilot-lib.test.mjs`. Run against the pre-fix library it
  aborts on the first new assertion (`PROVEN BYPASS: double-quoted -C path with a space`,
  `'allow' !== 'deny'`); against the new library `node .claude/hooks/autopilot-lib.test.mjs` reports
  **137 assertions passed** (107 before).
- `npm run test:correction-guards` and `npm run test:agent-workflows` both pass.
- The option region nests quantifiers, so backtracking was measured rather than assumed: 400 global
  options plus a non-matching subcommand decides in well under a millisecond, and the test asserts a
  1-second ceiling.

This widens a deny-set only; nothing previously blocked becomes allowed. Autopilot is not armed in
any worktree, so both bypasses were latent.
