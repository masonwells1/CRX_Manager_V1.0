# Plain-English Requests for Codex and Claude

Mason does not need to write technical prompts, name files, choose an implementation, or paste project rules into every session. `AGENTS.md` and the agent startup hooks already provide the shared context. Describe the business outcome in ordinary language; the agent owns the technical process.

This page is a convenience guide, not another policy file. If an example conflicts with `AGENTS.md`, `AGENTS.md` wins.

## The Shortest Useful Request

Usually this is enough:

> Fix [what is wrong] so [what should happen].

or:

> Build [outcome] for [who uses it].

Useful optional details are what you saw, what you expected, and any firm boundary such as “read-only,” “do not change production,” or “do not merge.” The agent should investigate missing technical details itself.

## Common Examples

### Fix a Bug

> Fix the problem where [what happened]. I expected [expected result]. Find the real cause, make the smallest complete fix, test the actual behavior, and carry it through the normal protected delivery process.

### Build a Feature

> Build [feature] so [person or role] can [business outcome]. Keep it simple and consistent with the rest of CRX Manager. Explain what changed and any business risk in plain English.

### Review Without Changing Anything

> Review [feature, page, workflow, branch, or PR]. This is read-only: do not edit, push, merge, deploy, or change live data. Tell me the important findings in plain English and recommend one next step.

### Diagnose Before Deciding

> Diagnose why [problem] is happening. Do not fix it yet. Show me the confirmed cause, the business impact, and your recommended fix.

### Database Change

> Add [field or behavior] to [business area]. Prepare the code and migration, run the safety reviews and tests, and explain the result. Do not apply the live migration until I explicitly ask you to apply that exact migration.

### Finish and Ship Existing Work

> Finish the current work for [outcome]. Resolve real review findings, run the required checks, use the protected PR process, merge when every gate is green, and verify production. Tell me immediately if a genuine Mason-only action is required.

### Check Current Status

> Check the current status of [task, PR, deployment, or production behavior]. Use current evidence, not an old handoff. Tell me what is complete, what remains, who owns it, and the one next step you recommend.

## Firm Boundaries

Add a boundary only when you actually want it. The agent must treat these literally:

- “Read-only” or “do not fix anything.”
- “Do not write files.”
- “Do not push or merge.”
- “Do not query or change production.”
- “Stop before applying the live migration.”

Without one of those limits, words such as “fix,” “build,” “finish,” and “ship” authorize the normal reversible work and protected delivery described in `AGENTS.md`. Codex starts that work automatically; Claude keeps its single existing plan checkpoint for multi-file or risk-sensitive work, then continues without repeated pauses.

## What Mason Should Expect

- The agent leads with the outcome and uses plain English.
- The agent makes routine technical choices instead of asking Mason to review code or select an implementation.
- The agent keeps working without needing “continue” messages.
- The agent reports meaningful progress and says plainly when a check or approach fails.
- A real stop begins with `NEEDS MASON - ACTION REQUIRED` or `NEEDS MASON - DECISION REQUIRED` and gives one recommended action.
- Closeout states whether the work is complete, what proof ran, who owns anything remaining, and one recommended next step.

Mason can always type a rough or misspelled request. Clear business intent matters more than technical wording.
