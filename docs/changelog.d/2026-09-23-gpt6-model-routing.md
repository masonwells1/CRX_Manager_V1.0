## 2026-09-23 — retire the `gpt-5.6` class: Luna builds and reviews, Sol is the money gate

Mason's decision, taken when the GPT-6 Codex class shipped: "use GPT-6 Luna for all reviews and
GPT-6 Sol for money and finance final gate reviews — make sure not routing to the old models."
Terra is retired as builder in the same change ("we don't need Terra as builder").

**The mapping.** Only two GPT-6 tiers are usable here: `gpt-6-terra` and `gpt-6-spark` are both
**refused for this account on this CLI** (reproduced 2026-09-23 and again 2026-09-25 on both
binaries). Note the limit of that evidence — the refusal is byte-identical to a made-up name's, so it
says "not usable here", **not** "does not exist"; an earlier draft of this entry overclaimed that and
was corrected after review. Either way the old three-tier split collapses:

| Role | Was | Now |
|---|---|---|
| Builder — standard and mechanical units | `gpt-5.6-terra` | `gpt-6-luna` |
| Builder — money / DB / complex units | `gpt-5.6-sol` | `gpt-6-sol` |
| Every iterating review round | `gpt-5.6-luna` / xhigh | `gpt-6-luna` / xhigh |
| Money-and-finance final gate (mints the proof) | `gpt-5.6-sol` / high | `gpt-6-sol` / high |
| Read-only bug hunter (`codex-hunt.mjs`) | `gpt-5.3-codex-spark` | `gpt-6-luna` |

**Guard code DID change this time**, unlike the 2026-09-20 tier decision which deliberately left it
alone. The proof identity is an exact string match, so all three enforcement points moved together:
`migration-apply-lib.mjs` `REQUIRED_CODEX_MODEL`, `codex-push-lib.mjs` `proofValid`, and
`scripts/write-codex-push-proof.mjs` `CODEX_REVIEW_MODEL`, plus the `.codex/` mirror
(`production-action-guard.mjs`) and every test fixture. **Once this lands on `main`, any
`gpt-5.6-sol` proof minted before it becomes invalid** and its work needs a fresh Sol pass. That cost
nothing: Codex credits were exhausted until 2026-09-26, so no proof-bearing work could move anyway.

**A PR that changes `REQUIRED_CODEX_MODEL` cannot satisfy its own new requirement.** The guard that
gates this merge is **`main`'s** copy, not the branch's — hooks load from the session's project
directory. So while this PR is open, `main` still demands `gpt-5.6-sol`, and a `gpt-6-sol` proof
minted from the branch is correctly **rejected**. It fails closed, so nothing unsafe can ship, but an
agent cannot merge this PR at all. Mason merges it by hand (his shell is not hook-gated), which is
the same escape this repo already uses when an agent merge gate is structurally stranded. **Do not
"fix" this by widening a validator to accept both models**; the chicken-and-egg is inherent to any
change of the gate's own identity, and a two-step accept-both → narrow migration is the alternative
if a human merge is ever unavailable. Found by adversarial review (Fable 5.1), 2026-09-25, after the
first attempt at an unattended merge job would have looped forever against this.

**The refusal message proves nothing on its own — always probe with a bogus control.** Every
`gpt-6-*` name was initially refused with `"The 'gpt-6-luna' model is not supported when using Codex
with a ChatGPT account."`, which is **byte-identical to what a made-up model name returns**. It says
nothing about spelling, plan access, or existence. The discriminating test, usable even while out of
credits: a **valid** model gets past validation and reaches the usage-limit error; an **invalid** one
stops at "not supported". Without a known-bogus name in the same batch the result means nothing.

**What actually changed is not settled.** Upgrading the npm CLI 0.153.4 → 0.156.1 coincided with the
names starting to validate, and the first draft of this entry claimed the CLI version was the cause.
Review found that weaker than stated: **the wrappers do not use the npm shim** — `resolveCodex()`
prefers the Desktop app binary under `AppData\Local\OpenAI\Codex\bin\`, which was on
`0.155.0-alpha.16.3` at the time and validates the names too. So the threshold is not "0.156", the
sample is n=1, and 0.153.4 is no longer installed to retest. Treat "the CLI version decides" as an
unverified hypothesis. See [[project_codex-model-probe-and-dual-binary]] for the two-install trap.

**`gpt-5.3-codex-spark` was already dead.** The bug hunter had been pinned to a model the API refuses
outright, so every hunt slice was failing on the model before reading a line of code. Fixed here.

**Accepted residual: Luna now builds *and* reviews.** On Codex-built code an iterating Luna round is
the model checking its own work, which catches less than an independent reviewer would. Accepted for
ordinary reversible changes; the Sol money gate stays fully independent and is the one that guards
money. Mason declined the optional "route Luna-built code to Sol for review" rule — reopen that if
Codex-built work starts landing with defects Luna passed.

**Verification — what was proven.** Model names probed on **both** installs (npm shim and the Desktop
binary the wrappers actually resolve) with a bogus-name control. Each shipped wrapper was run and the
model it sent read off the live Codex session header: `overnight-codex-gate.mjs` → `gpt-6-luna`/xhigh,
`--sol` → `gpt-6-sol`/high, `codex-build.mjs` → `gpt-6-luna`/xhigh, `write-codex-push-proof.mjs` →
`gpt-6-sol`/high, and the money gate **refused to mint** rather than self-certify when the run died.
`test:correction-guards`, `test:agent-workflows`, `check-doc-drift`, typecheck, build and the full
vitest suite (5411 passed, 123 skipped, 380 files) pass; CI green at the reviewed head.

**What is NOT proven — do not read the above as more than it is.** No end-to-end GPT-6 review has
produced findings; credits were exhausted until 2026-09-26. In particular, none of the evidence above
shows that a GPT-6 model emits a *parseable terminal verdict line* (prose after the token makes the
wrapper refuse, which would leave the gate unreachable), that Luna reads a large inlined diff and
echoes the tail canary, or that **`xhigh` is an accepted reasoning effort for `gpt-6-luna`** — only
the model *name* was validated, and the probe used a different effort. Run one real Luna round and
one Sol gate round before trusting this on money work. `npm run agent-health` currently FAILS in this
worktree on a pre-existing `core.hooksPath` misconfiguration unrelated to this change.

Mason's global `~/.codex/config.toml` top-level `model` moved `gpt-5.6-sol` → `gpt-6-sol`. Its
`[agents] default_subagent_model` was **also** still on the retired class and is moved here too; the
first draft claimed the whole file had been migrated when only the top-level key had. No repo gate
reads that file — every wrapper passes `--ignore-user-config` and an explicit pin — but an
interactive Codex session spawning a subagent would otherwise have used the retired tier.
Historical references to `gpt-5.6-sol` in migration comments, smoke provers, changelog entries, and
guard-lesson prose were deliberately left alone — they record which reviewer found which bug.
