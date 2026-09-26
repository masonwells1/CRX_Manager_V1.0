## 2026-09-23 - soft_delete_customer_document: PR #775 review fixes

CodeRabbit (CHANGES_REQUESTED): one Major, two Minor, all valid. No migration SQL changed.

- **(Major) Every proof fixture used a storage path that a prerequisite will forbid.** The parked
  `20260914100700` adds `customer_documents_storage_path_shape_check`, which requires
  `<customer uuid>/<document uuid>-<safe name>` and a safe name starting `[A-Za-z0-9_-]`. The
  prover's fixtures and the registered chain wrote `<customer uuid>/[SMOKE]-mine.pdf`: no document
  uuid and a leading `[`. Those inserts pass today only because the prover SKIPS that migration,
  and `20260914100700` applies **before** this candidate is allowed to — so the registered chain
  would have started failing at setup exactly when it was needed. All fixtures now go through one
  `docStoragePath()` helper in the server-issued shape, and the chain composes
  `v_customer || '/' || v_doc || '-SMOKE-...'`. The `[SMOKE]` marker stays in `filename`, which
  carries no constraint and is what the leftover-row check matches.

  The skip-soundness guard did not catch this because it only asked whether the skipped file
  changes the table's policies, triggers, ownership, forced RLS or grants — never whether it
  CONSTRAINS a column the fixtures write. New `assertFixturePathsSurviveParkedShapeCheck()` reads
  the constraint's regex out of that migration (never a copy), requires every fixture path to
  satisfy it, requires the regex to REJECT the two shapes this repo actually got wrong, and pins
  the chain's SQL path composition so it cannot drift back.

- **(Minor) `docs/reference/migration-history.md` named the wrong prerequisite rows.** It said row
  936 applies after "rows 935, 928 and 921's successors". Row 921 is the superseded
  document-writer entry with no file, and following its successor leads to `20260914100500`, which
  is already applied — a reader would never find `20260914100900`. It now names row 935
  (`20260914100700`), row 928 (`20260914100800`) and row 915 (`20260914100900`) directly, and says
  row 921 is not a prerequisite. Apply order is load-bearing here.

- **(Minor) The skip count was stale in three records.** The prover skips three parked files, not
  two: `20260914100700` joined `100800` and `100900` once #764's restamp landed on disk. The RPC
  entry, the Opus-review entry and the PR #767 entry now say three and name them.

Proof: the prover re-ran end to end to `CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS` with the
reshaped fixtures, the new path-shape assertions, the registered chain, and both mutation tests.
