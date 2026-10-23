## 2026-10-23 - native patch: Windows path aliases are refused, not judged

Second Luna review round on the native `apply_patch` envelope repair. The patch is applied on
Windows, where `production-action-guard.mjs.` (trailing dot), `production-action-guard.mjs::$DATA`
(alternate data stream) and `PRODUC~1.MJS` (8.3 short name) can name the protected file, and the
shared path matchers do not recognise all of those spellings (measured: the trailing-dot proof
file and the short name were allowed on the older bare-string route). Because this route used to
refuse every patch, letting those through would have been a new opening. A patch under
`tool_input.command` is now refused when any path it names has a segment ending in a dot or space,
a `:` other than a leading drive letter, an `~<digit>` short-name marker, or a wildcard or control
character. Plain dotted names (`.hidden.config.ts`, `a.b.md`) are unaffected. The older bare-string
and `patch`-field routes are unchanged and still carry those matcher gaps; they are recorded as a
separate follow-up.
