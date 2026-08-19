// Shared line-ending normalizer for the agent-workflow mirror checks.
//
// scripts/agent-health-check.mjs and scripts/sync-agent-workflows.mjs both
// compare the .claude sources against their generated .agents mirrors, and they
// have to agree on what "in sync" means. Between 2026-07-16 and 2026-08-19 they
// did not, so one commit could FAIL one check and PASS the other. Both import
// this one definition so they cannot diverge again; the full history is in the
// 2026-08-19 entry of docs/CHANGELOG.md.
//
// Deliberately narrow: CRLF becomes LF and nothing else does. A lone CR, a BOM,
// or a trailing-newline difference is still reported as drift. This fails
// closed - it can turn a real difference into a false alarm, never a real
// difference into a false pass.
export function normalizeEol(text) {
  if (typeof text !== "string") {
    throw new TypeError(`normalizeEol expects a string, received ${typeof text}`);
  }
  return text.replace(/\r\n/g, "\n");
}
