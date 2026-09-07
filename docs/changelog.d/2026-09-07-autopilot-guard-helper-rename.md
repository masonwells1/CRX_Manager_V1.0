## 2026-09-07 - the name-anchored deny helper no longer shadows the command variable

Follow-up to `2026-09-07-autopilot-guard-binary-shape.md`, same PR (#607). The helper that builds a
`<binary> <dangerous subcommand>` deny pattern was introduced as `cmd`, which is also the name of the
local variable holding the Bash command text inside both `autopilotDecision` and
`overnightGateDecision`. That is legal JavaScript and lint was clean, but it means a reader following
`cmd` through `.claude/hooks/autopilot-lib.mjs` meets two unrelated things with one name. Renamed to
`nameAnchored`, which also says what it does.

No behavior change, and that is measured rather than asserted: the 11,016-command differential sweep
returns the identical split (4,125 dangerous newly denied, 240 benign newly denied, 0 newly allowed,
0 drift in the plain-binary slice), and `node .claude/hooks/autopilot-lib.test.mjs` still reports 210
assertions passed. `npm run lint` is clean.
