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

export function scanFile(filePath, text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    for (const [re, kind] of CLAIM_PATTERNS) {
      if (!re.test(line)) continue;
      if (NEGATION_RE.test(line)) continue;   // a denial of the property, not a claim to it
      const from = Math.max(0, i - NEIGHBOURHOOD);
      const to = Math.min(lines.length, i + NEIGHBOURHOOD + 1);
      const annotated = lines.slice(from, to).some((l) => ANNOTATION_RE.test(l));
      found.push({
        file: path.relative(ROOT, filePath).replace(/\\/g, "/"),
        line: i + 1,
        kind,
        annotated,
        userFacing: isUserFacing(line),
        text: line.trim().slice(0, 160),
      });
      break;   // one finding per line; the first pattern is enough
    }
  });
  return found;
}

/** Baseline identity deliberately omits the line number, so moving code is not a new claim. */
export function claimKey(c) {
  return `${c.file}::${c.kind}::${c.text.replace(/\s+/g, " ").slice(0, 80)}`;
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
      note: "Grandfathered guard claims as of the ratchet's introduction. A NEW claim must carry @proven-by, @unproven, or @speed-bump. Shrinking this list is the point; do not grow it without a reason.",
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
