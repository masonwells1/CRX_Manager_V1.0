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
  // The `and <HEAD>` grep is the part that binds the result to the commit being
  // merged. Without it in the SAME command, the query proves only that some
  // submitted review exists — which is true of every PR that was ever reviewed.
  ok(
    hasCommandWithAll(cmds, [
      "pulls/<n>/reviews",
      'select(.user.login=="coderabbitai[bot]"',
      ".submitted_at != null",
      '.state != "DISMISSED"',
      'grep -oE "and <HEAD>"',
    ]),
    `${name}: the reviews query filters bot identity, unsubmitted, and dismissed AND binds to the head SHA`,
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
      'grep -oE "and <HEAD>"',
    ]),
    `${name}: the comments query keeps only the canonical walkthrough, drops chat replies, AND binds to the head SHA`,
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
  const bindsBoundVar = (cmd, prefix) =>
    Boolean(boundVar) &&
    Boolean(cmd) &&
    new RegExp(`\\b${boundVar}="\\$\\(git rev-parse <HEAD>\\^1\\)"`).test(cmd) &&
    new RegExp(`${prefix}\\$(?:\\{${boundVar}\\}|${boundVar}\\b)`).test(cmd);
  ok(
    bindsBoundVar(parentLookup, 'grep -oE "and '),
    `${name}: the canonical-stamp lookup expands the same variable it derived, not a separately supplied value`,
  );
  // The parent's own settled status is the other half of the full gate, and it
  // has to be bound the same way — a status check on a re-typed SHA proves the
  // same nothing the lookup would.
  const parentStatus = cmds.find(
    (c) => /\bgit rev-parse <HEAD>\^1\b/.test(c) && c.includes("/statuses"),
  );
  ok(
    bindsBoundVar(parentStatus, "commits/") &&
      parentStatus.includes('select(.context=="CodeRabbit")') &&
      parentStatus.includes('= "success"'),
    `${name}: the parent's own CodeRabbit status check derives and expands that same variable`,
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

const S = (state, created_at) => ({ context: "CodeRabbit", state, created_at });

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

// The skill must actually document the settle requirement, not just the query.
for (const [name, file] of SKILLS) {
  const text = readFileSync(file, "utf8");
  ok(/90\s*seconds apart/i.test(text), `${name}: the skill requires a >=90s settle window between polls`);
}

console.log(`deploy-check-review-gate: ${pass} assertions passed`);
