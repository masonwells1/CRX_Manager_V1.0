## 2026-10-23 - native patch: bound link resolution by the hook deadline

Codex GitHub App P1 on PR #1083: resolving every patch destination through links costs a filesystem
lookup per path component, so a patch of thousands of deeply nested missing paths could run the
hook past its 15-second limit, and a hook killed at its limit allows the action. Reproduced by the
reviewer with a 14.5 MB patch. The native patch route is now bounded: at most 200 paths per patch,
1024 characters and 48 segments per path (the worst case the caps admit resolves in well under a
second in the suite), plus a deadline check before each destination that refuses once the hook's
budget is spent. Tests pin each cap, the worst admitted case, and the deadline; each was disabled in a
scratch copy and the suite failed.
