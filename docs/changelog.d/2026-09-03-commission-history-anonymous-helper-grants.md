## 2026-09-03 - Fail closed on anonymous commission helper grants

- Reject migration replay if either internal commission-history helper is executable by the anonymous
  API role, instead of silently revoking and concealing a prior security exposure.
- Compare the complete non-owner ACL for all four functions, including unexpected roles and grant
  options, and mutation-test both helper signatures plus unexpected-role and grant-option drift.
- Reject replays containing any untracked NULL-history cancellation outside the clean-schema or
  exact two-row live legacy shape.
