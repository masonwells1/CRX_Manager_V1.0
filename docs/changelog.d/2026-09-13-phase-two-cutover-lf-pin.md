## 2026-09-13 - Pending #652 phase-two cutover LF pin

Agree with current-head GitHub Codex P2 `3998769135` on `7a0ed406b1`:
the new phase-two migration also pins its installed function body by MD5 and
needs the same explicit LF checkout rule as the related guard migrations.
Add its path to `.gitattributes` as `text eol=lf`. No SQL/body/signature/ACL,
money, frontend or business behavior changes; all migrations remain unapplied.

Observed metadata check: before the correction, `git -c core.autocrlf=true
check-attr text eol` reported both attributes unspecified. Afterward it reports
text set and eol lf. The SQL raw SHA-256 remains
`b6d05012f33b6567564c8e5b5337bf6f5af40b400a70fb20cb8486045c9c39b6`;
the executed normalized PostgreSQL proof therefore retains identical SQL inputs.
Focused indexed migration-history checks and docs checks must pass before commit.
After midnight the docs gate required today's scoped verification. Read-only live
ledger and invoice/job function contracts were re-read September 13; counts/pins
are unchanged and all three guard migrations remain unapplied. Renew only the
explicitly scoped manual/header notes, preserving historical dates and the
September 12 structural registry capture; do not imply a global recertification.
Fresh final-main-base exact-head Sol/high proof, normal protected push,
new-head CI and actual CodeRabbit review still bind publication/closeout.
No merge or live apply is authorized. Before live apply, refresh pins/proofs;
rollback of this metadata-only change is a normal reviewed attribute reversal,
which reintroduces the Windows cold-rebuild refusal and is not recommended.
