## 2026-10-23 — Remove app access to the unused `load_recipe_into_job` RPC (#1060 follow-up, Task B)

- Mason (2026-10-23, #1060 landing session): "Yes, remove access". New migration
  `20261023100000_revoke_load_recipe_into_job_app_access.sql` (row 982, NOT APPLIED) revokes EXECUTE on
  `load_recipe_into_job(uuid,uuid,text)` from PUBLIC, anon and authenticated. The function stays; postgres
  and service_role keep EXECUTE.
- Why: the RPC deletes every chemical line on a job before loading a recipe, which is why the app stopped
  calling it (Job Detail loads recipes client-side). A signed-in user could still call it directly.
- Caller check 2026-10-23: no app or Edge Function caller (only comments, generated types and a Sentry
  label); live, no function, view, policy or cron job references it.
- Access change on an existing object: applies only after Mason's in-chat `I approve`.
- `docs/reference/rpc-functions.md` notes the function is no longer app-callable.
