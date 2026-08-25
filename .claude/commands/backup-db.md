Run a full read-only backup of the live CRX Supabase database (project `rhyzpcqhnizqbxphqdkr`) into dated JSON files under `backups/`. The Supabase project is on the FREE plan — there is **no point-in-time recovery**, so this weekly dump is the only restorable copy of production data.

Mason does not type this command name. Run this flow when the weekly scheduled backup session starts, or when he says anything like: "back up the database", "backup the db", "make a backup", "run the backup". (If he asks "is my data backed up?", check BOTH channels — this local dump's `backups/LATEST-OK.json` AND the "Off-site DB backup" GitHub Action in the private `masonwells1/CRX_Backups` repo — and report the **newest** successful one; the staleness hook already consults the off-site workflow, so a fresh off-site run counts even when the local marker is old. No new backup needed just to answer the question.)

**Read-only guarantee:** every database call in this flow is a `SELECT` via the Supabase MCP `execute_sql`. Never any INSERT/UPDATE/DELETE/DDL. No service keys ever land on disk — the MCP holds the credentials; the script (`scripts/backup-db.mjs`) has no DB access at all.

## Steps

### 1. Print the plan

```bash
node scripts/backup-db.mjs --plan
```

This prints the exact introspection SQL and the steps below — use it as the checklist.

### 2. List the tables (MCP, read-only)

Via Supabase MCP `execute_sql` (single statement — `execute_sql` returns only the LAST statement's result, so never batch):

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1;
```

Note the table count **N** — the ingest step verifies against it.

### 3. Dump every table (MCP, read-only)

For each table, `execute_sql`:

```sql
SELECT * FROM public.<table>;
```

Write the raw row array **exactly as returned** to `backups/YYYY-MM-DD/<table>.json` (UTC date, one file per table; an empty table still gets its file with `[]`). For large tables (where `execute_sql` truncates), paginate with `ORDER BY <pk> LIMIT 1000 OFFSET <k>` and concatenate the pages into ONE array before writing.

### 4. Verify + finalize (deterministic script)

```bash
node scripts/backup-db.mjs --ingest backups/YYYY-MM-DD --expected-tables <N>
```

The script: verifies every dump parses as a row array, FAILS on a table-count mismatch or unparseable file (writing nothing), builds `backups/YYYY-MM-DD/manifest.json` (per-table row counts + bytes), prunes dated backup dirs older than 8 weeks (file-by-file — never a recursive force delete), and on success stamps `backups/LATEST-OK.json`. Pruning only ever runs AFTER the new backup verified.

### 5. Confirm

- Exit code 0.
- `backups/LATEST-OK.json` exists with today's `completed_at`. (This marker is one of the two evidence sources `session-staleness.mjs` consults — the other is the "Off-site DB backup" GitHub Action in `masonwells1/CRX_Backups`; the hook warns only when BOTH are stale.)

### 6. Report — one line, plain English

> "Backed up all N tables (X rows, Y MB) to backups/YYYY-MM-DD — verified and marked OK."

## Row-count sanity check

The ingest step compares total rows against the previous backup's manifest. If total rows **dropped more than 20%**, the script prints a WARNING — that is an early corruption / mass-deletion signal, NOT normal weekly variance. Relay it to Mason prominently, name the tables with the biggest drops (diff the two manifests), and do NOT hand-delete any older backup dirs while it's unexplained (the script's own pruning is fine — it only runs after a verified ingest, and the flagged dirs may be the only good copy).

## Hard rules

- `SELECT` only — never any write or DDL against the live database.
- Never commit `backups/` — it is gitignored because it contains full production data.
- Never bypass a FAIL from the ingest script by writing `LATEST-OK.json` by hand — a fake marker silences the staleness warning that would tell Mason his backup died.
- If the ingest fails, leave everything in place and tell Mason exactly what failed and which table dump is missing/broken.
