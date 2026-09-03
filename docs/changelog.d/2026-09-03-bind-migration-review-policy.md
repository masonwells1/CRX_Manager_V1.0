## 2026-09-03 - Bind migration review proofs to active policy and checkout

Migration-apply proofs now authorize only the active worktree, never a sibling
checkout with matching SQL. The guard also verifies that the reviewer proof was
minted under the current protected `origin/main` reviewer-policy commit.

The proof producer reads reviewer charters from that protected commit and runs
review children from an empty temporary directory, so candidate `AGENTS.md`,
`CLAUDE.md`, and branch charter edits cannot supply reviewer instructions. It
also refuses to mint a proof for a migration whose `SECURITY DEFINER` functions
lack an explicit revoke from `anon`.
