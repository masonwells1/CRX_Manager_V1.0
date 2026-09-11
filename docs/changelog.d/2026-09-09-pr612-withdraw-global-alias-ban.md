## 2026-09-09 - Withdraw PR #612's global native-read alias ban

PR #612 retains its resolved proof-name refusal, JSON-evidence refusal inside
review state, in-state multi-link refusal, and unresolvable-target fail-closed
classification. It withdraws only the new blanket refusal of every native read
that passed through an inspected symlink, junction, or other reparse component,
and the related propagation from a junctioned checkout parent.

Regression coverage now proves that an ordinary non-proof file through a
junction outside review state allows and that a direct real flag remains
readable when the checkout's parent is junctioned. It also keeps static proof
aliases, state-directory JSON, in-state multi-links, the directory itself,
Grep/Glob over the directory, and MCP readers denied.

The changelog, guardrails, and known-issues record now state the residual
plainly: a pre-tool hook cannot bind a checked pathname to a later open, so
alias retargeting and directory-entry replacement races remain open alongside
the pre-existing constructed-path, interpreter, and outside-state hard-link
routes. No production, database, or remote verification was performed.
