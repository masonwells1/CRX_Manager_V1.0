#!/usr/bin/env node
// Mutation tests for the guard-claim audit.
//
// The audit exists because five guards overclaimed in one night. So these tests
// are written the same way the finding was: each case is a REAL overclaim from
// that night, and the assertion is that the audit catches it. A test suite for a
// check about honest claims should not itself be decorative.
//
// Run: node scripts/guard-claim-audit.test.mjs

import assert from "node:assert/strict";
import { scanFile, claimKey, CLAIM_PATTERNS, guardSourceFiles } from "./guard-claim-audit.mjs";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const catches = (src, why) => {
  const found = scanFile("/repo/.claude/hooks/x.mjs", src);
  ok(found.length > 0, `must catch: ${why} — got nothing for ${JSON.stringify(src.trim().slice(0, 70))}`);
  return found[0];
};
const ignores = (src, why) => {
  const found = scanFile("/repo/.claude/hooks/x.mjs", src);
  ok(found.length === 0, `must ignore: ${why} — wrongly flagged ${JSON.stringify(src.trim().slice(0, 70))}`);
};

// ---------------------------------------------------------------------------
// 1. The five real overclaims from 2026-08-31. Every one must be caught.
// ---------------------------------------------------------------------------
catches('deny("...so an agent shell cannot run it.");', "guard-unlock's disproved claim");
catches("// This gives a boundary an agent cannot cross.", "the surface lock's original framing");
catches("// The classifier fails closed on anything unparseable.", "#502's assertion that reproduced an allow");
catches("// LIVE_CLAIM is fail-closed.", "#500's, which was really fail-permanently-closed");
catches("// The lexer is fail-closed by construction.", "#449's, which failed open on a trailing backslash");
catches("// No agent can satisfy this check.", "absolute agent-capability claim");
catches("// This is impossible to bypass.", "impossibility claim");
catches("// Only a human can open the lock.", "human-only claim");
catches("// The gate guarantees the migration is reviewed.", "guarantee");

// ---------------------------------------------------------------------------
// 2. Honesty must NOT be punished — the correction is the behaviour we want
// ---------------------------------------------------------------------------
ignores("// It is NOT a human-only gate, and must not be described as one.", "an explicit correction");
ignores("// This is deliberately not fail-closed; see the decision log.", "an explicit denial of the property");
ignores("// Treat this as a speed bump. It does not guarantee anything.", "a disclaimer");
ignores("// Read the file and return its contents.", "ordinary prose with no claim");
ignores("// Never edit an applied migration.", "an instruction to humans, not a claim about the guard");

// ---------------------------------------------------------------------------
// 3. An annotation discharges the claim — that is the whole escape hatch
// ---------------------------------------------------------------------------
for (const annotation of ["@proven-by guarded-surface-lib.test.mjs", "@speed-bump", "@unproven"]) {
  const src = `// ${annotation}\n// This cannot be bypassed.\n`;
  const found = scanFile("/repo/.claude/hooks/x.mjs", src);
  ok(found.length === 1 && found[0].annotated === true, `${annotation} must discharge the claim`);
}
// …but only within the neighbourhood, or a stray annotation elsewhere in a long
// file would launder every claim in it.
{
  const src = ["// @proven-by something", ...Array(10).fill("//"), "// This cannot be bypassed."].join("\n");
  const found = scanFile("/repo/.claude/hooks/x.mjs", src);
  ok(found.length === 1 && found[0].annotated === false, "a distant annotation must NOT discharge a claim");
}

// ---------------------------------------------------------------------------
// 4. User-facing claims are the ones that mislead an operator
// ---------------------------------------------------------------------------
{
  const refusal = scanFile("/repo/.claude/hooks/x.mjs",
    'permissionDecisionReason: "This cannot be bypassed."');
  ok(refusal[0]?.userFacing === true, "a refusal string must be marked user-facing");
  const comment = scanFile("/repo/.claude/hooks/x.mjs", "// This cannot be bypassed.");
  ok(comment[0]?.userFacing === false, "an internal comment is not user-facing");
}

// ---------------------------------------------------------------------------
// 5. Baseline identity survives code motion but not rewording
// ---------------------------------------------------------------------------
{
  const a = scanFile("/repo/.claude/hooks/x.mjs", "// pad\n// pad\n// This cannot be bypassed.")[0];
  const b = scanFile("/repo/.claude/hooks/x.mjs", "// This cannot be bypassed.")[0];
  ok(claimKey(a) === claimKey(b), "moving a claim must not read as a NEW claim");
  const c = scanFile("/repo/.claude/hooks/x.mjs", "// This cannot be bypassed, honestly.")[0];
  ok(claimKey(a) !== claimKey(c), "rewording a claim MUST read as new — that is the ratchet");
}

// ---------------------------------------------------------------------------
// 6. It actually points at this repo's guards, not an empty set
// ---------------------------------------------------------------------------
ok(CLAIM_PATTERNS.length >= 10, "claim vocabulary must not be silently emptied");
ok(guardSourceFiles().length > 20, "the audit must actually find this repo's guard sources");
ok(guardSourceFiles().every((f) => !f.includes(".test.")), "test files are proof, never claims — they must be excluded");

// ---------------------------------------------------------------------------
// 7. The three scanner defects the PR #530 reviewer reported (all P2)
// ---------------------------------------------------------------------------

// (a) IDENTITY MUST NOT TRUNCATE. The old key kept 80 characters, so a long
// grandfathered claim could be reworded past that point and keep matching the
// baseline — a reworded safety claim sailing through the ratchet.
{
  const pad = "x".repeat(90);
  const a = scanFile("/repo/.claude/hooks/x.mjs", `// This cannot be bypassed. ${pad} original tail.`)[0];
  const b = scanFile("/repo/.claude/hooks/x.mjs", `// This cannot be bypassed. ${pad} REWORDED tail.`)[0];
  ok(a && b, "both long claims must still be found");
  ok(claimKey(a) !== claimKey(b), "rewording BEYOND character 80 must still read as a new claim");
}

// (b) NEGATION MUST BIND TO THE CLAIM. An unrelated disclaimer anywhere on the
// line used to suppress the whole line. The reviewer's own example was
// `FAIL-CLOSED … deliberately NOT a destructive-verb list`, which reported zero.
{
  const sneaky = scanFile("/repo/.claude/hooks/x.mjs",
    "// FAIL-CLOSED READ-ONLY ALLOWLIST — deliberately NOT a destructive-verb list.");
  ok(sneaky.length === 1, "an unrelated negation elsewhere on the line must NOT suppress the claim");
  // …while a negation that really does modify the claim still discharges it,
  // which is the behaviour the negation rule exists for.
  ok(scanFile("/repo/.claude/hooks/x.mjs", "// This is not a fail-closed guard.").length === 0,
    "a negation directly before the claim must still suppress it");
  ok(scanFile("/repo/.claude/hooks/x.mjs", "// The hook does not guarantee anything.").length === 0,
    "a negation spanning into the claim word must still suppress it");
}

// (c) WRAPPED CLAIMS. Guard comments and concatenated refusal strings routinely
// break a phrase over two lines; scanning lines independently found nothing.
{
  ok(scanFile("/repo/.claude/hooks/x.mjs", "// the operation is denied (fail\n// closed).").length === 1,
    "a claim wrapped across two comment lines must be found");
  ok(scanFile("/repo/.claude/hooks/x.mjs", '  "… so the merge fails " +\n  "closed."').length === 1,
    "a claim split across a string concatenation must be found");
  ok(scanFile("/repo/.claude/hooks/x.mjs", "// this cannot be\n// bypassed by any agent.").length === 1,
    "`cannot be` / `bypassed` split across lines must be found");
  // Follow-up P2: a two-line join was not enough — a claim wrapped over THREE or
  // more lines still escaped the enforced audit entirely.
  ok(scanFile("/repo/.claude/hooks/x.mjs", "// This cannot\n// be\n// bypassed.").length === 1,
    "a claim wrapped over three lines must be found");
  ok(scanFile("/repo/.claude/hooks/x.mjs", "// This\n// cannot\n// be\n// bypassed.").length === 1,
    "a claim wrapped over four lines must be found");
  // …but the window stops at a paragraph break, so two unrelated comment blocks
  // cannot be spliced into a claim neither of them makes.
  ok(scanFile("/repo/.claude/hooks/x.mjs", "// This cannot\n//\n// be bypassed.").length === 0,
    "a blank comment line must end the wrap window");
  // Follow-up P2, and the one that would have bitten other people: the window fed
  // the baseline identity, so CODE below a wrapped claim entered its key. Editing
  // that unrelated code made an untouched claim read as NEW, failing the enforced
  // suite on a change that touched no claim. Code must end the window.
  {
    const withCode = (tail) => `// the operation is denied (fail\n// closed).\n${tail}`;
    const a = scanFile("/repo/.claude/hooks/x.mjs", withCode("if (reconstructed) return null;"))[0];
    const b = scanFile("/repo/.claude/hooks/x.mjs", withCode("if (somethingElse) return false;"))[0];
    ok(a && b, "the wrapped claim must still be found with code beneath it");
    ok(claimKey(a) === claimKey(b), "editing code below a wrapped claim must NOT change its identity");
    ok(!/reconstructed/.test(a.claim), "implementation code must never enter the claim identity");
  }
}

// …and the two-line join must not DOUBLE-count. A bare `//` before a claim line
// joins into a match that starts on the next line; only the line the match
// starts on may report it.
{
  const found = scanFile("/repo/.claude/hooks/x.mjs", "//\n// FAIL-OPEN: any error → allow.");
  ok(found.length === 1, "a claim preceded by a bare comment line must be counted once");
  ok(found[0].line === 2, "the finding must sit on the line the claim actually starts on");
}

console.log(`guard-claim-audit: ${pass} assertions passed`);
