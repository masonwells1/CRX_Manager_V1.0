## 2026-08-28 - Migration escape-string Unicode boundary

- Corrected the shared migration tokenizer so a non-ASCII PostgreSQL identifier ending in `E` cannot be mistaken for an `E'...'` escape string and hide transaction control from the atomic migration wrapper.

No production migration, live data, secret, or GitHub environment setting was changed.
