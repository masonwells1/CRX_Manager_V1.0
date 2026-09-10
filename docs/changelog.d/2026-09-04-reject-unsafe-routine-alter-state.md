## 2026-09-04 - Reject unsafe routine ALTER state in migration proof gate

The SECURITY DEFINER migration-proof scanner now rejects every routine configuration alteration
except the canonical `SET search_path = public, pg_temp` form. It also matches PostgreSQL function
overloads using input-capable parameters only, so an output-only parameter cannot make an execute
revoke appear to apply to the wrong function. The RLS reviewer instruction now evaluates the final
effective configuration for altered SECURITY DEFINER routines.
