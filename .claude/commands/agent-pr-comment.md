Post an agent review or handoff summary to a GitHub pull request.

Use this only when Mason explicitly asks to attach an agent review, Claude review, Codex review, pair review, audit, or handoff file to a PR.

## Hard Safety Gates

- Default to dry-run.
- Do not post to GitHub unless Mason explicitly confirms the PR number and posting action in the current conversation.
- Do not post secrets, `.env` values, tokens, service-role keys, customer private data, or oversized raw logs.
- Do not push, deploy, apply live migrations, delete data, or commit.

## Step 1 - Validate Inputs

Need:

- PR number.
- Local review/handoff/audit file path.

If either is missing, ask one short question.

## Step 2 - Dry Run

```powershell
node scripts/post-agent-review-to-pr.mjs --pr <number> --file <path> --dry-run
```

Review the generated comment text. If it contains secrets or sensitive customer information, stop and sanitize first. `CRX_Manager_V1.0` is a PUBLIC repo — also strip live financial values (pricing, costs, profit), customer names, and real record IDs before posting; review/audit files often embed live-DB evidence containing exactly that.

## Step 3 - Post Only With Current Confirmation

After Mason confirms the exact PR and says to post:

```powershell
node scripts/post-agent-review-to-pr.mjs --pr <number> --file <path> --confirm
```

## Step 4 - Report

Report:

- PR number;
- file posted;
- whether it was dry-run or actually posted;
- any errors.
