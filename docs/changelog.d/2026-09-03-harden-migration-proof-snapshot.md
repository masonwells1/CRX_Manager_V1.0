## 2026-09-03 - Harden the migration-proof evidence snapshot

The migration-proof producer now captures a validated, immutable in-memory snapshot before it
builds reviewer prompts. Every captured input must be a regular path inside the checkout;
symbolic links, reparse points, unsupported filesystem entries, path escapes, and invalid
migration basenames stop the review before any file content reaches a reviewer.

The proof hash is computed from that exact snapshot using length-framed path, presence, and byte
records. A second validated capture must match before reviewers start and after they finish, so a
working-tree change cannot make a proof claim a different evidence set from the bytes the reviewers
actually received.
