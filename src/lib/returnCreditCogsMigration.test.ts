import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260827041100_rebuild_return_credit_cogs_reversal.sql',
  'utf8',
);
const reportMigration = readFileSync(
  'supabase/migrations/20260827041000_align_recognized_invoice_report_statuses.sql',
  'utf8',
);
const allocatedDeliveryMigration = readFileSync(
  'supabase/migrations/20260817120000_carry_allocated_line_cents_through_lifecycle.sql',
  'utf8',
);
const deliveryCreditGateMigration = readFileSync(
  'supabase/migrations/20260827041200_exclude_return_credits_from_delivery_invoice_gate.sql',
  'utf8',
);
const deliverySurfaceMigration = readFileSync(
  'supabase/migrations/20260827041300_align_return_credit_delivery_surfaces.sql',
  'utf8',
);
const orderInvoiceGateMigration = readFileSync(
  'supabase/migrations/20260827041400_align_return_credit_order_invoice_gates.sql',
  'utf8',
);
const invoiceLineageMigration = readFileSync(
  'supabase/migrations/20260827041500_preserve_generated_invoice_lineage_and_finish_cutover.sql',
  'utf8',
);
const migrationHistory = readFileSync('docs/reference/migration-history.md', 'utf8');
const reportsPage = readFileSync('src/pages/Reports.tsx', 'utf8');
const monthEndPage = readFileSync('src/pages/MonthEndClose.tsx', 'utf8');
const invoicesPage = readFileSync('src/pages/Invoices.tsx', 'utf8');
const invoiceSource = readFileSync('src/pages/InvoiceDetail.tsx', 'utf8');
const recognizedInvoiceCustomers = readFileSync('src/lib/recognizedInvoiceCustomers.ts', 'utf8');
const customerDetailPage = readFileSync('src/pages/CustomerDetail.tsx', 'utf8');
const returnCreditSmoke = readFileSync('scripts/smoke/smoke-return-credit-chain.sql', 'utf8');

describe('return-credit COGS migration', () => {
  const functionBodySha256 = (sql: string, name: string) => {
    const match = [
      new RegExp(
        `CREATE(?: OR REPLACE)? FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$function\\$\\r?\\n([\\s\\S]*?)\\r?\\n\\$function\\$;`,
      ),
      new RegExp(
        `CREATE(?: OR REPLACE)? FUNCTION "public"\\."${name}"\\([\\s\\S]*?AS \\$\\$\\r?\\n([\\s\\S]*?)\\r?\\n\\$\\$;`,
      ),
    ].map((pattern) => sql.match(pattern)).find(Boolean);
    expect(match?.[1], `${name} body was not found`).toBeTruthy();
    const normalizedBody = match![1].replace(/\r\n/g, '\n');
    return createHash('sha256').update(`\n${normalizedBody}\n`, 'utf8').digest('hex');
  };

  const assertExceptionReset = (sql: string, setting: string) => {
    const escaped = setting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `EXCEPTION WHEN OTHERS THEN[\\s\\S]{0,220}set_config\\('${escaped}', '0', true\\)[\\s\\S]{0,100}RAISE;`,
    );
    if (!pattern.test(sql)) throw new Error(`${setting} is not reset before re-raising`);
  };

  it('pins the dependent live bodies and structurally rejects duplicate return lines', () => {
    expect(migration).toContain('RETURN_COGS_PREFLIGHT_DRIFT');
    expect(migration).toContain('_issue_return_credit_intent_impl_20260812');
    expect(migration).toContain('_receive_return_intent_impl_20260812');
    expect(migration).toContain('return_items_return_order_item_unique UNIQUE (return_id, order_item_id)');
    expect(migration).toContain('SELECT 1 FROM public.return_items\n    WHERE order_item_id IS NOT NULL');
    expect(migration).toContain('LOCK TABLE public.returns IN ACCESS EXCLUSIVE MODE');
    expect(migration).toContain("SET lock_timeout = '5s';");
    expect(migration).toContain('RESET lock_timeout;');
    expect(migration).toContain('RETURN_COGS_PREEXISTING_CREDIT_REQUIRES_BACKFILL');
    expect(migration).toContain('RETURN_COGS_RECEIVED_UNRESTOCKED_REQUIRES_REPAIR');
    expect(migration).toContain('RETURN_COGS_NONTERMINAL_RETURN_UNIT_REQUIRES_REPAIR');
    expect(migration).toContain('RETURN_COGS_RECEIVED_SOURCE_UNIT_REQUIRES_REPAIR');
    expect(migration).toContain('RETURN_COGS_OPEN_RETURN_INVENTORY_UNIT_REQUIRES_REPAIR');
    expect(migration).toContain('-- OPEN_RETURN_INVENTORY_UNIT_PREFLIGHT:');
    expect(migration).toContain('AND ri.quantity = 15');
    expect(migration).toContain('AND p.container_size = 2.5');
    expect(migration).toContain('AND v_item.quantity = 15');
    expect(migration).toContain('AND v_container_size = 2.5');
    expect(migration).toContain('AND NOT COALESCE((');
    expect(migration).toContain("r.status IN ('requested','approved','received')");
    expect(migration).toContain("inv.status IN ('posted','overdue','paid')");
    expect(migration).toContain('RETURN_COGS_PREFLIGHT_UNLINKED_COST_CREDIT');
    expect(migration).toContain('RETURN_COGS_PREFLIGHT_OVERLOAD_DRIFT');
    expect(migration).toContain('RETURN_COGS_POSTFLIGHT_DEPENDENCY_OVERLOAD_DRIFT');
    expect(migration).toContain('RETURN_COGS_PREFLIGHT_INVENTORY_UPSERT_CONSTRAINT');
    expect(migration).toContain('returns_credit_invoice_id_active_idx');
    expect(migration).toContain('RETURN_COGS_PREFLIGHT_BATCH_VOID_CONTRACT_DRIFT');
    expect(migration).toContain('RETURN_COGS_POSTFLIGHT_BATCH_VOID_CONTRACT_DRIFT');
    expect(migration).toContain("position('PERFORM void_invoice(v_inv.id, p_void_reason)' IN p.prosrc) > 0");
    expect(migration).toContain("position('UPDATE invoices SET' IN p.prosrc) = 0");
    expect(migration).toContain("'void_invoice', 'c7a488d58bd876e92565bca9bd4edc90'");
  });

  it('seeds a missing warehouse row and scopes the guard bypass to credit-memo reversals', () => {
    expect(migration).toContain('ON CONFLICT (product_id, location) DO UPDATE');
    expect(migration).toContain("current_setting('app.crx_return_credit_lineage', true) = '1'");
    expect(migration).toContain('EXECUTE FUNCTION public._enforce_below_cost_line()');
    expect(migration).toContain('RETURN_CREDIT_UNIT_MISMATCH');
    expect(migration).toContain('WHEN ri.order_item_id IS NULL THEN ri.unit');
    expect(migration).toContain("ELSE COALESCE(oi.unit_size, 'ea')");
    expect(migration).toContain("v_item.source_unit");
    expect(returnCreditSmoke).toContain('unit mismatch created a warehouse inventory row');
    expect(returnCreditSmoke).toContain('public receive tamper guard raised');
    expect(returnCreditSmoke).toContain('private receive unit guard raised');
    expect(migration).toContain('RETURN_CREDIT_UNLINKED_COST_LINE');
    expect(migration).toContain('RETURN_CREDIT_LEDGER_IMMUTABLE');
    expect(migration).toContain('BEFORE UPDATE OF status, deleted_at, total_amount_cents, total_cost_cents, season, invoice_type, invoice_date OR DELETE ON public.invoices');
    expect(migration).toContain('aa_crx_guard_return_credit_lineage');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF invoice_id, order_item_id, product_id, quantity, unit_price_cents, extended_cents, cost_cents, return_credit_cogs_cents, return_credit_source_item_id, unit_size, created_at OR DELETE');
    expect(migration).toContain('RETURN_CREDIT_INVENTORY_UNIT_MISMATCH');
    expect(migration).toContain('return_credit_cogs_cents bigint');
    expect(migration).toContain('return_credit_source_item_id uuid');
    expect(migration).toContain('invoice_items_return_credit_cogs_cents_nonpositive_chk');
    expect(migration).toContain('invoice_items_return_credit_source_item_fk');
    expect(migration).toContain('CREATE INDEX invoice_items_return_credit_source_item_idx');
    expect(migration).toContain('invoice_items_return_credit_source_shape_chk');
    expect(migration).toContain('RETURN_CREDIT_COGS_LEDGER_MISSING');
    expect(migration).toContain('RETURN_CREDIT_REVERSAL_EXCEEDS_RECOGNIZED');
    expect(migration).toContain("MESSAGE = 'RETURN_CREDIT_REVERSAL_EXCEEDS_RECOGNIZED'");
    expect(migration).toContain("DETAIL = 'The requested reversal exceeded the recognized whole-cent source-cost ceiling.'");
    expect(migration).not.toContain("'return_number=%s; violations=%s'");
    expect(migration).not.toContain('PERFORM 1 FROM public.order_items oi');
    expect(migration).toContain('ROW(NEW.invoice_id, NEW.order_item_id, NEW.product_id, NEW.quantity, NEW.unit_price_cents, NEW.extended_cents, NEW.cost_cents, NEW.return_credit_cogs_cents, NEW.return_credit_source_item_id, NEW.unit_size, NEW.created_at)');
    expect(migration).toContain('prl.source_item_id = sl.source_item_id');
    expect(migration).toContain('pcl.source_item_id = sl.source_item_id');
    expect(migration).toMatch(/s\.source_item_id,\s+-- RETURN_CREDIT_ZERO_COGS_SOURCE_LINEAGE_END\s+s\.unit, s\.sort_order/);
    expect(migration).not.toMatch(/ORDER BY (?:sl|al)\.invoice_date/);
    expect(returnCreditSmoke).toContain('SMOKE_FAIL: active return-credit cost line was reparented');
    expect(returnCreditSmoke).toContain('SMOKE_FAIL: active zero-cost return-credit line was costed later');
    expect(returnCreditSmoke).toContain('SMOKE_FAIL: active return-credit revenue fields were mutated');
    expect(migration).toContain("current_setting('transaction_isolation') <> 'read committed'");
    expect(migration).toContain("set_config('app.crx_return_credit_lineage', '0', true)");
    expect(migration).toContain("set_config('app.crx_return_credit_void', '1', true)");
    expect(migration).toContain("set_config('app.crx_return_credit_void', '0', true)");
    expect(migration).toContain("set_config('app.crx_return_credit_unapply', '1', true)");
    expect(migration).toContain("set_config('app.crx_return_credit_unapply', '0', true)");
    expect(migration).toContain('_void_invoice_return_credit_guard_impl_20260826');
    expect(migration).toContain('_unapply_return_credit_guard_impl_20260826');
    expect(migration).toContain('RETURN_CREDIT_VOID_RELEASE_FAILED');
    expect(migration).toContain('RETURN_CREDIT_UNAPPLY_RELEASE_FAILED');
    expect(migration).toContain('RETURN_CREDIT_HEADER_IMMUTABLE');
    expect(migration).toContain('v_enters_recognized :=');
    expect(migration).toContain("NEW.status IN ('posted','overdue','paid')");
    expect(migration).toContain('pg_try_advisory_xact_lock');
    expect(migration).toContain('RETURN_CREDIT_SOURCE_POST_REQUIRES_REISSUE');
    expect(migration).toContain('credit_line.return_credit_source_item_id = source_line.id');
    expect(migration).not.toMatch(/JOIN public\.invoice_items credit_line\s+ON credit_line\.order_item_id = source_line\.order_item_id/);
    expect(migration).toContain('-- RETURN_CREDIT_EXACT_SOURCE_RECOGNITION_GUARD_BEGIN');
    expect(migration).toContain('-- RETURN_CREDIT_ZERO_COGS_SOURCE_LINEAGE_BEGIN');
    expect(migration).toContain('RETURN_CREDIT_SOURCE_LINEAGE_INVALID');
    expect(migration).toContain('RETURN_CREDIT_SPLIT_CUSTOMER_SOURCE_REQUIRES_LINEAGE');
    expect(migration).toContain('explicit unlinked zero-COGS remainder');
    expect(migration).toContain('COALESCE(pcl.cogs_reversed_qty, 0) AS prior_cogs_qty');
    // Lineage-less prior credits must keep consuming source quantity, or an
    // already-credited quantity reads as available and the same posted quantity
    // can be credited twice. Pin both halves: the unlinked total is gathered,
    // and it is retired against the FIFO queue before allocation.
    expect(migration).toContain('COALESCE(puc.unlinked_qty, 0) AS unlinked_qty');
    expect(migration).toContain('AS net_available_qty');
    // The lineage-less fallback in both recognition guards is customer-scoped,
    // so a split-billed sibling's credit can never freeze another customer's
    // invoice. Dropping either scope silently widens the guard.
    expect(migration).toContain('credit_invoice.customer_id = OLD.customer_id');
    expect(migration).toContain('credit_invoice.customer_id = v_invoice_customer_id');
    // The cross-customer refusal fires only on the unallocated remainder, which
    // is what keeps ordinary split-billed returns creditable.
    expect(migration).toContain('remainder.return_credit_source_item_id IS NULL');
    expect(migration).toContain('SUM(ri.quantity)');
    expect(migration).toContain('RETURN_CREDIT_PARENT_IMMUTABLE');
    expect(migration).toContain('RETURN_CREDIT_LINE_TOTAL_MISMATCH');
    expect(migration).toContain('BEFORE UPDATE OF status, deleted_at, total_amount_cents, total_cost_cents, season, invoice_type, invoice_date OR DELETE');
    expect(migration).toContain('ROW(NEW.total_amount_cents, NEW.total_cost_cents, NEW.season, NEW.invoice_type, NEW.invoice_date)');
    expect(migration).toContain('CREATE TRIGGER aa_crx_guard_recognized_return_credit_delete');
    expect(migration).toContain("p.proname = 'current_season'");
    expect(migration).toContain("to_regprocedure('public.current_season()')");
    expect(migration).toContain("p.prorettype = 'integer'::regtype");
    expect(migration).toContain("p.provolatile = 's'");
    expect(migration).toContain("p.proconfig = ARRAY['search_path=public']::text[]");
    expect(migration.match(/0b9ef2b922c909de0cea7757bcfe95901c0781739eddd8521b09cfb1537907ba/g)).toHaveLength(2);
    expect(migration).toContain('RETURN_COGS_POSTFLIGHT_CURRENT_SEASON_DRIFT');
    expect(migration).toContain("v_business_date date := (now() AT TIME ZONE 'America/Chicago')::date");
    const chicagoDateBinding = migration.indexOf("PERFORM set_config('TimeZone', 'America/Chicago', true)");
    const delegatedHeader = migration.indexOf('v_header := public._issue_return_credit_header_only_impl_20260825(');
    expect(chicagoDateBinding).toBeGreaterThanOrEqual(0);
    expect(delegatedHeader).toBeGreaterThan(chicagoDateBinding);
    expect(migration).toContain('season = public.compute_season(v_business_date)');
    expect(migration).toContain("v_cached := public.check_idempotency(p_idempotency_key, 'unapply_credit_memo')");
    const unapplyWrapper = migration.slice(migration.indexOf('CREATE FUNCTION public.unapply_credit_memo('));
    const authRequired = unapplyWrapper.indexOf("RAISE EXCEPTION 'AUTH_REQUIRED'");
    const actorBinding = unapplyWrapper.indexOf('IF p_performed_by IS DISTINCT FROM v_actor');
    const adminGate = unapplyWrapper.indexOf("p.role = 'admin'");
    const reasonGate = unapplyWrapper.indexOf("IF p_reason IS NULL OR btrim(p_reason) = ''");
    const replayLookup = unapplyWrapper.indexOf("public.check_idempotency(p_idempotency_key, 'unapply_credit_memo')");
    expect(authRequired).toBeGreaterThanOrEqual(0);
    expect(actorBinding).toBeGreaterThan(authRequired);
    expect(adminGate).toBeGreaterThan(actorBinding);
    expect(reasonGate).toBeGreaterThan(adminGate);
    expect(replayLookup).toBeGreaterThan(reasonGate);
    expect(unapplyWrapper.indexOf("public.check_idempotency(p_idempotency_key, 'unapply_credit_memo')"))
      .toBeLessThan(unapplyWrapper.indexOf('public._unapply_return_credit_guard_impl_20260826('));
    expect(migration).not.toContain('RETURN_CREDIT_SOURCE_SEASON_AMBIGUOUS');
    expect(returnCreditSmoke).toContain("PERFORM void_invoice(v_credit_id, '[SMOKE] chain void'");
    expect(returnCreditSmoke).toContain("operation_type = 'invoice_voided'");
    expect(returnCreditSmoke).toContain("issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-reissue')");
    expect(returnCreditSmoke).toContain('batch void did not route the return credit through void_invoice');
    expect(returnCreditSmoke).toContain('assigned-only sales-rep year-end batch returned');
    expect(returnCreditSmoke).toContain('RETURN_CREDIT_DASHBOARD_UNBILLED_PROVEN');
    expect(returnCreditSmoke).toContain('SMK-RCC-DELETED-');
    expect(returnCreditSmoke).toContain('unauthenticated caller received cached unapply result');
    expect(returnCreditSmoke).toContain('non-admin caller received cached unapply result');
    expect(returnCreditSmoke).toContain('forged actor received cached unapply result');
    expect(returnCreditSmoke).toContain('blank-reason caller received cached unapply result');
    expect(returnCreditSmoke).toContain('authorized unapply replay did not return the cached result');
  });

  it('fails if an unapply replay authorization guard moves behind the cache lookup', () => {
    const wrapper = migration.slice(migration.indexOf('CREATE FUNCTION public.unapply_credit_memo('));
    const assertReplayAuthorizationFirst = (source: string) => {
      const replayLookup = source.indexOf("public.check_idempotency(p_idempotency_key, 'unapply_credit_memo')");
      const guards = [
        "RAISE EXCEPTION 'AUTH_REQUIRED'",
        'IF p_performed_by IS DISTINCT FROM v_actor',
        "p.role = 'admin'",
        "IF p_reason IS NULL OR btrim(p_reason) = ''",
      ];
      if (replayLookup < 0 || guards.some((guard) => {
        const position = source.indexOf(guard);
        return position < 0 || position >= replayLookup;
      })) {
        throw new Error('UNAPPLY_REPLAY_AUTHORIZATION_NOT_FIRST');
      }
    };

    expect(() => assertReplayAuthorizationFirst(wrapper)).not.toThrow();
    for (const guard of [
      "RAISE EXCEPTION 'AUTH_REQUIRED'",
      'IF p_performed_by IS DISTINCT FROM v_actor',
      "p.role = 'admin'",
      "IF p_reason IS NULL OR btrim(p_reason) = ''",
    ]) {
      const mutant = wrapper.replace(guard, '-- mutation removed replay authorization guard');
      expect(mutant).not.toBe(wrapper);
      expect(() => assertReplayAuthorizationFirst(mutant)).toThrow('UNAPPLY_REPLAY_AUTHORIZATION_NOT_FIRST');
    }
  });

  it('fails its source-order proof if the early unapply idempotency lock is removed', () => {
    const wrapper = migration.slice(migration.indexOf('CREATE FUNCTION public.unapply_credit_memo('));
    const assertEarlyLock = (source: string) => {
      const check = source.indexOf("public.check_idempotency(p_idempotency_key, 'unapply_credit_memo')");
      const delegate = source.indexOf('public._unapply_return_credit_guard_impl_20260826(');
      if (check < 0 || delegate < 0 || check >= delegate) throw new Error('UNAPPLY_IDEMPOTENCY_LOCK_NOT_EARLY');
    };
    expect(() => assertEarlyLock(wrapper)).not.toThrow();
    const mutant = wrapper.replace(
      "v_cached := public.check_idempotency(p_idempotency_key, 'unapply_credit_memo');",
      'v_cached := NULL; -- mutation: early serialization removed',
    );
    expect(mutant).not.toBe(wrapper);
    expect(() => assertEarlyLock(mutant)).toThrow('UNAPPLY_IDEMPOTENCY_LOCK_NOT_EARLY');
  });

  it('pins the replacement helper bodies used by the COGS postflight', () => {
    expect(functionBodySha256(allocatedDeliveryMigration, '_allocated_delivery_cents')).toBe('1df1d230c19e5d129038b1e5dfbca30db0b369ea5a91a22f19dd98cc53129142');
    expect(functionBodySha256(allocatedDeliveryMigration, '_complete_delivery_authorized_impl')).toBe('0e889bb6e0bc998d2833081e8e6f8e801e032595e7360e09d4f594e13ed7ad24');
    expect(functionBodySha256(allocatedDeliveryMigration, '_create_invoice_for_unbilled_delivery_impl_20260718')).toBe('6543165d2c7cb6acbffd222adb28fee9b66278338ec401f6b2f19537c8aebcaa');
    expect(functionBodySha256(deliveryCreditGateMigration, '_complete_delivery_authorized_impl')).toBe('15c5a7ddf836f402d52544a69b8628061b4e9042444362262c1d76d26916ee69');
    expect(functionBodySha256(deliveryCreditGateMigration, '_create_invoice_for_unbilled_delivery_impl_20260718')).toBe('89149c4596b68c8f98c52118433b21afc515f8af2e10d2ffa7ccb11cd87002e8');
    expect(deliveryCreditGateMigration.match(/AND invoice_type <> 'credit_memo'/g)).toHaveLength(2);
    expect(deliveryCreditGateMigration).toContain('UNBILLED_DELIVERY_RETURN_CREDIT_GATE_PREFLIGHT_CONTRACT_DRIFT');
    expect(deliveryCreditGateMigration).toContain('UNBILLED_DELIVERY_RETURN_CREDIT_GATE_POSTFLIGHT_DRIFT');
    expect(functionBodySha256(deliverySurfaceMigration, 'get_dashboard_action_items')).toBe('f70e6c5d6f192d8e5cb355dde8126f353842f20191c32d27a7ca28342fc385d5');
    expect(functionBodySha256(deliverySurfaceMigration, 'void_delivery')).toBe('7086ec87e31f5c2a59fda75ea6966e2bac3e7140366bc92d3e44765400f68af4');
    expect(functionBodySha256(deliverySurfaceMigration, 'cancel_delivery')).toBe('07eb823ddb26899dba8379c1c9596a0a52dd9d8dcf8530de680f8d33571d98fa');
    expect(functionBodySha256(deliverySurfaceMigration, '_complete_delivery_authorized_impl')).toBe('3c2dc6185c3f0de6beb32641f3963eacc4845ca2c22ad2575a72d2cb2892594a');
    expect(deliverySurfaceMigration.match(/invoice_type <> 'credit_memo'/g)).toHaveLength(8);
    expect(deliverySurfaceMigration).toContain('RETURN_CREDIT_DELIVERY_SURFACE_PREFLIGHT_CONTRACT_DRIFT');
    expect(deliverySurfaceMigration).toContain('RETURN_CREDIT_DELIVERY_SURFACE_POSTFLIGHT_CONTRACT_DRIFT');
    expect(deliverySurfaceMigration).toContain('"private":true');
    expect(deliverySurfaceMigration).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(deliverySurfaceMigration).toContain('AND i.deleted_at IS NULL');
    expect(deliverySurfaceMigration).toContain("AND deleted_at IS NULL\n      AND (delivery_id = p_delivery_id OR delivery_id IS NULL);");
    expect(orderInvoiceGateMigration).toContain('RETURN_CREDIT_ORDER_GATE_PREFLIGHT_CONTRACT_DRIFT');
    expect(orderInvoiceGateMigration).toContain('RETURN_CREDIT_ORDER_GATE_POSTFLIGHT_CONTRACT_DRIFT');
    expect(orderInvoiceGateMigration).toContain('1280d2461c9e79712900a7208fc2fcd760ccd9b4448f7fb3fc89a5523196bfc5');
    expect(orderInvoiceGateMigration).toContain('4e17b8eb18b544ebab5785f88c2346f76528a3a490c0a31b5f765b06db24d351');
    expect(orderInvoiceGateMigration).toContain('0d6ef022779bd6bc8ef694dab4ce9255053339eeb7d5e79e288d60eba15a6d28');
    expect(orderInvoiceGateMigration).toContain('ef8ed2b1e60554722eda863c953d997fd992c771f48ad9254f9e95155898df70');
    expect(orderInvoiceGateMigration.match(/invoice_type <> ''credit_memo''/g)).toHaveLength(2);
    expect(orderInvoiceGateMigration.match(/invoice_type <> 'credit_memo'/g)).toHaveLength(2);
    expect(orderInvoiceGateMigration.match(/deleted_at IS NULL/g)).toHaveLength(4);
    expect(orderInvoiceGateMigration).not.toContain('EXECUTE format(');
    expect(functionBodySha256(orderInvoiceGateMigration, '_create_invoice_from_order_impl_20260718')).toBe('0d6ef022779bd6bc8ef694dab4ce9255053339eeb7d5e79e288d60eba15a6d28');
    expect(functionBodySha256(orderInvoiceGateMigration, '_create_split_invoices_from_order_provenance_impl_20260719')).toBe('ef8ed2b1e60554722eda863c953d997fd992c771f48ad9254f9e95155898df70');
    expect(orderInvoiceGateMigration).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(functionBodySha256(migration, '_allocated_delivery_cents')).toBe('44a739b026385996b66355ee5c4b1175dbe5260bad57a459a91e69c3873bae81');
    expect(migration).toContain("AND inv.invoice_type <> 'credit_memo'");
    expect(migration).toContain("'Return credit - ' || s.product_name");
    expect(migration).toContain('RETURN_COGS_POSTFLIGHT_DELIVERY_ALLOCATION_DRIFT');
    expect(migration).toContain("p.prorettype = 'void'::regtype");
    expect(migration).toContain("p.prorettype = 'jsonb'::regtype");
    expect(functionBodySha256(migration, '_issue_return_credit_impl')).toBe('292439b173e66b97945c0532f4cc069ff80168aa6933c374ba794e910bda9dd4');
    expect(functionBodySha256(migration, '_receive_return_impl_20260714')).toBe('150b7ad4f001929baecc73078c181de092477ced7b3a4b3f85bfb2d9438dd789');
    expect(migration).toContain("p_return_id = '0cb556ed-467a-4949-866d-8d9edbb09522'::uuid");
    expect(migration).toContain('v_restock_qty := v_item.quantity * v_container_size');
    expect(migration).toContain('ADD COLUMN restocked_quantity numeric');
    expect(migration).toContain('return_items_restocked_quantity_positive_chk');
    expect(migration).toContain('restocked_quantity = v_restock_qty');
    expect(functionBodySha256(migration, 'void_invoice')).toBe('7d1eb3222e0cd59318919206d2338de7477c2091f22550671ecbcf5ff80a9d14');
    expect(functionBodySha256(migration, 'unapply_credit_memo')).toBe('3d4fa59a934832eb1a058b7a0bfdfb12316ac1ef6cee32724b1cd9dc30d38d41');
    expect(functionBodySha256(migration, 'guard_return_credit_source_recognition')).toBe('bbff0678a006179be1f86ef01a0ae87713323b6b9338762d675b7ac28290d4f0');
    expect(functionBodySha256(migration, 'guard_recognized_return_credit_delete')).toBe('89c96dabb82f6dada53e0084d5c65e72f11ea0630b56cf6e4f7f99620be48a8d');
    expect(functionBodySha256(migration, 'guard_return_credit_lineage')).toBe('7c8747bc970ac3ddd3cc2ce26f1cfea449c6930e9fb8d87c709c8bcccafee3ff');
    expect(migration).toContain('bcc1c37c0256756656cbe06a04c9c8b36ea87703e9ce56f09f34a2f439f4b765');
    expect(migration).toContain('3d528e657bb97824f50145c7388f74da6da713d271268fba346e6e1a94cb84f7');
    expect(migration).toContain('24085771e3e024e9083140fe30f5bb3bbe5ecfb295d95f9df5ad2bcee1b0dc32');
    expect(migration).toContain('_issue_return_credit_header_only_impl_20260825');
    expect(migration).toContain('_receive_return_impl_before_inventory_seed_20260825');
    expect(migration).toContain('RETURN_COGS_POSTFLIGHT_CONTRACT_DRIFT');
    expect(migration).toContain('8db113f5da2277a791ca6f4744581faa1bc02fe532ca19fec93c8120f80c1a05');
    expect(functionBodySha256(invoiceLineageMigration, '_save_invoice_scoped_impl'))
      .toBe('cab2bde1aa6bf26d918639cfb8d328ac579d0b7f5429123aa24710a1a835866e');
    expect(functionBodySha256(invoiceLineageMigration, '_cancel_return_intent_impl_20260812'))
      .toBe('31d4fef2a8303aa3351b842cdd814ca38109fae8cc255df01929ffc745dc0618');
    expect(invoiceLineageMigration).toContain('RETURN_RESTOCKED_QUANTITY_MISSING');
    expect(invoiceLineageMigration).toContain('sum(ri.restocked_quantity) AS restocked_quantity');
    expect(invoiceLineageMigration).toContain('GROUP BY ri.product_id, inv.id, inv.location, inv.quantity_available');
    expect(invoiceLineageMigration).toContain('quantity_available - v_item.restocked_quantity');
    expect(invoiceLineageMigration).toContain('restocked_quantity = NULL');
    expect(invoiceLineageMigration).toContain('GENERATED_INVOICE_LINEAGE_LINE_REQUIRED');
    expect(invoiceLineageMigration).toContain('SET id = preserved.source_item_id');
    expect(invoiceLineageMigration).toContain('cost_cents = preserved.cost_cents');
    expect(invoiceLineageMigration).toContain('created_at = preserved.created_at');
    expect(returnCreditSmoke).toContain('generated invoice edit lost immutable order/cost lineage');
    expect(returnCreditSmoke).toContain('DELIVERY_RECEIVED_RETURN_REVERSAL_GUARDS_PROVEN');
    expect(returnCreditSmoke).toContain('LEGACY_RESTOCK_CANCEL_EXACT_PROVEN');
    expect(returnCreditSmoke).toContain('SAME_PRODUCT_CANCEL_AGGREGATE_GUARD_PROVEN');
    expect(returnCreditSmoke).toContain('MISSING_INVENTORY_CANCEL_GUARD_PROVEN');
    expect(returnCreditSmoke).toContain('RETURN_RESTOCK_INVENTORY_MISSING:%');
    expect(returnCreditSmoke).toContain('same-product cancel accepted 12 returned units with only 10 available');
  });

  it('keeps report status alignment in the separate report-only migration', () => {
    expect(reportMigration).toContain("status IN ('posted', 'overdue', 'paid')");
    expect(reportMigration).toContain("regexp_count(v_src, 'status IN \\(''posted'', ''overdue'', ''paid''\\)') <> 3");
    expect(reportMigration).toContain('get_customer_year_end_summary');
    expect(reportMigration).toContain("status IN ('posted', 'overdue') AND balance_cents > 0");
    expect(reportMigration).not.toContain('invoice_items (');
    expect(reportMigration).toContain('RECOGNIZED_INVOICE_REPORT_PREFLIGHT_EXISTING_RETURN_CREDIT');
    expect(reportMigration).toContain('LOCK TABLE public.returns IN SHARE ROW EXCLUSIVE MODE');
    expect(reportMigration).toContain("SET lock_timeout = '5s';");
    expect(reportMigration).toContain('RESET lock_timeout;');
    expect(reportMigration).toContain('CREATE TRIGGER aa_crx_block_return_credit_during_cogs_cutover');
    expect(reportMigration).toContain('RETURN_CREDIT_CUTOVER_IN_PROGRESS');
    expect(reportMigration).toContain('RECOGNIZED_INVOICE_REPORT_PREREQUISITE_MISSING');
    expect(reportMigration).toContain('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)');
    expect(reportMigration).toContain('public._restore_quote_version_below_cost_impl_20260810(uuid,uuid,uuid,text,bigint)');
    expect(migration).toContain('RETURN_COGS_CUTOVER_BARRIER_MISSING');
    expect(migration).not.toContain('DROP TRIGGER aa_crx_block_return_credit_during_cogs_cutover ON public.returns');
    for (const dependent of [deliveryCreditGateMigration, deliverySurfaceMigration, orderInvoiceGateMigration, invoiceLineageMigration]) {
      expect(dependent).toContain('RETURN_COGS_CUTOVER_BARRIER_DRIFTED');
    }
    expect(invoiceLineageMigration).toContain('DROP TRIGGER aa_crx_block_return_credit_during_cogs_cutover ON public.returns');
    const postflightEnd = invoiceLineageMigration.indexOf('$postflight$;');
    expect(postflightEnd).toBeGreaterThanOrEqual(0);
    expect(invoiceLineageMigration.indexOf('DROP TRIGGER aa_crx_block_return_credit_during_cogs_cutover')).toBeGreaterThan(
      postflightEnd,
    );
  });

  it('selects paid and overdue customers in both year-end batch callers', () => {
    expect(recognizedInvoiceCustomers).toContain(".in('status', ['posted', 'overdue', 'paid'])");
    expect(recognizedInvoiceCustomers).not.toContain(".in('status', ['posted', 'voided'])");
    expect(recognizedInvoiceCustomers).toContain(".order('id', { ascending: true })");
    expect(recognizedInvoiceCustomers).toContain('.range(from, to)');
    expect(recognizedInvoiceCustomers).toContain('from += rows.length');
    expect(recognizedInvoiceCustomers).toContain('getAssignedRecognizedInvoiceCustomerIds');
    for (const source of [reportsPage, monthEndPage]) {
      expect(source).toContain('getRecognizedInvoiceCustomerIds(season)');
    }
    expect(reportsPage).toContain("toast('error', sanitizeError(err))");
    expect(reportsPage).toContain('getAssignedRecognizedInvoiceCustomerIds(discoveredIds, profile.id)');
    expect(recognizedInvoiceCustomers).toContain(".eq('assigned_sales_rep', salesRepId)");
    expect(recognizedInvoiceCustomers).not.toContain(".eq('is_active', true)");
    expect(reportsPage).toContain("toast('error', sanitizeError(batchError))");
    expect(monthEndPage).toContain("toast('error', sanitizeError(batchError))");
    expect(monthEndPage).toContain('Recognized Invoices');
    expect(monthEndPage).toContain('recognized, ${summary.invoices.voided_count} voided');
    expect(monthEndPage).not.toContain('Posted Invoices');
    expect(customerDetailPage).toContain("toast('error', sanitizeError(err))");
    expect(customerDetailPage).not.toContain("err instanceof Error ? err.message : 'Failed to generate summary'");
    const batchPostStart = invoicesPage.indexOf('const handleBatchPost = async () =>');
    const batchPrintStart = invoicesPage.indexOf('const handleBatchPrint = async (');
    expect(batchPostStart).toBeGreaterThanOrEqual(0);
    expect(batchPrintStart).toBeGreaterThan(batchPostStart);
    const batchPostHandler = invoicesPage.slice(batchPostStart, batchPrintStart);
    expect(batchPostHandler).toContain('failures.push(`${target.label}: ${sanitizeError(err)}`)');
    expect(invoiceSource).toContain('id: it.id');
    expect(invoiceSource).toContain('order_item_id: it.order_item_id');
  });

  it('clears return-credit bypass settings on delegated failures and detects reset removal', () => {
    const settings = ['app.crx_return_credit_void', 'app.crx_return_credit_unapply'];
    for (const setting of settings) {
      expect(() => assertExceptionReset(migration, setting)).not.toThrow();
      const mutant = migration.replace(
        `PERFORM set_config('${setting}', '0', true);`,
        `PERFORM set_config('${setting}', '1', true); -- mutation: reset removed`,
      );
      expect(mutant).not.toBe(migration);
      expect(() => assertExceptionReset(mutant, setting)).toThrow(`${setting} is not reset before re-raising`);
    }
  });

  it('gives sales reps one clear empty-assignment message', () => {
    expect(reportsPage).toContain('if (skippedCount > 0 && uniqueIds.length > 0)');
    expect(reportsPage).toContain('No assigned customers have invoices for season');
  });

  it('measures report behavior as a fixture delta instead of company-wide absolutes', () => {
    expect(returnCreditSmoke).toContain('v_pnl_revenue_before');
    expect(returnCreditSmoke).toContain('v_cents - v_pnl_revenue_before <> -1000');
    expect(returnCreditSmoke).toContain("(v_res #>> '{invoices,posted_count}')::bigint - v_monthly_posted_before <> 4");
    expect(returnCreditSmoke).toContain("(v_res #>> '{invoices,total_amount_cents}')::bigint - v_monthly_amount_before <> -1000");
    expect(returnCreditSmoke).toContain("(v_res #>> '{invoices,total_cost_cents}')::numeric - v_monthly_cost_before <> 501");
    expect(returnCreditSmoke).toContain('FRACTIONAL_COGS_EXPECTED_251');
    expect(returnCreditSmoke).toContain('FRACTIONAL_COGS_EXPECTED_250');
    expect(returnCreditSmoke).toContain('RETURN_CREDIT_COGS_BACKDATED_EXPECTED_375');
    expect(returnCreditSmoke).toContain('backdated same-cost cumulative COGS=% (expected 626)');
    expect(returnCreditSmoke).toContain('RETURN_CREDIT_EQUAL_TIMESTAMP_TIEBREAK_PROVEN');
    expect(returnCreditSmoke).toContain("'00000000-0000-4000-8000-00000000f001'");
    expect(returnCreditSmoke).toContain("'00000000-0000-4000-8000-00000000f002'");
    expect(returnCreditSmoke).toMatch(/00000000-0000-4000-8000-00000000f001[\s\S]*?'gal', now\(\)/);
    expect(returnCreditSmoke).toMatch(/00000000-0000-4000-8000-00000000f002[\s\S]*?'gal', now\(\)/);
    expect(returnCreditSmoke).toContain('current-season return credit restated the source-season year-end summary');
    expect(returnCreditSmoke).toContain('current-season credit usage quantity=% value=% (expected -15/-15000)');
    expect(returnCreditSmoke).toContain("legacy 15-each return was not converted to 37.5 gallons");
  });

  it('pins the reviewed live year-end body before replacing it', () => {
    expect(reportMigration).toContain('34d92979d8d5dbc6f3eff7ebc3daaec4833baeac8917044c89c0af16e00624e7');
    expect(reportMigration).toContain("p.proconfig = ARRAY['search_path=public, pg_temp']::text[]");
    expect(reportMigration).toContain('RECOGNIZED_INVOICE_REPORT_PREFLIGHT_YEAR_END_DRIFT');
    expect(reportMigration).toContain('4d4515042f0b2fab834ad22ba79f877c9cc444e920402593bfc5947f5ff382f4');
    expect(reportMigration).toContain('ad1432467c3739bd581b42729a2b7bc7d0ff19a60736481881d5ae1ddebbab05');
    expect(reportMigration).toContain('fae61d495af1f6bb0ab690d6cb9d6d111a3a6e387e0c047f9f8c0d568bd49680');
  });

  it('fail-closes year-end financial data to admins or the assigned sales rep', () => {
    expect(reportMigration).toContain('PERFORM public.require_admin_or_sales_rep()');
    expect(reportMigration).toContain('IF NOT public.is_admin()');
    expect(reportMigration).toContain('c.assigned_sales_rep = auth.uid()');
    expect(reportMigration).toContain("RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'");
    expect(reportMigration).toContain('RECOGNIZED_INVOICE_REPORT_POSTFLIGHT_BATCH_WRAPPER');
  });

  it('pins the exact postflight body source for every redefined report RPC', () => {
    expect(functionBodySha256(reportMigration, 'get_bottom_line_pnl')).toBe('307c94d4e8de83c91b0b7ca680d529c6834e56ef5bc5b10c5c6d054fc1a265d2');
    expect(functionBodySha256(reportMigration, 'get_monthly_summary')).toBe('c90c10378f5fc2feb8c41554f0fbc85280f55ca3b637e7b24654055e3dfe8330');
    expect(functionBodySha256(reportMigration, 'get_customer_year_end_summary')).toBe('983e802e334a70cb2a627447b8760d3830a690dab789d26e161a7f590efe1bfe');
  });

  it('keeps function body proof hashes stable across LF and CRLF checkouts', () => {
    expect(functionBodySha256(reportMigration, 'get_bottom_line_pnl')).toBe(
      functionBodySha256(reportMigration.replace(/\r?\n/g, '\r\n'), 'get_bottom_line_pnl'),
    );
    expect(reportMigration).toContain("replace(v_src, chr(13) || chr(10), chr(10))");
    expect(migration).toContain("replace(v_src, chr(13) || chr(10), chr(10))");
    const migrationSha256 = createHash('sha256')
      .update(migration.replace(/\r\n/g, '\n'), 'utf8')
      .digest('hex');
    expect(migrationSha256).toBe('a42777c989083e790d9d67f1c0ff3d24f98206a90f09a614a14055e8db3ab1c1');
    expect(migrationHistory).toContain(`SQL sha256: \`${migrationSha256}\` (LF-normalized bytes)`);
    const deliverySurfaceSha256 = createHash('sha256')
      .update(deliverySurfaceMigration.replace(/\r\n/g, '\n'), 'utf8')
      .digest('hex');
    expect(deliverySurfaceSha256).toBe('6a82256d2e252641469bba409e96a98fd8f10750e413eb869fbd0f70cfe1f3ea');
    expect(migrationHistory).toContain(`SQL sha256: \`${deliverySurfaceSha256}\` (LF-normalized bytes)`);
    const orderInvoiceGateSha256 = createHash('sha256')
      .update(orderInvoiceGateMigration.replace(/\r\n/g, '\n'), 'utf8')
      .digest('hex');
    expect(orderInvoiceGateSha256).toBe('9a27f42ee070404f7de19ccc312aa80eba31d0344f2cb5c2d639aa87a59bf417');
    expect(migrationHistory).toContain(`SQL sha256: \`${orderInvoiceGateSha256}\` (LF-normalized bytes)`);
    const invoiceLineageSha256 = createHash('sha256')
      .update(invoiceLineageMigration.replace(/\r\n/g, '\n'), 'utf8')
      .digest('hex');
    expect(invoiceLineageSha256).toBe('720f82c80671fab9099d0d28a5e6eee658d8af4138ab3f5c0304ed00613ac779');
    expect(migrationHistory).toContain(`SQL sha256: \`${invoiceLineageSha256}\` (LF-normalized bytes)`);
  });

  it('does not claim field profitability consumes the credit-memo COGS reversal', () => {
    expect(migrationHistory).toContain(
      "Live `get_field_profitability` is different: it reads `invoices.total_cost_cents` and scopes itself to `invoice_type = 'field_application'`, so it excludes credit memos and does not carry this reversal.",
    );
    expect(migrationHistory).not.toContain(
      'the invoice-basis RPCs (`get_bottom_line_pnl`, `get_monthly_summary`, field profitability) derive cost from `invoice_items.cost_cents`',
    );
    expect(migrationHistory).not.toContain('20260825161340_return_credit_cogs_reversal_current');
  });
});
