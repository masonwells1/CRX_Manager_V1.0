// Tests for migration-access-lib.mjs — Mason's 2026-09-26 permissions line:
// routine lock-down on objects the migration creates applies by itself;
// anything that widens access or changes existing access is his.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { accessChangeCheck, dataRewriteCheck, readMigrationHistory } from "./migration-access-lib.mjs";

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

// ── Sol round 11: a SECURITY DEFINER body that reaches logins/files/secrets ───
const secdef = (body, security = "SECURITY DEFINER") => `CREATE OR REPLACE FUNCTION public.whoami(p_id uuid)
RETURNS text LANGUAGE plpgsql ${security} SET search_path = public, pg_temp AS $fn$
BEGIN
  -- a comment naming auth.users is not a reference
${body}
END $fn$;
REVOKE ALL ON FUNCTION public.whoami(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whoami(uuid) TO authenticated;`;
masons(secdef("  RETURN (SELECT email FROM auth.users WHERE id = p_id);"), "auth.users",
  "Sol's case: an authenticated-callable SECURITY DEFINER body reading auth.users");
masons(secdef("  INSERT INTO storage.objects (bucket_id, name) VALUES ('docs', p_id::text);"), "storage.objects",
  "a SECURITY DEFINER body writing storage.objects");
masons(secdef("  PERFORM vault.create_secret('x', 'y');"), "vault.create_secret", "a SECURITY DEFINER body writing a secret");
routine(secdef("  IF p_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'no'; END IF;\n  RETURN auth.role();"),
  "auth.uid()/auth.role() in a SECURITY DEFINER body, even after FROM");
routine(secdef("  RETURN (SELECT email FROM auth.users WHERE id = p_id);", "SECURITY INVOKER"),
  "a SECURITY INVOKER body runs with the caller's own rights");
masons(`CREATE FUNCTION public.odd() RETURNS int LANGUAGE sql SECURITY DEFINER BEGIN ATOMIC SELECT 1; END;`,
  "cannot read", "a SECURITY DEFINER body in a form the check cannot read");

// ── Sol round 11 (Mason 2026-09-27, "Data rewrites wait"): overwriting rows ────
let rewrites = 0;
const rewriteOk = (sql, message, options = { history: [] }) => {
  const verdict = dataRewriteCheck(sql, options);
  assert.equal(verdict.rewrites, false, `${message} — expected ROUTINE, got: ${verdict.reason}`);
  rewrites++;
};
const rewriteMasons = (sql, fragment, message, options = { history: [] }) => {
  const verdict = dataRewriteCheck(sql, options);
  assert.equal(verdict.rewrites, true, `${message} — expected MASON'S`);
  assert.ok(String(verdict.reason).includes(fragment), `${message} — reason ${JSON.stringify(verdict.reason)} lacks ${JSON.stringify(fragment)}`);
  rewrites++;
};
rewriteMasons("UPDATE public.invoices SET total_amount_cents = 0;", "invoices (UPDATE)", "Sol's case: overwrite every invoice total");
rewriteMasons("DO $$ BEGIN UPDATE order_items oi SET cost_cents = 0 WHERE oi.id IS NOT NULL; END $$;", "order_items", "an UPDATE inside a DO block");
rewriteMasons("WITH x AS (UPDATE ONLY public.payments AS p SET amount_cents = 1 RETURNING p.id) SELECT count(*) FROM x;", "payments", "an UPDATE in a CTE");
rewriteMasons("INSERT INTO public.settings (key, value) VALUES ('a', 'b') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;",
  "ON CONFLICT DO UPDATE", "an upsert overwrites existing rows");
rewriteMasons("MERGE INTO public.products p USING staging s ON p.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name;", "MERGE", "MERGE");
rewriteMasons("ALTER TABLE public.invoices ALTER COLUMN total_amount_cents TYPE integer USING total_amount_cents::integer;", "TYPE",
  "a column type conversion rewrites existing values");
rewriteOk("INSERT INTO public.settings (key, value) VALUES ('a', 'b') ON CONFLICT (key) DO NOTHING;", "adding rows is routine");
rewriteOk("ALTER TABLE public.invoices ADD COLUMN note text DEFAULT '';", "adding a column is routine");
rewriteOk(`CREATE TABLE public.widgets (id bigint, n int);
INSERT INTO public.widgets VALUES (1, 1);
UPDATE public.widgets SET n = 2;
ALTER TABLE public.widgets ALTER COLUMN n TYPE bigint;`, "a table this migration creates has no existing rows");
rewriteOk("CREATE TRIGGER t BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.touch();", "a trigger definition is not an update");
rewriteOk("ALTER TABLE public.lines ADD CONSTRAINT fk FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON UPDATE SET NULL;", "ON UPDATE SET NULL is not an update");
rewriteOk("SELECT id FROM public.invoices FOR UPDATE;", "SELECT ... FOR UPDATE is not an update");
rewriteOk("COMMENT ON TABLE public.invoices IS 'UPDATE invoices SET x = 1';", "an UPDATE in a string literal is not a statement");

// Functions run while applying.
const WRITER = `CREATE OR REPLACE FUNCTION public.backfill_totals() RETURNS void LANGUAGE plpgsql AS $$
BEGIN UPDATE public.invoices SET total_amount_cents = 0; END $$;`;
const READER = `CREATE OR REPLACE FUNCTION public._assert_shape() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF to_regprocedure('public.backfill_totals()') IS NULL THEN RAISE EXCEPTION 'missing backfill_totals()'; END IF;
END $$;`;
rewriteMasons(`${WRITER}\nSELECT public.backfill_totals();`, "backfill_totals() while applying, which changes existing rows",
  "calling a writer defined in this migration");
rewriteMasons(`${WRITER}\nCREATE FUNCTION public.run_all() RETURNS void LANGUAGE sql AS $$ SELECT public.backfill_totals() $$;\nDO $$ BEGIN PERFORM public.run_all(); END $$;`,
  "run_all() → backfill_totals()", "a writer reached through another function");
rewriteOk(`${WRITER}\n${READER}\nSELECT public._assert_shape();`, "a read-only assertion that NAMES a writer in a string");
rewriteOk(`${WRITER}\nDO $$ BEGIN IF to_regprocedure('public.x()') IS NULL THEN ALTER FUNCTION public.backfill_totals() RENAME TO old_backfill; END IF; END $$;`,
  "ALTER FUNCTION f() inside a DO block names the function, it does not call it");
rewriteOk(`${WRITER}\nDO $$ DECLARE c jsonb; BEGIN FOR c IN SELECT value FROM jsonb_array_elements($checks$[{"signature":"public.backfill_totals()"}]$checks$) LOOP NULL; END LOOP; END $$;`,
  "a name inside a DO block's own dollar-quoted string is not a call");
rewriteMasons("SELECT public.backfill_totals();", "backfill_totals() while applying",
  "a writer defined in an earlier migration", { history: [file("20260101000000_fn", WRITER)] });
rewriteOk("SELECT public.backfill_totals();", "a function the history shows is read-only",
  { history: [file("20260101000000_fn", WRITER.replace("UPDATE public.invoices SET total_amount_cents = 0;", "PERFORM 1;"))] });
rewriteMasons("SELECT public.backfill_totals();", "without the migration history", "no history: an earlier public function is unknown", {});
rewriteOk("SELECT set_config('x', 'y', true), now();", "built-in functions are not migration functions", {});
rewriteMasons(`CREATE OR REPLACE FUNCTION public.clean() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE format('UPDATE %I SET x = 1', 't'); END $$;
SELECT public.clean();`, "dynamic SQL", "a called function running dynamic SQL");
pass += rewrites;

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
