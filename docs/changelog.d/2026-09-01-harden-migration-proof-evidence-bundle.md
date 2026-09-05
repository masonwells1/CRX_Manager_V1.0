## 2026-09-01 - Harden the migration-proof evidence bundle after an exact-head Codex review

The exact-head `gpt-5.6-sol` review of PR #544 found that the reviewer child was receiving an
incomplete evidence bundle. The findings were real and are fixed here.

### HIGH - incomplete security evidence could produce a false clean review

The bundle embedded only the grants **declared in the migration under review**, omitted frontend
RPC callers and non-status CHECK values, and kept only the first caller found in each migration
file. It also missed functions declared without an explicit `public.` prefix. Because the reviewer
charter forbids looking anywhere else, a reviewer could see a partial caller list presented as if
complete, or skip an endpoint / constraint check for lack of evidence.

- Every caller across every migration is now embedded, including callers later in the migration
  being reviewed. Silent truncation is the defect: it reads to the reviewer as "these are all the
  callers".
- Public functions declared either with or without `public.` are discovered. Their matching
  `src/` RPC callers are embedded as well.
- The registry slice includes relevant `check_constraints` entries alongside columns and status
  values, so drift review can evaluate non-status CHECK constraints.
- The grants section now states plainly that it shows the migration's own DDL and **not** the
  effective live ACL, that earlier migrations may have granted or revoked EXECUTE, and that a
  check turning on the effective grant must report BLOCKERS rather than infer the live posture.

### HIGH - review evidence was untrusted, mutable, and unbound to the proof

Only the migration itself was labelled untrusted, while the registry, ledger,
migration-history rows, prior declarations, TypeScript declarations and call-site excerpts
were injected as ordinary prompt text. All of those are candidate-controlled repository
content and can contain sentences addressed to the model. Separately, the bundle was rebuilt
for each reviewer and only the migration hash was re-checked afterwards, so two charters
could judge different inputs.

- Every embedded section is now explicitly marked untrusted, with instructions never to
  follow directives found inside any of them.
- The bundle is built **once**, hashed with SHA-256, and the identical string is passed to
  every reviewer.
- After the last review the bundle is rebuilt and compared; a mismatch mints nothing and says
  which sources moved.
- `evidenceHash` is a deterministic fingerprint of the repository evidence and proof-producer
  inputs: the schema registry, migration history, applied-migration ledger, all migration
  declarations/callers, production TypeScript RPC callers, and the relevant proof-wrapper source.
  The protected reviewer charters are pinned separately by `reviewerPolicyCommit`; wrapper source
  is integrity-bound but is not itself reviewer-packet text. The hash is recorded in both proof
  files and recomputed by the apply guard before it accepts either proof, so an input change
  invalidates the verdict instead of silently reusing it.

### Note

The proof wrapper now has a `--print-evidence` mode and focused tests that exercise the real
return-credit chain, an unqualified RPC declaration with frontend callers, and multiple same-file
callers. That suite now runs inside `test:correction-guards`, the CI correction-guard job. These
defects were found by independent review, not self-certification.
