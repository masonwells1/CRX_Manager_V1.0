## 2026-09-09 - Compose recursive-delete alias command heads

PowerShell and cmd recursive-delete alias scans now reuse the shape-aware command
head matcher, so executable-suffix and path-qualified aliases retain the existing
order-independent recursive-switch detection. Regression tests pin both bare and
executable-suffix forms for the six reviewed bypasses; direct module execution
observed every suffix form change from `allow` to `deny`, and the focused guard
suite passed 357 assertions. The full correction-guard and agent-workflow suites
also passed; no production command was run or production state changed.
