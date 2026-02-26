# Doc Update Rules

## When to Update MEMORY.md
- New environment info (Node version, new tool, new computer)
- New "lesson learned" (add to `lessons.md` instead if it's a gotcha)
- Change in "What's Next" priorities
- Major stat changes (page count, test count, new deploy URL)

## When NOT to Update MEMORY.md
- Sprint-by-sprint progress (that goes in git commits + docs/CHANGELOG.md)
- Feature implementation details (that's in repo CLAUDE.md)
- Temporary debugging notes

---

## Mandatory Pre-Commit Doc Review

**ENFORCED ON EVERY COMMIT. No exceptions.**

Before every commit, the agent MUST:
1. Review what changed in the working tree (files added/modified/deleted)
2. Check each doc below and update anything that is now stale or missing
3. Include the doc updates IN THE SAME COMMIT as the code changes

### Checklist

| Doc | What to check | Update if... |
|-----|--------------|-------------|
| `MEMORY.md` | Current Stats, What's Next | Test counts changed, priorities shifted |
| Memory `lessons.md` | Key gotchas | New gotcha discovered |
| Repo `CLAUDE.md` | Current State stats, Pages, Tables, RPCs, Edge Functions, Patterns | New page/table/RPC/migration/pattern added, test counts changed |
| Repo `README.md` | Features section, Current State stats | Features added/removed, stats changed |
| Repo `TESTING.md` | Quick Facts (test counts), "What Unit Tests Cover" list | New test files added, test counts changed |
| Repo `DEPLOYMENT.md` | Environment variables, Edge Function list | New env vars or Edge Functions added |
| Repo `docs/CHANGELOG.md` | Latest entry | Any significant work was completed (append new entry at top) |
| `docs/reference/database-schema.md` | Table listings, RLS matrix | New table added via migration |
| `docs/reference/rpc-functions.md` | RPC listings by category | New function/RPC added via migration |
| `docs/reference/migration-history.md` | Migration table entries | New migration file added |
| `docs/reference/pages-routes.md` | Route table entries | New page added |
| `docs/reference/code-patterns.md` | Number formats, UI patterns | New pattern added |
| `docs/reference/qa-testing.md` | Role matrix, workflow tests | New workflow added |

### Also Remove Stale Info
If a feature was deleted, a page removed, or an RPC dropped — DELETE the references from the docs. Don't leave dead entries.

Run **`/update-docs`** for a full automated audit anytime.
