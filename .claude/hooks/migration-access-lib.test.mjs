// Tests for migration-access-lib.mjs — Mason's 2026-09-26 permissions line:
// routine lock-down on objects the migration creates applies by itself;
// anything that widens access or changes existing access is his.
import assert from "node:assert/strict";
import { accessChangeCheck } from "./migration-access-lib.mjs";

let pass = 0;
const routine = (sql, message) => {
  const verdict = accessChangeCheck(sql);
  assert.equal(verdict.changesAccess, false, `${message} — expected ROUTINE, got: ${verdict.reason}`);
  pass++;
};
const masons = (sql, fragment, message) => {
  const verdict = accessChangeCheck(sql);
  assert.equal(verdict.changesAccess, true, `${message} — expected MASON'S`);
  assert.ok(String(verdict.reason).includes(fragment), `${message} — reason ${JSON.stringify(verdict.reason)} lacks ${JSON.stringify(fragment)}`);
  pass++;
};

const NEW_FN = `CREATE OR REPLACE FUNCTION public.save_widget(p_id uuid, p_name text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- grant nothing here; this body never runs at apply time
  EXECUTE 'GRANT ALL ON public.customers TO anon';
  RETURN '{}'::jsonb;
END $$;`;
const NEW_TABLE = "CREATE TABLE public.widgets (id bigserial PRIMARY KEY, owner uuid REFERENCES auth.users(id), name text);";

// ── routine: lock-down on objects this migration creates ──────────────────────
routine(`${NEW_FN}
REVOKE ALL ON FUNCTION public.save_widget(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_widget(uuid, text, text) TO authenticated, service_role;`,
  "the house pattern on a function created here");
routine(`${NEW_FN}
ALTER FUNCTION public.save_widget(uuid, text, text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.save_widget(uuid, text, text) TO postgres;`,
  "OWNER TO postgres and a grant to postgres on a function created here");
routine(`${NEW_FN}\nGRANT EXECUTE ON FUNCTION save_widget TO authenticated;`, "an unqualified name without an argument list");
routine(`${NEW_TABLE}
ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widgets FORCE ROW LEVEL SECURITY;
CREATE POLICY "Staff read widgets" ON public.widgets FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
REVOKE ALL ON TABLE public.widgets FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.widgets TO authenticated;
GRANT USAGE ON SEQUENCE public.widgets_id_seq TO authenticated;`,
  "a new table with RLS, a policy, grants and its serial sequence");
routine("ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;", "enabling RLS on an existing table narrows access");
routine("CREATE INDEX widgets_name_idx ON public.widgets (name);", "an ordinary schema change touches no access");
routine(`DO $$ BEGIN
  -- Revoke it from PUBLIC and grant deliberately: prose, not a statement
  IF NOT has_function_privilege('authenticated', 'public.f()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: changed owner to %, revoke it from PUBLIC', 'x';
  END IF;
END $$;`, "a self-check DO block's comments and messages are not statements");
routine("COMMENT ON TABLE public.customers IS 'grant select on customers to anon is forbidden';", "prose in a string literal is not a statement");
routine("-- GRANT ALL ON public.customers TO anon;\nSELECT 1;", "a commented-out grant is not a statement");
routine(`CREATE TRIGGER widgets_touch BEFORE UPDATE ON public.widgets FOR EACH ROW EXECUTE FUNCTION public.touch();`,
  "trigger EXECUTE FUNCTION syntax is not dynamic SQL");

// ── Mason's: widening, or changing existing access ────────────────────────────
masons(`${NEW_FN}\nGRANT EXECUTE ON FUNCTION public.save_widget(uuid, text, text) TO anon;`, "anonymous users or PUBLIC", "a grant to anon, even on a new function");
masons(`${NEW_TABLE}\nGRANT SELECT ON public.widgets TO PUBLIC;`, "anonymous users or PUBLIC", "a grant to PUBLIC");
masons("GRANT SELECT ON public.customers TO authenticated;", "which this migration did not create", "a grant on an existing table");
masons("REVOKE SELECT ON public.customers FROM authenticated;", "which this migration did not create", "a revoke on an existing table");
masons(`${NEW_FN}\nGRANT EXECUTE ON FUNCTION public.save_widget(uuid, text) TO authenticated;`, "did not create", "a grant on a DIFFERENT overload (arity) of a new function");
masons(`${NEW_TABLE}\nGRANT SELECT ON public.widgets, public.customers TO authenticated;`, "customers", "one existing table in a list is enough");
masons("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;", "schema-wide", "an IN SCHEMA bulk grant");
masons("GRANT USAGE ON SCHEMA public TO authenticated;", "schema-wide", "a schema grant");
masons(`${NEW_TABLE}\nGRANT SELECT ON public.widgets TO reporting_role;`, "reporting_role", "a grant to any other role");
masons(`${NEW_TABLE}\nGRANT SELECT ON public.widgets TO authenticated WITH GRANT OPTION;`, "WITH GRANT OPTION", "a grant that can be passed on");
masons("GRANT service_role TO authenticated;", "role membership", "granting a role to a role");
masons("REVOKE authenticated FROM some_user;", "role membership", "revoking role membership");
masons(`${NEW_TABLE}\nCREATE POLICY p ON public.customers FOR SELECT TO authenticated USING (true);`, "existing table", "a policy on an existing table");
masons(`${NEW_TABLE}\nCREATE POLICY p ON public.widgets FOR SELECT TO anon USING (true);`, "anonymous or PUBLIC", "a new table's policy aimed at anon");
masons("ALTER POLICY p ON public.customers USING (true);", "existing access policy", "ALTER POLICY");
masons("DROP POLICY IF EXISTS p ON public.customers;", "existing access policy", "DROP POLICY");
masons("ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY;", "row-level security", "disabling RLS");
masons("ALTER TABLE public.customers NO FORCE ROW LEVEL SECURITY;", "row-level security", "un-forcing RLS");
masons("CREATE ROLE reporting;", "database role", "creating a role");
masons("ALTER ROLE authenticated SET statement_timeout = '5s';", "database role", "altering a role");
masons("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;", "default privileges", "default privileges");
masons("ALTER TABLE public.customers OWNER TO postgres;", "owner", "OWNER TO on an existing object");
masons(`${NEW_FN}\nALTER FUNCTION public.save_widget(uuid, text, text) OWNER TO someone_else;`, "owner", "OWNER TO a role other than postgres");
masons("SET ROLE service_role;", "switches the database role", "SET ROLE");
masons("SET SESSION AUTHORIZATION postgres;", "switches the database role", "SET SESSION AUTHORIZATION");
masons("ALTER FUNCTION public.get_customer(uuid) SECURITY DEFINER;", "elevated rights", "making an existing function SECURITY DEFINER");
masons("CREATE TRIGGER t AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.on_signup();", "auth.users", "a trigger on auth.users");
masons("INSERT INTO storage.buckets (id, name, public) VALUES ('docs', 'docs', true);", "storage.buckets", "creating a storage bucket");
masons(`CREATE POLICY p ON storage.objects FOR SELECT TO authenticated USING (true);`, "storage.objects", "a storage policy");
masons("SELECT vault.create_secret('x', 'y');", "vault.create_secret", "calling a vault function writes a secret");
masons("INSERT INTO auth.users (id) VALUES (gen_random_uuid());", "auth.users", "INSERT INTO auth.users with a column list");
routine(`${NEW_TABLE}\nCREATE POLICY own ON public.widgets FOR SELECT TO authenticated USING (owner = auth.uid() AND storage.foldername(name) IS NOT NULL);`,
  "auth.uid() and storage.foldername() calls in a new table's policy");
masons("CREATE VIEW public.people AS SELECT id, email FROM auth.users;", "auth.users", "a view exposing auth.users");
masons(`DO $$ BEGIN EXECUTE 'GRANT ALL ON public.customers TO anon'; END $$;`, "dynamic SQL", "a grant hidden in a DO block's dynamic SQL");
masons(`DO $$ DECLARE q text := 'x'; BEGIN EXECUTE q; END $$;`, "dynamic SQL", "dynamic SQL from a variable");
masons(`DO $$ BEGIN GRANT SELECT ON public.customers TO authenticated; END $$;`, "did not create", "a plain grant inside a DO block");
masons(`CREATE TABLE IF NOT EXISTS public.widgets (id bigint);\nGRANT SELECT ON public.widgets TO authenticated;`, "did not create",
  "IF NOT EXISTS may leave an older table in place, so its grants change existing access");
masons(`SELECT '/*'; GRANT SELECT ON public.customers TO anon; SELECT '*/';`, "anonymous users or PUBLIC",
  "a fake comment span inside string literals cannot hide a real grant");
masons(`GRANT SELECT ON public.customers TO "anon";`, "anonymous users or PUBLIC", "a quoted grantee is still anon");
masons(`grant select on public.customers to authenticated`, "did not create", "lower case, no semicolon");
masons(`GRANT/**/SELECT ON public.customers TO anon;`, "anonymous users or PUBLIC", "a comment used as whitespace");

console.log(`migration-access-lib: ${pass} assertions passed`);
