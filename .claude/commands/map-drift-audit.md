Run the **map-drift audit** — a read-only reconciliation of the app-workflow-map's claims against the live Supabase database + the actual code. Use it to diagnose whether the app's wiring (pages ↔ RPCs ↔ lifecycles ↔ RLS) has drifted from what the map shows, or after a feature/migration changes RPCs, status enums, or tables.

It is **read-only**: it analyzes and writes ONE report file. It does not edit code, apply migrations, deploy, or commit.

## The single source of truth

The full, canonical instructions live in **`docs/audits/map-drift-audit-prompt.md`** — read that file and execute it exactly. Do NOT paraphrase or duplicate its steps here: a second copy would drift from the original, which is precisely the failure class this audit exists to catch.

In summary, that prompt makes you:

- **Step 0** — freshen the map (`npm run generate-map`) and load its claims (the `NODES`/`EDGES` arrays in `docs/app-workflow-map.html` + the hardcoded `DATA_FLOW_EDGES` in `scripts/generate-workflow-map.mjs`).
- **Passes 0–6** — run the seven reconciliation passes against the live DB (project `rhyzpcqhnizqbxphqdkr`) + `src/`:
  0. harvest the map's own auto-checks · 1. asserted-flow verification · 2. RPC reality (missing / overloaded / `search_path`) · 3. lifecycle vs live CHECK constraints · 4. role / RLS coherence · 5. missing connections · 6. **map defects** (where the generator itself is stale).
- **Adversarial gate** — try to *refute* every BLOCKER/HIGH against live before it enters the report. A finding with no live-confirmed `file:line` / migration / constraint / RPC citation does not count.
- **Report** — write ONE dated file: `docs/audits/<YYYY-MM-DD>-map-drift-audit.md` (use a real clock for the date — `(Get-Date).ToString("yyyy-MM-dd")` — never fabricate it).

## Hard rules (from the prompt)

- **Read-only.** No `Edit`/`Write` except the one report file. No `apply_migration`, no deploy, no `git commit`.
- **A clean result is a valid, valuable result** — do not manufacture findings to look productive.
- **Cite or cut** — every finding carries a hard citation; unconfirmed leads go in a separate "needs human check" list, not the ranked findings.
- **Complements `/review-workflow`.** `/review-workflow` is the broad workflow sweep; this is the focused, repeatable "did the map drift from reality?" pass. Don't duplicate it.

## After the report

Give Mason a 5-line summary — verdict, counts by severity, the top finding (or "clean"), and the suggested next step — and remind him nothing was changed (read-only). If there are **map defects**, offer to fix `scripts/generate-workflow-map.mjs` so the next run starts from a more honest map.
