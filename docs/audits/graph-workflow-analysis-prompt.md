# Graph Workflow Analysis — Reusable Audit Prompt

**How to run:** open a fresh Claude Code session in this repo and say:
> "Follow `docs/audits/graph-workflow-analysis-prompt.md`."

**What it does:** uses the prebuilt Graphify knowledge graph to find (1) misplaced & duplicated logic, (2) workflow-integrity problems, and (3) structural-health issues — then writes a dated findings report. It **identifies** problems only; it does **not** propose or apply fixes.

---

## 0. Scope & honesty rules (read first)

The graph at `graphify-out/graph.json` was built by AST extraction over **`src/pages` + `src/lib` + `src/hooks`** (the TypeScript business layer). Know its limits before you reason about it:

- It captures **code structure only**: edge relations are `contains` (a file holds a symbol), `calls` (function→function), and `imports`/`imports_from` (module→module). ~88% of edges are `contains`.
- It does **NOT** contain database/RPC names. `supabase.rpc('post_invoice')` is a string argument — there is no `post_invoice` node. **Workflow-integrity analysis therefore comes from grepping source, not from the graph.**
- It does **NOT** include `src/components`, the SQL migrations, the router, or the database. Business flow that runs through those layers is invisible here.

**Hard rules for every finding:**
1. Cite **`file:line`** for the code AND the **graph evidence** (node id / edge) it came from.
2. Tag each finding **`[verified in source]`** or **`[graph-only]`**. Never present a graph-only hunch as confirmed.
3. **Never invent an edge or connection.** If the graph lacks evidence, say so.
4. **Ignore** `*.test.ts`, `*.test.tsx`, `*.spec.ts`, mock builders, and test harnesses. They are noise for this audit.
5. Assign severity **High / Med / Low** with a one-line "why it matters."
6. Do **not** suggest fixes. Identify and explain the problem; leave remediation for Mason to decide.

---

## 1. Refresh the graph first

The graph is local and gitignored, so rebuild it before analyzing (so findings reflect current code). Run via the **Bash tool** (graphify lives in the Bash Python's user site-packages, not PowerShell):

```bash
python -m graphify src/pages src/lib src/hooks --update
```

If `graphify-out/graph.json` does not exist at all, do a full build instead:

```bash
python -m graphify src/pages && python -m graphify src/lib --update && python -m graphify src/hooks --update
```

Then load these inputs:
- `graphify-out/graph.json` — the graph (nodes + `links`)
- `graphify-out/GRAPH_REPORT.md` — god nodes, communities, cohesion scores, surprising connections
- `CLAUDE.md` — business-logic lifecycles, schema gotchas, mandated patterns
- `docs/reference/rpc-functions.md` — what each RPC does (workflow truth)
- `docs/reference/database-schema.md` — table/column truth
- the actual source files — for verification in Stage 2

**Graph field reference** (so your queries are correct):
- node: `id`, `label`, `file_type`, `source_file`, `source_location` (e.g. `L42`), `community`, `norm_label`
- edge (under `links`): `source`, `target`, `relation` (`contains`|`calls`|`imports`|`imports_from`), `confidence`, `source_file`, `source_location`

---

## 2. Stage 1 — Structural pre-pass (build a candidate list)

Run these read-only queries on `graph.json` to generate **suspects**. These are starting points — adapt or add your own. Do not judge yet; just collect candidates.

### 1A — Duplicate function names (duplication suspects)
```python
import json
from collections import defaultdict
g = json.loads(open('graphify-out/graph.json', encoding='utf-8').read())
fns = defaultdict(set)
for n in g['nodes']:
    sf = n.get('source_file', '')
    if '.test.' in sf or '.spec.' in sf:
        continue
    lbl = n.get('label', '')
    if lbl.endswith('()'):
        fns[lbl].add(sf)
dups = {k: sorted(v) for k, v in fns.items() if len(v) > 1}
for k in sorted(dups, key=lambda x: -len(dups[x])):
    print(len(dups[k]), k, dups[k][:8])
```
A name defined in many files (e.g. `fmt()`, `fmtCents()`, `nextKey()`, `buildChain()`) is a candidate for "should be one shared helper."

### 1B — Page-level symbols used cross-module (misplacement suspects)
`lib/` and `hooks/` are legitimate shared homes, so only flag symbols **defined in `pages/`** that other files consume — those are the genuinely buried utilities.
```python
import json
from collections import Counter
g = json.loads(open('graphify-out/graph.json', encoding='utf-8').read())
byid = {n['id']: n for n in g['nodes']}
used_across = Counter()
for e in g.get('links', []):
    if e['relation'] not in ('calls', 'imports', 'imports_from'):
        continue
    src = byid.get(e['source'], {}); tgt = byid.get(e['target'], {})
    sfile = src.get('source_file', ''); tfile = tgt.get('source_file', '')
    if '.test.' in sfile or '.test.' in tfile:
        continue
    # a symbol DEFINED in pages/ but consumed by a different file
    if tfile and sfile and tfile != sfile and tfile.startswith('pages/'):
        used_across[(tgt.get('label'), tfile)] += 1
for (lbl, tfile), c in used_across.most_common(30):
    print(c, lbl, tfile)
```
A function defined in a `pages/` file but imported by other files (e.g. `fmtCents()` living in `pages/DeliveryDetail.tsx`) is a candidate for "buried shared utility that belongs in `lib/`." For broad duplication (the same helper re-implemented in many files), rely on query 1A instead.

### 1C — Orphan / dead-code suspects
```python
import json
from collections import Counter, defaultdict
g = json.loads(open('graphify-out/graph.json', encoding='utf-8').read())
deg = Counter()
rel_by_node = defaultdict(set)
for e in g.get('links', []):
    deg[e['source']] += 1; deg[e['target']] += 1
    rel_by_node[e['source']].add(e['relation']); rel_by_node[e['target']].add(e['relation'])
for n in g['nodes']:
    sf = n.get('source_file', ''); lbl = n.get('label', '')
    if '.test.' in sf or not lbl.endswith('()'):
        continue
    # only connection is the 'contains' edge from its own file => never called within graph
    if deg[n['id']] <= 1 and rel_by_node[n['id']] <= {'contains'}:
        print(lbl, sf, n.get('source_location'))
```
**Caveat for Stage 2 (important — this query is noisy):** these are only *suspects*. Expect many false positives:
- **Top-level page components** (e.g. `CropPrograms()`, `BrandVsGeneric()`) are default-exported and rendered by the router in `App.tsx`, which is **not in the graph** — so every page component looks orphaned. Exclude any symbol that is a default-exported page component.
- Others may be called from `src/components` (not in graph), used in JSX, or exported for external use.
Confirm a symbol is genuinely dead only by grepping the **whole `src/` tree** (including `components/` and `App.tsx`) and checking exports. If referenced anywhere, drop it from dead-code findings (optionally note it in the appendix as "graph-only, used outside graph scope").

### 1D — Low-cohesion communities (structural-health suspects)
Read cohesion scores from `graphify-out/GRAPH_REPORT.md`. Flag communities with **cohesion < 0.20** whose member labels span clearly unrelated concerns (e.g. PDF drawing mixed with date math) as candidates for "module doing too much."

### 1E — Per-page RPC usage (workflow-integrity input — from SOURCE, not graph)
The graph has no RPC names, so grep source for each page's RPC calls:
```bash
grep -rnoE "\.rpc\('[a-z_]+'" src/pages
```
Build a `page → {rpc names}` map. This is the raw material for Stage 2 workflow checks.

---

## 3. Stage 2 — Judgment pass (verify each candidate)

For every candidate from Stage 1, open the real source and decide. Only the three chosen dimensions:

### A. Misplaced & duplicated logic
- For duplicate names (1A): read 2–3 of the definitions. Are they genuinely the same logic (true duplication) or coincidentally same name? List every callsite.
- For buried utilities (1B): confirm the symbol is general-purpose and lives in a page/hook file. Note who depends on it.
- Verdict per finding: is this a real consolidation opportunity, and what is the blast radius (how many files depend on it)?

### B. Workflow integrity
- For each page's RPC set (1E), compare against the documented lifecycle in **CLAUDE.md › Business Logic Lifecycles** and **`docs/reference/rpc-functions.md`**. Examples to check:
  - Delivery pages should drive `confirm_delivery` → `complete_delivery` (two-step). Flag a page that calls `complete_delivery` without the confirm step.
  - Invoice posting must go through `post_invoice` (which enforces `check_period_open`). Flag direct status writes that bypass it.
  - Quote→order conversion should use `convert_quote_to_order`. Flag ad-hoc order creation from a quote page.
- Flag: **missing** lifecycle steps, **out-of-order** calls, or RPCs that **don't belong** on that page (business-nonsensical usage).
- Every workflow finding must quote the `file:line` of the `.rpc()` call and the lifecycle rule it violates.

### C. Structural health
- For orphan suspects (1C): grep all of `src/` (including `components/`) and check exports. Only report as dead code if **truly unreferenced**. Otherwise note "graph-only; used outside graph scope" and drop it.
- For low-cohesion modules (1D): read the file(s). Does it genuinely mix unrelated responsibilities? Explain the specific concerns that are tangled.

---

## 4. Output

Write findings to **`docs/audits/YYYY-MM-DD-graph-workflow-analysis.md`** (today's date). Structure:

```
# Graph Workflow Analysis — <YYYY-MM-DD>

## Executive Summary
- Graph scope + node/edge counts analyzed
- Counts per category (Misplaced/Duplicated, Workflow Integrity, Structural Health)
- Top 5 highest-impact findings (one line each)

## 1. Misplaced & Duplicated Logic
For each finding:
- **Title** — severity [High/Med/Low]
- Graph evidence: node id(s) / edge(s) / duplicate-name count
- Source: file:line (all callsites)
- Why it matters: <one or two lines>
- Tag: [verified in source] | [graph-only]

## 2. Workflow Integrity
(same per-finding shape; cite the .rpc() file:line + the CLAUDE.md lifecycle rule)

## 3. Structural Health
(same per-finding shape)

## Appendix — Looked Odd But Is Fine
Candidates from Stage 1 that turned out to be non-issues, with a one-line reason each
(prevents re-investigating them next run).
```

Keep it factual. Identify and explain — **do not** prescribe fixes.

---

## 5. Notes for the operator (Mason)

- Re-run this any time after adding pages/lib/hooks — Stage 1 step refreshes the graph automatically.
- The analysis is only as current as the last graph build; the refresh in §1 handles that.
- If you later want database/RPC bodies in the graph too, that requires extending the build to the SQL migrations with semantic extraction — a separate, slower, token-costing pass. This prompt deliberately stays in the fast/free TypeScript-layer lane.
