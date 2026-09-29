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

// INCIDENT (2026-09-25). A background subagent's final report reached its parent
// session wrapped as
//     Another Claude session sent a message:
//     <\~agent-message from="<agent id>">
//     [Subagent hand-back] ...indented report...
//     <\~/agent-message>
// None of that was recognised, so the report was read as Mason's words: a "stop"
// in it latched hold.json, a quoted `--no-verify` fired dangerous-phrase-warning,
// and the ship / autopilot / gauntlet reminders fired too. The hold then blocked
// source edits until Mason replied.
//
// A hand-back is recognised by its LINE STRUCTURE, not by tag pairing. The
// harness always puts the preamble line in front of it, writes the open and
// close tags alone on their own lines at column zero, and indents every line of
// the report itself; only its own frame lines ("[Subagent hand-back] ...",
// "[harness: ...]") sit at column zero inside. So a block is:
//   1. the preamble, with the open tag after it on the same line or on the next
//      non-blank line (indentation allowed), and — outside STRICT mode — a
//      "[Subagent hand-back]" / "[harness" frame as the next non-blank line, so
//      only the exact harness shape is ever taken away from Mason;
//   2. then the run of blank / indented / frame lines after the open tag, plus
//      a column-zero close-tag line directly after that run. The first other
//      column-zero line ends the block. When the open tag itself was indented,
//      an indented close-tag line ends it too.
//   3. STRICT mode only: everything from the hand-back to the end of the
//      prompt. Every other preamble LINE is dropped whole, words after it
//      included.
// The two modes follow the union / intersection split below (Luna review,
// 2026-09-26). A truncated report followed by Mason's "stop now" and then a
// close tag is indistinguishable from a closed report with one unindented line.
// Latching and the reminders use rule 2, so his stop is never swallowed; the
// latch also keeps a report with no close tag whole (see keepTruncated below).
// hasAuthoredText() uses rule 3, so no report layout can count as Mason
// speaking and CLEAR a hold he latched.
// Defects of the earlier rules (Claude review + Luna review, 2026-09-25) that
// cannot happen under this one:
//   - a close tag the REPORT quotes is indented, so it cannot end the report
//     early and expose the rest of it as Mason's words;
//   - a tag Mason MENTIONS, or a wrapper he types without the harness preamble,
//     is not a block, and a truncated report ends at the next column-zero line,
//     so none of them can swallow the "stop" he typed. Pairing to end-of-prompt
//     did exactly that, and so did accepting an open tag with no preamble.
//
// The tag carries a "~" sigil, and the copy in the incident report had it
// backslash-escaped (the harness neutralises control tags by inserting "\"),
// with the sigil in front of the "/" on the close. Both tags accept any number
// of backslashes and an optional "~". The tag name must end at whitespace or
// ">", so `<agent-message-log>` is not an open tag, and the tag must be ALONE
// on its line: `<agent-message> stop now </agent-message>` is Mason's text.
// Column zero only: a preamble the REPORT quotes is indented, and must not be
// taken for the start of a new message (Luna review round 4, 2026-09-26).
const PREAMBLE_LINE_RE = /^Another Claude session sent a message:([^\n]*)$/i;
const AGENT_OPEN_RE = /^<\\*~?agent-message(?:\s[^<>]*)?>$/i; // tested on a trimmed line
const AGENT_CLOSE_LINE_RE = /^<\\*~?\/~?agent-message\s*>\s*$/i;
const REPORT_FRAME_LINE_RE = /^\[(?:Subagent hand-back|harness)\b/i;

function isReportBodyLine(line) {
  return line.trim() === "" || /^[ \t]/.test(line) || REPORT_FRAME_LINE_RE.test(line);
}

function nextNonBlank(lines, from) {
  let j = from;
  while (j < lines.length && lines[j].trim() === "") j++;
  return j;
}

// Index of a hand-back's open-tag line when line i is its preamble, else -1.
function reportOpenAt(lines, i, strict) {
  const pre = PREAMBLE_LINE_RE.exec(lines[i]);
  if (!pre) return -1;
  let open = -1;
  if (AGENT_OPEN_RE.test(pre[1].trim())) open = i;
  // The harness preamble ends at the colon. Words after it are not the
  // harness's, and the block would drop that whole line, so outside strict mode
  // such a line never starts a report (Sol review of #826, 2026-09-29: Mason's
  // "…message: stop now" above a report was swallowed).
  else if (!strict && pre[1].trim() !== "") return -1;
  else {
    const j = nextNonBlank(lines, i + 1);
    if (j < lines.length && AGENT_OPEN_RE.test(lines[j].trim())) open = j;
  }
  if (open < 0 || strict) return open;
  // The frame sits at column zero, or at the open tag's own indentation.
  const frame = nextNonBlank(lines, open + 1);
  if (frame >= lines.length) return -1;
  const openIndent = open === i ? "" : /^[ \t]*/.exec(lines[open])[0];
  const frameLine = lines[frame].startsWith(openIndent) ? lines[frame].slice(openIndent.length) : lines[frame];
  return REPORT_FRAME_LINE_RE.test(frameLine) ? open : -1;
}

// Index of a hand-back's last line (rules 2 and 3 above).
function reportEndAfter(lines, open, strict) {
  // STRICT: the rest of the prompt. Rounds 4-7 of the Luna review each found a
  // malformed report layout (a quoted close tag, a stray preamble, an
  // unindented line) that ended a narrower strict scan early and let report
  // text CLEAR a hold. Ending at the prompt's end closes the whole class. The
  // cost: Mason's words typed AFTER a hand-back in the same prompt cannot clear
  // a hold — his next message does. Words before it still count.
  if (strict) return lines.length - 1;
  // An open tag on the preamble's own line counts as column zero.
  const indentedOpen = /^[ \t]/.test(lines[open]) && !PREAMBLE_LINE_RE.test(lines[open]);
  let end = open;
  while (end + 1 < lines.length && isReportBodyLine(lines[end + 1])) {
    end++;
    if (indentedOpen && AGENT_CLOSE_LINE_RE.test(lines[end].trim())) return end;
  }
  if (end + 1 < lines.length && AGENT_CLOSE_LINE_RE.test(lines[end + 1])) end++;
  return end;
}

// Runs FIRST in both strip orders: the structure above is unambiguous, and a
// fence inside an indented report must not get the chance to pair with a fence
// in what Mason typed below it.
//
// `keepTruncated` (the hold LATCH only): a report with no close tag is kept, not
// stripped. Its end cannot be found, so an indented "  stop now" Mason typed
// under it is indistinguishable from report text, and stripping it lost his
// stop (Sol review of #826, 2026-09-29). Keeping it is the fail-safe direction:
// at worst a truncated report's own words latch a spurious hold. The reminders
// still strip it, so it cannot fire them or write the overnight freeze flag.
function stripSubagentReports(text, strict = false, keepTruncated = false) {
  const lines = text.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const open = reportOpenAt(lines, i, strict);
    if (open >= 0) {
      const end = reportEndAfter(lines, open, strict);
      if (keepTruncated && !(end > open && AGENT_CLOSE_LINE_RE.test(lines[end].trim()))) {
        kept.push(lines[i]);
        continue;
      }
      i = end;
      kept.push("");
    } else if (strict && PREAMBLE_LINE_RE.test(lines[i])) {
      // Luna round 5: words after a stray preamble never count as Mason
      // speaking. A tag there (a peer envelope opening on the same line) is
      // kept so the envelope strippers still pair it with its close.
      const rest = PREAMBLE_LINE_RE.exec(lines[i])[1];
      kept.push(/^\s*</.test(rest) ? rest : "");
    } else if (!AGENT_CLOSE_LINE_RE.test(lines[i])) {
      kept.push(lines[i]); // an orphaned close-tag line carries no words; drop it
    }
  }
  return kept.join("\n");
}

// The line the harness puts in front of every peer envelope (cross-session and
// agent-message alike). It is not Mason's either: while it counted as his text,
// a peer-only message passed hasAuthoredText() and CLEARED a hold he latched.
// Only the phrase itself is removed, and only at the start of a line, so
// anything typed after it on the same line is still read.
const PEER_PREAMBLE_RE = /^[ \t]*Another Claude session sent a message:/gim;

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
function stripEnvelopesFirst(text, strict = false) {
  let out = stripClosedEnvelopes(stripSubagentReports(text, strict, !strict));
  out = stripFencedCode(out);
  out = out.replace(INLINE_CODE_RE, " ");
  out = stripUnclosedEnvelopes(out);
  return out.replace(BLOCKQUOTE_LINE_RE, " ").replace(PEER_PREAMBLE_RE, " ");
}

// Code first (the pre-#504b order): an envelope tag Mason QUOTES in a fence or
// inline code is gone before it can pair with a real peer's closing tag and
// cut out what he typed between them.
function stripCodeFirst(text, strict = false) {
  let out = stripFencedCode(stripSubagentReports(text, strict, !strict));
  out = out.replace(INLINE_CODE_RE, " ");
  out = stripUnclosedEnvelopes(stripClosedEnvelopes(out));
  return out.replace(BLOCKQUOTE_LINE_RE, " ").replace(PEER_PREAMBLE_RE, " ");
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
// never clear his hold by how it formats its own message. For the same reason
// both orders strip subagent hand-backs in STRICT mode (see the note on those).
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
    stripEnvelopesFirst(text, true).trim() !== "" &&
    stripCodeFirst(text, true).trim() !== "" &&
    stripPre794(text).trim() !== ""
  );
}

// ── withoutSubagentReports(prompt) ───────────────────────────────────────
// For the intent REMINDER hooks (dangerous-phrase-warning, ship-intent,
// autopilot-intent, codex-gauntlet, agent-pair-review, codex-to-claude-handoff).
// It removes only agent-message blocks (by the line structure above, closed or
// truncated) and the peer preamble line — not code, blockquotes or
// cross-session messages, which authoredByMason() strips for the hold latch.
// The reminders must keep reading those: Mason's own `git push --force` in
// backticks is exactly what the danger warning is for, and a sibling session's
// request is still something this session may act on. A subagent's hand-back
// is neither — it is this session's own child reporting.
export function withoutSubagentReports(prompt) {
  const text = String(prompt || "");
  return stripSubagentReports(text).replace(PEER_PREAMBLE_RE, " ").trim();
}

// Keep this a pointer, not a second copy of the policy: the full hard-gate list
// lives in AGENTS.md › Safety and Protected Delivery and the landing steps in
// .claude/commands/ship.md Step 8. A shorter restated list here once told agents
// only three actions were gated (2026-09-25 guidance review).
export const PUSH_POLICY =
  "LANDING POLICY: Mason's autonomous-landing rule (2026-09-26): branch → PR → required checks green → ready-for-coderabbit → CodeRabbit APPROVED on the exact head (fixes stay on the same PR) → exact-SHA Sol proof LAST → apply the change's NON-destructive migration, if any → exact-head merge, all with no in-chat ask, as detailed in .claude/commands/ship.md Step 8; direct pushes to main are impossible. The merge and apply gates enforce it in every session; an ARMED hands-free run passes only a plain branch push and a plain `gh pr merge <n>` on to those gates. HARD GATES — every one in AGENTS.md › Safety and Protected Delivery (force-push, DESTRUCTIVE migration or live-data change outside a reviewed migration, Edge Function or out-of-band production change, data deletion, secrets, authentication, permissions, billing, domains, ownership) — need Mason's explicit OK in the current conversation; destructive migrations (DELETE/TRUNCATE business rows, DROP data-bearing tables/columns) are refused for agents even then, armed or not, until he says yes. Never commit unrelated files.";
