## 2026-09-03 — Actor refusal rejects pre-check runtime search-path changes

Exact-SHA review reproduced a forged-actor path where a routine declared a
safe `search_path`, then executed `SET search_path = evil, pg_catalog` inside
its body before comparing the caller-supplied actor with `auth.uid()`. A
malicious UUID equality operator could make the apparent refusal always pass.

The guard now fails closed when executable `SET [LOCAL|SESSION] search_path`,
quoted `SET "search_path"`, `RESET search_path`, or `RESET ALL` appears before
the recognized top-level actor refusal. Changes after the refusal and unrelated
`SET` statements remain compatible.

The exact operator exploit and body-level SET/RESET variants failed before the
repair and pass afterward. Disabling only the new pre-refusal detector makes
the exploit fail again; the restored focused suite passes 541 assertions. This
bounded check does not widen the broader actor-analysis cap.
