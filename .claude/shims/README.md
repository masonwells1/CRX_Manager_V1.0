# Capability-layer shims

These replace a guess with a fact.

`.claude/hooks/codex-recursion-guard.mjs` reads the command **string** an agent
asks to run and decides whether it looks dangerous. Ten adversarial review rounds
found eighteen ways past that boundary — quote-composed names, caret escapes,
platform variable expansion, shim extensions, redirects glued to the executable,
builtin wrappers, launchers with numeric arguments, a bare `kill` — not one found
by reasoning about the pattern; every one came from executing commands against
it. The reviewer's conclusion, three verdicts running:

> Extending token enumeration with another escape rule will remain structurally
> bypassable. Keep the issue open until capability-level enforcement and
> end-to-end bypass tests exist.

**The reason text matching keeps losing is that the shell rewrites the text
before it resolves the program.** Quotes, carets, variables and redirects are all
gone by the time the program name is looked up. So this layer sits on the far
side of that rewrite: `bin/` goes first on `PATH`, and every one of those
spellings arrives as the same lookup. There is nothing left to spell differently.

## What is here

| File | Role |
|---|---|
| `bash-env.sh` | Prepends `bin/` to `PATH` and disables the `kill` builtin. Loaded via `BASH_ENV`, which bash reads for every non-interactive shell — exactly what the Bash tool runs. |
| `bin/codex` | Refuses the `review` subcommand; passes everything else through to the real binary. |
| `bin/taskkill`, `bin/pkill`, `bin/killall`, `bin/kill` | Refuse process termination. |

`BASH_ENV` is wired in `.claude/settings.json`. That block holds **literal**
strings — it cannot expand `$PATH` — which is why the `PATH` edit lives in
`bash-env.sh` rather than the JSON.

## Two things that will bite you

**`kill` is a shell builtin**, so a `PATH` entry alone never runs. `bash-env.sh`
calls `enable -n kill` specifically to force the lookup. Remove that line and the
shim is installed but unreachable — it fails **silently**, which is the same
"looks clean, never ran" shape as the incident itself. `capability-shim.test.mjs`
pins the line for that reason.

**A missing `BASH_ENV` target is ignored silently by bash.** Point it at a path
that does not exist and everything here quietly stops working while still
appearing installed. The test suite runs the real shims through real bash so this
cannot pass unnoticed.

## What this does NOT cover — keep the text guard

This layer is not a superset. It is the other half.

- **Absolute paths skip `PATH`.** A fully-qualified termination binary never
  consults `bin/`. Pinned as a passing test so nobody mistakes it for coverage.
- **PowerShell cmdlets are not on `PATH`.** `Stop-Process` is built into that
  shell, so no shim intercepts it.
- **API-level termination** — a `.kill(pid)` call, a `.Kill()` method, a CIM
  `Terminate` invocation — never resolves a program at all.

`codex-recursion-guard.mjs` covers those three. **Do not delete either layer
believing the other is total.**

## The gain beyond coverage

The text guard cannot tell *writing about* a tool from *running* it, so it
refuses an ordinary `grep` for one of these names — it even blocked the commit
message describing it. This layer never faces that question, because nothing is
executed, so prose runs normally. That over-block is fixed here, and a test pins
it.
