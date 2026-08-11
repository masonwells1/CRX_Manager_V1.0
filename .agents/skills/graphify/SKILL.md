---
name: graphify
description: Use Graphify's local CRX architecture graph before broad code search when tracing dependencies, planning a multi-file refactor, reviewing a workflow/migration/PR, or answering how modules connect. It saves tokens by returning a scoped subgraph; source and live database evidence remain authoritative.
---

# Graphify — CRX architecture navigation

Use this skill for structure and connection questions, not for a simple single-file edit or as a substitute for code review.

## Check freshness first

Read `graphify-out/GRAPH_REPORT.md` and compare its build commit with `git rev-parse HEAD`. Refresh when the report is missing, the commit differs, or relevant operating-code/database files have changed locally:

```bash
npm run graph:refresh
```

The graph is local and gitignored under `graphify-out/`. It contains only the current operating code/database corpus selected by `.graphifyignore`; it never writes to production or sends code to a remote model.

Use `GRAPH_REPORT.md` as the freshness/community index and `graph.html` as an optional visual map. Prefer the CLI queries below over manually mining `graph.json` or `manifest.json` unless diagnosing Graphify itself.

## Use the smallest useful query

```bash
graphify explain "<symbol>"
graphify affected "<symbol>" --depth 3
graphify path "<page or module>" "<helper or database function>"
graphify query "what connects <concept A> to <concept B>?" --budget 1200
```

For a PR or pre-push review, first inspect changed files, then query only their shared symbols and direct dependents. Before broad file exploration, use the graph to choose the smallest source surface that can answer the task. Focused raw source reads do not need Mason's explicit request: confirm every meaningful edge in source, and always inspect files that will be edited. For SQL/RPC, validate the current database using the normal read-only evidence workflow because migrations are historical and Graphify does not prove the live schema.

## Preserve useful query outcomes

When a query materially guides the work, dead-ends, or is corrected, save that outcome with `graphify save-result`. Periodically run `graphify reflect` to aggregate local lessons under `graphify-out/reflections/`. Do not save trivial/noisy queries, and keep durable project decisions in tracked documentation because `graphify-out/` is local and gitignored.

## What to report

State the graph's build commit from `graphify-out/GRAPH_REPORT.md`, the exact graph query used, candidate nodes, and the source/live evidence that confirmed or rejected it. Do not present a graph-only connection as a verified behavior.
