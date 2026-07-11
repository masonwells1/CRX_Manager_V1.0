# ChemMan Parity Loop — Ledger

Mission: `docs/loops/chemman-parity-loop-2026-07-11.md` · Worktree: `C:\CRX_ChemMan` · Branch: `feat/chemman-parity-2026-07`
Loop start (UTC): 2026-07-11T16:20Z (Step 0)

## Step 0 — setup

- Worktree created from origin/main @ 933189b2 (includes the mobile-overhaul merge).
- `npm install` OK. `codex-cli 0.144.1` OK. Wrapper self-test PASS (Terra wrote + we deleted `scripts/.codex-build-selftest.txt`).
- Live migration high-water: version `20260711150108` (name-stamp high-water `20260712220000`) — new migrations must stamp `20260713000000+`.
- Disk migration `20260712120000_save_job_applied_record_payload_conflict_guard` IS applied live (version 20260710190012) — registry was stale, not the DB.
- Schema registry: rebuilt from live introspection (subagent) — see Step-0 commit.
- Baseline green: typecheck ✓ · build ✓ · lint ✓ · tests 3262 passed / 117 skipped ✓.
- GROUNDING AMENDMENT recorded in mission §5: vehicles + job tags + rem-acres + as-applied tach/weather/crew + job_attachments already shipped by parallel sessions; units M4/M5/M11 shrink accordingly.

## Units

| Unit | Status | Tier | Rounds | Migration | Commit | Verdict |
|---|---|---|---|---|---|---|
| M1 | pending | terra | – | – | – | – |
| M2 | pending | terra | – | – | – | – |
| M3 | pending | terra | – | – | – | – |
| M4 | pending | terra | – | – | – | – |
| M5 | pending | sol+terra | – | – | – | – |
| M6 | pending | sol+terra | – | – | – | – |
| M7 | pending | terra | – | – | – | – |
| M8 | pending | terra | – | – | – | – |
| M9 | pending | sol+terra | – | – | – | – |
| M10 | pending | terra | – | – | – | – |
| M11 | pending | terra | – | – | – | – |
| M12 | pending | research | – | – | – | – |

## Per-unit PROOF log

(appended as units complete)
