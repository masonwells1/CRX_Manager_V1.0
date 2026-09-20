## 2026-09-19 — Codex reviewer sandbox rebuilt for Codex CLI 0.155

**What broke.** The Codex desktop app auto-updated its CLI to 0.155.0-alpha.9.2 on
2026-09-19. Its elevated Windows sandbox refuses the reviewer's `":root" = "deny"`
permission profile ("elevated Windows sandbox requires effective `:root` read access"),
so `scripts/write-codex-push-proof.mjs` and `scripts/write-apply-proofs.mjs` failed in
about a second without reviewing anything. That failure printed as "no clean verdict",
which reads like findings but is a startup error.

**What we learned.** Codex 0.153.4 ran the same deny-root profile but silently fell back
to plain `sandbox: read-only`: in a canary run its sandboxed commands could read
`~/.codex/auth.json`, sibling temp files, and `C:\FarmRx`. The packet-only read scope
was never really in force. Codex 0.155 now enforces reads with persistent deny ACEs on
the named paths. Windows copies each ACE onto every file beneath it, and every sandboxed
Codex session on the machine shares them. A deny on a large tree (a repo root,
`C:\Users`, a whole drive) runs for hours and breaks Codex's normal work inside that
tree. An interrupted probe left orphaned deny ACEs on `C:\CRX_Manager` and seven other
top-level folders, which also stopped ordinary `codex exec --sandbox read-only` reviews
from reading the repo. Those ACEs were removed with
`icacls <dir> /remove:d CodexSandboxUsers`.

**Change.** The reviewer profile is now `":root" = "read"` plus explicit deny-read
entries, with writes and network still denied. The entries are discovered by shape each
run (`codexReviewDenyReadPaths`):
- home credential stores: `.codex/auth.json`, `.ssh`, `.supabase`, `.docker`, `.aws`,
  `.azure`, `.config/gh`, `.git-credentials`, `.netrc`, `.npmrc`, `.pgpass`;
- every `.env` or `.env.*` file (except `*.example`, `*.sample`, and `*.template`) one
  level below the system drive root, and in each worktree of the repo under review.

On this machine that is 11 small paths, computed in about 0.1 s.

**Proof.** A canary run through the real `buildCodexExecArgs` on Codex 0.155 finished in
38 s. The packet and `C:\CRX_Manager\package.json` were readable. Codex's
`auth.json`, the `.env` files for CRX, FarmRx, and paperless, and `~/.ssh` and
`~/.supabase` were denied. Writes to the packet and the repo were denied, and network was
blocked. `node scripts/write-codex-push-proof.test.mjs` and
`node scripts/write-apply-proofs.test.mjs` pass.

**Residual risk, not verified away.** The reviewer can read ordinary files that any
local Windows account can read. That includes source in other repos and any secret
stored under a name other than the shapes above. D: and G: are not scanned. Network stays
off, so anything read can leave only through the review text, which goes to OpenAI and
the local capture (secret-shaped values are redacted).
