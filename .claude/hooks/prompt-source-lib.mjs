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

// KEEP THIS LIST CURRENT. Every entry here was added because a real automated
// prompt was mistaken for something Mason typed. The 2026-07-04 incident above
// recurred on 2026-08-16 for exactly the same reason: <heartbeat> — the envelope
// the crx-active-session-fleet-monitor automation arrives in — was not listed,
// so its <instructions> body latched hold.json three times in one session and
// blocked an approved live migration apply, with no human involved.
//
// Audited the project's transcripts (786 user-prompt records) after that
// incident to find every tag that actually opens a prompt here. Four were
// missing from this list; three are added below. The tags that open a prompt in
// practice are: task-notification, scheduled-task, system-reminder,
// local-command-caveat, command-name, cross-session-message, heartbeat.
//
// DELIBERATELY NOT LISTED: "cross-session-message". A sibling Claude/Codex
// session is behind that envelope, not the harness, so unlike the entries below
// there IS an agent choosing the words. Listing it would stop a sibling from
// latching a hold on this session — a loosening, not a tightening — and that is
// Mason's call to make, not this file's. Left out on purpose; do not "complete"
// the list from the audit above without asking him first.
export const MACHINE_TAG_NAMES = [
  "task-notification",
  "scheduled-task",
  "system-reminder",
  "local-command-caveat",
  "command-name",
  "local-command-stdout",
  "heartbeat",
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
  "LANDING POLICY: Mason authorized auto-landing regular code on main (2026-06-16; mechanics updated 2026-07-14) — once the pipeline is green (review clean + tests + the pre-push hook's typecheck/build), land via branch → PR → required Vercel check → merge; direct pushes to main are impossible for everyone (protect-main ruleset); Vercel rollback is one click. In an ARMED hands-free run (autopilot flag), pushes/merges instead PARK for Mason's morning review — the armed-mode deny rules win over this standing authorization. HARD GATES that ALWAYS need Mason's explicit OK in the current conversation: deploying an edge function, deleting data, and — in an interactive session — applying a live migration. Settled exception (Mason 2026-07-13): in a hands-free run he pre-authorized (autopilot armed), a NON-destructive migration may apply through the migration-apply-guard proof + Codex gates without a per-migration ask; destructive migrations (DELETE/TRUNCATE business rows, DROP data-bearing tables/columns) are hard-refused while armed. Never commit unrelated files.";
