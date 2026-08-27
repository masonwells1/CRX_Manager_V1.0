## 2026-08-26 - trusted documentation fast lane verified live

The first production-backed proof change for the trusted documentation route adds only this new,
valid changelog fragment. Its pull-request and merge-push checks must keep containment, CI scope
classification, the full SQL migration audit, and both required status contexts visible and green
while skipping application lint, type checking, guards, tests, coverage, build, and Windows
containment. Any uncertain, protected, executable, or mixed path, plus any non-added changelog
fragment, still falls back to complete CI. The exact passive `README.md` and `docs/CHANGELOG.md`
records may also be modified or deleted in the fast route.
