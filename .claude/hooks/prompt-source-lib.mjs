// Shared helpers for the UserPromptSubmit phrase hooks (prompt-source + push policy).
//
// isMachineGenerated(prompt): the phrase hooks exist to react to things MASON
// actually typed. But UserPromptSubmit also fires for machine-built prompts —
// <task-notification> digests, <system-reminder> context blocks, slash-command
// expansions (<command-name> / <local-command-stdout>). Proven 2026-07-04: a
// <task-notification> carrying an audit report tripped dangerous-phrase-warning,
// codex-gauntlet-reminder, ship-intent-reminder, autopilot-intent-reminder AND
// latched hold-latch-prompt's hold.json — all on text Mason never wrote.
// This check is deliberately conservative: it only flags prompts that carry a
// known machine-envelope tag, so a normal typed sentence can never match.
//
// PUSH_POLICY: the ONE canonical statement of the push policy, imported by every
// hook that injects it. Three hooks used to carry their own stale copy ("do not
// push without Mason's explicit approval") that contradicted the authorized
// auto-push — a single shared constant means the wording can't drift again.

const MACHINE_TAG_NAMES = [
  "task-notification",
  "system-reminder",
  "command-name",
  "local-command-stdout",
];

// Full envelope tags anywhere in the prompt...
const CONTAINS_MACHINE_TAG_RE = new RegExp(
  "<(?:" + MACHINE_TAG_NAMES.join("|") + ")>",
  "i"
);
// ...or the trimmed prompt STARTS with one of those tag names (covers tags that
// carry attributes, e.g. <task-notification source="...">).
const STARTS_WITH_MACHINE_TAG_RE = new RegExp(
  "^<(?:" + MACHINE_TAG_NAMES.join("|") + ")\\b",
  "i"
);

export function isMachineGenerated(prompt) {
  const text = String(prompt || "");
  if (!text) return false;
  if (CONTAINS_MACHINE_TAG_RE.test(text)) return true;
  return STARTS_WITH_MACHINE_TAG_RE.test(text.trim());
}

export const PUSH_POLICY =
  "PUSH POLICY: Mason authorized AUTO-PUSH to main (2026-06-16) — push regular code once the pipeline is green (review clean + tests + the pre-push hook's typecheck/build); no approval click; Vercel rollback is one click. HARD GATES that ALWAYS need Mason's explicit OK in the current conversation: deploying an edge function, deleting data, and — in an interactive session — applying a live migration. Settled exception (Mason 2026-07-13): in a hands-free run he pre-authorized (autopilot armed), a NON-destructive migration may apply through the migration-apply-guard proof + Codex gates without a per-migration ask; destructive migrations (DELETE/TRUNCATE business rows, DROP data-bearing tables/columns) are hard-refused while armed. Never commit unrelated files.";
