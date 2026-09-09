## 2026-09-06 — PR #605 round two: package-manager commands can no longer rewrite package.json unseen

CodeRabbit review `5126628334` on `18d1bee17` (Major, Security): `.claude/hooks/review-proof-guard.mjs`
protects `package.json` as an enforcement surface, but only against commands that NAME it. `npm install
left-pad`, `npm uninstall`, `npm pkg set` and `npm version patch` all rewrite the file without the name
ever appearing on the command line — the hook's own comment recorded that gap, and
`review-proof-guard.test.mjs` pinned `npm install left-pad` as an ALLOW. Probe-confirmed: every one of
those was exit 0 / silent before this change.

### Fix — matched by shape, not by spelling

A new rule in the same hook denies any package-manager invocation whose subcommand FAMILY writes the
manifest, for `npm`, `pnpm`, `yarn` and `bun` alike (path-qualified, `.cmd`, behind `corepack`, after
a `VAR=value` prefix, or after `cd … &&`):

| denied | why |
| --- | --- |
| `<pm> install\|i\|add\|link <package>` | adds a dependency |
| `<pm> uninstall\|remove\|rm\|un\|unlink …` | always rewrites the manifest |
| `<pm> update\|up\|upgrade …` | npm ≥ 7 saves the new ranges |
| `<pm> pkg set\|delete\|fix`, `<pm> init`, `<pm> set-script`, `<pm> version <bump>` | direct manifest edits |

Still silent: installing FROM the manifest (`npm install`, `npm ci`, `pnpm install`, `yarn`,
`bun install`), `--no-save`, `-g` / `--global`, `npm run`, `npm test`, `npm pkg get`, bare
`npm version` (prints), `npx`. A dependency is added deliberately through Edit/Write on
`package.json`, where the `ask` tier in `.claude/settings.json` decides — the same door every other
protected file already uses.

Known over-blocks, accepted on this file's standing rule that a false refusal is the cheaper failure:
a value-taking flag before the package name (`--registry <url>`) reads as a positional; bare
`pnpm update` / `yarn upgrade` are refused even where only the lockfile would change.

### Proof

- New test: `.claude/hooks/review-proof-guard.test.mjs` — 35 shell deny cases (all four managers,
  aliases, `corepack`, env prefix, `cd &&`, quoted package, PowerShell) plus 16 allow cases for the
  from-manifest and `--no-save` / `-g` forms.
- Backwards: the new test against the OLD hook fails at `must deny: npm install left-pad` (exit 1);
  against the new hook it passes (exit 0).

No `.claude/settings.json` change; no new prompts.
