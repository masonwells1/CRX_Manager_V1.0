## 2026-09-23 — retire the `gpt-5.6` class: Luna builds and reviews, Sol is the money gate

Mason's decision, taken when the GPT-6 Codex class shipped: "use GPT-6 Luna for all reviews and
GPT-6 Sol for money and finance final gate reviews — make sure not routing to the old models."
Terra is retired as builder in the same change ("we don't need Terra as builder").

**The mapping.** The GPT-6 class ships exactly two tiers — there is no `gpt-6-terra` and no
`gpt-6-spark` (both verified refused, 2026-09-23) — so the old three-tier split collapses:

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
(`production-action-guard.mjs`) and every test fixture. **Any `gpt-5.6-sol` proof minted before this
change is now invalid** and its work needs a fresh Sol pass. That cost nothing when it landed: Codex
credits were exhausted until 2026-09-26, so no proof-bearing work could move anyway.

**The CLI was the actual blocker, not the account.** On `codex-cli` 0.153.4 every `gpt-6-*` name was
refused with `"The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."` —
a message that is **byte-identical to the one a made-up model name returns**, so it cannot be read as
evidence about either the spelling or the plan. Upgrading to 0.156.1 made `gpt-6-luna` and
`gpt-6-sol` validate. The discriminating test, usable while out of credits: a **valid** model reaches
the usage-limit error, an **invalid** one stops at "not supported". Keep that control in any future
model probe — without a known-bogus name in the same batch the result means nothing.

**`gpt-5.3-codex-spark` was already dead.** The bug hunter had been pinned to a model the API refuses
outright, so every hunt slice was failing on the model before reading a line of code. Fixed here.

**Accepted residual: Luna now builds *and* reviews.** On Codex-built code an iterating Luna round is
the model checking its own work, which catches less than an independent reviewer would. Accepted for
ordinary reversible changes; the Sol money gate stays fully independent and is the one that guards
money. Mason declined the optional "route Luna-built code to Sol for review" rule — reopen that if
Codex-built work starts landing with defects Luna passed.

**Verification.** Model names probed live against `codex-cli` 0.156.1 with a bogus-name control.
`test:correction-guards`, `test:agent-workflows`, `agent-health`, and the five model-identity test
files pass. **Not yet proven:** no end-to-end GPT-6 review has actually run — credits reset
2026-09-26. Do one live Luna round and one Sol gate round before trusting this on money work.

Mason's global `~/.codex/config.toml` default moved `gpt-5.6-sol` → `gpt-6-sol` in the same change.
Historical references to `gpt-5.6-sol` in migration comments, smoke provers, changelog entries, and
guard-lesson prose were deliberately left alone — they record which reviewer found which bug.
