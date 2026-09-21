## 2026-09-21 — the one Sol pass on the review-tier change found 4 real defects in the Luna harness

Continues `2026-09-20-review-tier-luna-round3-fixes.md`. The merge gate classified
`scripts/overnight-codex-gate.mjs` as risky and required the single end-of-run `gpt-5.6-sol`/high
proof, exactly as the new policy prescribes. Sol returned `CODEX_PROOF_VERDICT: BLOCKERS` with four
findings in `.claude/skills/codex-review/SKILL.md` Step 3A. All four were verified real and fixed.

- **Git text-conversion helpers still ran outside the sandbox** (HIGH). `--no-ext-diff` does not
  disable `textconv`; only `--no-textconv` does. Proven with a planted helper in a scratch repo: it
  executed under the old flags and does not under the new ones. All `diff`/`show` calls now pass both.
- **A failed or timed-out run could pass validation** (HIGH). The Codex exit status was printed and
  never checked. It is now captured immediately (`CODEX_RC`) and must be `0`.
- **The validation grepped a transcript that echoes the prompt** (HIGH — worse than reported). The
  prompt itself contains the tail canary and example `LUNA_REVIEW:` lines, so the canary and
  terminator checks could pass on the echo alone, and two contradicting verdicts were accepted. The
  run now uses `codex exec -o` to capture the reviewer's **final message only**, and validation
  requires exactly one `LUNA_REVIEW:` line that is the last non-blank line and well-formed.
- **The prompt asked for the header canary while the check demanded the tail one** (MED), so a
  compliant review failed closed. The prompt now asks for the tail canary.

**Proof:** the exact Step 3A blocks were extracted from the skill file by script (not retyped) and
run live on Luna against commit `75b62ea17`: exit 0, tail canary echoed, `run validated; verdict:
LUNA_REVIEW: CLEAN` (32,937 tokens). The validator was then fed 11 crafted cases: both good cases
(including CRLF line endings) pass; all 9 bad cases — exit 124, exit 1, no final message, missing
canary, header-canary-only, two verdicts, verdict not last, `NO_DIFF`, malformed verdict — are
rejected with the correct reason. Guard files and `write-codex-push-proof.mjs` remain untouched.
