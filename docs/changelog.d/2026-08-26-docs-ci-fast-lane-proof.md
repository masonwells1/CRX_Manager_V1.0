## 2026-08-26 - trusted documentation fast lane verified live

The first production-backed proof change for the trusted documentation route adds only this new,
valid changelog fragment. Its pull-request and merge-push checks must keep containment, CI scope
classification, the full SQL migration audit, and both required status contexts visible and green
while skipping application lint, type checking, guards, tests, coverage, build, and Windows
containment. Any uncertain, protected, executable, mixed, modified, renamed, or deleted path still
falls back to complete CI.
