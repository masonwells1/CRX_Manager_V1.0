---
name: graphify
description: Use Graphify's local CRX architecture graph before broad code search when tracing dependencies, planning a multi-file refactor, reviewing a workflow/migration/PR, or answering how modules connect. It saves tokens by returning a scoped subgraph; source and live database evidence remain authoritative.
---

# Graphify — CRX architecture navigation

Use this skill for structure and connection questions, not for a simple single-file edit or as a substitute for code review.

## Refresh first when the graph could be stale

```bash
npm run graph:refresh
```

The graph is local and gitignored under `graphify-out/`. It contains only the current operating code/database corpus selected by `.graphifyignore`; it never writes to production or sends code to a remote model.

## Use the smallest useful query

```bash
graphify explain "<symbol>"
graphify affected "<symbol>" --depth 3
graphify path "<page or module>" "<helper or database function>"
graphify query "what connects <concept A> to <concept B>?" --budget 1200
```

For a PR or pre-push review, first inspect changed files, then query only their shared symbols and direct dependents. Use the graph to choose which files to read; confirm every meaningful edge in source. For SQL/RPC, validate the current database using the normal read-only evidence workflow because migrations are historical and Graphify does not prove the live schema.

## What to report

State the graph's build commit from `graphify-out/GRAPH_REPORT.md`, the exact graph query used, and the source/live evidence that confirmed or rejected it. Do not present a graph-only connection as a verified behavior.
