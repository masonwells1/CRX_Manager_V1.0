## 2026-09-03 - Bind migration-review proof evidence to the apply guard

Migration-review proofs now carry a deterministic `evidenceHash` over the complete
repository input surface shown to the reviewer: reviewer charters, schema registry,
applied-migration ledger, migration history, SQL declarations/callers, production TypeScript
callers, and the proof-wrapper source. The migration apply guard recomputes that fingerprint
before accepting a reviewer proof in either interactive or hands-free mode, and also requires it
on the hands-free Sol/high proof.

The correction-guard CI suite now executes the focused proof-evidence tests. Guard mutation tests
cover a wrong reviewer hash, a wrong Sol hash, and a source caller added after review; each must
deny while a known-good fixture remains allowed.
