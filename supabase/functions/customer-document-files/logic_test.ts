import {
  buildStoragePath,
  canAccessCustomerDocuments,
  isServerIssuedPath,
  MAX_FILE_SIZE_BYTES,
  parseDocumentFileRequest,
} from "./logic.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(message ?? `Expected ${expectedJson}, received ${actualJson}`);
  }
}

const CUSTOMER = "11111111-2222-4333-8444-555555555555";
const OTHER_CUSTOMER = "99999999-2222-4333-8444-555555555555";
const DOCUMENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const REP = "rep-user-id";

Deno.test("admins reach every customer; reps only their assigned customers", () => {
  assertEquals(canAccessCustomerDocuments("admin", "admin-id", null), true);
  assertEquals(canAccessCustomerDocuments("sales_rep", REP, REP), true);
  assertEquals(canAccessCustomerDocuments("sales_rep", REP, "someone-else"), false);
  assertEquals(canAccessCustomerDocuments("sales_rep", REP, null), false);
  assertEquals(canAccessCustomerDocuments("driver", REP, REP), false);
});

Deno.test("server-built paths stay inside the customer folder and pass the shape check", () => {
  const uniqueId = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const path = buildStoragePath(CUSTOMER, uniqueId, "../../etc/passwd");
  assertEquals(path.startsWith(`${CUSTOMER}/${uniqueId}-`), true);
  assertEquals(isServerIssuedPath(path, CUSTOMER), true);
  assertEquals(buildStoragePath(CUSTOMER, uniqueId, "Farm Map (2026).pdf"), `${CUSTOMER}/${uniqueId}-Farm_Map_2026_.pdf`);
  assertEquals(isServerIssuedPath(buildStoragePath(CUSTOMER, uniqueId, "..."), CUSTOMER), true);
});

Deno.test("shape check refuses look-alikes and other folders", () => {
  const good = `${CUSTOMER}/0f1e2d3c-4b5a-4968-8776-655443322110-lease.pdf`;
  assertEquals(isServerIssuedPath(good, CUSTOMER), true);
  // Variants Storage could resolve to the same object as `good`.
  assertEquals(isServerIssuedPath(`${good}#a`, CUSTOMER), false);
  assertEquals(isServerIssuedPath(`${good}?a`, CUSTOMER), false);
  assertEquals(isServerIssuedPath(good.replace(".pdf", "%2Epdf"), CUSTOMER), false);
  assertEquals(isServerIssuedPath(`${good} `, CUSTOMER), false);
  assertEquals(isServerIssuedPath(good.toUpperCase(), CUSTOMER.toUpperCase()), false);
  assertEquals(isServerIssuedPath(good.replace(CUSTOMER, OTHER_CUSTOMER), CUSTOMER), false);
  assertEquals(isServerIssuedPath(`${CUSTOMER}/lease.pdf`, CUSTOMER), false);
  assertEquals(isServerIssuedPath(`${CUSTOMER}/a/b.pdf`, CUSTOMER), false);
  assertEquals(isServerIssuedPath(`${CUSTOMER}/`, CUSTOMER), false);
});

Deno.test("prepare_upload accepts the allowed shape only", () => {
  const good = {
    action: "prepare_upload",
    customer_id: CUSTOMER.toUpperCase(),
    filename: "map.pdf",
    mime_type: "application/pdf",
    size_bytes: 1024,
  };
  const parsed = parseDocumentFileRequest(good);
  assertEquals(parsed.ok, true);
  if (parsed.ok && parsed.request.action === "prepare_upload") {
    assertEquals(parsed.request.customerId, CUSTOMER);
  }
  assertEquals(parseDocumentFileRequest({ ...good, mime_type: "text/html" }).ok, false);
  assertEquals(parseDocumentFileRequest({ ...good, size_bytes: 0 }).ok, false);
  assertEquals(parseDocumentFileRequest({ ...good, size_bytes: MAX_FILE_SIZE_BYTES + 1 }).ok, false);
  assertEquals(parseDocumentFileRequest({ ...good, size_bytes: 1.5 }).ok, false);
  assertEquals(parseDocumentFileRequest({ ...good, customer_id: "not-a-uuid" }).ok, false);
  assertEquals(parseDocumentFileRequest({ ...good, filename: "  " }).ok, false);
  // A caller may not choose the storage path or an expiry.
  assertEquals(parseDocumentFileRequest({ ...good, storage_path: `${CUSTOMER}/x.pdf` }).ok, false);
  assertEquals(parseDocumentFileRequest({ ...good, expires_in: 999999 }).ok, false);
});

Deno.test("download needs only a document id", () => {
  assertEquals(parseDocumentFileRequest({ action: "download", document_id: DOCUMENT }).ok, true);
  assertEquals(parseDocumentFileRequest({ action: "download", document_id: "x" }).ok, false);
  assertEquals(
    parseDocumentFileRequest({ action: "download", document_id: DOCUMENT, expires_in: 60 }).ok,
    false,
  );
});

Deno.test("unknown actions and non-object bodies are refused", () => {
  assertEquals(parseDocumentFileRequest({ action: "sign_url" }).ok, false);
  assertEquals(parseDocumentFileRequest({ action: "discard_upload", customer_id: CUSTOMER }).ok, false);
  assertEquals(parseDocumentFileRequest(null).ok, false);
  assertEquals(parseDocumentFileRequest([]).ok, false);
});
