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
const migrationHistory = readFileSync('docs/reference/migration-history.md', 'utf8');
const reportsPage = readFileSync('src/pages/Reports.tsx', 'utf8');
const monthEndPage = readFileSync('src/pages/MonthEndClose.tsx', 'utf8');
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
    expect(migration).toContain('BEFORE UPDATE OF status, deleted_at, total_amount_cents, total_cost_cents, season OR DELETE ON public.invoices');
    expect(migration).toContain('aa_crx_guard_return_credit_lineage');
    expect(migration).toContain('BEFORE UPDATE OF invoice_id, order_item_id, product_id, quantity, unit_price_cents, extended_cents, cost_cents, unit_size OR DELETE');
    expect(migration).toContain('ROW(NEW.invoice_id, NEW.order_item_id, NEW.product_id, NEW.quantity, NEW.unit_price_cents, NEW.extended_cents, NEW.cost_cents, NEW.unit_size)');
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
    expect(migration).toContain('SUM(ri.quantity)');
    expect(migration).toContain('RETURN_CREDIT_PARENT_IMMUTABLE');
    expect(migration).toContain('RETURN_CREDIT_LINE_TOTAL_MISMATCH');
    expect(migration).toContain('BEFORE UPDATE OF status, deleted_at, total_amount_cents, total_cost_cents, season OR DELETE');
    expect(migration).toContain('ROW(NEW.total_amount_cents, NEW.total_cost_cents, NEW.season)');
    expect(migration).toContain('CREATE TRIGGER aa_crx_guard_recognized_return_credit_delete');
    expect(migration).toContain("p.proname = 'current_season'");
    expect(migration).toContain("to_regprocedure('public.current_season()')");
    expect(migration).toContain("p.prorettype = 'integer'::regtype");
    expect(migration).toContain("p.provolatile = 's'");
    expect(migration).toContain("p.proconfig = ARRAY['search_path=public']::text[]");
    expect(migration.match(/0b9ef2b922c909de0cea7757bcfe95901c0781739eddd8521b09cfb1537907ba/g)).toHaveLength(2);
    expect(migration).toContain('RETURN_COGS_POSTFLIGHT_CURRENT_SEASON_DRIFT');
    expect(migration).toContain('SET total_cost_cents = -v_cogs, season = public.current_season()');
    expect(migration).not.toContain('RETURN_CREDIT_SOURCE_SEASON_AMBIGUOUS');
    expect(returnCreditSmoke).toContain("PERFORM void_invoice(v_credit_id, '[SMOKE] chain void'");
    expect(returnCreditSmoke).toContain("operation_type = 'invoice_voided'");
    expect(returnCreditSmoke).toContain("issue_return_credit(v_return_id, v_admin, 'smk-rcc-' || v_suffix || '-reissue')");
    expect(returnCreditSmoke).toContain('batch void did not route the return credit through void_invoice');
    expect(returnCreditSmoke).toContain('assigned-only sales-rep year-end batch returned');
    expect(returnCreditSmoke).toContain('RETURN_CREDIT_DASHBOARD_UNBILLED_PROVEN');
    expect(returnCreditSmoke).toContain('SMK-RCC-DELETED-');
  });

  it('pins the replacement helper bodies used by the COGS postflight', () => {
    expect(functionBodySha256(allocatedDeliveryMigration, '_allocated_delivery_cents')).toBe('1df1d230c19e5d129038b1e5dfbca30db0b369ea5a91a22f19dd98cc53129142');
    expect(functionBodySha256(allocatedDeliveryMigration, '_complete_delivery_authorized_impl')).toBe('0e889bb6e0bc998d2833081e8e6f8e801e032595e7360e09d4f594e13ed7ad24');
    expect(functionBodySha256(allocatedDeliveryMigration, '_create_invoice_for_unbilled_delivery_impl_20260718')).toBe('6543165d2c7cb6acbffd222adb28fee9b66278338ec401f6b2f19537c8aebcaa');
    expect(functionBodySha256(deliveryCreditGateMigration, '_complete_delivery_authorized_impl')).toBe('15c5a7ddf836f402d52544a69b8628061b4e9042444362262c1d76d26916ee69');
    expect(functionBodySha256(deliveryCreditGateMigration, '_create_invoice_for_unbilled_delivery_impl_20260718')).toBe('d74e002a01fffedbb69322174f1da1cad8b86b0df4312c5ac56257f1f6077f5f');
    expect(deliveryCreditGateMigration.match(/AND invoice_type <> 'credit_memo'/g)).toHaveLength(2);
    expect(deliveryCreditGateMigration).toContain('UNBILLED_DELIVERY_RETURN_CREDIT_GATE_PREFLIGHT_CONTRACT_DRIFT');
    expect(deliveryCreditGateMigration).toContain('UNBILLED_DELIVERY_RETURN_CREDIT_GATE_POSTFLIGHT_DRIFT');
    expect(functionBodySha256(deliverySurfaceMigration, 'get_dashboard_action_items')).toBe('583519bf36990ea38eac510ce46aeaf0425b13964abbab2fded53d442e60a769');
    expect(functionBodySha256(deliverySurfaceMigration, 'void_delivery')).toBe('d7f0465616be4e125c0b5a1fd2b15a8b0b502b2f2ecaaeb4a981abb599837d25');
    expect(functionBodySha256(deliverySurfaceMigration, 'cancel_delivery')).toBe('73be159b6793fb16580a702068974102e6ef12794be9f38af861b92e9d6495dd');
    expect(functionBodySha256(deliverySurfaceMigration, '_complete_delivery_authorized_impl')).toBe('3c2dc6185c3f0de6beb32641f3963eacc4845ca2c22ad2575a72d2cb2892594a');
    expect(deliverySurfaceMigration.match(/invoice_type <> 'credit_memo'/g)).toHaveLength(7);
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
    expect(orderInvoiceGateMigration).toContain('c8b12fc25025e598846b6b2fbdfe4e0fd0e30078086b17194807f1428b9d0d7e');
    expect(orderInvoiceGateMigration).toContain('9d3de61eb30e9b9435556da45fe17c15a1b83285c917e3a5e7c2893cb4428104');
    expect(orderInvoiceGateMigration.match(/invoice_type <> ''credit_memo''/g)).toHaveLength(4);
    expect(orderInvoiceGateMigration.match(/deleted_at IS NULL/g)).toHaveLength(4);
    expect(orderInvoiceGateMigration).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(functionBodySha256(migration, '_allocated_delivery_cents')).toBe('44a739b026385996b66355ee5c4b1175dbe5260bad57a459a91e69c3873bae81');
    expect(migration).toContain("AND inv.invoice_type <> 'credit_memo'");
    expect(migration).toContain("'Return credit - ' || s.product_name");
    expect(migration).toContain('RETURN_COGS_POSTFLIGHT_DELIVERY_ALLOCATION_DRIFT');
    expect(migration).toContain("p.prorettype = 'void'::regtype");
    expect(migration).toContain("p.prorettype = 'jsonb'::regtype");
    expect(functionBodySha256(migration, '_issue_return_credit_impl')).toBe('4724b26d13c30047b37c187b4a4d9058db2c35c531b825c8c040d90a7a3e3881');
    expect(functionBodySha256(migration, '_receive_return_impl_20260714')).toBe('722ff281a364867058154c1c7d8060c6c6ea16a60f4c8764005d6ba0c8f0ef28');
    expect(functionBodySha256(migration, 'void_invoice')).toBe('7d1eb3222e0cd59318919206d2338de7477c2091f22550671ecbcf5ff80a9d14');
    expect(functionBodySha256(migration, 'unapply_credit_memo')).toBe('005ce6a1cfbc7c7f7fcf4712104235bf884af9bc5b30e5f3cbf1edc0f2b6e63e');
    expect(functionBodySha256(migration, 'guard_return_credit_source_recognition')).toBe('cce665d2c4b34a2b253a9e4518599f75d489309f25cc402fe6ae59269c41442e');
    expect(functionBodySha256(migration, 'guard_recognized_return_credit_delete')).toBe('89c96dabb82f6dada53e0084d5c65e72f11ea0630b56cf6e4f7f99620be48a8d');
    expect(functionBodySha256(migration, 'guard_return_credit_lineage')).toBe('7b5ccb72380c54cd2a202f891de659bce1b916c09c76ad9884446ba1544dd89f');
    expect(migration).toContain('0f0ad06a8e8fe0994d051fc5b6659cef04f9f16829cbf9998e8b3f1265a257cb');
    expect(migration).toContain('3d528e657bb97824f50145c7388f74da6da713d271268fba346e6e1a94cb84f7');
    expect(migration).toContain('cc146431df3ab52d734ce3f62189bbbd51e3779ce64cfa789ee829e704f9e27c');
    expect(migration).toContain('_issue_return_credit_header_only_impl_20260825');
    expect(migration).toContain('_receive_return_impl_before_inventory_seed_20260825');
    expect(migration).toContain('RETURN_COGS_POSTFLIGHT_CONTRACT_DRIFT');
    expect(migration).toContain('8db113f5da2277a791ca6f4744581faa1bc02fe532ca19fec93c8120f80c1a05');
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
    expect(migration).toContain('RETURN_COGS_CUTOVER_BARRIER_MISSING');
    expect(migration).toContain('DROP TRIGGER aa_crx_block_return_credit_during_cogs_cutover ON public.returns');
    expect(migration.indexOf('DROP TRIGGER aa_crx_block_return_credit_during_cogs_cutover')).toBeGreaterThan(
      migration.indexOf('$postflight$;'),
    );
  });

  it('selects paid and overdue customers in both year-end batch callers', () => {
    for (const source of [reportsPage, monthEndPage]) {
      expect(source).toContain(".in('status', ['posted', 'overdue', 'paid'])");
      expect(source).not.toContain(".in('status', ['posted', 'voided'])");
    }
    expect(reportsPage).toContain("toast('error', sanitizeError(err))");
    const assignedCustomerQuery = reportsPage.match(
      /const \{ data: assignedCustomers[\s\S]*?if \(assignedError\)/,
    )?.[0];
    expect(assignedCustomerQuery).toContain(".eq('assigned_sales_rep', profile.id)");
    expect(assignedCustomerQuery).not.toContain(".eq('is_active', true)");
    expect(reportsPage).toContain("toast('error', sanitizeError(batchError))");
    expect(monthEndPage).toContain("toast('error', sanitizeError(batchError))");
    expect(monthEndPage).toContain('Recognized Invoices');
    expect(monthEndPage).toContain('recognized, ${summary.invoices.voided_count} voided');
    expect(monthEndPage).not.toContain('Posted Invoices');
    expect(customerDetailPage).toContain("toast('error', sanitizeError(err))");
    expect(customerDetailPage).not.toContain("err instanceof Error ? err.message : 'Failed to generate summary'");
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
    expect(returnCreditSmoke).toContain('current-season return credit restated the source-season year-end summary');
    expect(returnCreditSmoke).toContain('current-season credit usage quantity=% value=% (expected -15/-15000)');
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
