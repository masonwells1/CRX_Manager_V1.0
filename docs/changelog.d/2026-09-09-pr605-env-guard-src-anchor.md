## 2026-09-09 — PR #605: env-guard scoped on a `/src/` substring, so a repo-relative MultiEdit skipped the service_role scan

Codex (`gpt-5.6-sol`, exact-SHA review of `4c869416a`) High: `env-guard.mjs` tested `filePath.includes("/src/")`.
A repo-relative path — `src/lib/x.ts`, which is what a `MultiEdit` ordinarily sends, and which this PR makes
auto-accepted — has no leading slash, so it never matched, `isFrontendFile` stayed false, and the service_role /
JWT-literal scan was skipped entirely. Only an absolute or nested spelling (`C:/repo/src/…`) was ever in scope.

Fix: the predicate is anchored to a segment boundary, `/(?:^|\/)src\//`, the same change the eight other content
guards received in the previous commit. env-guard was missed there because it already canonicalised its path and so
did not share their scope line.

Proof, real hook, previous version swapped in place and restored sha-verified: `MultiEdit src/lib/secrets.ts`
introducing `import.meta.env.SUPABASE_SERVICE_ROLE_KEY` and `Write src/lib/secrets.ts` with a `'service_role'`
literal both returned **allow** on the committed hook and **deny** after the fix; the absolute spelling denied in
both, confirming the gap was the anchor and not the scan. Five cases pinned in
`content-guards-multiedit.test.mjs` (two MultiEdit/Write denies, one Edit deny, one anon-key allow, and
`docs/src-notes.md` staying out of scope). `test:correction-guards` and `lint` green.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
