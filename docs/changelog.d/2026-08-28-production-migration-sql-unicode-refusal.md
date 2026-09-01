## 2026-08-28 - Production migration SQL Unicode refusal

- Made the metadata-only production migration lane reject non-ASCII SQL before tokenization. This deliberately conservative boundary prevents Unicode dollar-quote syntax from concealing destructive commands while retaining the normal reviewed migration path for work outside this narrow automated channel.

No production migration, live data, secret, or GitHub environment setting was changed.
