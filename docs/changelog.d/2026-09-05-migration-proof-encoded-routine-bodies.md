## 2026-09-05 - Migration proof encoded routine bodies

- Refused source-only migration proof for `E'…'` and `U&'…'` function or procedure bodies. PostgreSQL can decode those forms into executable statements, so treating their encoded spelling as harmless could conceal an owner-privileged `search_path` change.
