#!/usr/bin/env node
// UserPromptSubmit half of Mason's owner approval (owner-approval-lib.mjs;
// Mason 2026-10-09: replaces Windows Hello so he can approve from his phone).
//   - His WHOLE message is `approve <6-digit code>` → the pending request with that
//     code (built by scripts/owner-approve-migration.mjs) becomes an approval good
//     for 30 minutes, and the agent is told so.
//   - Any other message → nothing happens.
// A hook runs on a message sent into the session, never on a tool call, so no
// command an agent runs approves a parked migration through it.

import { readFileSync } from "node:fs";
import { approvalCodeFromReply, ownerRequestDirs, recordReplyApproval } from "./owner-approval-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  }
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }

const reply = String(payload?.prompt ?? "");
const code = approvalCodeFromReply(reply);
if (!code) emit();

let result;
try {
  const dirs = ownerRequestDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]);
  result = recordReplyApproval({ code, dirs, reply });
} catch (error) {
  result = { ok: false, reason: `the approval hook failed (${error?.message || error})` };
}

if (!result.ok) {
  emit([
    `OWNER APPROVAL NOT RECORDED — Mason replied "approve ${code}", but ${result.reason}. Nothing was approved.`,
    "Tell him in one line. If he still wants the change, run node scripts/owner-approve-migration.mjs again for a fresh code.",
  ].join("\n"));
}

if (result.kind === "selftest") {
  emit(
    `OWNER APPROVAL TEST PASSED — Mason's reply "approve ${code}" reached the approval hook and was recorded ` +
    `(${result.file}). Approving by chat reply works from where he sent it. Nothing was approved.`);
}

const p = result.payload;
emit([
  `OWNER APPROVAL RECORDED — Mason approved ${p.migration} (pull request #${p.pullRequest}, head ${String(p.prHead).slice(0, 12)}) ` +
    `by replying "approve ${code}". It works once, for the next 30 minutes, for that exact file and head.`,
  `Apply it now: node scripts/apply-migration-file.mjs supabase/migrations/${p.migration}.sql (dry run), then again with --confirm.`,
].join("\n"));
