## 2026-09-08 — PR #605: NTFS stream and device-prefix aliases are non-canonical spellings

Codex (`gpt-5.6-sol`, exact-SHA proof on `d1bbf5ac6`) High, probe-confirmed: the canonical-spelling
rule did not know NTFS alternate data streams, so `package.json::$DATA`, `.claude/settings.json::$DATA`
and `scripts/write-codex-push-proof.mjs::$DATA` passed every native editor although each opens the
real file; `env-guard`'s `.env` rule judged the raw spelling, so `.env `, `C:.env` and `.env::$DATA`
passed too.

Fix by class: both review-proof-guard resolvers and autopilot-lib's `canonicalToolPath()` cut every
segment at its first colon (the rooted drive `C:` is the one colon kept) and drop a `\\?\` / `\\.\`
device prefix in front of a drive; `env-guard` now imports `canonicalToolPath()` and judges the
canonical path (trailing period/space, drive-relative prefix and stream suffix all fold onto `.env`).
Over-inclusive for a POSIX file name that contains a colon; for a deny-guard that can only over-block.

Proof: eight deny cases (MultiEdit/Edit/Write/NotebookEdit stream forms, a device-prefixed rooted
path, an MCP path field, a shell redirect) and one allow case in `review-proof-guard.test.mjs`; five
armed cases in `autopilot-lib.test.mjs`; the parity test adds `::$DATA` to every protected sample; five
env-guard cases in `content-guards-multiedit.test.mjs`. The previous hook and env-guard, swapped in place,
are silent on the payloads and fail the new suites. The previous autopilot-lib already denied these
spellings through its raw-spelling match (`/.claude/hooks/` is a prefix of the alias), so its change is
alignment of the canonical form, which env-guard now imports, not a closed bypass.
