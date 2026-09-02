#!/usr/bin/env node

// Guard-claim audit — the lessons-to-checks ratchet from 2026-08-31.
//
// WHY THIS EXISTS
// ---------------
// In one night, five guards across four PRs were found asserting a safety
// property they did not have. Every one overclaimed; not one understated:
//
//   * guarded-surface-lock  "a boundary an agent cannot cross"  → a five-line
//                            script writing through node fs walked through it
//   * guard-unlock          "an agent shell cannot run it"      → a PTY-capable
//                            agent satisfies isTTY; the phrase is in the source
//   * PR #502               "fails closed"                      → Codex
//                            reproduced an `allow` on the live-migration path
//   * PR #449 lexer README  "fail-closed"                       → fails open on
//                            an ordinary trailing-backslash string
//   * PR #500 LIVE_CLAIM    "fail-closed"                       → really
//                            fail-PERMANENTLY-closed: 23h+ operator lockout
//
// Overclaiming is worse than having no control, because a control described as
// stronger than it is stops anyone building the real one. Mason read "boundary"
// and reasonably concluded the surface was protected; it was not.
//
// THE RULE THIS ENFORCES
//   An absolute safety claim in guard source or in a user-facing refusal must
//   either cite what demonstrates it (@proven-by) or admit that nothing does
//   (@unproven). Silence is what produced all five.
//
// WHAT THIS IS NOT
//   This is a LINT OVER TEXT. It cannot tell whether a claim is true — only
//   whether someone stated a claim without saying what backs it. It will not
//   catch a guard that is wrong while saying nothing, and it is trivially
//   satisfied by writing `@proven-by` next to a lie. It raises the cost of
//   drifting by accident, which is how all five of the above happened. Stating
//   that plainly here is itself the rule this file exists to enforce.
//
// USAGE
//   node scripts/guard-claim-audit.mjs                 report + fail on NEW claims
//   node scripts/guard-claim-audit.mjs --report        report only, never fails
//   node scripts/guard-claim-audit.mjs --update-baseline   re-baseline deliberately

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(ROOT, "scripts", "guard-claim-audit.baseline.json");

// Absolute assertions about a control's own strength. Deliberately narrow:
// ordinary prose ("never edit an applied migration") is an instruction, not a
// claim about what the guard guarantees, and flagging it would bury the signal.
export const CLAIM_PATTERNS = [
  [/\bfails?[- ]closed\b/i, "fail-closed"],
  [/\bfails?[- ]open\b/i, "fail-open"],
  [/\bno agent (?:can|could|is able)\b/i, "no-agent-can"],
  [/\bagent shell cannot\b/i, "agent-cannot"],
  [/\bcannot be (?:bypassed|circumvented|disabled|forged|evaded|defeated)\b/i, "cannot-be-bypassed"],
  [/\bimpossible to (?:bypass|circumvent|disable|forge|evade)\b/i, "impossible"],
  [/\bguarantee(?:s|d)?\b/i, "guarantee"],
  [/\bonly a human\b/i, "human-only"],
  [/\bhuman[- ]only\b/i, "human-only"],
  [/\bboundary an agent cannot\b/i, "boundary"],
  [/\bnever (?:allows?|permits?)\b/i, "never-allows"],
  [/\balways (?:denies|blocks|refuses)\b/i, "always-denies"],
];

// An annotation anywhere in the claim's neighbourhood discharges it.
const ANNOTATION_RE = /@(?:proven-by|unproven|speed-bump)\b/i;
const NEIGHBOURHOOD = 3;   // lines either side

// A line that DENIES the property is the opposite of an overclaim — it is the
// correction we want people writing. "It is NOT a human-only gate" must not be
// reported as claiming to be one; flagging honesty would teach exactly the wrong
// lesson. Found immediately on first run against this repo's own correction text.
const NEGATION_RE = /\b(?:is|are|was|were)\s+(?:deliberately\s+)?not\b|\bnot\s+a\b|\bnever\s+claim|\bdoes\s+not\s+(?:guarantee|fail)|\bcannot\s+be\s+described\b|\bno\s+longer\b|\bmust\s+not\s+be\s+(?:described|called)\b/i;

/** Guard sources whose claims matter. Tests are excluded: an assertion IS proof. */
export function guardSourceFiles(root = ROOT) {
  const out = [];
  for (const dir of [path.join(root, ".claude", "hooks"), path.join(root, ".codex", "hooks")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".mjs")) continue;
      if (name.includes(".test.")) continue;
      out.push(path.join(dir, name));
    }
  }
  const unlock = path.join(root, "scripts", "guard-unlock.mjs");
  if (existsSync(unlock)) out.push(unlock);
  return out.sort();
}

/**
 * A claim is "user-facing" when it sits in a line that also looks like refusal
 * text an operator will read. Those are the ones that actually mislead someone —
 * Mason read a refusal message, not a source comment.
 */
function isUserFacing(line) {
  return /permissionDecisionReason|process\.stdout|process\.stderr|console\.(?:log|error)|^\s*["'`]|fail\(/.test(line);
}

/**
 * Reduce a source line to the prose it carries, so a phrase that WRAPPED across
 * two lines reads as one phrase. Leading comment markers go, the trailing `+` of
 * a concatenated refusal string goes, and quote characters become gaps — that is
 * what turns `"… fails " +` / `"closed."` into `… fails closed.`
 */
export function stripCommentSyntax(s) {
  return String(s)
    .replace(/^\s*(?:\/\/+|\/\*|\*\/|\*|#)\s?/, "")
    .replace(/\s*\+\s*$/, "")
    .replace(/["'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// How far BEFORE a matched claim a negation may sit and still be read as
// negating it. English puts the negation first ("does not fail closed", "is not
// a human-only gate"), so the window runs backwards from the match and includes
// the match itself.
const NEGATION_WINDOW = 30;

// How many source lines a single wrapped claim may span. Five covers every
// wrapped claim in this repo's guards with room to spare; the cap exists so a
// 200-line comment block does not turn the scan quadratic.
const WRAP_WINDOW = 5;

/**
 * The contiguous prose run starting at line `i`, joined into one string. A line
 * that strips to nothing — blank, or a bare `//` — ends the run, because that is
 * where one comment paragraph stops and the next begins.
 */
export function wrapWindow(flat, i) {
  const parts = [flat[i]];
  for (let j = i + 1; j < flat.length && parts.length < WRAP_WINDOW; j += 1) {
    if (!flat[j]) break;
    parts.push(flat[j]);
  }
  return parts.join(" ").trim();
}

export function scanFile(filePath, text) {
  const lines = text.split(/\r?\n/);
  const flat = lines.map(stripCommentSyntax);
  const found = [];
  lines.forEach((line, i) => {
    const single = flat[i];
    // WRAPPED CLAIMS. Reviewer P2: guard comments in this repo routinely break a
    // phrase across lines (`fails` / `closed`, `cannot be` / `bypassed`), and
    // scanning each line alone found nothing at all.
    //
    // A follow-up P2 showed a two-line join is not enough — `// This cannot` /
    // `// be` / `// bypassed.` still escaped, so any claim could be hidden simply
    // by wrapping it over three lines. The window now runs to the end of the
    // contiguous prose block (a blank or marker-only line ends it), capped so a
    // long comment cannot make this quadratic.
    const pair = wrapWindow(flat, i);
    for (const [re, kind] of CLAIM_PATTERNS) {
      let m = re.exec(single);
      if (!m && pair !== single) {
        const p = re.exec(pair);
        // Only a match that STARTS on this line is this line's finding. `pair`
        // begins with `single` verbatim, so a match the single-line pass missed
        // either spans the seam (report it here) or lies wholly in the next line
        // (that line reports it itself). Without this, every claim preceded by a
        // bare `//` was counted twice, the second copy carrying `//` as its text.
        if (p && p.index < single.length) m = p;
      }
      if (!m) continue;
      // NEGATION BOUND TO THE CLAIM. Reviewer P2: testing the whole line let any
      // unrelated disclaimer suppress a real claim — `FAIL-CLOSED … deliberately
      // NOT a destructive-verb list` reported zero, because the `NOT` belonged to
      // a different clause. Only a negation just before (or inside) the matched
      // phrase counts now.
      const subject = m.input;
      const window = subject.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index + m[0].length);
      if (NEGATION_RE.test(window)) continue;
      const from = Math.max(0, i - NEIGHBOURHOOD);
      const to = Math.min(lines.length, i + NEIGHBOURHOOD + 1);
      const annotated = lines.slice(from, to).some((l) => ANNOTATION_RE.test(l));
      found.push({
        file: path.relative(ROOT, filePath).replace(/\\/g, "/"),
        line: i + 1,
        kind,
        annotated,
        userFacing: isUserFacing(line),
        // Display is truncated; IDENTITY is not — see claimKey.
        text: line.trim().slice(0, 160),
        claim: subject,
      });
      break;   // one finding per line; the first pattern is enough
    }
  });
  return found;
}

/**
 * Baseline identity deliberately omits the line number, so moving code is not a
 * new claim.
 *
 * It uses the COMPLETE normalized claim text. Reviewer P2: the old key truncated
 * at 80 characters, so a grandfathered claim longer than that could be reworded
 * past character 80 and keep its key — the reworded claim then matched the
 * baseline and passed the ratchet, which directly contradicts the invariant that
 * rewording is new. `c.text` stays truncated for DISPLAY; identity never is.
 */
export function claimKey(c) {
  const full = (c.claim ?? c.text).replace(/\s+/g, " ").trim();
  return `${c.file}::${c.kind}::${full}`;
}

export function auditAll(root = ROOT) {
  return guardSourceFiles(root).flatMap((f) => scanFile(f, readFileSync(f, "utf8")));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const reportOnly = process.argv.includes("--report");
  const update = process.argv.includes("--update-baseline");
  const claims = auditAll();

  if (update) {
    const keys = [...new Set(claims.map(claimKey))].sort();
    writeFileSync(BASELINE, `${JSON.stringify({
      note: "Grandfathered guard claims as of the ratchet's introduction. A NEW claim must carry @proven-by, @unproven, or @speed-bump. Shrinking this list is the point; do not grow it without a reason. Re-baselined 2026-09-01 after four reviewer-reported scanner defects were fixed (truncated identity, whole-line negation, single-line-only scanning, and a two-line wrap window that a three-line claim still escaped): the identity now uses the complete claim text, so every key changed, and widening the wrap window changed it again for the handful of claims that actually wrap. Six entries are newly DETECTED rather than newly written — pre-existing claims in codex-push-lib, idempotency-body-check, migration-apply-lib, and production-action-guard that the old scanner could not see. The three the fixes surfaced in review-proof-guard.mjs were annotated instead of grandfathered.",
      claims: keys,
    }, null, 2)}\n`, "utf8");
    process.stdout.write(`Baseline written: ${keys.length} grandfathered claim(s).\n`);
    process.exit(0);
  }

  let baseline = { claims: [] };
  try { baseline = JSON.parse(readFileSync(BASELINE, "utf8")); } catch { /* first run */ }
  const known = new Set(baseline.claims || []);

  const unannotatedNew = claims.filter((c) => !c.annotated && !known.has(claimKey(c)));
  const grandfathered = claims.filter((c) => !c.annotated && known.has(claimKey(c)));
  const userFacingGrandfathered = grandfathered.filter((c) => c.userFacing);

  process.stdout.write(`\n── guard-claim audit ─────────────────────────────────────\n`);
  process.stdout.write(`  scanned            ${guardSourceFiles().length} guard source file(s)\n`);
  process.stdout.write(`  claims found       ${claims.length}\n`);
  process.stdout.write(`  annotated          ${claims.filter((c) => c.annotated).length}\n`);
  process.stdout.write(`  grandfathered      ${grandfathered.length}  (${userFacingGrandfathered.length} user-facing)\n`);
  process.stdout.write(`  NEW unannotated    ${unannotatedNew.length}\n\n`);

  if (userFacingGrandfathered.length) {
    process.stdout.write(`  User-facing grandfathered claims — these are what actually mislead an operator:\n`);
    for (const c of userFacingGrandfathered.slice(0, 12)) {
      process.stdout.write(`    ${c.file}:${c.line}  [${c.kind}]  ${c.text}\n`);
    }
    if (userFacingGrandfathered.length > 12) {
      process.stdout.write(`    … and ${userFacingGrandfathered.length - 12} more\n`);
    }
    process.stdout.write("\n");
  }

  if (unannotatedNew.length) {
    process.stdout.write(`  ❌ NEW absolute safety claims with nothing backing them:\n\n`);
    for (const c of unannotatedNew) {
      process.stdout.write(`    ${c.file}:${c.line}  [${c.kind}]\n      ${c.text}\n`);
    }
    process.stdout.write([
      "",
      "  Add ONE of these within 3 lines of the claim:",
      "    @proven-by <test name>   the suite demonstrates it",
      "    @speed-bump              it raises cost, it is not a boundary",
      "    @unproven                nothing demonstrates it (say why it stays)",
      "",
      "  Or soften the wording. Five guards overclaimed in one night and every",
      "  one of them would have passed a test suite; none said what backed it.",
      "",
    ].join("\n"));
    if (!reportOnly) process.exit(1);
  } else {
    process.stdout.write(`  ✅ no new unbacked safety claims.\n\n`);
  }
  process.exit(0);
}
