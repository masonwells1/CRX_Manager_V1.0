## 2026-09-08 — PR #605: `gh` is a namespace (read verbs only); Corepack and versioned descriptors count as package-manager writes

GitHub Codex (two P1s on `c94e16dc7`, both on `review-proof-guard.mjs`, both probe-confirmed):

1. **`gh` clone subcommands reached protected directories.** `gh` sat whole in the read-only
   command set, so `gh gist clone deadbeef .claude/skills/probe` and `gh repo clone owner/repo
   .claude/skills/probe` were silent although they materialise files at the named directory;
   `gh run download --dir`, `gh release download --dir` and `gh repo fork --clone` write too.
   Fix by class: `gh` is a namespace. `ghIsReadOnly()` skips value-taking global options,
   reads the command and verb, and vouches only for read verbs (view, list, status, checks,
   diff, watch, browse, search) or read-only commands (`api`, `search`, `status`, `browse`,
   `auth status`, `help`); any other verb, known or not, is a writer of the paths it names
   and denies when one is on the enforcement surface. Eight deny and seven allow cases.
2. **`corepack use pnpm@latest` rewrote the manifest unseen.** The package-manager scanner
   matched exact `npm`/`pnpm`/`yarn`/`bun` tokens, so the descriptor `pnpm@latest` was not a
   manager and `corepack` was not known at all, although `corepack use` assigns the release to
   `package.json` and installs. Fix by class: a versioned descriptor is the manager it names
   (`PACKAGE_MANAGER_RE` accepts `@<spec>`, the classifier strips it), `corepack use`/`corepack
   up` are manifest writers, `enable`/`disable`/`prepare`/`hydrate`/`pack`/`cache`/`install`
   are not, and an unknown Corepack subcommand is refused. Eight deny and six allow cases.

The previous hook, swapped in place, stays silent on `gh gist clone deadbeef .claude/skills/probe`
and on `corepack use pnpm@latest` and fails the new tests.
