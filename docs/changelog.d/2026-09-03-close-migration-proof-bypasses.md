## 2026-09-03 - Close additional migration-proof review bypasses

The proof fingerprint now includes the reviewer executable resolver and the
SECURITY DEFINER ACL scanner. Review proof fixtures also bind to their synthetic
protected policy commit, including explicit missing-policy and wrong-policy
denials.

The SECURITY DEFINER precondition now parses executable SQL rather than raw
text, requires the exact function signature to revoke both `PUBLIC` and `anon`,
and detects a later grant that restores either role.
