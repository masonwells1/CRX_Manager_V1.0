## 2026-09-20 — everyday Codex review moves to `gpt-5.6-luna` at xhigh; `gpt-5.6-sol` becomes a once-at-the-end gate

Mason's standing review-tier decision, taken on Codex token cost. Recorded in
`docs/manual/DECISION_LOG.md` (2026-09-20).

**The split.** Iterating review rounds now run on `gpt-5.6-luna` at `xhigh`, advisory-only, as many
rounds as the work needs. `gpt-5.6-sol` at `high` is no longer the everyday reviewer — it runs
**once**, after Luna is clean, and only for a risky money / inventory / RLS / migration / permission
diff. Escalating a round to Sol early is allowed for genuinely complex work with a stated reason.

**No guard code changed, on purpose.** `migration-apply-lib.mjs` (`REQUIRED_CODEX_MODEL` /
`REQUIRED_CODEX_EFFORT`), `codex-push-lib.mjs` (`proofValid`), their tests, and the `.codex/` mirror
still hard-require `gpt-5.6-sol`/`high`. Mason was offered the option of loosening them so a Luna
proof would satisfy the gates and declined. The cheap tier physically cannot satisfy the gate, which
is what enforces "Luna until clean, then exactly one Sol" without relying on an agent remembering it.

**Two traps the new default had to design around:**

- `scripts/write-codex-push-proof.mjs` unlinks the existing proof for the current HEAD at the start
  of a run. Routing a Luna round through it would destroy a valid Sol proof and mint one the guards
  reject. Luna therefore never uses the proof wrapper.
- `codex review`/`exec` pointed at this repo loads `AGENTS.md` / `CLAUDE.md` / the review commands
  as context; those instruct an agent to run a Codex review, so the reviewer self-recurses and kills
  its own process tree while still exiting 0 (observed twice, 2026-08-23). The new advisory path
  runs from a neutral directory with `--skip-git-repo-check` against a frozen diff file, with the
  five CRX failure classes inlined into the prompt instead of inherited from `AGENTS.md`.

**Changed:**

- `AGENTS.md` — Luna default added; the Sol gate bullet now says "once, after Luna is clean" and
  that a clean Luna round is not proof, mirroring "a green status row is not proof".
- `.claude/skills/codex-review/SKILL.md` — tier table, the advisory **Step 3A** (Luna/xhigh, neutral
  cwd, frozen diff, `LUNA_REVIEW: CLEAN|FINDINGS <n>` terminator), and the old wrapper path relabeled
  **Step 3B** as the ship gate.
- `.claude/skills/codex-cross-review/SKILL.md` — packet reviewer model defaults to Luna/xhigh.
- `.claude/commands/ship.md`, `codex-gauntlet.md`, `review-workflow.md`, `overnight-bug-hunt.md`,
  `codex-driven-bug-hunt.md` — Luna-first ordering, Sol named as the single end gate.
- `scripts/overnight-codex-gate.mjs` — defaults to `gpt-5.6-luna`/`xhigh`; new `--sol` flag restores
  `gpt-5.6-sol`/`high` for one pass, and the wrapper now logs the tier it selected to stderr rather
  than leaving the audit trail dependent on the CLI banner. Its `--sol` values are imported from
  `write-codex-push-proof.mjs` rather than redefined, so this wrapper cannot drift from the proof
  WRITER. **That is not a repo-wide single source, and this entry previously over-claimed that it
  was:** `migration-apply-lib.mjs`, `codex-push-lib.mjs` and the `.codex/` mirror each still carry
  their own independent copy of the required model/effort. Changing the required tier means
  changing every one of them together; changing one alone makes the writer and the validators
  disagree, and a proof is then either rejected or accepted at the wrong tier.
- `docs/reference/agent-guardrails.md` — header note on why the advisory tier and the gate identity
  deliberately differ.

**Proof:** `gpt-5.6-luna` at xhigh probed live 2026-09-20 (`tokens used 16,331` — the genuine-run
marker), confirming credits returned and that the 2026-09-17 outage note was stale.
`overnight-codex-gate.mjs` was then executed on both branches and observed selecting the right tier:
default → `model: gpt-5.6-luna` / `reasoning effort: xhigh`; `--sol` → `model: gpt-5.6-sol` /
`reasoning effort: high`. `git diff origin/main...HEAD` over `.claude/hooks/`, `.codex/hooks/` and
`scripts/write-codex-push-proof.mjs` is empty, so the gates are byte-identical to `main`.
