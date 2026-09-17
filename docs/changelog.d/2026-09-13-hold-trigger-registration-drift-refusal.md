## 2026-09-13 - Refuse changed hold-trigger registrations on migration replay

GitHub Codex review of PR #689, comment 4002212614, identified that the unapplied
hold receipt migration pinned the standalone insert-guard body but could still
overwrite a later disabled or reconfigured trigger registration. The new
preflight verifies the expected table, trigger name, exact guard-function OID,
BEFORE ROW INSERT type, enabled state, non-internal status, zero arguments and
absence of a WHEN qualifier before any replacement. An occupied name with the
expected function absent also refuses. First installation remains allowed when
both the function and registration are absent.

The independently executed disposable PostgreSQL regression failed against the
previous candidate: process 17435 exited 1 because replay silently restored the
disabled standalone insert trigger. After the 15-line correction, process 99203
exited 0. It demonstrated disabled-registration refusal with state D preserved
and AFTER INSERT registration refusal with type 5 preserved, then restored the
captured original definition inside the throwaway database. The same full proof
replayed 93 predecessor migrations and passed the existing keyless cutover,
concurrent same-key receipt replay, rolled-back smoke, source-backed insert
boundaries, unchanged rerun, receipt-body/registration drift and hold-body drift
checks. The focused migration contract passed all seven tests.

Scoped security and migration drift reviews returned zero blocker, high or
medium findings. Final compliance, exact-commit independent review, remote
checks and production verification are recorded by the landing coordinator as
they complete. Unchanged frontend and prior full-suite proof remain supporting
evidence; the changed SQL requires fresh exact-commit delivery clearance.

No function bodies, body pins, signatures, grants, columns, money math or
frontend behavior change in this correction. No live database query, apply or
business mutation was performed. Migration 20260908130000 remains NOT APPLIED.
PR #689 and its original finding are preserved; its thread is resolved only
after an actually published checked successor is linked.
