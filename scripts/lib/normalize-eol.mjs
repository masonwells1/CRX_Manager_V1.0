// Shared line-ending normalizer for the agent-workflow mirror checks.
//
// The generator and the health check MUST agree on what "in sync" means, and
// they did not. sync-agent-workflows.mjs normalized CRLF to LF before
// comparing; agent-health-check.mjs compared raw bytes. On a checkout where a
// non-git writer had smudged .claude/skills to CRLF while .agents stayed LF,
// one commit produced opposite verdicts in the same run - agent-health FAILed
// the mirror while the generator reported all files already in sync. Two
// reviewers on the same commit of PR 414 got opposite results that way.
//
// The smudge is also self-healing-proof: .gitattributes pins both trees to
// eol=lf, so git hashes them EOL-normalized. The smudged file never shows as
// modified and a checkout never repairs it.
//
// Line endings are not content drift for these LF-pinned paths - the committed
// form is LF either way. Both callers import this one function so the two
// definitions of "in sync" cannot drift apart again.
export const normalizeEol = (text) => String(text).replace(/\r\n/g, "\n");
