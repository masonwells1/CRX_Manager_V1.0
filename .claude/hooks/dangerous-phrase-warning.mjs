#!/usr/bin/env node
// UserPromptSubmit hook for CRX Manager.
// Detects risky phrases in Mason's prompts and injects a "slow down + explain first" reminder.
// Does NOT block — Mason may have a legitimate reason. Instead, makes the assistant
// pause and explain consequences before acting on dangerous wording.
//
// Behavior:
//   - Read prompt from stdin payload (UserPromptSubmit event)
//   - Match against a list of risky phrase patterns
//   - If any match, emit hookSpecificOutput.additionalContext with a structured warning
//   - If none match, exit silently (no additional context)
//
// Patterns map to the most common ways a beginner can ask Claude to do something destructive
// without realizing what it costs.

import { readFileSync } from "node:fs";
import { isMachineGenerated, PUSH_POLICY } from "./prompt-source-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra }
    }));
  }
  process.exit(0);
}

let payload;
try {
  payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8"));
} catch {
  emit();
}

// Machine-generated envelopes (<task-notification>, <system-reminder>, slash-command
// output) are not something Mason typed — stay silent so an embedded report full of
// risky-sounding words can't trip the warning.
if (isMachineGenerated(payload?.prompt)) emit();

const prompt = (payload?.prompt || "").toLowerCase();
if (!prompt) emit();

// Each rule = { pattern, label, why, alternatives, requiresFreshApproval? }
const rules = [
  {
    pattern: /\b(drop|delete|remove|undo|revert|kill)\b[^.!?]{0,40}\b(migration|migrations)\b/,
    label: "DELETE/DROP MIGRATION",
    why: "Migrations in CRX Manager are append-only. Deleting a migration file does NOT undo the schema change on the live DB — it just makes the local repo and live DB drift.",
    alternatives: "Write a NEW migration that reverses the change. Or, if the migration was never applied live, simply rename it out of the way (don't `git rm`)."
  },
  {
    pattern: /\b(drop|truncate)\s+(table|all\s+tables|the\s+db|database|production)\b/,
    label: "DROP/TRUNCATE TABLE",
    why: "Dropping or truncating a table is irreversible without a backup. CRX Manager has financial_audit_log, invoices, payments — losing any of these is unrecoverable.",
    alternatives: "If you want to clear test data, use the `[E2E]` cleanup pattern (see tests/e2e/globalTeardown). If you want to remove a column, write a migration with `DROP COLUMN IF EXISTS`."
  },
  {
    pattern: /\b(force\s*-?push|push\s+-+f|push\s+--force)\b/,
    label: "FORCE PUSH",
    why: "Force-pushing rewrites Git history. If the target is `main` or a branch shared with anyone else (including past-you's PRs), you lose commits that aren't on your laptop.",
    alternatives: "Confirm the target branch isn't `main` and that you're the only one who has pulled it. If you're trying to fix a commit message, use a new commit + `git revert` instead."
  },
  {
    pattern: /\b(no\s*-?verify|skip\s+(the\s+)?(pre\s*-?commit\s+)?hook|--no-verify)\b/,
    label: "SKIP PRE-COMMIT HOOK",
    why: "The fast pre-commit staged safety checks plus pre-push/CI product proof exist because bypassing verification has shipped bugs before. Skipping them is almost never the right answer.",
    alternatives: "Tell Claude what error the hook is producing — there's usually a 1-line fix. Only legitimate `--no-verify` use is when the hook itself is broken (rare)."
  },
  {
    pattern: /\bservice[_\s-]?role[_\s-]?key\b[^.!?]{0,40}\b(frontend|client|src|browser|react)\b|\b(frontend|client|src|browser|react)\b[^.!?]{0,40}\bservice[_\s-]?role[_\s-]?key\b/,
    label: "SERVICE_ROLE IN FRONTEND",
    why: "service_role bypasses ALL Row Level Security. Putting it anywhere reachable from the browser exposes every customer's data to anyone with browser dev tools.",
    alternatives: "The action you want belongs in an Edge Function (supabase/functions/), which runs server-side with the service_role key. The frontend calls the Edge Function with the anon key + a JWT."
  },
  {
    pattern: /\b(disable|turn\s+off|remove)\s+rls\b/,
    label: "DISABLE RLS",
    why: "RLS is the only thing keeping anon users from reading every row of every table. Disabling it (even temporarily on a 'small' table) creates a hole that's easy to forget about.",
    alternatives: "If RLS is blocking a legitimate query, the fix is to add a more permissive POLICY, not to disable RLS. If you need to debug from the SQL editor, that already runs as postgres role and bypasses RLS — no need to disable it."
  },
  {
    pattern: /\b(amend|squash|rebase)\b[^.!?]{0,30}\b(published|pushed|remote|origin|main)\b/,
    label: "REWRITE PUBLISHED HISTORY",
    why: "Amending/squashing/rebasing commits that are already pushed forces a force-push, and anyone else who pulled is stuck. See FORCE PUSH note.",
    alternatives: "Use a new commit. If the commit message is wrong, accept it — it's not worth the blast radius."
  },
  {
    pattern: /\bauto[_\s-]?(commit|push|merge)\b/,
    label: "AUTO-COMMIT/PUSH/MERGE",
    why: `Automation is fine for regular code, but NOT for the hard gates. ${PUSH_POLICY}`,
    alternatives: "Treat this as routine protected delivery: use /ship, run the required proof, push the feature branch, and merge the green reviewed PR without asking Mason again. Stop only at a hard gate named in the PUSH POLICY.",
    requiresFreshApproval: false
  },
  {
    pattern: /\bauto[_\s-]?deploy\b/,
    label: "AUTO DEPLOY",
    why: "A deployment outside the normal reviewed merge-to-main path is a production action and stays behind its existing explicit approval gate.",
    alternatives: "Use the protected green PR path for ordinary app delivery. For an edge function or any out-of-band production deployment, finish all safe preparation and get Mason's explicit approval immediately before the deploy."
  },
  {
    pattern: /\bbypass\s+(check_period_open|period[_\s-]?open|closed[_\s-]?period)\b/,
    label: "BYPASS CLOSED PERIOD",
    why: "check_period_open() exists to prevent backdated changes to closed accounting periods. Bypassing it can corrupt month-end reports and require a manual fix in Sage/QuickBooks.",
    alternatives: "If a legitimate correction is needed, reopen the period via the month-end UI (admin only), apply the fix, then close again. The audit trail will show the reopen event."
  },
  {
    pattern: /\bedit\s+(the\s+)?(financial[_\s-]?audit[_\s-]?log|audit\s+log)\b|\bdelete\s+from\s+financial_audit_log\b/,
    label: "MODIFY AUDIT LOG",
    why: "financial_audit_log is append-only by hard rule. Editing or deleting rows defeats the entire purpose of the audit trail and could be a compliance issue.",
    alternatives: "If a wrong entry was logged, write a NEW entry that explains the correction. The original stays."
  },
];

const matches = [];
for (const rule of rules) {
  if (rule.pattern.test(prompt)) matches.push(rule);
}

if (matches.length === 0) emit();

const lines = [
  "⚠️  CRX Manager safety check — classify the matched wording before acting.",
  "",
];
for (const m of matches) {
  lines.push(`▸ ${m.label}`);
  lines.push(`   Why this is risky: ${m.why}`);
  lines.push(`   Safer path: ${m.alternatives}`);
  lines.push("");
}
const hardMatches = matches.filter((match) => match.requiresFreshApproval !== false);
if (hardMatches.length > 0) {
  lines.push(
    "Continue all safe preparation automatically. Stop only before the specific destructive or irreversible matched action until you have:",
    "  1. Explained in plain English what would happen",
    "  2. Offered the safer alternative above",
    "  3. Gotten Mason's explicit confirmation that he understands and still wants that hard-gated action",
    "Do not ask again for routine reads, edits, tests, commits, feature-branch pushes, PR work, or verification."
  );
} else {
  lines.push(
    "This is routine protected delivery under Mason's standing authorization, NOT a fresh approval gate.",
    "Continue through review, feature-branch push, green PR merge, and verification without asking Mason again."
  );
}

emit(lines.join("\n"));
