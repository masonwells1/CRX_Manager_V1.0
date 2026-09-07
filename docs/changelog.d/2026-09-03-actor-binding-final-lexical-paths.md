## 2026-09-03 — Actor guard closes three exact-review lexical paths

Exact-SHA review reproduced three remaining fail-open spellings: quoted
CREATE-level `"search_path"` and `SET search_path FROM CURRENT`, an adjacent
`UPDATE"cron"."job"SET"command"=...` write, and migration paths containing
`.`/`..` or duplicate separators that still resolve under
`supabase/migrations/`.

The guard now fails closed on inherited CREATE search paths, includes quoted
CREATE-level search-path attributes, accepts adjacent quoted target/keyword
boundaries for cron command writes, and normalizes the candidate file path
before applying the migration-directory scope check.

Each exact payload failed before its repair and failed again when that repair
alone was disabled. The restored focused suite passes 550 assertions. These
are bounded lexical and path-identity repairs; the broader actor-analysis cap
is unchanged.
