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
// Order matters, and the order below was corrected on 2026-09-21 (#504b).
//
// The original order ran fences FIRST, so that a fence containing a bare
// envelope OPEN tag could not trip the unterminated-envelope rule below and
// swallow the rest of the prompt. That protected a prompt Mason wrote, and
// broke one he received: an unterminated ``` fence INSIDE a peer envelope ran
// past the peer's own closing tag and consumed everything after it — including
// the "stop" Mason typed below the peer's message. A real halt then matched
// nothing. Fail-OPEN on the halt path, which is the wrong direction.
//
// So CLOSED envelopes come out first, whole: a peer's unfinished markdown
// cannot reach past the closing tag that ends that peer's own turn. Fences run
// next, on what is left, which still shields a quoted open tag from the
// unterminated-envelope rule — the case the original order existed for. Then
// inline code (`stop-wrap.mjs`), then any UNCLOSED envelope, then blockquotes.
//
// That order alone has its own hole (2026-09-24 review): an open tag Mason
// quotes in code pairs with a real peer's closing tag further down, and his
// "stop" between them is cut out. The original code-first order handles that
// shape. authoredByMason() therefore runs BOTH orders and keeps what either
// keeps — see the note above it.
//
// Residual, accepted deliberately: a peer that writes a fake closing tag inside
// its own message ends its envelope early, so peer words after the fake tag are
// read as Mason's and can latch a hold he did not ask for. That is the
// fail-SAFE direction (a spurious pause costs a round-trip; a missed "stop"
// does not stop), and it is how this file already behaved before #504b. It
// stays fail-safe even when the peer follows its fake tag with an unterminated
// fence, because stripFencedCode() gives an unclosed fence's lines back instead
// of dropping the rest of the prompt.

// Peer-session envelopes are stripped as data even though they are deliberately
// absent from MACHINE_TAG_NAMES — see the note on that list.
const NON_AUTHORED_TAG_NAMES = ["cross-session-message", ...MACHINE_TAG_NAMES];

// ``` / ~~~ fenced blocks, line-based. Only a fence that CLOSES is removed.
//
// An unterminated fence keeps its lines (2026-09-24, #504b follow-up). It used
// to drop everything to the end of the prompt, and a dangling fence can be left
// over after stripClosedEnvelopes() by text Mason did not write — a peer's fake
// closing tag followed by a fence, or a quoted open tag in Mason's own fence
// pairing with a real peer's close. Either way it swallowed the "stop" Mason
// typed below: fail-OPEN on the halt path. Keeping the lines is fail-SAFE —
// at worst code or peer text is read as Mason's and latches a spurious hold.
//
// `giveBack: false` restores the old drop-to-end behaviour. Only
// hasAuthoredText() uses it, because there the safe direction is reversed:
// see the note on that function.
function stripFencedCode(text, { giveBack = true } = {}) {
  const kept = [];
  let openFence = null;
  let pending = [];
  for (const line of text.split("\n")) {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (openFence === null) {
      if (m) { openFence = m[1][0]; pending = [line]; continue; }
      kept.push(line);
    } else if (m && m[1][0] === openFence) {
      openFence = null; // closing line is dropped with the block
      pending = [];
    } else {
      pending.push(line);
    }
  }
  // Never closed: give the lines back rather than dropping them. The opener
  // line comes back as-is; the rest is re-scanned so a CLOSED inner fence of
  // the other marker (``` inside ~~~ or vice versa) is still removed.
  if (openFence !== null && giveBack) {
    kept.push(pending[0], stripFencedCode(pending.slice(1).join("\n")));
  }
  return kept.join("\n");
}

const INLINE_CODE_RE = /`+[^`\n]*`+/g;
const BLOCKQUOTE_LINE_RE = /^[ \t]{0,3}>.*$/gm;

// Closed blocks anywhere in the prompt: an open tag through its matching close.
// Non-greedy, so two envelopes in one prompt are two separate removals and what
// Mason typed BETWEEN them survives.
function stripClosedEnvelopes(text) {
  let out = text;
  for (const tag of NON_AUTHORED_TAG_NAMES) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
  }
  return out;
}

// What is left over once every closed envelope is gone: a truncated envelope
// with no close, and any orphaned closing tag.
function stripUnclosedEnvelopes(text) {
  let out = text;
  for (const tag of NON_AUTHORED_TAG_NAMES) {
    // A truncated/unterminated envelope: everything from the open tag onward.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"), " ");
    // Any orphaned closing tag left behind.
    out = out.replace(new RegExp(`<\\/${tag}\\s*>`, "gi"), " ");
  }
  return out;
}

// Envelopes first: a peer's unfinished markdown cannot reach past the closing
// tag that ends the peer's own turn.
function stripEnvelopesFirst(text) {
  let out = stripClosedEnvelopes(text);
  out = stripFencedCode(out);
  out = out.replace(INLINE_CODE_RE, " ");
  out = stripUnclosedEnvelopes(out);
  return out.replace(BLOCKQUOTE_LINE_RE, " ");
}

// Code first (the pre-#504b order): an envelope tag Mason QUOTES in a fence or
// inline code is gone before it can pair with a real peer's closing tag and
// cut out what he typed between them.
function stripCodeFirst(text) {
  let out = stripFencedCode(text);
  out = out.replace(INLINE_CODE_RE, " ");
  out = stripUnclosedEnvelopes(stripClosedEnvelopes(out));
  return out.replace(BLOCKQUOTE_LINE_RE, " ");
}

// The parser exactly as it was before #794: an unclosed fence drops to the end,
// and each tag's closed, unclosed and orphaned forms are removed before the
// next tag. Used only by hasAuthoredText() as a floor for clearing a hold.
function stripPre794(text) {
  let out = stripFencedCode(text, { giveBack: false });
  out = out.replace(INLINE_CODE_RE, " ");
  for (const tag of NON_AUTHORED_TAG_NAMES) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"), " ");
    out = out.replace(new RegExp(`<\\/${tag}\\s*>`, "gi"), " ");
  }
  return out.replace(BLOCKQUOTE_LINE_RE, " ");
}

// Each order loses Mason's words in a shape the other handles (2026-09-24,
// #504b review): envelopes-first loses a "stop" between a quoted open tag and
// a real peer message; code-first loses one below a peer's unfinished fence.
// So both run, and anything EITHER order keeps counts as his. That is the
// fail-safe union — at worst text one order would strip is read as Mason's and
// latches a spurious hold; a halt either order preserves always latches.
export function authoredByMason(prompt) {
  const text = String(prompt || "");
  if (!text) return "";
  const envelopesFirst = stripEnvelopesFirst(text);
  const codeFirst = stripCodeFirst(text);
  if (envelopesFirst.trim() === codeFirst.trim()) return envelopesFirst;
  return `${envelopesFirst}\n${codeFirst}`;
}

// True when the prompt still carries words Mason typed after stripping. A prompt
// that is ENTIRELY not-his (a bare peer message) is not his turn to speak: it
// must neither latch a hold nor clear one.
//
// This is the INTERSECTION of the two orders, deliberately not the union that
// authoredByMason() returns (2026-09-24 review). Deciding "Mason spoke" is what
// lets a prompt CLEAR a hold, so it must be conservative in the other
// direction: a peer that merely quotes its own closing tag leaves text in one
// order only, and under the union that peer-only message released a hold Mason
// latched. Requiring BOTH orders to keep text means a sibling session can
// never clear his hold by how it formats its own message.
//
// It also requires the pre-#794 parser (stripPre794) to keep text (2026-09-26,
// Codex review of #794). Giving an
// unclosed fence's lines back is fail-safe for LATCHING, but for clearing it
// is the unsafe direction: a peer message with a fake closing tag followed by
// a dangling fence had its tail given back in BOTH orders, so it cleared a hold
// the old parser kept. With this third check, clearing is never easier than it
// was before #794.
export function hasAuthoredText(prompt) {
  const text = String(prompt || "");
  if (!text) return false;
  return (
    stripEnvelopesFirst(text).trim() !== "" &&
    stripCodeFirst(text).trim() !== "" &&
    stripPre794(text).trim() !== ""
  );
}

// Keep this a pointer, not a second copy of the policy: the full hard-gate list
// lives in AGENTS.md › Safety and Protected Delivery and the landing steps in
// .claude/commands/ship.md Step 8. A shorter restated list here once told agents
// only three actions were gated (2026-09-25 guidance review).
export const PUSH_POLICY =
  "LANDING POLICY: Mason authorized auto-landing regular, reversible code on main (2026-06-16) once the full pipeline is green: branch → (exact-SHA Sol proof first, for a risky diff) → PR → required checks → CodeRabbit review of the frozen head → exact-head merge, as detailed in .claude/commands/ship.md Step 8; direct pushes to main are impossible. In an ARMED hands-free run (autopilot flag), pushes/merges PARK for Mason's review instead. HARD GATES — every one in AGENTS.md › Safety and Protected Delivery (force-push, live migration or live-data change, Edge Function or out-of-band production change, data deletion, secrets, authentication, permissions, billing, domains, ownership) — need Mason's explicit OK in the current conversation. The only exception: a NON-destructive migration in an armed hands-free run he pre-authorized, through the migration-apply-guard proof + Codex gates; destructive migrations (DELETE/TRUNCATE business rows, DROP data-bearing tables/columns) are refused even then. Never commit unrelated files.";
