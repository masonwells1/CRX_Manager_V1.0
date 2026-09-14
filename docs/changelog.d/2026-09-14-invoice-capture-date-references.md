## 2026-09-14 - Correct invoice ledger-capture date references

Claude's verified exact-head review of2443913336cb6286b9e40ea3ef5340a71b6c094b
cleared the code/migrations and returned only two LOW stale capture references.
Point the current-state link and the superseded September8 ledger block at the
actual September14 current capture, and align the current-state historical header
to that same date. Preserve dated historical publications and every SQL byte.

Documentation drift checks remain required. Sol's1200-second review timed out
without a verdict or proof; this is not clearance or tool-unavailability evidence.
The corrected commit requires fresh full Claude CLI and canonical Sol/high review
with the supported longer2400-second limit, then all protected delivery and actual
exact-head CodeRabbit APPROVED gates. No live migration apply or data changes.
