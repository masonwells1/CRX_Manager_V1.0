-- Supplier Pricing Phase 3 Stage A return-policy matrix.
-- Execute as one transaction after 20260722222743 is applied.  The terminal
-- exception is intentional and rolls every [SMOKE] fixture back.
DO $smoke$
DECLARE
  v_admin uuid;
  v_sales uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_unknown uuid;
  v_returnable uuid;
  v_blocked uuid;
  v_other uuid;
  v_order uuid;
  v_item uuid;
  v_return uuid;
  v_credit uuid;
  v_returnable_order uuid;
  v_returnable_item uuid;
  v_returnable_return uuid;
  v_reject_order uuid;
  v_reject_item uuid;
  v_reject_return uuid;
  v_cancel_order uuid;
  v_cancel_item uuid;
  v_cancel_return uuid;
  v_force_order uuid;
  v_force_item uuid;
  v_force_return uuid;
  v_before_inventory numeric;
  v_before_count bigint;
  v_before_status text;
  v_result jsonb;
  v_reason text;
  v_n int;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role='admin' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_sales FROM public.profiles WHERE role='sales_rep' AND is_active ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_sales IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin and sales_rep required'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  INSERT INTO public.customers(farm_name) VALUES ('[SMOKE] Phase3 policy '||v_suffix) RETURNING id INTO v_customer;
  -- Default Product INSERT is a compatibility control: all metadata is dormant.
  INSERT INTO public.products(product_name) VALUES ('[SMOKE] unknown '||v_suffix) RETURNING id INTO v_unknown;
  SELECT count(*) INTO v_n FROM public.products WHERE id=v_unknown AND product_family_id IS NULL AND return_policy='unknown' AND packaging_variant IS NULL AND is_full_tote_only=false;
  IF v_n<>1 THEN RAISE EXCEPTION 'SMOKE_FAIL: default Product INSERT did not retain Phase3 defaults'; END IF;
  -- Owner-only transaction context is the Stage C path; it creates no durable classification here.
  PERFORM set_config('app.phase3_metadata_authorized','true',true);
  INSERT INTO public.products(product_name,return_policy) VALUES ('[SMOKE] returnable '||v_suffix,'returnable') RETURNING id INTO v_returnable;
  INSERT INTO public.products(product_name,return_policy) VALUES ('[SMOKE] blocked '||v_suffix,'no_return') RETURNING id INTO v_blocked;
  INSERT INTO public.products(product_name) VALUES ('[SMOKE] other '||v_suffix) RETURNING id INTO v_other;
  PERFORM set_config('app.phase3_metadata_authorized','false',true);
  BEGIN
    INSERT INTO public.products(product_name,return_policy) VALUES ('[SMOKE] forbidden metadata '||v_suffix,'no_return');
    RAISE EXCEPTION 'SMOKE_FAIL: direct nondefault Product INSERT was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRODUCT_PHASE3_METADATA_GOVERNED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected governed INSERT refusal, got %',SQLERRM; END IF;
  END;
  BEGIN
    UPDATE public.products SET return_policy='no_return' WHERE id=v_unknown;
    RAISE EXCEPTION 'SMOKE_FAIL: direct metadata UPDATE was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'PRODUCT_PHASE3_METADATA_GOVERNED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected governed UPDATE refusal, got %',SQLERRM; END IF;
  END;
  IF has_function_privilege('anon','public.set_product_phase3_metadata(uuid,uuid,text,text,boolean,uuid,text,text,boolean,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.set_product_phase3_metadata(uuid,uuid,text,text,boolean,uuid,text,text,boolean,text)','EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: metadata RPC is executable by an app role';
  END IF;

  INSERT INTO public.orders(order_number,customer_id,salesman_id) VALUES ('SMK-P3-'||v_suffix,v_customer,v_admin) RETURNING id INTO v_order;
  INSERT INTO public.order_items(order_id,product_id,product_name,price_per_unit,total_units_needed,unit_size,total_price,quantity_delivered,quantity_remaining)
  VALUES(v_order,v_unknown,'[SMOKE] unknown',10,4,'ea',40,4,0) RETURNING id INTO v_item;
  -- sales_rep positive control proves the public wrapper remains available.
  PERFORM set_config('request.jwt.claim.sub', v_sales::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v_result:=public.create_return(jsonb_build_object('customer_id',v_customer,'order_id',v_order,'reason','overstock'),jsonb_build_array(jsonb_build_object('order_item_id',v_item,'quantity',1,'condition','unopened','restock',false)),'smk-p3-'||v_suffix||'-unknown');
  v_return:=(v_result->>'return_id')::uuid;
  IF v_return IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: unknown policy did not create return'; END IF;
  -- The public governed metadata API refuses every active lifecycle state.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM public.set_product_phase3_metadata(v_unknown,NULL,'unknown',NULL,false,NULL,'no_return',NULL,false,'smk-p3-'||v_suffix||'-requested-metadata');
    RAISE EXCEPTION 'SMOKE_FAIL: active requested return permitted metadata change';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RETURN_POLICY_ACTIVE_RETURN%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected active-return guard, got %',SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub', v_sales::text, true);
  v_result:=public.approve_return(v_return,v_sales,'smk-p3-'||v_suffix||'-approve');
  IF v_result->>'status' IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'SMOKE_FAIL: unknown approve %',v_result; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM public.set_product_phase3_metadata(v_unknown,NULL,'unknown',NULL,false,NULL,'no_return',NULL,false,'smk-p3-'||v_suffix||'-approved-metadata');
    RAISE EXCEPTION 'SMOKE_FAIL: active approved return permitted metadata change';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RETURN_POLICY_ACTIVE_RETURN%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected approved active-return guard, got %',SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub', v_sales::text, true);
  v_result:=public.receive_return(v_return,v_sales,'smk-p3-'||v_suffix||'-receive');
  IF v_result->>'status' IS DISTINCT FROM 'received' THEN RAISE EXCEPTION 'SMOKE_FAIL: unknown receive %',v_result; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM public.set_product_phase3_metadata(v_unknown,NULL,'unknown',NULL,false,NULL,'no_return',NULL,false,'smk-p3-'||v_suffix||'-received-metadata');
    RAISE EXCEPTION 'SMOKE_FAIL: active received return permitted metadata change';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RETURN_POLICY_ACTIVE_RETURN%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected received active-return guard, got %',SQLERRM; END IF;
  END;
  PERFORM set_config('request.jwt.claim.sub', v_sales::text, true);

  -- Returnable remains a positive, full real-wrapper control: requested ->
  -- approved -> received (restock) -> credited.  This is distinct from the
  -- dormant unknown compatibility chain above.
  INSERT INTO public.orders(order_number,customer_id,salesman_id) VALUES ('SMK-P3-RET-'||v_suffix,v_customer,v_sales) RETURNING id INTO v_returnable_order;
  INSERT INTO public.order_items(order_id,product_id,product_name,price_per_unit,total_units_needed,unit_size,total_price,quantity_delivered,quantity_remaining)
  VALUES(v_returnable_order,v_returnable,'[SMOKE] returnable',10,4,'ea',40,4,0) RETURNING id INTO v_returnable_item;
  INSERT INTO public.inventory(product_id,location,quantity_available,unit_size) VALUES(v_returnable,'Main Warehouse',7,'ea');
  v_result:=public.create_return(jsonb_build_object('customer_id',v_customer,'order_id',v_returnable_order,'reason','overstock'),jsonb_build_array(jsonb_build_object('order_item_id',v_returnable_item,'quantity',2,'condition','unopened','restock',true)),'smk-p3-'||v_suffix||'-returnable-create');
  v_returnable_return:=(v_result->>'return_id')::uuid;
  IF v_returnable_return IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: returnable create failed'; END IF;
  v_result:=public.approve_return(v_returnable_return,v_sales,'smk-p3-'||v_suffix||'-returnable-approve');
  IF v_result->>'status' IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'SMOKE_FAIL: returnable approve %',v_result; END IF;
  SELECT quantity_available INTO v_before_inventory FROM public.inventory WHERE product_id=v_returnable AND location='Main Warehouse';
  v_result:=public.receive_return(v_returnable_return,v_sales,'smk-p3-'||v_suffix||'-returnable-receive');
  IF v_result->>'status' IS DISTINCT FROM 'received' OR v_result->>'restocked_quantity' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'SMOKE_FAIL: returnable receive %',v_result; END IF;
  IF (SELECT quantity_available FROM public.inventory WHERE product_id=v_returnable AND location='Main Warehouse') IS DISTINCT FROM v_before_inventory+2
     OR (SELECT count(*) FROM public.inventory_transactions WHERE product_id=v_returnable AND transaction_type='returned') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: returnable receive did not restock exactly once';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result:=public.issue_return_credit(v_returnable_return,v_admin,'smk-p3-'||v_suffix||'-returnable-credit');
  v_credit:=(v_result->>'credit_invoice_id')::uuid;
  IF v_result->>'success' IS DISTINCT FROM 'true' OR v_credit IS NULL
     OR (SELECT status FROM public.returns WHERE id=v_returnable_return) IS DISTINCT FROM 'credited'
     OR (SELECT count(*) FROM public.financial_audit_log WHERE entity_id=v_returnable_return OR new_values->>'return_id'=v_returnable_return::text) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: returnable credit did not create exact invoice/audit chain %',v_result;
  END IF;
  -- Credited is deliberately not an active-return conflict. The governed
  -- change succeeds, then unapply (a reversal path) remains legal and the
  -- re-credit is stopped by the real policy wrapper before money effects.
  PERFORM public.set_product_phase3_metadata(v_returnable,NULL,'returnable',NULL,false,NULL,'no_return',NULL,false,'smk-p3-'||v_suffix||'-credited-metadata');
  IF (SELECT return_policy FROM public.products WHERE id=v_returnable) IS DISTINCT FROM 'no_return' THEN RAISE EXCEPTION 'SMOKE_FAIL: credited Product did not accept governed no_return'; END IF;
  v_result:=public.unapply_credit_memo(v_credit,'Phase 3 rollback reversal',v_admin,'smk-p3-'||v_suffix||'-unapply');
  IF v_result->>'success' IS DISTINCT FROM 'true' OR (SELECT status FROM public.returns WHERE id=v_returnable_return) IS DISTINCT FROM 'received' THEN RAISE EXCEPTION 'SMOKE_FAIL: unapply did not preserve reversal boundary %',v_result; END IF;
  SELECT count(*) INTO v_before_count FROM public.invoices;
  BEGIN
    PERFORM public.issue_return_credit(v_returnable_return,v_admin,'smk-p3-'||v_suffix||'-blocked-recredit');
    RAISE EXCEPTION 'SMOKE_FAIL: no_return re-credit was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RETURN_POLICY_NO_RETURN%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected no_return re-credit refusal, got %',SQLERRM; END IF;
  END;
  IF (SELECT status FROM public.returns WHERE id=v_returnable_return) IS DISTINCT FROM 'received'
     OR (SELECT count(*) FROM public.invoices) IS DISTINCT FROM v_before_count
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key='smk-p3-'||v_suffix||'-blocked-recredit') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: blocked re-credit leaked effects';
  END IF;

  -- No-return is directly reachable for create_return and must fail before a
  -- return row, line, activity, or idempotency result exists.
  PERFORM set_config('request.jwt.claim.sub', v_sales::text, true);
  INSERT INTO public.orders(order_number,customer_id,salesman_id) VALUES ('SMK-P3-NR-'||v_suffix,v_customer,v_sales) RETURNING id INTO v_force_order;
  INSERT INTO public.order_items(order_id,product_id,product_name,price_per_unit,total_units_needed,unit_size,total_price,quantity_delivered,quantity_remaining)
  VALUES(v_force_order,v_blocked,'[SMOKE] no return',10,4,'ea',40,4,0) RETURNING id INTO v_force_item;
  BEGIN
    PERFORM public.create_return(jsonb_build_object('customer_id',v_customer,'order_id',v_force_order,'reason','overstock'),jsonb_build_array(jsonb_build_object('order_item_id',v_force_item,'quantity',1,'condition','unopened','restock',false)),'smk-p3-'||v_suffix||'-blocked-create');
    RAISE EXCEPTION 'SMOKE_FAIL: no_return create was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RETURN_POLICY_NO_RETURN%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected no_return create refusal, got %',SQLERRM; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.returns WHERE order_id=v_force_order)
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key='smk-p3-'||v_suffix||'-blocked-create') THEN RAISE EXCEPTION 'SMOKE_FAIL: no_return create leaked effects'; END IF;

  -- Policy does not interfere with retire-only reversal wrappers.
  INSERT INTO public.orders(order_number,customer_id,salesman_id) VALUES ('SMK-P3-REJ-'||v_suffix,v_customer,v_sales) RETURNING id INTO v_reject_order;
  INSERT INTO public.order_items(order_id,product_id,product_name,price_per_unit,total_units_needed,unit_size,total_price,quantity_delivered,quantity_remaining)
  VALUES(v_reject_order,v_other,'[SMOKE] reject',10,4,'ea',40,4,0) RETURNING id INTO v_reject_item;
  v_result:=public.create_return(jsonb_build_object('customer_id',v_customer,'order_id',v_reject_order,'reason','overstock'),jsonb_build_array(jsonb_build_object('order_item_id',v_reject_item,'quantity',1,'condition','unopened','restock',false)),'smk-p3-'||v_suffix||'-reject-create');
  v_reject_return:=(v_result->>'return_id')::uuid;
  v_result:=public.reject_return(v_reject_return,v_sales,'smk-p3-'||v_suffix||'-reject');
  IF v_result->>'status' IS DISTINCT FROM 'rejected' THEN RAISE EXCEPTION 'SMOKE_FAIL: reject boundary %',v_result; END IF;
  INSERT INTO public.orders(order_number,customer_id,salesman_id) VALUES ('SMK-P3-CAN-'||v_suffix,v_customer,v_sales) RETURNING id INTO v_cancel_order;
  INSERT INTO public.order_items(order_id,product_id,product_name,price_per_unit,total_units_needed,unit_size,total_price,quantity_delivered,quantity_remaining)
  VALUES(v_cancel_order,v_other,'[SMOKE] cancel',10,4,'ea',40,4,0) RETURNING id INTO v_cancel_item;
  v_result:=public.create_return(jsonb_build_object('customer_id',v_customer,'order_id',v_cancel_order,'reason','overstock'),jsonb_build_array(jsonb_build_object('order_item_id',v_cancel_item,'quantity',1,'condition','unopened','restock',false)),'smk-p3-'||v_suffix||'-cancel-create');
  v_cancel_return:=(v_result->>'return_id')::uuid;
  v_result:=public.cancel_return(v_cancel_return,'Phase 3 rollback cancellation',v_sales,'smk-p3-'||v_suffix||'-cancel');
  IF v_result->>'status' IS DISTINCT FROM 'cancelled' THEN RAISE EXCEPTION 'SMOKE_FAIL: cancel boundary %',v_result; END IF;

  -- These disposable-only BEFORE triggers fail after each real wrapper has
  -- already reached a late side-effect boundary. They are created inside this
  -- rollback-only DO statement and are never installed in a committed schema.
  EXECUTE $sql$
    CREATE FUNCTION public.smoke_phase3_late_activity() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF current_setting('app.phase3_smoke_force', true) = 'return_requested' AND NEW.event_type = 'return_requested' THEN
        RAISE EXCEPTION 'SMOKE_FORCED_RETURN_REQUESTED';
      ELSIF current_setting('app.phase3_smoke_force', true) = 'return_approved' AND NEW.event_type = 'return_approved' THEN
        RAISE EXCEPTION 'SMOKE_FORCED_RETURN_APPROVED';
      END IF;
      RETURN NEW;
    END;
    $fn$
  $sql$;
  EXECUTE $sql$
    CREATE FUNCTION public.smoke_phase3_late_inventory_transaction() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF current_setting('app.phase3_smoke_force', true) = 'return_received' AND NEW.transaction_type = 'returned' THEN
        RAISE EXCEPTION 'SMOKE_FORCED_RETURN_RECEIVED';
      END IF;
      RETURN NEW;
    END;
    $fn$
  $sql$;
  EXECUTE $sql$
    CREATE FUNCTION public.smoke_phase3_late_credit_audit() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF current_setting('app.phase3_smoke_force', true) = 'credit_issued' AND NEW.operation_type = 'return_credit_issued' THEN
        RAISE EXCEPTION 'SMOKE_FORCED_CREDIT_ISSUED';
      END IF;
      RETURN NEW;
    END;
    $fn$
  $sql$;
  EXECUTE 'CREATE TRIGGER smoke_phase3_late_activity BEFORE INSERT ON public.activity_feed FOR EACH ROW EXECUTE FUNCTION public.smoke_phase3_late_activity()';
  EXECUTE 'CREATE TRIGGER smoke_phase3_late_inventory_transaction BEFORE INSERT ON public.inventory_transactions FOR EACH ROW EXECUTE FUNCTION public.smoke_phase3_late_inventory_transaction()';
  EXECUTE 'CREATE TRIGGER smoke_phase3_late_credit_audit BEFORE INSERT ON public.financial_audit_log FOR EACH ROW EXECUTE FUNCTION public.smoke_phase3_late_credit_audit()';

  -- return_requested: return and return_items are inserted before activity; a
  -- forced late activity failure must erase all three and the idempotency row.
  INSERT INTO public.orders(order_number,customer_id,salesman_id) VALUES ('SMK-P3-FORCE-C-'||v_suffix,v_customer,v_sales) RETURNING id INTO v_force_order;
  INSERT INTO public.order_items(order_id,product_id,product_name,price_per_unit,total_units_needed,unit_size,total_price,quantity_delivered,quantity_remaining)
  VALUES(v_force_order,v_other,'[SMOKE] forced create',10,4,'ea',40,4,0) RETURNING id INTO v_force_item;
  SELECT count(*) INTO v_before_count FROM public.activity_feed WHERE customer_id=v_customer AND event_type='return_requested';
  PERFORM set_config('app.phase3_smoke_force','return_requested',true);
  BEGIN
    PERFORM public.create_return(jsonb_build_object('customer_id',v_customer,'order_id',v_force_order,'reason','overstock'),jsonb_build_array(jsonb_build_object('order_item_id',v_force_item,'quantity',1,'condition','unopened','restock',false)),'smk-p3-'||v_suffix||'-force-create');
    RAISE EXCEPTION 'SMOKE_FAIL: forced return_requested did not fail';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SMOKE_FORCED_RETURN_REQUESTED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: forced create wrong error %',SQLERRM; END IF;
  END;
  PERFORM set_config('app.phase3_smoke_force','',true);
  IF EXISTS (SELECT 1 FROM public.returns WHERE order_id=v_force_order)
     OR EXISTS (SELECT 1 FROM public.return_items ri JOIN public.returns r ON r.id=ri.return_id WHERE r.order_id=v_force_order)
     OR (SELECT count(*) FROM public.activity_feed WHERE customer_id=v_customer AND event_type='return_requested') IS DISTINCT FROM v_before_count
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key='smk-p3-'||v_suffix||'-force-create') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: forced return_requested leaked side effects';
  END IF;

  -- Build one real requested return, then force its late approve activity. The
  -- status, activity, and idempotency key must all revert to the requested
  -- snapshot.
  v_result:=public.create_return(jsonb_build_object('customer_id',v_customer,'order_id',v_force_order,'reason','overstock'),jsonb_build_array(jsonb_build_object('order_item_id',v_force_item,'quantity',1,'condition','unopened','restock',true)),'smk-p3-'||v_suffix||'-force-create-ok');
  v_force_return:=(v_result->>'return_id')::uuid;
  SELECT count(*) INTO v_before_count FROM public.activity_feed WHERE related_entity_type='return' AND related_entity_id=v_force_return;
  PERFORM set_config('app.phase3_smoke_force','return_approved',true);
  BEGIN
    PERFORM public.approve_return(v_force_return,v_sales,'smk-p3-'||v_suffix||'-force-approve');
    RAISE EXCEPTION 'SMOKE_FAIL: forced return_approved did not fail';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SMOKE_FORCED_RETURN_APPROVED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: forced approve wrong error %',SQLERRM; END IF;
  END;
  PERFORM set_config('app.phase3_smoke_force','',true);
  IF (SELECT status FROM public.returns WHERE id=v_force_return) IS DISTINCT FROM 'requested'
     OR (SELECT approved_by FROM public.returns WHERE id=v_force_return) IS NOT NULL
     OR (SELECT count(*) FROM public.activity_feed WHERE related_entity_type='return' AND related_entity_id=v_force_return) IS DISTINCT FROM v_before_count
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key='smk-p3-'||v_suffix||'-force-approve') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: forced return_approved leaked side effects';
  END IF;

  -- return_received: the disposable trigger fires only after the real receive
  -- implementation has updated Main Warehouse and attempted its inventory
  -- transaction. Both inventory and return state must roll back.
  PERFORM public.approve_return(v_force_return,v_sales,'smk-p3-'||v_suffix||'-force-approve-ok');
  INSERT INTO public.inventory(product_id,location,quantity_available,unit_size) VALUES(v_other,'Main Warehouse',7,'ea');
  SELECT quantity_available INTO v_before_inventory FROM public.inventory WHERE product_id=v_other AND location='Main Warehouse';
  SELECT count(*) INTO v_before_count FROM public.inventory_transactions WHERE product_id=v_other;
  PERFORM set_config('app.phase3_smoke_force','return_received',true);
  BEGIN
    PERFORM public.receive_return(v_force_return,v_sales,'smk-p3-'||v_suffix||'-force-receive');
    RAISE EXCEPTION 'SMOKE_FAIL: forced return_received did not fail';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SMOKE_FORCED_RETURN_RECEIVED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: forced receive wrong error %',SQLERRM; END IF;
  END;
  PERFORM set_config('app.phase3_smoke_force','',true);
  IF (SELECT status FROM public.returns WHERE id=v_force_return) IS DISTINCT FROM 'approved'
     OR (SELECT quantity_available FROM public.inventory WHERE product_id=v_other AND location='Main Warehouse') IS DISTINCT FROM v_before_inventory
     OR (SELECT count(*) FROM public.inventory_transactions WHERE product_id=v_other) IS DISTINCT FROM v_before_count
     OR (SELECT restocked FROM public.return_items WHERE return_id=v_force_return) IS DISTINCT FROM false
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key='smk-p3-'||v_suffix||'-force-receive') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: forced return_received leaked inventory or status effects';
  END IF;

  -- credit-issued: the audit trigger fires only on the second real audit row,
  -- after invoice creation and the return's credited update. All money/audit
  -- and idempotency effects therefore have to atomically disappear.
  PERFORM public.receive_return(v_force_return,v_sales,'smk-p3-'||v_suffix||'-force-receive-ok');
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT count(*) INTO v_before_count FROM public.invoices;
  SELECT count(*) INTO v_n FROM public.financial_audit_log;
  PERFORM set_config('app.phase3_smoke_force','credit_issued',true);
  BEGIN
    PERFORM public.issue_return_credit(v_force_return,v_admin,'smk-p3-'||v_suffix||'-force-credit');
    RAISE EXCEPTION 'SMOKE_FAIL: forced credit-issued did not fail';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SMOKE_FORCED_CREDIT_ISSUED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: forced credit wrong error %',SQLERRM; END IF;
  END;
  PERFORM set_config('app.phase3_smoke_force','',true);
  IF (SELECT status FROM public.returns WHERE id=v_force_return) IS DISTINCT FROM 'received'
     OR (SELECT credit_invoice_id FROM public.returns WHERE id=v_force_return) IS NOT NULL
     OR (SELECT total_credit_cents FROM public.returns WHERE id=v_force_return) IS DISTINCT FROM 0
     OR (SELECT count(*) FROM public.invoices) IS DISTINCT FROM v_before_count
     OR (SELECT count(*) FROM public.financial_audit_log) IS DISTINCT FROM v_n
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key='smk-p3-'||v_suffix||'-force-credit') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: forced credit-issued leaked money/audit effects';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_sales::text, true);

  -- Validate-only trigger backstop: privileged direct line paths get the exact code.
  BEGIN
    INSERT INTO public.return_items(return_id,product_id,product_name,quantity,unit,unit_price_cents,extended_cents,condition,restock,sort_order)
    VALUES(v_return,v_blocked,'[SMOKE] blocked',1,'ea',1,1,'unopened',false,99);
    RAISE EXCEPTION 'SMOKE_FAIL: direct blocked return_items INSERT was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RETURN_POLICY_NO_RETURN%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected RETURN_POLICY_NO_RETURN direct insert, got %',SQLERRM; END IF;
  END;
  BEGIN
    UPDATE public.return_items SET product_id=v_blocked WHERE return_id=v_return;
    RAISE EXCEPTION 'SMOKE_FAIL: blocked Product-changing return_items UPDATE was allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'RETURN_POLICY_NO_RETURN%' THEN RAISE EXCEPTION 'SMOKE_FAIL: expected RETURN_POLICY_NO_RETURN direct update, got %',SQLERRM; END IF;
  END;

  -- The four wrappers must retain the common exact refusal before effects.
  FOR v_reason IN SELECT unnest(ARRAY['create_return','approve_return','receive_return','issue_return_credit']) LOOP
    IF position('assert_phase3_return_policy' IN (SELECT prosrc FROM pg_proc WHERE oid=('public.'||v_reason||CASE WHEN v_reason='create_return' THEN '(jsonb,jsonb,text)' ELSE '(uuid,uuid,text)' END)::regprocedure))=0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % lost policy assertion',v_reason;
    END IF;
  END LOOP;
  -- Existing reversal paths deliberately do not read policy. The canonical
  -- return-credit chain separately proves cancel/reject/unapply/re-credit.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.unapply_credit_memo(uuid,text,uuid,text)'::regprocedure) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: unapply_credit_memo missing';
  END IF;
  -- No real Product classification survives this rollback-only chain.
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
