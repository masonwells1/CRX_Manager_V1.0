## 2026-09-25 — agent guidance review for GPT-6 (Astra, Sol, Luna) and Claude best practices

Mason asked for a review of `AGENTS.md`, `CLAUDE.md`, and the other guidance documents, and for
`AGENTS.md` to be set up for OpenAI's new GPT-6 models. He approved "Phases 1 + 2" and the model
roles "Luna reviews, Sol gate, Astra plans" in the session. Recorded in `docs/manual/DECISION_LOG.md`
(2026-09-25).

**Why.** GPT-6 Sol and GPT-6 Luna launched on 2026-09-22 (GPT-6 Astra earlier in September).
OpenAI's GPT-6 guidance says the models follow contextual instruction files more literally and may
stall or follow the wrong rule when those files disagree. A four-reviewer audit found that the text
hooks inject on nearly every prompt disagreed with `AGENTS.md`: it listed three hard gates instead
of twelve, told Codex to wait for plan approval, left out CodeRabbit, and pointed at Windows-only
`C:\CRX_Manager\...` paths. The five reviewer agents were also pinned to the retired
`claude-opus-5`.

**Changed (guidance):**

- `AGENTS.md` — adds an instruction-priority order (the CRX Hard Rules and every "never" rule sit
  above everything, including Mason's current message, which sets scope and limits but never
  loosens a rule or gate), one stop rule (a workflow's round cap stays a ceiling), done-by-task-type,
  the landing order with the Sol proof before the push, a "search, never read whole" rule for the large logs and schema registry, a
  routing row for Codex model choice, and CodeRabbit on the protected path. The review-tier bullets
  now name the Luna and Sol roles and defer exact model IDs to one document. Still 84 lines and
  under the 12,000-byte budget; every validator-pinned sentence is kept.
- New `docs/reference/codex-model-tuning.md` — the Codex model, effort, and pinning location for
  each job (matching the GPT-6 pins PR #796 put on `main`), GPT-6 prompting guidance, and the rules
  for changing a pinned model later.
- `docs/reference/claude-model-tuning.md` — current Claude model IDs; use the `opus`/`fable`/
  `sonnet`/`haiku` aliases instead of dated IDs.
- `CLAUDE.md` — Codex tuning route, cloud-session limits, and "search the schema registry".
- Contradictions fixed: gauntlet command, skill, and workflow are review-only and defer landing to
  `ship.md`; `ship.md` gains the Codex plan branch, the stop-rule pointer, and the Trivial-path
  exception to "never skip the review fan-out"; `OWNER_PLAYBOOK.md` no longer says `/ship` stops
  before every production push, lists every hard gate, mentions CodeRabbit, and explains which AI
  does what; `coding-guidelines.md` and `SAFE_DEVELOPMENT_RULES.md` say to search the decision and
  known-issues logs rather than read them; `AGENT_ONBOARDING.md` drops a stale hook count and the
  "smaller or cheaper model" framing; `AGENT_COLLABORATION.md` points to both tuning documents.

**Changed (agent surface):**

- `.claude/agents/*.md`, `.claude/workflows/{money-inventory-hunt,gauntlet-sections-loop}.js`,
  `.claude/commands/claude-review.md`, and `scripts/run-claude-review.mjs` (plus its test): the
  model pin moves from `claude-opus-5` to the `opus` alias.
- `.claude/hooks/prompt-source-lib.mjs` — `PUSH_POLICY` now points at the canonical gate list in
  `AGENTS.md`, names every gate category, and describes the PR → checks → CodeRabbit → exact-head
  merge path. `prompt-hooks.test.mjs` pins every gate category and CodeRabbit.
- Gauntlet, pair-review, and handoff reminders use repository-relative paths; the gauntlet reminder
  defaults to per-change mode instead of asking; the ship reminder says Codex does not wait for plan
  approval; the dangerous-phrase warning no longer says `/ship` "auto-pushes to main"; the
  session-start text no longer tells Claude to re-read `AGENTS.md` and `CLAUDE.md`, which the
  `@` import already loads.
- `.claude/settings.json` — the Vercel deny list now names the mutating and secret-reading tools
  listed in this session's Vercel connector tool list: out-of-band deploy, promote, rollback,
  alias, and cancel; project create (including git import), update, pause, and transfer; the
  Vercel CLI passthrough; routes, redirects, and versions; feature flags and cache invalidation;
  certificates and KMS signing keys; environment variables and any tool that returns secret
  values or tokens; domains and DNS records; firewall and network; drains, connectors, and
  private links; API keys, auth tokens, and SDK keys; edge-config writes; rolling releases; and
  every domain and credit purchase. Connector tool lists change between sessions, so this is a
  best-effort explicit list on top of `defaultMode: dontAsk`, which already refuses any unlisted
  tool. Listing them in `deny` makes that explicit and keeps it if the mode ever changes. No
  workflow uses them, because production deploys only through a PR merge, and a Vercel rollback
  stays one click in the Vercel dashboard. The old tool names are kept; they match nothing but are
  harmless. Nothing was added to `allow` or `ask`.
- `scripts/check-agent-guidance.mjs` — tracks the new Claude tuning sentence and checks the Codex
  tuning document and its `AGENTS.md` route.

**Not changed here.** This PR changes no gate code or Codex model pin. The switch of the proof gates
and scripts to GPT-6 landed separately in PR #796 (Luna builds and reviews, Sol gates money), which
merged while this PR was open. This PR's model document, decision-log entry, and owner playbook were
then reconciled to #796's pins; where this session had proposed Sol at `medium` as the default
builder, #796's Luna builder stands.

**Independent review.** An adversarial Claude (Opus) reviewer read the whole diff and returned
FIX-THEN-SHIP: 1 HIGH, 4 MED, 5 LOW, all confirmed and fixed in this change. The HIGH was that the
first draft of the priority order let Mason's message outrank the Hard Rules. The MEDs were the
unbounded stop rule, the landing order, two gauntlet contradictions, and missing Vercel denies.
A second Opus round on the fixed head returned FIX-THEN-SHIP with 1 MED (more Vercel denies) and 5
LOWs, all fixed; a third round returned CLEAN with 3 LOWs (a gauntlet scope wording clash, this
changelog's wording, and more Vercel check and upload tools), also fixed in this change.

**Proof observed (cloud session):** `npm run test:agent-workflows` passed; all 53 top-level
`*.test.mjs` files directly under `.claude/hooks/`, `.codex/hooks/`, and `scripts/` passed (the
`scripts/smoke/` and `scripts/db-invariant-sweeps/` tests need live or database fixtures and were
not run); `scripts/check-agent-guidance.mjs`
passed; `node scripts/sync-agent-workflows.mjs --write` regenerated the 37 Codex adapters.

**Not verified here:** no Codex (Luna) review ran, because the Codex CLI is not installed in the
cloud container, and `npm run agent-health` fails only on the missing Codex CLI. It was not
confirmed that the Claude Code `opus` alias resolves identically in `claude -p` on Mason's machine,
though `--model` accepts aliases by design.
