#!/usr/bin/env node
// Regression tests for the deploy-check pre-merge review gate.
//
// SCOPE — read this before trusting a green run. This is DOCUMENTATION-REGRESSION
// coverage, not runtime enforcement. It proves the documented procedure still says
// the right thing; it does NOT execute the review verification, and it cannot stop
// a merge that skips those steps. `.claude/hooks/pr-merge-guard.mjs` currently
// enforces neither the CodeRabbit artifacts nor `--match-head-commit`, so a green
// run here plus a careless merge is still a bad merge. Codex raised exactly this
// (CRX-SEC-002, Medium, PR #441) and the honest label is its own mitigation:
// converting these checks into the merge guard is tracked follow-up work, and
// until that lands nobody should cite this suite as the hard gate.
//
// The gate lives in prose (.claude/skills/deploy-check/SKILL.md) rather than in
// executable code, so these tests pin the exact query shapes that make it sound.
// Each assertion here corresponds to a hole that was live at some point on
// PR #441 and was closed by a reviewer finding. Weakening any of them silently
// restores a way for an unreviewed commit to reach production.
//
// IMPORTANT: assert against the extracted ```bash COMMANDS, never against the
// document text. The first version of this file used whole-file `includes()`,
// which the surrounding explanatory paragraphs satisfy on their own — so the
// suite would have stayed green while the real command regressed. CodeRabbit
// caught that on PR #441; it is the same "green signal for the wrong thing"
// failure the gate itself exists to prevent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKILLS = [
  ["claude", path.join(ROOT, ".claude", "skills", "deploy-check", "SKILL.md")],
  ["codex", path.join(ROOT, ".agents", "skills", "deploy-check", "SKILL.md")],
];

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// Extract the bodies of every ```bash fenced block, collapsed to one line each.
function bashCommands(markdown) {
  const blocks = [];
  const fence = /```bash\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(markdown)) !== null) {
    for (const line of m[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) blocks.push(trimmed);
    }
  }
  return blocks;
}

// The slice of the document between two markers, so a prose rule can be asserted
// where it must actually appear rather than anywhere in the file. Returns null
// when either marker is missing or they are out of order, so a moved section
// fails closed instead of silently matching an empty string.
function sectionBetween(markdown, startNeedle, endNeedle) {
  const start = markdown.indexOf(startNeedle);
  if (start === -1) return null;
  const end = markdown.indexOf(endNeedle, start + startNeedle.length);
  if (end === -1) return null;
  return markdown.slice(start, end);
}

// Every needle present, each after the previous one — a SEQUENCE, not a set.
// Independent `includes()` checks pass on scrambled prose: "require that same
// created_at before merging, wait 90s" contains every fragment while describing
// a different (and wrong) procedure. Walking the index forward pins the order.
// (CodeRabbit, PR #441.)
// Same "derive it and expand it, in that order, in one command" rule the parent
// SHA already has to satisfy, reusable for any command that derives PARENT1.
function bindsBoundVarIn(cmd, varName, prefix) {
  if (!cmd) return false;
  const assign = cmd.match(new RegExp(`\\b${varName}="\\$\\(git rev-parse <HEAD>\\^1\\)"`));
  const use = cmd.match(new RegExp(`${prefix}\\$(?:\\{${varName}\\}|${varName}\\b)`));
  if (!assign || !use) return false;
  return assign.index < use.index;
}

function containsInOrder(text, needles) {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    if (at === -1) return false;
    from = at + needle.length;
  }
  return true;
}

// A command satisfies a rule only if it contains EVERY required fragment.
const hasCommandWithAll = (cmds, fragments) =>
  cmds.some((c) => fragments.every((f) => c.includes(f)));
const noCommandWithAll = (cmds, fragments) =>
  !cmds.some((c) => fragments.every((f) => c.includes(f)));
const noCommandMatching = (cmds, re) => !cmds.some((c) => re.test(c));

// Any shell expansion in a `contents/` path segment, not just the literal
// <FILE> placeholder the first draft used: a later rewrite to contents/$f,
// contents/${f}, contents/$(...), or contents/`...` would reintroduce the same
// injection vector while passing a literal-only check.
//
// `<(` and `>(` cover Bash process substitution, which the `<[A-Za-z_]+>`
// placeholder alternative does not match — `contents/<(cat f)` would otherwise
// slip through. (CodeRabbit, PR #441.)
//
// Deliberately NOT matching a bare double quote. An earlier revision did, which
// false-positived on a perfectly safe literal such as
// `gh api "repos/o/r/contents/README.md?ref=abc"` — the closing quote alone is
// not an expansion. The quoted-expansion form `contents/"$f"` is still caught,
// because the `$` alternative matches it. A guard that blocks safe commands gets
// edited away, so precision here is what keeps it alive. (CodeRabbit, PR #441.)
const EXPANSION_AFTER_CONTENTS = /contents\/[^\s]*(?:<[A-Za-z_]+>|<\(|>\(|\$|`)/;

// Any placeholder that invites the operator to name what "reviewed" means —
// <REVIEWED_SHA>, <REVIEWED_COMMIT>, <EXPECTED_REVIEWED_HEAD>, <KNOWN_GOOD_SHA>.
// The parent's identity must be DERIVED from HEAD^1 and proven against a
// CodeRabbit artifact; a value typed in by whoever runs the procedure is the
// claim, not proof of it. (CodeRabbit, PR #441.)
//
// Angle brackets are one notation for that idea, not the idea. Once the procedure
// started using real shell variables, `$REVIEWED_SHA` / `${REVIEWED_SHA}` became
// the natural next spelling of the same hole — an operator-set environment value
// reads as derived while being exactly as supplied as a typed-in placeholder. The
// bracket-only pattern would have waved it through. (CodeRabbit, PR #441 — the
// second time this file was caught matching a spelling instead of a concept.)
const OPERATOR_SUPPLIED_REVIEWED_PLACEHOLDER =
  /(?:<|\$\{?)[A-Z_]*(?:REVIEWED|KNOWN_GOOD|TRUSTED|VERIFIED)[A-Z_]*(?:>|\})?/;

for (const [name, file] of SKILLS) {
  const cmds = bashCommands(readFileSync(file, "utf8"));
  ok(cmds.length > 0, `${name}: bash commands were extracted from the skill`);

  // ── Completion bound to the exact head COMMIT ─────────────────────────────
  // gh pr checks answers "what is current for the PR", not "what is true of the
  // commit I am merging". Commit statuses are written by CodeRabbit under its
  // own credentials and bound by GitHub to one SHA; a PR author cannot post one.
  ok(
    hasCommandWithAll(cmds, ["commits/<HEAD>/statuses", 'select(.context=="CodeRabbit")', '= "success"']),
    `${name}: one command asserts a CodeRabbit success status on the head commit itself`,
  );
  ok(
    noCommandWithAll(cmds, ["gh pr checks", "grep -i coderabbit"]),
    `${name}: no command greps the PR check list for the word "coderabbit" (it matches "pending" too)`,
  );

  // ── Review objects: reject unsubmitted and dismissed ──────────────────────
  // The endpoint returns PENDING (submitted_at: null) and DISMISSED reviews
  // whose bodies still carry the range line.
  // `.commit_id` is what binds the result to the commit being merged, and it is
  // GitHub-populated structured data rather than prose. An earlier revision
  // grepped the review BODY for a bare `and <HEAD>`; Codex returned High on
  // that, because review bodies are AI-generated summaries of public PR content
  // and a PR containing the target SHA could have it echoed back. Without a
  // head binding in the SAME command, the query proves only that some submitted
  // review exists — true of every PR that was ever reviewed.
  ok(
    hasCommandWithAll(cmds, [
      "pulls/<n>/reviews",
      'select(.user.login=="coderabbitai[bot]"',
      ".submitted_at != null",
      '.state != "DISMISSED"',
      '.commit_id == "<HEAD>"',
    ]),
    `${name}: the reviews query filters bot identity, unsubmitted, and dismissed AND binds to the head via structured commit_id`,
  );
  ok(
    noCommandWithAll(cmds, ["pulls/<n>/reviews", 'grep -oE "and <HEAD>"']),
    `${name}: the reviews query does not fall back to matching the head SHA in prose`,
  );

  // ── Forged-comment defence (Codex BLOCKED, 2026-08-20) ────────────────────
  // chat.auto_reply is on and the repo is public, so ANY coderabbitai[bot]
  // comment is attacker-solicitable: a PR author can ask the bot to echo the
  // head SHA. Only the canonical walkthrough comment counts.
  ok(
    hasCommandWithAll(cmds, [
      "issues/<n>/comments",
      'select(.user.login=="coderabbitai[bot]")',
      'contains("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->")',
      'select((.body | contains("auto-generated reply by CodeRabbit")) | not)',
      "iles that changed from the base of the PR and between [0-9a-f]{40} and <HEAD>",
    ]),
    `${name}: the comments query keeps only the canonical walkthrough, drops chat replies, AND binds to the head via the fully anchored stamp line`,
  );
  ok(
    noCommandWithAll(cmds, ["issues/<n>/comments", 'grep -oE "and <HEAD>"']),
    `${name}: the comments query does not accept a bare, unanchored "and <HEAD>" anywhere in the body`,
  );
  ok(
    noCommandWithAll(cmds, [
      "issues/<n>/comments",
      'select(.user.login=="coderabbitai[bot]") | .body',
    ]) || hasCommandWithAll(cmds, ['contains("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->")']),
    `${name}: no unfiltered any-bot-comment query survives (it is forgeable via chat)`,
  );

  // ── Merge binding ─────────────────────────────────────────────────────────
  ok(
    hasCommandWithAll(cmds, ["gh pr merge", "--match-head-commit"]),
    `${name}: the merge command binds GitHub to the reviewed SHA`,
  );

  // ── No-op-merge fallback must assert, not print ───────────────────────────
  // The parent must be PROVEN reviewed, never asserted equal to a SHA the
  // operator supplied — an unreviewed parent labelled <REVIEWED_SHA> would pass
  // all three tree checks, and the merge commit itself carries no stamp by
  // design. (Codex CRX-SEC-001, High, PR #441.)
  // Match the CONCEPT, not one spelling: an earlier revision rejected only the
  // literal `<REVIEWED_SHA>`, so renaming it `<REVIEWED_COMMIT>` or
  // `<EXPECTED_REVIEWED_HEAD>` would have restored the hole with a green suite.
  ok(
    noCommandMatching(cmds, OPERATOR_SUPPLIED_REVIEWED_PLACEHOLDER),
    `${name}: no check compares HEAD^1 to an operator-supplied "reviewed" identifier, under any name`,
  );
  // The parent must be DERIVED, and the derived value must be what the review
  // lookup consumes — checked as ONE binding, not as two independent facts.
  // Asserting "a command derives HEAD^1" and "a command greps for the parent"
  // separately is satisfied by a procedure that derives one value and looks up
  // another; the gap between two blocks is exactly where a substituted SHA gets
  // in. So find the single command that does both, read the variable name it
  // assigns from `git rev-parse <HEAD>^1`, and require THAT name to be what the
  // lookup expands. (CodeRabbit, PR #441.)
  const parentLookup = cmds.find(
    (c) => /\bgit rev-parse <HEAD>\^1\b/.test(c) && c.includes("issues/<n>/comments"),
  );
  ok(
    Boolean(parentLookup),
    `${name}: the parent derivation and the canonical-stamp lookup are a single command`,
  );
  const assignment = parentLookup
    ? parentLookup.match(/\b([A-Za-z_][A-Za-z0-9_]*)="\$\(git rev-parse <HEAD>\^1\)"/)
    : null;
  ok(
    Boolean(assignment),
    `${name}: the parent SHA is captured into a shell variable from git rev-parse <HEAD>^1`,
  );
  const boundVar = assignment ? assignment[1] : null;
  // A command is bound only if it BOTH assigns the derived parent to `boundVar`
  // and expands that same name. Checking the expansion alone is not enough: a
  // command that assigns `OTHER="$(git rev-parse <HEAD>^1)"` and then expands
  // `$PARENT1` still matches an expansion-only test, while `$PARENT1` is unset
  // there and expands to nothing — `commits//statuses`. The assignment and the
  // use have to be the same name in the same command, or the "binding" is a
  // coincidence of spelling. (CodeRabbit, PR #441.)
  // Presence of both is still not enough — they have to be in that ORDER. A
  // command that expands `$PARENT1` and assigns it afterwards satisfies two
  // independent `.test()` calls while the variable is empty at the moment it is
  // used, which is the same `commits//statuses` nothing as before. Compare match
  // positions: the assignment must precede its first expansion.
  // (CodeRabbit, PR #441.)
  const bindsBoundVar = (cmd, prefix) => {
    if (!boundVar || !cmd) return false;
    const assign = cmd.match(new RegExp(`\\b${boundVar}="\\$\\(git rev-parse <HEAD>\\^1\\)"`));
    const use = cmd.match(new RegExp(`${prefix}\\$(?:\\{${boundVar}\\}|${boundVar}\\b)`));
    if (!assign || !use) return false;
    return assign.index < use.index;
  };
  ok(
    // The prefix is the tail of the anchored canonical stamp line, so this also
    // proves the parent lookup uses the anchored form rather than a bare
    // `and $PARENT1`. Regex metacharacters in the character class are escaped
    // because this string is compiled into a RegExp.
    bindsBoundVar(parentLookup, "and between \\[0-9a-f\\]\\{40\\} and "),
    `${name}: the canonical-stamp lookup expands the same variable it derived, not a separately supplied value`,
  );
  // The parent gets the same two-endpoint treatment as the head: a review WITH
  // findings binds through structured commit_id, a clean review only ever
  // appears in the walkthrough comment. Checking one endpoint reports a
  // reviewed parent as unreviewed. (Codex, PR #441.)
  const parentReviewLookup = cmds.find(
    (c) => /\bgit rev-parse <HEAD>\^1\b/.test(c) && c.includes("pulls/<n>/reviews"),
  );
  ok(
    Boolean(parentReviewLookup),
    `${name}: the parent is also checked against the reviews endpoint, not comments alone`,
  );
  ok(
    // The jq filter sits inside a double-quoted shell string, so the quotes
    // around the value are backslash-escaped in the command text. Tolerate any
    // run of quote/backslash characters between `==` and the expansion.
    bindsBoundVar(parentReviewLookup, 'commit_id == [\\\\"]*'),
    `${name}: the parent reviews lookup binds through structured commit_id, derived in the same command`,
  );
  // The parent's own settled status is the other half of the full gate, and it
  // has to be bound the same way — a status check on a re-typed SHA proves the
  // same nothing the lookup would.
  const parentStatus = cmds.find(
    (c) => /\bgit rev-parse <HEAD>\^1\b/.test(c) && c.includes("/statuses"),
  );
  ok(
    bindsBoundVar(parentStatus, "commits/") &&
      parentStatus.includes('select(.context=="CodeRabbit")'),
    `${name}: the parent's own CodeRabbit status check derives and expands that same variable`,
  );
  // A one-shot `= "success"` on the parent is the SAME intermediate-success hole
  // the head procedure exists to close, and an earlier revision shipped exactly
  // that while this file's own settlement section explained why it is not
  // terminal. The parent already carries its walkthrough stamp during that
  // window (the stamp is written when a review STARTS), so a no-op merge could
  // land before findings were generated. The parent command must therefore emit
  // `created_at` — the value the two-poll comparison needs — and must not reduce
  // the status to a bare success test. Asserting this on the COMMAND is the
  // point: a document-wide search for "90 seconds apart" is satisfied by the
  // head's section and proves nothing about the parent.
  // (Codex CRX-SEC-001, High, PR #441.)
  ok(
    Boolean(parentStatus) && parentStatus.includes(".created_at"),
    `${name}: the parent status command emits created_at, so its success can be settled across polls`,
  );
  ok(
    Boolean(parentStatus) && !parentStatus.includes('= "success"'),
    `${name}: the parent status is not reduced to a one-shot success test`,
  );
  // Emitting `created_at` only makes settlement POSSIBLE; the procedure still has
  // to spell out the whole sequence. "Wait 90 seconds" cannot live inside a single
  // shell command, so this is the one rule that is necessarily prose — which makes
  // it the one rule a document-wide search would wrongly satisfy from the head's
  // section. Scope the search to the parent block itself: every element of the
  // sequence must appear between the parent heading and the tree checks that
  // follow it. (CodeRabbit, PR #441.)
  const parentSection = sectionBetween(
    readFileSync(file, "utf8"),
    "**Do not compare the parent to a SHA you typed in",
    "git merge-base --is-ancestor <HEAD>^2 <BASE_SHA>",
  );
  ok(Boolean(parentSection), `${name}: the parent fallback section is locatable`);
  // One ordered sequence, not five independent presence checks. Order is the
  // substance here: "require that same created_at before merging, wait 90s"
  // contains every fragment and describes the wrong procedure. The parent
  // section must lay the steps out in the order they are performed —
  // poll, wait 90s, poll again, require identical, then re-read before merging
  // and require that same created_at. (CodeRabbit, PR #441.)
  ok(
    Boolean(parentSection) &&
      containsInOrder(parentSection, [
        "wait 90s",
        "run it again",
        "identical",
        "before merging",
        "same",
        "created_at",
      ]),
    `${name}: the parent section states the full settlement sequence, in order`,
  );
  ok(
    hasCommandWithAll(cmds, ["git merge-tree --write-tree", "<HEAD>^{tree}", "MERGE_ADDED_NOTHING"]),
    `${name}: tree identity is asserted, not printed`,
  );
  ok(
    hasCommandWithAll(cmds, ["git merge-base --is-ancestor <HEAD>^2 <BASE_SHA>", "ANCESTOR_OF_BASE"]),
    `${name}: ancestry is bound to the PR's baseRefOid`,
  );
  ok(
    noCommandWithAll(cmds, ["git merge-base --is-ancestor", "origin/main"]),
    `${name}: ancestry is not checked against the origin/main tracking ref`,
  );

  // ── No PR-controlled text in a shell command ──────────────────────────────
  // Filenames come from the PR and may contain quotes, semicolons, or $().
  ok(
    noCommandMatching(cmds, EXPANSION_AFTER_CONTENTS),
    `${name}: no PR-controlled filename is interpolated into a shell command, in any expansion form`,
  );
}

// ── Status-settlement logic, exercised against real recorded timelines ───────
// CodeRabbit's status sequence is not monotonic: a `success` can sit between two
// `pending` entries, and the walkthrough stamp is written when a review STARTS —
// so during that window both the stamp and the newest status look final while
// findings are still being generated. Codex raised this as High on PR #441.
//
// `settledSuccess` is the rule the skill documents: poll the newest exact-head
// CodeRabbit status twice, >= MIN_SETTLE_MS apart, and require `success` with an
// identical created_at both times. Statuses arrive newest-first from the API.
export const MIN_SETTLE_MS = 90_000;

export function newestStatus(statuses) {
  return statuses.filter((s) => s.context === "CodeRabbit")[0] ?? null;
}

export function settledSuccess(firstPoll, secondPoll, elapsedMs) {
  if (elapsedMs < MIN_SETTLE_MS) return false;
  const a = newestStatus(firstPoll);
  const b = newestStatus(secondPoll);
  if (!a || !b) return false;
  return a.state === "success" && b.state === "success" && a.created_at === b.created_at;
}

// The pre-merge re-read is not "is it success now" — that would pass on a
// DIFFERENT run that started and finished after the settle window. It must be the
// same status: success at the identical created_at the settle pair agreed on.
// (CodeRabbit, PR #441.)
export function finalPollConfirms(settledPoll, finalPoll) {
  const settled = newestStatus(settledPoll);
  const final = newestStatus(finalPoll);
  if (!settled || !final) return false;
  return (
    settled.state === "success" &&
    final.state === "success" &&
    settled.created_at === final.created_at
  );
}

// A settled `success` is not a completed review. Recorded on PR #411: the check
// row read "CodeRabbit pass — Review completed" while the bot's own comment said
// "Review failed — An error occurred during the review process", with no findings
// ever submitted; PR #402 showed "Review rate limited" behind the same green row
// (docs/reference/gotchas.md). The walkthrough stamp does not rescue this, because
// it is written when a review STARTS — so a review that stamps the head and then
// dies leaves the stamp, the status, and the settle comparison all passing.
// (Codex CRX-SEC-002, High, PR #441.)
export const REVIEW_FAILURE_MARKERS = [
  "Review failed",
  "Review rate limited",
  "No files to review",
  "Review limit reached",
];

// "Reviews paused" is deliberately NOT a failure marker: auto_pause_after_reviewed_commits
// makes that notice a permanent fixture of the walkthrough on an active branch, so
// treating it as failure would block every merge forever.
export const NOT_A_FAILURE_MARKER = "Reviews paused";

// Comments are considered only from this head's own review cycle. A failure from an
// earlier head is history; scanning the whole PR would wedge the gate shut on any PR
// that ever had one failed review.
export function reviewCompleted(botComments, cycleStartIso) {
  return !botComments.some(
    (c) =>
      c.created_at >= cycleStartIso &&
      REVIEW_FAILURE_MARKERS.some((m) => c.body.includes(m)),
  );
}

const S = (state, created_at) => ({ context: "CodeRabbit", state, created_at });
const C = (created_at, body) => ({ created_at, body });

// The real 5a12433f timeline, newest-first at two moments.
const atIntermediateSuccess = [S("success", "2026-08-20T22:51:50Z"), S("pending", "2026-08-20T22:51:43Z")];
const afterResume = [S("pending", "2026-08-20T22:51:54Z"), S("success", "2026-08-20T22:51:50Z")];
const atFinalSuccess = [S("success", "2026-08-20T22:59:14Z"), S("pending", "2026-08-20T22:51:54Z")];

ok(
  settledSuccess(atIntermediateSuccess, afterResume, 120_000) === false,
  "intermediate success -> resumed pending is REJECTED (the PR #441 race)",
);
ok(
  settledSuccess(atIntermediateSuccess, atIntermediateSuccess, 4_000) === false,
  "two polls inside the 4s intermediate window are REJECTED (settle time not met)",
);
ok(
  settledSuccess(atFinalSuccess, atFinalSuccess, 120_000) === true,
  "a stable final success across the settle window is ACCEPTED",
);
ok(
  settledSuccess(atIntermediateSuccess, atFinalSuccess, 120_000) === false,
  "success at a DIFFERENT created_at is REJECTED (a new run finished in between)",
);
ok(settledSuccess([], [], 120_000) === false, "no CodeRabbit status at all is REJECTED (fail closed)");

// Third poll, immediately before the merge.
const laterRunFinished = [S("success", "2026-08-21T00:10:00Z"), S("pending", "2026-08-21T00:05:00Z")];
const resumedAgain = [S("pending", "2026-08-21T00:05:00Z"), S("success", "2026-08-20T22:59:14Z")];

ok(
  finalPollConfirms(atFinalSuccess, atFinalSuccess) === true,
  "final poll matching the settled status exactly is ACCEPTED",
);
ok(
  finalPollConfirms(atFinalSuccess, laterRunFinished) === false,
  "final poll showing a DIFFERENT run's success is REJECTED (new created_at)",
);
ok(
  finalPollConfirms(atFinalSuccess, resumedAgain) === false,
  "final poll showing a resumed pending is REJECTED",
);
ok(finalPollConfirms(atFinalSuccess, []) === false, "final poll with no status is REJECTED (fail closed)");

// ── A stable success is not a completed review (the PR #411 shape) ───────────
const CYCLE = "2026-08-17T10:00:00Z";
ok(
  reviewCompleted([C("2026-08-17T10:05:00Z", "walkthrough … and <HEAD>")], CYCLE) === true,
  "a stamped head with no failure marker this cycle is ACCEPTED",
);
ok(
  reviewCompleted(
    [
      C("2026-08-17T10:05:00Z", "walkthrough … and <HEAD>"),
      C("2026-08-17T10:06:00Z", "**Review failed** — An error occurred during the review process."),
    ],
    CYCLE,
  ) === false,
  "the real PR #411 shape is REJECTED: stamped head, stable success, review failed",
);
ok(
  reviewCompleted([C("2026-08-17T10:06:00Z", "Review rate limited")], CYCLE) === false,
  "the PR #402 shape is REJECTED: green row, review rate limited",
);
ok(
  reviewCompleted([C("2026-08-17T10:06:00Z", "Review limit reached")], CYCLE) === false,
  "a review-limit-reached comment this cycle is REJECTED",
);
ok(
  reviewCompleted([C("2026-08-17T10:06:00Z", "No files to review.")], CYCLE) === false,
  "a no-files-to-review comment this cycle is REJECTED for a real commit",
);
ok(
  reviewCompleted([C("2026-08-17T09:00:00Z", "**Review failed** — earlier head")], CYCLE) === true,
  "a failure marker from BEFORE this cycle is history, not a verdict on this head",
);
ok(
  reviewCompleted([C("2026-08-17T10:06:00Z", `> ## ${NOT_A_FAILURE_MARKER}`)], CYCLE) === true,
  "the permanent auto-pause notice is NOT treated as a failure (it would block every merge)",
);

// The skill must actually document the settle requirement, not just the query.
for (const [name, file] of SKILLS) {
  const text = readFileSync(file, "utf8");
  ok(/90\s*seconds apart/i.test(text), `${name}: the skill requires a >=90s settle window between polls`);
}

// ── The probe's DECISION, modelled and executed ──────────────────────────────
// Codex's second pass on this file: the previous assertions matched command
// substrings and never validated what the command DOES when a stage fails. The
// first version ended `... | grep -qE "…" || echo NO_FAILURE_MARKER_THIS_HEAD`,
// so a network blip, an expired token, or a jq error all fell through to the
// clean marker — and it passed `--arg` to `gh api`, which rejects it outright
// (`accepts 1 arg(s), received 4`), so the probe never ran at all and reported
// clean unconditionally. Both reviewers caught it independently. A fail-open
// check is worse than no check, because it also reports success.
export const PROBE_CLEAN = "NO_FAILURE_MARKER";
export const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
export function failureProbeOutcome({ since, fetchOk, markerFound }) {
  if (!ISO_UTC.test(since ?? "")) return "BLOCKED_CANNOT_DETERMINE_CYCLE_START";
  if (!fetchOk) return "BLOCKED_COMMENTS_FETCH_FAILED";
  if (markerFound) return "BLOCKED_REVIEW_DID_NOT_COMPLETE";
  return PROBE_CLEAN;
}
const allOk = { since: "2026-08-17T10:00:00Z", fetchOk: true, markerFound: false };
ok(failureProbeOutcome(allOk) === PROBE_CLEAN, "probe: every stage succeeded and no marker -> clean");
ok(
  failureProbeOutcome({ ...allOk, markerFound: true }) !== PROBE_CLEAN,
  "probe: a failure marker BLOCKS",
);
ok(
  failureProbeOutcome({ ...allOk, fetchOk: false }) !== PROBE_CLEAN,
  "probe: a failed comments fetch BLOCKS rather than reporting clean",
);
// The timestamp guard fails closed AND is what makes interpolating $SINCE into
// the jq program safe. Anything that is not an anchored ISO-8601 UTC instant is
// rejected before it can reach the query.
for (const bad of ["", "   ", "not-a-date", "2026-08-17", '2026-08-17T10:00:00Z" or "1']) {
  ok(
    failureProbeOutcome({ ...allOk, since: bad }) === "BLOCKED_CANNOT_DETERMINE_CYCLE_START",
    `probe: a malformed cycle start (${JSON.stringify(bad)}) BLOCKS`,
  );
}

// …and the skill must carry that structure as a real command, for the head AND
// for the merge-only fallback's parent — Codex found the parent running only the
// stamp and the settled status while the text called it the "full" gate.
for (const [name, file] of SKILLS) {
  const cmds = bashCommands(readFileSync(file, "utf8"));
  const probes = [
    ["head", cmds.find((c) => c.includes("Review failed") && c.includes("commits/<HEAD>/statuses"))],
    ["parent", cmds.find((c) => c.includes("Review failed") && /\bgit rev-parse <HEAD>\^1\b/.test(c))],
  ];
  for (const [which, probe] of probes) {
    ok(Boolean(probe), `${name}: a ${which} command checks whether the review actually completed`);
    // The three markers both probes must carry. "No files to review" is required
    // of the head only — it is the EXPECTED answer for a merge-only head, and is
    // deliberately absent from the parent-cycle pattern.
    for (const marker of ["Review failed", "Review rate limited", "Review limit reached"]) {
      ok(
        Boolean(probe) && probe.includes(marker),
        `${name}: the ${which} completed-review check covers "${marker}"`,
      );
    }
    ok(
      Boolean(probe) && !probe.includes(NOT_A_FAILURE_MARKER),
      `${name}: the ${which} check does NOT match the permanent auto-pause notice`,
    );
    ok(
      Boolean(probe) && !/--arg\b/.test(probe),
      `${name}: the ${which} check passes no --arg (gh api rejects it; standalone jq is absent here)`,
    );
    ok(
      Boolean(probe) && probe.includes("[0-9]{4}-[0-9]{2}-[0-9]{2}T"),
      `${name}: the ${which} check validates the cycle-start timestamp before interpolating it`,
    );
    ok(
      Boolean(probe) && !/\|\|\s*echo\s+NO_FAILURE_MARKER/.test(probe),
      `${name}: the ${which} check never reaches its clean marker through an || fallback`,
    );
    ok(
      Boolean(probe) && /\bBLOCKED_[A-Z_]+/.test(probe),
      `${name}: the ${which} check emits explicit BLOCKED markers for its error paths`,
    );
    ok(
      Boolean(probe) && probe.includes("$SINCE") && probe.includes("statuses"),
      `${name}: the ${which} check is scoped to that commit's own review cycle`,
    );
    ok(
      Boolean(probe) && probe.includes('.created_at >= \\"$SINCE\\"'),
      `${name}: the ${which} check filters comments by that cycle start`,
    );
  }
  ok(
    Boolean(probes[1][1]) && bindsBoundVarIn(probes[1][1], "PARENT1", "commits/"),
    `${name}: the parent completed-review check derives PARENT1 and expands it, in that order`,
  );
}

// ── the stamp matcher itself, run rather than described ──────────────────────
// Codex, High, PR #441: the head binding read AI-generated bot prose and matched
// a bare `and <HEAD>` anywhere in it. Review and walkthrough bodies summarise
// PUBLIC PR content, so a PR that contains the target SHA in a changed file — in
// a doc, a fixture, a test name — could have it echoed into a body and satisfy
// that grep with no review of that head. The commands are now (a) `.commit_id`,
// structured and un-influenceable, for review objects, and (b) the entire
// canonical stamp line, `^`/`$` anchored, for the clean-review walkthrough.
//
// Both are modelled here as functions so the negative cases actually EXECUTE. A
// substring assertion over the command text would have passed for the old,
// broken form too — which is exactly how it shipped.
const HEAD_SHA = "821c26b4ee4217ef6991ff1846e6ebeb1ed0fab3";
const BASE_SHA = "75cce46d81941a273d0496b7fac753220cbf54df";

// Mirrors the grep in the comments query, character for character.
export function stampLineBinds(body, head) {
  const re = new RegExp(
    `^> [A-Za-z ]*[Ff]iles that changed from the base of the PR and between [0-9a-f]{40} and ${head}\\.$`,
    "m",
  );
  return re.test(body);
}

// Mirrors the jq select in the reviews query.
export function reviewObjectBinds(review, head) {
  return (
    review.user?.login === "coderabbitai[bot]" &&
    review.submitted_at != null &&
    review.state !== "DISMISSED" &&
    review.commit_id === head
  );
}

const REAL_STAMP = `> Reviewing files that changed from the base of the PR and between ${BASE_SHA} and ${HEAD_SHA}.`;
ok(stampLineBinds(REAL_STAMP, HEAD_SHA), "the real canonical stamp line is ACCEPTED (verified live on PR #441)");

// Every one of these contains the head SHA and would have satisfied `and <HEAD>`.
for (const [label, body] of [
  ["prose mentioning the SHA", `The diff touches a doc that references commit and ${HEAD_SHA} in passing.`],
  ["a summarised diff line", `+ // rebased onto and ${HEAD_SHA}`],
  ["a quoted file path", `> \`docs/handoffs/and ${HEAD_SHA}.md\``],
  ["the stamp without the leading blockquote", `Reviewing files that changed from the base of the PR and between ${BASE_SHA} and ${HEAD_SHA}.`],
  ["the stamp with trailing text appended", `${REAL_STAMP} (cached)`],
  ["a stamp naming a different head", `> Reviewing files that changed from the base of the PR and between ${BASE_SHA} and ${BASE_SHA}.`],
  ["a non-hex base", `> Reviewing files that changed from the base of the PR and between not-a-sha and ${HEAD_SHA}.`],
]) {
  ok(!stampLineBinds(body, HEAD_SHA), `stamp matcher REJECTS ${label}`);
}

const submitted = { user: { login: "coderabbitai[bot]" }, submitted_at: "2026-08-24T11:40:20Z", state: "COMMENTED", commit_id: HEAD_SHA };
ok(reviewObjectBinds(submitted, HEAD_SHA), "a submitted bot review whose commit_id IS the head is ACCEPTED");
for (const [label, review] of [
  ["a review submitted against an older commit", { ...submitted, commit_id: BASE_SHA }],
  ["an unsubmitted (PENDING) review", { ...submitted, submitted_at: null }],
  ["a dismissed review", { ...submitted, state: "DISMISSED" }],
  ["a review by a non-bot account", { ...submitted, user: { login: "someone" } }],
  ["a review with no commit_id at all", { ...submitted, commit_id: undefined }],
  ["a review whose BODY names the head but whose commit_id does not", { ...submitted, commit_id: BASE_SHA, body: REAL_STAMP }],
]) {
  ok(!reviewObjectBinds(review, HEAD_SHA), `review binding REJECTS ${label}`);
}

console.log(`deploy-check-review-gate: ${pass} assertions passed`);
