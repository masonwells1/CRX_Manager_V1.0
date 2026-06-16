# 🔴 PARKED-07 — `seed-admin` edge function is a latent unauthenticated admin-minting endpoint

**Severity:** HIGH · **Tier:** RED (needs MASON — production config + a redeploy/delete; I did NOT touch it).
Finding key: `edgefn:seed-admin:fail-open-admin-seed` · Nightly Debug cycle 6 (whole-app pass) · 2026-06-16

> This is the most important thing the whole-app audit found. Nothing here was changed or deployed —
> the fix requires **your** actions on the live project. Please action this first.

## What's exposed (verified live, project rhyzpcqhnizqbxphqdkr)
- `list_edge_functions` shows **`seed-admin` is deployed with `verify_jwt = false`** — the ONLY one of your
  7 functions with JWT verification off (all 6 others are `true`). So it is reachable with **no login**.
- Its only two gates (deployed v15 == disk, confirmed via `get_edge_function`):
  1. `if (ENVIRONMENT === 'production') return 403` — but **M4 is still OPEN**: it is NOT confirmed that
     `ENVIRONMENT=production` is actually set on the live project (TODO.md:22, CLAUDE.md owner items). If that
     secret is unset, this kill-switch is a **no-op**.
  2. A static, non-rotating `SEED_ADMIN_SECRET` header compared with a fast-exit `!==` (not constant-time).
- On success it calls `auth.admin.createUser({ user_metadata: { role: 'admin' }, email_confirm: true })`.
- **Verified end-to-end:** `handle_new_user` (the auth→profile trigger) does
  `COALESCE(NEW.raw_user_meta_data->>'role','sales_rep')` straight into `profiles.role` with **no allowlist** —
  so a seed-admin-minted user is a *fully functioning admin*, not a downgraded one. No RLS/trigger neutralizes it.

**Net worst case:** if `ENVIRONMENT` is unset on prod, anyone who learns/guesses `SEED_ADMIN_SECRET` can mint a
working admin and fully compromise the production ERP. Even with `ENVIRONMENT` set, the only barrier is one
dashboard-only secret with zero repo-level enforcement and a `verify_jwt` setting that diverges from every
sibling function.

## What YOU need to do (in order)
1. **Confirm `ENVIRONMENT=production` is set on the live Supabase project** (closes owner item M4). This is the
   single most important step — it makes gate #1 actually work.
2. **Redeploy `seed-admin` with `verify_jwt: true`, OR delete the function entirely** — the one-time admin seed
   is long done, so deleting it is the cleanest. (Both are deploy actions = your call; I will not deploy.)
3. *(defense-in-depth, optional)* Add a tracked `supabase/config.toml` pinning each function's `verify_jwt` so a
   future redeploy can't silently flip it (this also closes the related LOW finding
   `edgefn:config-toml:missing-verify-jwt-iac`).
4. *(defense-in-depth, optional)* Harden the code itself: make the gate **fail closed** and use a timing-safe
   secret compare — proposed below.

## Proposed code hardening (reference only — NOT applied, review before deploying)
In `supabase/functions/seed-admin/index.ts`, invert the environment gate to an allowlist so an *unset*
ENVIRONMENT fails CLOSED, and use a constant-time secret comparison:
```ts
// Fail CLOSED: only allow in an explicitly non-production environment.
const env = Deno.env.get('ENVIRONMENT') || Deno.env.get('DENO_ENV') || '';
if (env !== 'development' && env !== 'staging') {
  return new Response('Disabled', { status: 403 });
}
// Timing-safe secret compare (replace `provided !== expected`):
const enc = new TextEncoder();
const ok = provided.length === expected.length &&
  crypto.subtle.timingSafeEqual?.(enc.encode(provided), enc.encode(expected));
if (!ok) return new Response('Forbidden', { status: 403 });
```
Proposed `supabase/config.toml`:
```toml
[functions.seed-admin]
verify_jwt = true
# All other functions already default to verify_jwt = true.
# ⚠️ Do NOT pin verify_jwt = false here — that would re-expose the unauthenticated admin-mint
#    (Codex cross-review P1). If you DELETE seed-admin instead (recommended — the one-time seed
#    is done), omit this block entirely.
```

**Tell me how you want to proceed** (e.g. "delete seed-admin" or "harden + redeploy it") and I'll prepare the
exact steps — but the deploy/secret actions are yours to run.
