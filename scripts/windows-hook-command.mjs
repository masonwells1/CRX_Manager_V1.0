#!/usr/bin/env node
// Detector for the 2026-07-28 fail-open: a `.codex/hooks.json` `commandWindows`
// string is itself launched through a PowerShell parent, so the parent expands
// any `$…` in it before the inner PowerShell ever parses the line. `$root`
// therefore arrived empty, `Join-Path $root '<path>'` fell to a single argument,
// and PowerShell consumed the hook's own stdin payload as the missing ChildPath.
// All 30 Windows guards failed open that way while still "existing", so the
// presence check in check-agent-guidance.mjs stayed green the whole time.
//
// Every PowerShell expansion form is rejected, not just the bare `$root` that
// caused the outage: `${root}`, `$env:FOO`, and `$(...)` are expanded by the same
// parent and would reintroduce the identical failure. Windows hook commands need
// no expansion at all — use an inline `(git rev-parse --show-toplevel)` command
// group, which the inner PowerShell evaluates itself.
const POWERSHELL_EXPANSION = /\$[A-Za-z_{(:]/;

export function hasWindowsShellVariable(commandWindows) {
  return POWERSHELL_EXPANSION.test(commandWindows || "");
}

export function findWindowsShellVariableHooks(hooks) {
  return hooks.filter((hook) => hasWindowsShellVariable(hook?.commandWindows));
}
