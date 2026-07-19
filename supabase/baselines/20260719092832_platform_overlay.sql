-- CRX Supabase platform overlay at live high-water 20260719092832.
-- Apply after the matching public schema baseline on a NEW Supabase project.
-- This restores only CRX-owned auth/storage objects; Supabase owns the platform schemas.
BEGIN;

DROP TRIGGER IF EXISTS "on_auth_user_created" ON "auth"."users";
CREATE OR REPLACE TRIGGER "on_auth_user_created" AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_user"();

DROP POLICY IF EXISTS "Authenticated users can read signatures" ON "storage"."objects";
DROP POLICY IF EXISTS "Authenticated users can upload documents" ON "storage"."objects";
DROP POLICY IF EXISTS "Authenticated users can upload signatures" ON "storage"."objects";
DROP POLICY IF EXISTS "Authenticated users can upload team note attachments" ON "storage"."objects";
DROP POLICY IF EXISTS "Users can delete own document uploads" ON "storage"."objects";
DROP POLICY IF EXISTS "Users can delete own team note attachments" ON "storage"."objects";
DROP POLICY IF EXISTS "Users can read own document uploads" ON "storage"."objects";
DROP POLICY IF EXISTS "blend_ticket_images_delete" ON "storage"."objects";
DROP POLICY IF EXISTS "blend_ticket_images_insert" ON "storage"."objects";
DROP POLICY IF EXISTS "blend_ticket_images_select" ON "storage"."objects";
DROP POLICY IF EXISTS "blend_ticket_images_update" ON "storage"."objects";
DROP POLICY IF EXISTS "customer_documents_objects_admin_delete" ON "storage"."objects";
DROP POLICY IF EXISTS "customer_documents_objects_admin_insert" ON "storage"."objects";
DROP POLICY IF EXISTS "customer_documents_objects_admin_select" ON "storage"."objects";
DROP POLICY IF EXISTS "customer_documents_objects_rep_insert" ON "storage"."objects";
DROP POLICY IF EXISTS "customer_documents_objects_rep_select" ON "storage"."objects";
DROP POLICY IF EXISTS "delivery_photos_delete" ON "storage"."objects";
DROP POLICY IF EXISTS "delivery_photos_insert" ON "storage"."objects";
DROP POLICY IF EXISTS "delivery_signatures_delete" ON "storage"."objects";
DROP POLICY IF EXISTS "delivery_signatures_insert" ON "storage"."objects";
DROP POLICY IF EXISTS "delivery_signatures_select" ON "storage"."objects";
DROP POLICY IF EXISTS "job_attachments_objects_delete" ON "storage"."objects";
DROP POLICY IF EXISTS "job_attachments_objects_insert" ON "storage"."objects";
DROP POLICY IF EXISTS "job_attachments_objects_select" ON "storage"."objects";
DROP POLICY IF EXISTS "recv_photos_storage_delete" ON "storage"."objects";
DROP POLICY IF EXISTS "recv_photos_storage_upload" ON "storage"."objects";
DROP POLICY IF EXISTS "supplier_price_evidence_objects_insert" ON "storage"."objects";
DROP POLICY IF EXISTS "supplier_price_evidence_objects_select" ON "storage"."objects";

CREATE POLICY "Authenticated users can read signatures" ON "storage"."objects" FOR SELECT TO "authenticated" USING (("bucket_id" = 'delivery-signatures'::"text"));
CREATE POLICY "Authenticated users can upload documents" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK (("bucket_id" = 'document-uploads'::"text"));
CREATE POLICY "Authenticated users can upload signatures" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK (("bucket_id" = 'delivery-signatures'::"text"));
CREATE POLICY "Authenticated users can upload team note attachments" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK (("bucket_id" = 'team-note-attachments'::"text"));
CREATE POLICY "Users can delete own document uploads" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'document-uploads'::"text") AND (("storage"."foldername"("name"))[1] = (( SELECT "auth"."uid"() AS "uid"))::"text")));
CREATE POLICY "Users can delete own team note attachments" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'team-note-attachments'::"text") AND ((("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'admin'::"text")))))));
CREATE POLICY "Users can read own document uploads" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'document-uploads'::"text") AND (("storage"."foldername"("name"))[1] = (( SELECT "auth"."uid"() AS "uid"))::"text")));
CREATE POLICY "blend_ticket_images_delete" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'blend-ticket-images'::"text") AND ("public"."is_admin"() OR ("public"."is_sales_rep"() AND (("owner_id" = (( SELECT "auth"."uid"() AS "uid"))::"text") OR (EXISTS ( SELECT 1
   FROM "public"."blend_tickets" "bt"
  WHERE ((("bt"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("bt"."uploaded_by" = ( SELECT "auth"."uid"() AS "uid"))))))))));
CREATE POLICY "blend_ticket_images_insert" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'blend-ticket-images'::"text") AND ("public"."is_admin"() OR "public"."is_sales_rep"())));
CREATE POLICY "blend_ticket_images_select" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'blend-ticket-images'::"text") AND ("public"."is_admin"() OR "public"."is_sales_rep"())));
CREATE POLICY "blend_ticket_images_update" ON "storage"."objects" FOR UPDATE TO "authenticated" USING ((("bucket_id" = 'blend-ticket-images'::"text") AND ("public"."is_admin"() OR ("public"."is_sales_rep"() AND (("owner_id" = (( SELECT "auth"."uid"() AS "uid"))::"text") OR (EXISTS ( SELECT 1
   FROM "public"."blend_tickets" "bt"
  WHERE ((("bt"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("bt"."uploaded_by" = ( SELECT "auth"."uid"() AS "uid")))))))))) WITH CHECK ((("bucket_id" = 'blend-ticket-images'::"text") AND ("public"."is_admin"() OR ("public"."is_sales_rep"() AND (("owner_id" = (( SELECT "auth"."uid"() AS "uid"))::"text") OR (EXISTS ( SELECT 1
   FROM "public"."blend_tickets" "bt"
  WHERE ((("bt"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("bt"."uploaded_by" = ( SELECT "auth"."uid"() AS "uid"))))))))));
CREATE POLICY "customer_documents_objects_admin_delete" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'customer-documents'::"text") AND "public"."is_admin"() AND (NOT (EXISTS ( SELECT 1
   FROM "public"."customer_documents" "cd"
  WHERE (("cd"."storage_path" = "objects"."name") AND ("cd"."deleted_at" IS NULL)))))));
CREATE POLICY "customer_documents_objects_admin_insert" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'customer-documents'::"text") AND "public"."is_admin"() AND ("array_length"("storage"."foldername"("name"), 1) = 1) AND ("storage"."filename"("name") <> ''::"text") AND (EXISTS ( SELECT 1
   FROM "public"."customers" "c"
  WHERE (("c"."id")::"text" = ("storage"."foldername"("objects"."name"))[1])))));
CREATE POLICY "customer_documents_objects_admin_select" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'customer-documents'::"text") AND "public"."is_admin"()));
CREATE POLICY "customer_documents_objects_rep_insert" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'customer-documents'::"text") AND "public"."is_sales_rep"() AND ("array_length"("storage"."foldername"("name"), 1) = 1) AND ("storage"."filename"("name") <> ''::"text") AND (EXISTS ( SELECT 1
   FROM "public"."customers" "c"
  WHERE ((("c"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("c"."assigned_sales_rep" = ( SELECT "auth"."uid"() AS "uid")))))));
CREATE POLICY "customer_documents_objects_rep_select" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'customer-documents'::"text") AND "public"."is_sales_rep"() AND (EXISTS ( SELECT 1
   FROM "public"."customers" "c"
  WHERE ((("c"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("c"."assigned_sales_rep" = ( SELECT "auth"."uid"() AS "uid"))))) AND (("owner_id" = ( SELECT ("auth"."uid"())::"text" AS "uid")) OR (EXISTS ( SELECT 1
   FROM "public"."customer_documents" "cd"
  WHERE (("cd"."storage_path" = "objects"."name") AND ("cd"."deleted_at" IS NULL)))))));
CREATE POLICY "delivery_photos_delete" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'delivery-photos'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"text", 'sales_rep'::"text"])))))));
CREATE POLICY "delivery_photos_insert" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK (("bucket_id" = 'delivery-photos'::"text"));
CREATE POLICY "delivery_signatures_delete" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'delivery-signatures'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['admin'::"text", 'sales_rep'::"text"])))))));
CREATE POLICY "delivery_signatures_insert" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK (("bucket_id" = 'delivery-signatures'::"text"));
CREATE POLICY "delivery_signatures_select" ON "storage"."objects" FOR SELECT TO "authenticated" USING (("bucket_id" = 'delivery-signatures'::"text"));
CREATE POLICY "job_attachments_objects_delete" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'job-attachments'::"text") AND ("public"."is_admin"() OR "public"."is_sales_rep"() OR ("public"."is_applicator"() AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE ((("j"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("j"."applicator_id" = ( SELECT "auth"."uid"() AS "uid"))))))) AND ("public"."is_admin"() OR "public"."is_sales_rep"() OR ("owner_id" = (( SELECT "auth"."uid"() AS "uid"))::"text"))));
CREATE POLICY "job_attachments_objects_insert" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'job-attachments'::"text") AND ("public"."is_admin"() OR "public"."is_sales_rep"() OR ("public"."is_applicator"() AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE ((("j"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("j"."applicator_id" = ( SELECT "auth"."uid"() AS "uid")))))))));
CREATE POLICY "job_attachments_objects_select" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'job-attachments'::"text") AND ("public"."is_admin"() OR "public"."is_sales_rep"() OR ("public"."is_applicator"() AND (EXISTS ( SELECT 1
   FROM "public"."jobs" "j"
  WHERE ((("j"."id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("j"."applicator_id" = ( SELECT "auth"."uid"() AS "uid")))))))));
CREATE POLICY "recv_photos_storage_delete" ON "storage"."objects" FOR DELETE TO "authenticated" USING (("bucket_id" = 'receiving-photos'::"text"));
CREATE POLICY "recv_photos_storage_upload" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK (("bucket_id" = 'receiving-photos'::"text"));
CREATE POLICY "supplier_price_evidence_objects_insert" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'supplier-price-evidence'::"text") AND "public"."is_admin"() AND (("storage"."foldername"("name"))[1] = (( SELECT "auth"."uid"() AS "uid"))::"text")));
CREATE POLICY "supplier_price_evidence_objects_select" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'supplier-price-evidence'::"text") AND ("public"."is_admin"() OR "public"."is_sales_rep"())));

INSERT INTO "storage"."buckets"
  ("id", "name", "public", "file_size_limit", "allowed_mime_types")
VALUES
  ('blend-ticket-images', 'blend-ticket-images', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]),
  ('customer-documents', 'customer-documents', false, 20971520, ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']::text[]),
  ('delivery-photos', 'delivery-photos', true, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif']::text[]),
  ('delivery-signatures', 'delivery-signatures', false, 1048576, ARRAY['image/png', 'image/jpeg', 'image/webp']::text[]),
  ('document-uploads', 'document-uploads', false, 10485760, ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']::text[]),
  ('job-attachments', 'job-attachments', false, 26214400, ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/csv', 'text/plain', 'text/xml', 'application/xml', 'application/vnd.google-earth.kml+xml', 'application/gpx+xml', 'application/octet-stream', 'application/zip']::text[]),
  ('receiving-photos', 'receiving-photos', true, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif']::text[]),
  ('supplier-price-evidence', 'supplier-price-evidence', false, 26214400, ARRAY['application/pdf']::text[]),
  ('team-note-attachments', 'team-note-attachments', true, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif']::text[]);
COMMIT;
