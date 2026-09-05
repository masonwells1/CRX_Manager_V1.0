## 2026-09-05 - Route the read-only report commands (status, fleet, parked) to a faster model at low effort

**Why.** The 2026-09-04 harness token audit (PR #613, `scripts/claude-usage-report.mjs`) deferred
this item: `docs/reference/claude-model-tuning.md` already says mechanical read-only status,
parked-work inventory, and fleet checks start at `low` effort, but the three command files carried
no `model:`/`effort:` frontmatter, so each ran on the session's premium model at default effort.
The blocker was the Codex adapter generator, which derives each adapter's description from the
command file's text and had no notion of a frontmatter block.

**What changed.**

- `scripts/sync-agent-workflows.mjs`: `commandTitle()` now strips a YAML frontmatter block at the
  START of a command file before looking for the `#` heading. Without this, a YAML comment line
  (`# ...`) inside the block matched the H1 pattern and became the adapter's title. A `---` rule
  further down the file is untouched. `stripFrontmatter()` and `commandTitle()` are exported for
  the test.
- `.claude/commands/status.md`, `fleet.md`, `parked.md`: new frontmatter `model: sonnet`,
  `effort: low`, with a YAML comment naming the tuning doc. `parked` keeps the human gate: an
  apply request leaves it for `/explain-migration` and `/migration-review`, which are not
  lowered. Nothing else in the three files changed, so their first paragraph (what Claude Code
  shows as the description when `description:` is omitted) is the same text as before.
- `scripts/sync-agent-workflows.test.mjs`: pins that a frontmatter YAML comment does not become
  the title (this case FAILS on the old code), that a body `---` rule is left alone, and that the
  three real command files still resolve to the titles their `.agents/` adapters carry.
- `docs/reference/claude-model-tuning.md`: one paragraph recording which commands carry the
  routing and why `agent-health` does not.

**Not routed, and why.** `agent-health` has a same-named skill, and Claude Code gives the skill
precedence, so frontmatter on the command file would be inert. `quick-fix` diagnoses production
errors and rates data risk, so it is not mechanical. The read-only audits (`architecture-weakness-audit`,
`foundation-ultra-review`, `map-drift-audit`, `review-workflow`, `gauntlet-section`) sit in the
`xhigh` row of the tuning table. No money, security, migration, or shipping command was touched.

**Proof.** `node scripts/sync-agent-workflows.test.mjs` (new cases red on the old `commandTitle`,
green on the new one), `node scripts/sync-agent-workflows.mjs --write` (no adapter content
changed), `npm run test:agent-workflows`, `npm run agent-health`. Not verified: an actual
`/status` run under the Sonnet model in a fresh session; the frontmatter fields are the ones
Claude Code documents for commands, but the routing itself was not observed live.
