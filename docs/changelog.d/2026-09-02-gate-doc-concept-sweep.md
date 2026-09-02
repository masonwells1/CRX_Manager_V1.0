## 2026-09-02 — concept-level sweep: four operator docs described behaviour this PR made untrue

Prompted by the merge-coordination session, after #545's owner found two instructions that had gone
actively wrong and whose own sweep missed them by matching phrasings rather than the concept. This
PR rewrites gate and `/ship` documentation, which is exactly where that happens. Four hits, all
created by fixes made earlier in this same PR — the docs were right when written and wrong by the
time the code changed under them.

**1. `AGENTS.md` — a failed comment post had two documented outcomes; it now has three.** The text
read *"dedupe state is kept if the command landed, otherwise both labels clear for a deliberate
retry"*. After the unverifiable-lookup fix there is a third case that the word *otherwise* silently
mis-files: when the follow-up lookup **also** fails, the marker is **preserved**, because clearing it
would let a relabel buy a second review for the same head. An operator following the old sentence
would have expected a clear retry path and found the marker still attached. Rewritten to name all
three outcomes explicitly.

**2. `AGENTS.md`, `.claude/commands/ship.md`, `.claude/skills/deploy-check/SKILL.md` — a reset now
does more than clear labels.** All three said a new commit "clears both labels" / "clears both state
labels". Since the superseded-command fix a reset also **deletes the command already posted for the
superseded head**, and deliberately leaves a command for the still-current head alone. That is
visible to an operator watching the PR — a comment disappears — so it belongs in the description.

**3. `AGENTS.md` — cancelling a request was undocumented.** Removing `coderabbit-review-requested`
while a request is in flight now cancels it, because both final validations require the marker.
Previously the command posted anyway and the reset landed afterwards. Stated.

**4. `docs/reference/gotchas.md` — the paid-retry instruction could not work as written.** It said to
remove `coderabbit-review-requested` and reapply `ready-for-coderabbit`. Removing the marker fires an
asynchronous `unlabeled` run that clears **both** labels, so a ready label reapplied while that run
is still queued is cleared by it and nothing is posted — the operator would conclude the gate was
broken. Now instructs waiting for the reset to finish and confirming both labels are gone first.

Codex adapters regenerated; `test:agent-workflows`, `check:docs` and the 96 gate tests green.

**The method, since the phrase-matching failure is the reusable part.** Grepping for the old wording
finds nothing — the wording was never wrong, the behaviour moved. What worked was listing what this
PR *changed about the gate's behaviour* (reset semantics, failure outcomes, label requirements) and
then searching the docs for any sentence that **describes** those behaviours, whatever words it uses.
Sweep the concept from the diff, not the phrase from the file.
