// Tests for migration-access-lib.mjs — Mason's 2026-09-26 permissions line:
// routine lock-down on objects the migration creates applies by itself;
// anything that widens access or changes existing access is his.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accessChangeCheck, readMigrationHistory } from "./migration-access-lib.mjs";

let pass = 0;
// Default: an empty history, i.e. nothing in these snippets existed before.
const routine = (sql, message, options = { history: [] }) => {
  const verdict = accessChangeCheck(sql, options);
  assert.equal(verdict.changesAccess, false, `${message} — expected ROUTINE, got: ${verdict.reason}`);
  pass++;
};
const masons = (sql, fragment, message, options = { history: [] }) => {
  const verdict = accessChangeCheck(sql, options);
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
// Sol HIGH, round 10: no TO clause means TO PUBLIC.
masons(`${NEW_TABLE}\nCREATE POLICY p ON public.widgets FOR SELECT USING (true);`, "no TO clause", "a new table's policy with no TO clause");
masons(`${NEW_TABLE}\nCREATE POLICY p ON public.widgets FOR SELECT TO reporting USING (true);`, "reporting", "a new table's policy for another role");
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

// ── Sol HIGH #2, round 10: a REPLACED object keeps its earlier access ─────────
const file = (name, text) => ({ name: `${name}.sql`, text });
const LOCKED = [file("20260101000000_helper", `CREATE FUNCTION public.save_widget(p_id uuid, p_name text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
REVOKE ALL ON FUNCTION public.save_widget(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_widget(uuid, text, text) TO service_role;`)];
const OPEN = [file("20260101000000_rpc", `CREATE FUNCTION public.save_widget(p_id uuid, p_name text, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
REVOKE ALL ON FUNCTION public.save_widget(uuid, text, text) FROM PUBLIC, anon;`)];
const HOUSE = `${NEW_FN}
REVOKE ALL ON FUNCTION public.save_widget(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_widget(uuid, text, text) TO authenticated, service_role;`;
const RECREATE = `DROP FUNCTION IF EXISTS public.save_widget(uuid, text, text);
${NEW_FN.replace("CREATE OR REPLACE", "CREATE")}`;

masons(HOUSE, "did not have before", "Sol's case: replace an internal helper, then grant it to authenticated", { history: LOCKED });
routine(`${NEW_FN}
REVOKE ALL ON FUNCTION public.save_widget(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_widget(uuid, text, text) TO service_role;`,
  "replacing the helper and re-granting only what it had", { history: LOCKED });
routine(HOUSE, "replacing an RPC authenticated already had (by default)", { history: OPEN });
masons(RECREATE, "PUBLIC", "drop + create hands a locked helper Supabase's defaults again", { history: LOCKED });
routine(`${RECREATE}
REVOKE ALL ON FUNCTION public.save_widget(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_widget(uuid, text, text) TO service_role;`,
  "drop + create that locks it down again", { history: LOCKED });
routine(HOUSE, "a helper dropped in an earlier migration is new again",
  { history: [...LOCKED, file("20260102000000_drop", "DROP FUNCTION public.save_widget(uuid, text, text);")] });
routine(HOUSE, "a function created with defaults and never narrowed",
  { history: [file("20260101000000_rpc", NEW_FN.replace("CREATE OR REPLACE", "CREATE"))] });
routine(HOUSE, "a replace of a function no earlier migration names is new", { history: [file("20260101000000_other", "CREATE TABLE public.other (id int);")] });

// No history (the daily summary): a replaced object's earlier access is unknown.
masons(HOUSE, "cannot be checked without the migration history", "no history: replace + grant", {});
routine(`${NEW_FN}\nREVOKE ALL ON FUNCTION public.save_widget(uuid, text, text) FROM PUBLIC, anon;`, "no history: replace + revoke only", {});
routine(`${NEW_FN.replace("CREATE OR REPLACE", "CREATE")}
GRANT EXECUTE ON FUNCTION public.save_widget(uuid, text, text) TO authenticated;`, "no history: a plain CREATE is new", {});
masons(`${RECREATE}\nGRANT EXECUTE ON FUNCTION public.save_widget(uuid, text, text) TO authenticated;`,
  "cannot be checked", "no history: drop + create may be an existing object", {});

// History the model has to read carefully.
masons(HOUSE, "did not have before", "a schema-wide revoke in the history",
  { history: [...OPEN, file("20260102000000_bulk", "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;")] });
const DYNAMIC_REVOKE = file("20260102000000_loop", `DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT oid::regprocedure AS sig FROM pg_proc LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
  END LOOP; END $$;`);
routine(HOUSE, "a dynamic loop's grant to authenticated keeps a known grant",
  { history: [file("20260101000000_rpc", NEW_FN.replace("CREATE OR REPLACE", "CREATE")), DYNAMIC_REVOKE] });
masons(RECREATE, "PUBLIC", "a dynamic loop's revoke makes PUBLIC unknown, and drop + create restores it",
  { history: [file("20260101000000_rpc", NEW_FN.replace("CREATE OR REPLACE", "CREATE")), DYNAMIC_REVOKE] });
routine(HOUSE, "a RAISE message saying REVOKE is prose, not dynamic SQL",
  { history: [...OPEN, file("20260102000000_check", `DO $$ BEGIN EXECUTE 'SELECT 1'; RAISE EXCEPTION 'REVOKE verification failed for %', 'x'; END $$;`)] });
masons(HOUSE, "cannot confirm", "renaming another function into this name",
  { history: [file("20260101000000_old", `CREATE FUNCTION public.old_widget(p_id uuid, p_name text, p_key text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
ALTER FUNCTION public.old_widget(uuid, text, text) RENAME TO save_widget;`)] });
masons(HOUSE, "cannot confirm", "two overloads with the same argument count cannot be told apart",
  { history: [...OPEN, file("20260102000000_overload", `CREATE FUNCTION public.save_widget(p_id text, p_name text, p_key text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;`)] });
masons(HOUSE, "cannot confirm", "an unknown ALTER DEFAULT PRIVILEGES makes older objects' starting access unknown",
  { history: [file("20260101000000_rpc", NEW_FN.replace("CREATE OR REPLACE", "CREATE")),
    file("20260102000000_defaults", "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated;")] });
masons(HOUSE, "did not have before", "pg_dump-style quoted names in the history",
  { history: [file("20250101000000_remote_schema", `CREATE OR REPLACE FUNCTION "public"."save_widget"("p_id" "uuid", "p_name" "text", "p_idempotency_key" "text" DEFAULT NULL::"text") RETURNS "jsonb" LANGUAGE "sql" AS $$ SELECT '{}'::jsonb $$;
REVOKE ALL ON FUNCTION "public"."save_widget"("p_id" "uuid", "p_name" "text", "p_idempotency_key" "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."save_widget"("p_id" "uuid", "p_name" "text", "p_idempotency_key" "text") FROM "authenticated";`)] });
// Holding a privilege through PUBLIC counts: granting it by name widens nothing.
routine(HOUSE, "authenticated already had EXECUTE through PUBLIC",
  { history: [file("20260101000000_rpc", `${NEW_FN.replace("CREATE OR REPLACE", "CREATE")}
REVOKE ALL ON FUNCTION public.save_widget(uuid, text, text) FROM authenticated;`)] });

// Views: CREATE OR REPLACE VIEW keeps grants too.
const VIEW_HISTORY = [file("20260101000000_view", `CREATE VIEW public.widget_totals AS SELECT 1 AS n;
REVOKE ALL ON public.widget_totals FROM anon;`)];
routine(`CREATE OR REPLACE VIEW public.widget_totals AS SELECT 2 AS n;
GRANT SELECT ON public.widget_totals TO authenticated;`, "replacing a view authenticated could already read", { history: VIEW_HISTORY });
masons(`DROP VIEW public.widget_totals;
CREATE VIEW public.widget_totals AS SELECT 2 AS n;`, "anon", "drop + create of a view hands anon SELECT back", { history: VIEW_HISTORY });
masons(`DROP FUNCTION public.widget_source() CASCADE;
CREATE OR REPLACE VIEW public.widget_totals AS SELECT 2 AS n;`, "anon", "a CASCADE may have dropped the view that is then re-created", { history: VIEW_HISTORY });
routine(`DROP VIEW public.widget_totals;
CREATE VIEW public.widget_totals AS SELECT 2 AS n;
REVOKE ALL ON public.widget_totals FROM anon;
GRANT SELECT ON public.widget_totals TO authenticated;`, "drop + create of a view that locks anon out again", { history: VIEW_HISTORY });

// readMigrationHistory: only files that sort before the current one, oldest first.
{
  const dir = mkdtempSync(path.join(tmpdir(), "access-history-"));
  try {
    for (const name of ["20260103000000_c.sql", "20260101000000_a.sql", "20260102000000_now.sql", "notes.md"]) writeFileSync(path.join(dir, name), `-- ${name}`);
    const history = readMigrationHistory(dir, "20260102000000_now");
    assert.deepEqual(history.map((entry) => entry.name), ["20260101000000_a.sql"]);
    assert.equal(history[0].text, "-- 20260101000000_a.sql");
    pass++;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`migration-access-lib: ${pass} assertions passed`);
