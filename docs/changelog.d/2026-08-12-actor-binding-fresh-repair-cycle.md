## 2026-08-12 — Actor-binding fresh repair cycle: pre-guard exits, quoted qualifier rebinding, operator aliases, and COPY PROGRAM sinks

Actor-binding fresh repair cycle: fixed pre-guard exits, quoted qualifier rebinding, operator aliases, and COPY PROGRAM sinks; full local gate passed; final exact-head review found a HIGH cron.job identity-change bypass, so the branch and PR publication were parked without push, merge, migration apply, or production change.

- **Commits this session** (git log origin/main..HEAD):
  - `bf629bd6 docs(handoff): park cron identity blocker`
  - `6b835feb fix(hooks): close alternate SQL sinks`
  - `bd1466f6 fix(hooks): reject quoted actor rebinding`
  - `7820126c docs(migrations): record actor guard exemptions`
  - `b57b27b8 Merge remote-tracking branch 'origin/main' into codex/actor-binding-mixed-notation-repair-20260810`
  - `881a6267 fix(hooks): reject pre-guard actor exits`
  - `55914011 Merge remote-tracking branch 'origin/codex/harden-actor-binding-sql-reader' into codex/actor-binding-mixed-notation-repair-20260810`
  - `cfdbc59d fix(hooks): reject qualified actor rebinding`
  - `d9af7b24 Merge branch 'main' into codex/harden-actor-binding-sql-reader`
  - `83ef1847 fix(hooks): fail closed on renamed cron command views`
  - `1dfc4792 Merge remote-tracking branch 'origin/main' into codex/actor-binding-mixed-notation-repair-20260810`
  - `480cbc4b fix(hooks): harden legacy actor refusal guards`
  - `3055ddf6 Merge remote-tracking branch 'origin/main' into codex/actor-binding-mixed-notation-repair-20260810`
  - `03d96fd5 Merge remote-tracking branch 'origin/main' into codex/actor-binding-mixed-notation-repair-20260810`
  - `075a1d47 fix(hooks): ignore quoted control keywords`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260812030000_reject_non_finite_money_and_quantities.sql`
  - `supabase/migrations/20260812050000_guard_job_commission_split_immutable.sql`
  - `supabase/migrations/20260812060000_require_completed_delivery_before_invoice_post.sql`
