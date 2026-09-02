## 2026-09-02 - Arm allowance accepts forward slashes only (cross-platform correctness)

CI caught what a Windows workstation cannot: the arm allowance also accepted the Windows
backslash spelling, and that is a genuine cross-platform bug.

## The defect

`ARM_CMD_RE` admitted `.claude\hooks\autopilot-arm.mjs`. On Windows that resolves normally.
On Linux `\` is **not** a path separator, so the whole string is a single filename that never
resolves to the trusted script — the documented arm command would have been refused on any
non-Windows runner. The guard-hook regression suite failed in CI:

```text
AssertionError: Windows path separator passes
  actual: 'deny-until-armed'   expected: 'allow-through'
```

## Why rejection, not normalization

Normalizing `\` → `/` before resolving would be **worse than rejecting it**. On Linux a file
literally named `.claude\hooks\autopilot-arm.mjs` is creatable; normalization would match that
name against the trusted path while Node executed the literal-backslash file instead —
re-opening the exact identity confusion the root-binding fix just closed.

Forward slashes cost nothing: Node accepts them on Windows, and they are the spelling both
the handshake's deny message and `autopilot-arm.mjs`'s own header already document. One
canonical shape, one slot to reason about.

## Verification

80 unit assertions and 10 end-to-end checks pass. The backslash form is now asserted
**denied**, with the forward-slash form asserted allowed under `PowerShell` as well as
`Bash`, so the cross-platform contract is pinned rather than assumed.

## Note

This is the second defect in this change set that only a non-Windows runner could surface.
Path handling in these guards is resolved with `node:path`, whose behaviour is
platform-dependent by design — any future path comparison here needs a CI run, not just a
local one, before it is believed.
