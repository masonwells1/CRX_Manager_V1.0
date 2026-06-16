# Map-Drift Audit — Reusable Prompt

> **What this is (plain English):** A reusable instruction set that points Claude at
> `docs/app-workflow-map.html` (the auto-generated app graph) and makes it check, one item
> at a time, whether what the map *claims* about the app still matches **reality** — the live
> Supabase database and the actual code. It hunts the thing that has caused most of this
> project's bugs: **drift** (the map/docs/UI say one thing, the database does another).
>
> **How to run it:** Start a fresh Claude Code session and say:
> *"Run the map-drift audit — follow `docs/audits/map-drift-audit-prompt.md`."*
>
> **What you get back:** A dated, read-only findings report at
> `docs/audits/<YYYY-MM-DD>-map-drift-audit.md`, ranked BLOCKER / HIGH / MED, every finding
> backed by a real citation (file:line, migration, constraint, or RPC name) and verified
> against the live DB before it's allowed in. **No files or database rows are changed** — you
> review the findings and decide what to fix.
>
> **How it relates to `/review-workflow`:** `/review-workflow` is the broad, periodic sweep of
> all workflow logic. *This* is the narrow, repeatable "did the map drift from reality?" pass —
> run it after every map regeneration. They complement each other; this one is deliberately
> scoped to map-vs-reality reconciliation so it stays fast and exhaustive.

---

## 0. Mission & non-goals

**Mission:** For every claim the workflow map makes — every page, every role label, every flow
arrow, every RPC group, every auto-detected problem — confirm it against the **live database**
and the **current code**, and report every place they diverge.

**The core insight that justifies this audit:** the map is a *topology artifact derived from the
frontend*. Several of its "facts" are **hand-asserted or doc-derived**, not verified:
- The entity→entity flow arrows (`Quote→Order→Delivery→Invoice→Payment`, etc.) are **hardcoded**
  in `DATA_FLOW_EDGES` inside `scripts/generate-workflow-map.mjs`. The map draws them whether or
  not the code still implements them.
- The RPC catalog the map checks against comes from `docs/reference/rpc-functions.md` (a doc),
  **not** the live database's RPCs. Docs drift.
- RPC edges are bucketed into ~11 groups, not individual functions.
- Page role labels come from `allowedRoles` in `App.tsx` — that is *frontend* gating, which may
  not match the **RLS / GRANTs** that actually protect the data.

So the map is the **checklist**; the live DB + code are the **truth**. Your job is reconciliation.

**Non-goals (do NOT do these here):**
- Do **not** re-run the broad workflow review — that's `/review-workflow`. Stay on map-vs-reality drift.
- Do **not** edit any file or mutate the database. This is **read-only**.
- Do **not** apply fixes. Findings only; remediation is a separate, human-approved step.
- Do **not** manufacture findings. **A clean result is a valid, valuable result** — say "verified, no drift" and move on. Inventing plausible-but-unconfirmed problems is the failure mode this prompt exists to prevent.

---

## 1. Hard rules

1. **Read-only.** Allowed: `Read`, `Grep`, `Glob`, Supabase MCP **read** tools (`list_tables`,
   `list_migrations`, `execute_sql` with `SELECT`/catalog queries only, `get_advisors`,
   `list_edge_functions`). **Forbidden:** `apply_migration`, any `INSERT/UPDATE/DELETE/DDL`,
   `Edit`, `Write` (except writing the single final report file), `deploy_edge_function`.
2. **Verify before you report.** No finding enters the report until you have **independently
   confirmed it against live** (a catalog query, a constraint read, or a code read that proves
   it). This is the adversarial gate in §4. If you cannot confirm it, it does not get a severity
   — it goes in an "Unconfirmed / needs human check" list, clearly separated.
3. **Cite everything.** Every finding carries at least one hard citation: `path/file.tsx:line`,
   migration filename, `pg_constraint` name + definition, RPC `proname`, or policy name. No
   citation → not a finding.
4. **Live DB is the truth, not the docs.** When `rpc-functions.md` / `database-schema.md` /
   `CLAUDE.md` disagree with the live database, the **live database wins**, and the disagreement
   itself is a (usually MED) finding.
5. **Stay in scope.** Project ID `rhyzpcqhnizqbxphqdkr`. Only the `public` schema unless a
   finding demands otherwise.
6. **Prefer single-statement SQL.** Supabase MCP `execute_sql` returns only the **last**
   statement's rows — run diagnostic queries one statement at a time.

---

## 2. Ground-truth sources

| Source | How to read it | Gives you |
|--------|----------------|-----------|
| The map's claims | `Read docs/app-workflow-map.html` — the `NODES` array (between `// __NODES_START__` / `__NODES_END__`) and `EDGES` array (`// __EDGES_START__` / `__EDGES_END__`); the "Auto-detected Problems" section | Pages + role labels + groups, nav/rpc/data edges, already-computed problems |
| The map's hardcoded assertions | `Read scripts/generate-workflow-map.mjs` — `DATA_FLOW_EDGES`, `INTERNAL_RPCS`, `rpcToGroupId`, role parsing | What the map *asserts* vs *derives* |
| Live RPCs | `execute_sql` (catalog queries in §3) | The current set of public RPCs (run the §3 snapshot for the live count — do NOT trust any number written here), their overloads, signatures, SECDEF/search_path, grants |
| Live constraints | `execute_sql` on `pg_constraint` | Real status enums / CHECK values |
| Live RLS & grants | `execute_sql` on `pg_policies`, `has_function_privilege` | Who can actually reach the data |
| Live tables | `list_tables` | The current public tables + columns (live count from list_tables — do NOT trust any number written here) |
| Advisors | `get_advisors` (security + performance) | Anon-executable SECDEF, missing RLS, etc. |
| Frontend reality | `Grep`/`Read` over `src/` | Actual `.rpc('name')` calls, status strings sent, navigate targets, role gates |
| Migrations | `Glob supabase/migrations/*.sql` + `Read` | History of a constraint/function when live & docs disagree |

> Optional accelerators (only if helpful): the project's review subagents can parallelize the
> heavy passes — `rls-security-reviewer` for Pass 4, `migration-drift-reviewer` for Pass 2
> (overload/constraint drift), `typescript-types-drift-reviewer` for column-name drift surfaced
> in any pass. They're optional; the audit must be completable without them.

---

## 3. Step 0 — Freshen the map, then load its claims

1. **Freshen** (so the map reflects current code): `npm run generate-map`. Note the printed
   stats line (`N routes · N RPC calls · N issues`). If `npm` isn't desired, proceed with the
   committed map but **note in the report that the map was not re-freshened**.
2. **Load claims** into working memory:
   - The **page set** with role labels (`page-admin` / `page-sales` / `page-all` / `page-auth`)
     and group, from the `NODES` array.
   - The **edge set** (`nav`, `rpc`, `data`) from the `EDGES` array.
   - The **hardcoded `DATA_FLOW_EDGES`** from the generator (these are the *unverified* arrows).
   - The map's **auto-detected problems** list (Pass 0 harvests these).
3. **Snapshot reality** up front (cache for all passes):

```sql
-- Every public RPC, its overload count, and signatures (existence + B7 overload check)
SELECT proname,
       count(*)                                              AS overloads,
       array_agg(pg_get_function_identity_arguments(oid))    AS signatures,
       bool_or(prosecdef)                                    AS any_secdef
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
GROUP BY proname
ORDER BY proname;
```

```sql
-- All status / state CHECK constraints (lifecycle truth)
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE contype = 'c' AND connamespace = 'public'::regnamespace
  AND pg_get_constraintdef(oid) ILIKE '%status%'
ORDER BY 1;
```

```sql
-- Anon-executable SECURITY DEFINER functions (Pass 4 security drift)
SELECT p.proname
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY 1;
```

```sql
-- RLS policies (Pass 4)
SELECT tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;
```

Also capture frontend RPC usage:
`Grep` pattern `\.rpc\(\s*['"\x60]([a-z_]+)` across `src/` → the set of RPC names the UI calls.

---

## 4. The reconciliation passes

Walk these **in order**. For each item, do **extract → verify → classify**. Keep a running tally
of "checked & clean" so the report can prove coverage.

### Pass 0 — Harvest the map's own auto-checks
The generator already computes four problem classes. **Surface each, then re-confirm it's still
true** (don't trust the cached HTML blindly):
- **Orphan pages** — confirm nothing references the route (`Grep` for the path across `src/`).
- **Broken `navigate()`** — confirm no matching `Route` in `App.tsx`.
- **Dead RPCs** — listed in docs, never called from `src/`. Cross-check: does it even exist live?
  (doc-only-and-dead = MED doc drift; live-and-dead may be intentional/admin/cron — verify against `INTERNAL_RPCS`.)
- **Unguarded financial writes** — confirm the file truly never calls `checkMutationResult`.
> Currently the map reports **0** of these. If still 0, record "Pass 0: map auto-checks clean."

### Pass 1 — Asserted-flow verification (the map's blind arrows)
For **every** `DATA_FLOW_EDGES` arrow (e.g. `e-quote → e-order`, `e-delivery → e-invoice`,
`e-return → e-inventory`, `e-job → e-invoice`, `e-blend → e-order`):
- **Find the code path** that implements that transition (the RPC and/or trigger that turns a
  Quote into an Order, a Delivery into an Invoice, etc.). Cite it.
- If **no implementation exists**, or the only implementer is dead/unreachable → finding
  (the map asserts a flow the app no longer delivers).
- If it exists, sanity-check it **preserves the documented invariant** (e.g. converting a quote
  releases its inventory holds; completing a delivery produces/links a draft invoice; a return
  reverses inventory). A drawn arrow whose code skips the invariant is a HIGH.

### Pass 2 — RPC reality check
Using the §3 RPC snapshot and the frontend RPC set:
- **Called-but-missing:** an RPC name the UI calls that has **no row in `pg_proc`** → **BLOCKER**
  (runtime crash for users). Confirm the exact spelling live before reporting.
- **Overloaded:** any `proname` with `overloads > 1` → **HIGH** (the B7 class — ambiguous calls,
  drift magnet). List the signatures.
- **Doc drift:** in `rpc-functions.md` but not live, or live but not documented → **MED**.
- **SECDEF without `search_path`:** any SECDEF function missing `SET search_path` → **HIGH**
  (confirm via `pg_get_functiondef`).

### Pass 3 — Lifecycle integrity
For each entity with a documented lifecycle (Quote, Order, Delivery, Invoice, Job, PO, Return,
Commission Payment — see `CLAUDE.md` "Business Logic Lifecycles") and the live CHECK constraint
from §3:
- **UI-sends-rejected-status:** any status string the frontend writes/sends (`Grep` `status:`,
  `status ===`, `.eq('status'`) that is **not in the live CHECK set** → **BLOCKER** (the
  `'void'` vs `'voided'` class — user hits an error wall). Confirm both sides.
- **Dead-end state:** a non-terminal status with **no transition out** in any RPC → HIGH.
- **Transition with no backing RPC:** a documented transition the UI offers but no RPC performs → HIGH.
- **CHECK-superset violations** between migrations (a later constraint that dropped an older allowed value) → HIGH.

### Pass 4 — Role / RLS coherence
The map labels each page admin / sales / all from `allowedRoles`. Reconcile that *frontend* label
with the *real* protection on the data it touches:
- **Open page → privileged data:** a `page-all` page whose RPCs/tables are reachable by `anon`
  (cross-ref the anon-SECDEF list + `pg_policies`) → **BLOCKER** if it exposes PII/financials.
- **Label vs RLS mismatch:** a `page-sales` page calling an RPC/table that RLS restricts to admin
  (users get silent failures) or vice-versa → HIGH.
- **Missing RLS:** any table a page writes that has **no RLS policy** (`get_advisors` security) → BLOCKER.
- Honor documented exceptions (e.g. `profile_public_view` SECDEF is **accepted** — see
  `CLAUDE.md` Schema Gotchas; `/payments` is intentionally admin+sales). Don't re-flag accepted findings — but **do** confirm they still match their documented rationale.

### Pass 5 — Missing connections (gaps the map can't draw)
Reason about flows that *should* exist but neither map nor code provides:
- An **entity with no path to revenue** (created but never invoiceable/payable).
- A **reversal/cleanup that's missing** (return without inventory reversal; void without the
  paired ledger entry; cancel that leaves holds active — note the documented quote-cancel hold fix as the pattern).
- A **record created but never consumed** (written by one RPC, read by nothing).
- A **lifecycle terminal that strands related records** (voided invoice whose commissions stay `pending`).
Each gap is HIGH or MED depending on money/data impact. **Reason from the schema + lifecycles,
then confirm the absence** (prove no RPC/trigger covers it) before reporting.

### Pass 6 — Map defects (audit the asserter)
Anywhere a previous pass proved the **map itself is wrong** (a hardcoded `DATA_FLOW_EDGE` that no
longer matches code, a role label the generator mis-derives, an RPC group mapping that's stale),
record it as a **map defect** with the exact generator location
(`scripts/generate-workflow-map.mjs:line`). These feed a follow-up to fix the *generator*, so the
map gets more honest over time. Severity MED (it misleads humans but doesn't break the app),
unless the map hides a real BLOCKER (then inherit that severity).

---

## 5. Adversarial verification gate (every BLOCKER & HIGH)

Before a BLOCKER or HIGH is written to the report, **try to refute it**:
- Re-run the exact live query / re-read the exact code that proves it. Quote the proof.
- Ask: "Is there a path that makes this safe?" — a trigger, an admin-override hatch, an
  `INTERNAL_RPCS` exemption, an accepted-finding note in `CLAUDE.md`, a dynamic `navigate()` the
  regex can't see. If such a path exists, **downgrade or drop** the finding and say why.
- A finding survives only if you cannot refute it. If you're <80% sure after trying, it goes to
  **"Unconfirmed / needs human check,"** not into the ranked findings.

This gate is the whole point: **the project has been burned more by confident-but-wrong handoffs
than by missed bugs.** Prefer a short, true report over a long, speculative one.

---

## 6. Severity rubric

| Severity | Meaning | Examples |
|----------|---------|----------|
| **BLOCKER** | Crashes, corrupts data, mis-handles money, or breaches security **in production** | Frontend calls a non-existent RPC; UI sends a status the CHECK rejects; open page exposes financial data via anon-SECDEF; new table with no RLS |
| **HIGH** | Real logic gap / drift → wrong behavior, not a crash/breach | Asserted flow not implemented; lifecycle dead-end; return doesn't reverse inventory; overloaded RPC; SECDEF missing `search_path` |
| **MED** | Drift / inconsistency, low blast radius | Doc-vs-live RPC drift; map defect; role-label cosmetic mismatch with no security effect |

---

## 7. Output — the report file

Write **one** file: `docs/audits/<YYYY-MM-DD>-map-drift-audit.md` (use the real date; ask the
user or read it from the environment — never fabricate it). Nothing else is written or changed.

```markdown
# Map-Drift Audit — <YYYY-MM-DD>

**Map state:** <N routes · N RPC calls · N map-issues · freshened? yes/no>
**Live snapshot:** <N RPCs (X overloaded), N tables, N anon-SECDEF, advisors: S sec / P perf>
**Verdict:** <CLEAN | N findings (B BLOCKER / H HIGH / M MED) + U unconfirmed>

## Summary
| Pass | Checked | Clean | Findings |
|------|---------|-------|----------|
| 0 Auto-checks | … | … | … |
| 1 Asserted flows | … | … | … |
| 2 RPC reality | … | … | … |
| 3 Lifecycle | … | … | … |
| 4 Role/RLS | … | … | … |
| 5 Missing connections | … | … | … |
| 6 Map defects | … | … | … |

## Findings (ranked)
### [BLOCKER] <id> — <title>
- **Pass:** <n>  **Entity/Page/RPC:** <what>
- **Evidence:** <file:line / migration / constraint name + def / proname>
- **What the map claims vs reality:** <one or two lines>
- **Why it matters:** <user-visible / money / security impact>
- **Verification performed:** <the query/read that confirmed it, quoted>
- **Suggested direction (NOT applied):** <pointer, not a patch>

### [HIGH] … ### [MED] …

## Unconfirmed / needs human check
- <candidate> — <why it couldn't be confirmed read-only>

## Map defects (fix the generator)
- <scripts/generate-workflow-map.mjs:line> — <what's stale>

## Coverage note
<What was checked and found clean — so a clean run proves work, not silence.>
```

---

## 8. Close-out (in chat, after writing the report)

Give the user a 5-line summary: the verdict, the count by severity, the single most important
finding (or "clean"), and the suggested next step (e.g. "spin the top BLOCKER into a fix branch,"
or "fix the 2 map defects in the generator"). Remind them **nothing was changed** — this was
read-only — and that fixes are a separate, approved step. If there are map defects, offer to open
a follow-up to fix `generate-workflow-map.mjs` so the next audit starts from a more honest map.
