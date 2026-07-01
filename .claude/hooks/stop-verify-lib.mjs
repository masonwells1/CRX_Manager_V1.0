// Pure, side-effect-free helpers for stop-verify.mjs, so the proof-detection
// logic can be unit-tested (stop-verify-lib.test.mjs) without a live git repo,
// a session snapshot, or a real transcript on disk.

// A porcelain status line counts as a "watched code change" when it touches a
// .ts/.tsx/.sql/.mjs/.js file under src/, supabase/migrations/,
// supabase/functions/, or scripts/. (Same scope stop-verify has always used.)
const CODE_PATH_RE = /\.(ts|tsx|sql|mjs|js)\b/;
const WATCHED_DIR_RE = /\b(src|supabase\/migrations|supabase\/functions|scripts)\//;

export function isWatchedCodeChange(porcelainLine) {
  const line = String(porcelainLine || "").replace(/[\r\n]/g, "");
  if (line.length < 4) return false;
  const pathPart = line.slice(3);
  const norm = pathPart.replace(/\\/g, "/").replace(/^"|"$/g, "");
  return CODE_PATH_RE.test(norm) && WATCHED_DIR_RE.test(norm);
}

// Does the session transcript show that the change was actually RUN and OBSERVED
// in reality — not merely built/tested? Two ways to satisfy it:
//
//  1. An explicit PROOF block. The model states, in plain English, what it ran,
//     what it literally saw, and what it could NOT verify. This is the universal
//     escape valve: even when a thing can't be observed (a desktop icon on
//     Mason's machine), honestly naming that under "Not verified" satisfies the
//     gate — which is exactly the behavior Mason wants.
//     Match: "PROOF —", "PROOF -", "PROOF:", "PROOF Ran:".
//
//  2. Real end-state evidence tool calls recorded in the transcript: a browser
//     preview (screenshot/inspect/snapshot/...), a WebFetch, a fetch of the
//     live site, or a SQL query against the DB. These mean the model went and
//     looked at reality rather than trusting "tests pass".
//
// Note: "npm run build" / "npm run test" passing is deliberately NOT sufficient
// on its own — a self-written test can rubber-stamp the same misunderstanding
// that caused the bug. Wrap the test result in a PROOF block instead.
const PROOF_TOKEN_RE = /\bPROOF\b\s*(?:[—–\-:]|ran\b|saw\b)/i;

const EVIDENCE_RES = [
  /preview_(?:screenshot|snapshot|inspect|navigate|click|fill|logs|network|console|eval|start|resize)/i,
  /mcp__Claude_Preview__/i,
  /"name"\s*:\s*"WebFetch"/i,
  /croprxsolutions\.app/i,
  /execute_sql/i, // ran a query against the DB (e.g. a BEGIN;…;ROLLBACK smoke, or a SELECT of the mutated row)
];

export function hasVerificationEvidence(transcriptText) {
  const text = String(transcriptText || "");
  if (!text) return false;
  if (PROOF_TOKEN_RE.test(text)) return true;
  return EVIDENCE_RES.some((re) => re.test(text));
}

export { PROOF_TOKEN_RE, EVIDENCE_RES, CODE_PATH_RE, WATCHED_DIR_RE };
