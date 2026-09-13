## 2026-09-09 - the fingerprint generator now validates everything it writes into the guard

Found by the automated commit security review on `d1ea521c4`, and it is a direct
consequence of the previous change rather than an unrelated nit.

Moving the authorised hashes inside `.claude/hooks/live-testdata-lib.mjs` closed
the bypass where a writable manifest could be edited to authorise arbitrary SQL.
But it also made `write-predicate-fingerprints.mjs` a **code generator that
writes JavaScript into the enforcement surface** — and it was interpolating
predicate filenames into that JavaScript without validating them:

```js
const lines = predicates.map((p) => `  "${p.sha256}", // ${p.file}`);
```

A predicate named `x\n  "<hash>", // y.sql` closes the trailing comment and
injects a line into the authorised Set. That is code injection into the guard,
reached by creating a file rather than by editing a protected one — which is the
same shape as the bypass just fixed, one level up.

It is not exploitable on this machine, because Windows forbids newlines in
filenames. That is an accident of platform, not a control, and the repository is
checked out on other systems.

**The generator now refuses to interpolate anything it has not validated:**
filenames must match `^[A-Za-z0-9._-]+$` and fingerprints `^[0-9a-f]{64}$`, or it
throws rather than writing. Both are far narrower than the shapes that would be
dangerous, which is the right side to err on for a generator aimed at a security
file.

**Proof.** Eight new assertions drive `renderRegion` with the newline-injection
payload, a lone carriage return, a path traversal, and quote/backtick/`${}`
characters, and require it to throw on each — plus a malformed fingerprint, plus
a control asserting the 29 real filenames still pass.
`predicate-fingerprints.test.mjs` 176 → 184; full
`npm run test:correction-guards` green; regenerating produces no change, so the
authorised hashes are untouched.

**Worth recording:** the previous change was correct and this is what it cost. A
standing allowance belongs inside the protected surface — but moving it there
turned a data file into generated code, and generated code aimed at a security
boundary has to treat its inputs as hostile. The fix for one class of problem
created the preconditions for another, and only looking again caught it.
