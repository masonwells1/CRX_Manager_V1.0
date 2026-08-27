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
//
// MASON ANSWERED (2026-08-26), and the answer was NOT "add it to this list".
// Adding it here would make a whole prompt inert — so a message where Mason
// typed "pause" AND pasted/received a peer block would stop latching, which is
// exactly the direction he forbade. The answer is authoredByMason() below:
// the peer's words are REMOVED from the text, and whatever Mason typed around
// them is still matched normally. See that function for the incident.
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

// ── authoredByMason(prompt) ──────────────────────────────────────────────
// isMachineGenerated() above is an all-or-nothing gate: the WHOLE prompt is the
// harness's, so ignore the WHOLE prompt. That is right for a <heartbeat> digest
// and wrong for the case below, where one prompt mixes Mason's words with words
// he did not write.
//
// INCIDENT (2026-08-26, reproduced in BOTH directions). A coordinator session
// sent a peer a <cross-session-message> discussing a PR escalation path, using
// the words "stand down ... no need to stop the other lane". The PEER's hold
// latched, as though Mason had told it to halt. The peer quoted the phrasing
// back in its reply; the COORDINATOR's hold then latched on the same words.
// It escalated from there: naming the hook file itself was enough, because
// "stop-wrap.mjs" contains "stop" between word boundaries. Net cost — two
// sessions burned round-trips inventing substitute vocabulary ("the brake",
// "frozen/released") just to discuss the guard, and one sat idle with finished
// work because there was no message it could safely receive.
//
// Root cause: trigger-word matching read the ENTIRE inbound prompt, including
// envelope blocks that are DATA (another agent's words) and quoted spans where
// Mason is REPORTING a phrase rather than issuing it.
//
// This returns the prompt with the not-Mason spans removed, so the phrase
// matchers see only what he actually typed. It NARROWS THE INPUT ONLY — it does
// not touch the trigger vocabulary and does not soften any latch. Mason's own
// "stop" / "pause" / "hold on" / scope-only wording still fires exactly as
// before, including when it shares a message with a stripped block.
//
// Order matters: fences first (a fence may contain a bare envelope tag that
// would otherwise swallow the rest), then inline code (`stop-wrap.mjs`), then
// envelopes, then blockquotes.

// Peer-session envelopes are stripped as data even though they are deliberately
// absent from MACHINE_TAG_NAMES — see the note on that list.
const NON_AUTHORED_TAG_NAMES = ["cross-session-message", ...MACHINE_TAG_NAMES];

// ``` / ~~~ fenced blocks, line-based so an unterminated fence drops to the end.
function stripFencedCode(text) {
  const kept = [];
  let openFence = null;
  for (const line of text.split("\n")) {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (openFence === null) {
      if (m) { openFence = m[1][0]; continue; }
      kept.push(line);
    } else if (m && m[1][0] === openFence) {
      openFence = null; // closing line is dropped with the block
    }
  }
  return kept.join("\n");
}

const INLINE_CODE_RE = /`+[^`\n]*`+/g;
const BLOCKQUOTE_LINE_RE = /^[ \t]{0,3}>.*$/gm;

function stripEnvelopes(text) {
  let out = text;
  for (const tag of NON_AUTHORED_TAG_NAMES) {
    // Closed blocks anywhere in the prompt.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    // A truncated/unterminated envelope: everything from the open tag onward.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"), " ");
    // Any orphaned closing tag left behind.
    out = out.replace(new RegExp(`<\\/${tag}\\s*>`, "gi"), " ");
  }
  return out;
}

export function authoredByMason(prompt) {
  const text = String(prompt || "");
  if (!text) return "";
  let out = stripFencedCode(text);
  out = out.replace(INLINE_CODE_RE, " ");
  out = stripEnvelopes(out);
  out = out.replace(BLOCKQUOTE_LINE_RE, " ");
  return out;
}

// True when the prompt still carries words Mason typed after stripping. A prompt
// that is ENTIRELY not-his (a bare peer message) is not his turn to speak: it
// must neither latch a hold nor clear one.
export function hasAuthoredText(prompt) {
  return authoredByMason(prompt).trim() !== "";
}

export const PUSH_POLICY =
  "LANDING POLICY: Mason authorized auto-landing regular code on main (2026-06-16; mechanics updated 2026-07-14 and 2026-08-27) — once the pipeline is green (review clean + tests + the pre-push hook's typecheck/build), land via branch → PR → required Vercel check → merge; direct pushes to main are impossible for everyone (protect-main ruleset); Vercel rollback is one click. In an ARMED hands-free run, ordinary feature-branch pushes and protected PR merges continue through their existing exact-head guards without another Mason confirmation; the armed flag removes prompt friction but never bypasses a guard. HARD GATES that ALWAYS need Mason's explicit OK in the current conversation: force-pushing or rewriting shared history, deleting or irreversibly overwriting business/customer data, changing secrets/authentication/permissions/billing/domains/account ownership, and accepting an unresolved red or ambiguous release gate. Existing migration and production-action guards remain authoritative. Settled exception (Mason 2026-07-13): in a hands-free run he pre-authorized (autopilot armed), a NON-destructive migration may apply through the migration-apply-guard proof + Codex gates without a per-migration ask; destructive migrations (DELETE/TRUNCATE business rows, DROP data-bearing tables/columns) are hard-refused while armed. Never commit unrelated files.";
