## 2026-08-12 — Actor-binding PR review closes final-mode and cron rewrite gaps

Fresh GitHub review of exact head `e652f723` raised six follow-ups. Direct hook
reproduction showed three pg_cron rename/view reports were already denied, while
two HIGH findings and one false-positive report were valid: `ALTER FUNCTION ...
SECURITY DEFINER` could elevate an unbound invoker routine after its readable
definition, `ALTER TABLE cron.job ALTER COLUMN command ... USING` could rewrite
stored delayed SQL, and complete declarative EXECUTE privilege forms beyond
`ON FUNCTION` were incorrectly refused. The guard now evaluates the final
same-file SECURITY DEFINER/INVOKER mode, fails closed when an elevated existing
routine body is unavailable, rejects command-column type rewrites, and accepts
the complete routine privilege heads while still rejecting a second EXECUTE
token. Overload matching is bound to normalized identity argument types so one
readable function cannot hide a different same-named routine. Ten focused
assertions cover unsafe and safe controls; the full hook suite now passes 359
assertions.

