// Pure request and authorization rules for customer-document-files.
//
// Browser users have no direct Storage SELECT on the customer-documents bucket,
// so they can never mint a Storage signed download URL. This function is the
// only byte path: it re-checks the metadata row on every download, so a
// soft-deleted document stops being downloadable immediately.

export const DOCUMENT_BUCKET = "customer-documents";

// Mirrors the bucket's own limits and CustomerDocuments.tsx; keep all three in step.
// These checks are early refusals only: the upload token is not bound to them, so
// the bucket's limits are what actually enforce type and size on upload.
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILENAME_LENGTH = 255;

export type DocumentFileRequest =
  | {
    action: "prepare_upload";
    customerId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }
  | { action: "download"; documentId: string };

export type ParseResult =
  | { ok: true; request: DocumentFileRequest }
  | { ok: false; error: string };

function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseDocumentFileRequest(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const input = body as Record<string, unknown>;

  if (input.action === "prepare_upload") {
    if (
      !hasOnlyKeys(input, [
        "action",
        "customer_id",
        "filename",
        "mime_type",
        "size_bytes",
      ])
    ) {
      return { ok: false, error: "Request contains unsupported fields." };
    }
    if (!isUuid(input.customer_id)) {
      return { ok: false, error: "A valid customer is required." };
    }
    if (
      typeof input.filename !== "string" ||
      input.filename.trim() === "" ||
      input.filename.length > MAX_FILENAME_LENGTH
    ) {
      return { ok: false, error: "A file name is required." };
    }
    if (
      typeof input.mime_type !== "string" ||
      !(ALLOWED_MIME_TYPES as readonly string[]).includes(input.mime_type)
    ) {
      return { ok: false, error: "Choose a PDF, JPEG, PNG, or WebP file." };
    }
    if (
      typeof input.size_bytes !== "number" ||
      !Number.isSafeInteger(input.size_bytes) ||
      input.size_bytes <= 0 ||
      input.size_bytes > MAX_FILE_SIZE_BYTES
    ) {
      return { ok: false, error: "Documents must be non-empty and 20 MB or smaller." };
    }
    return {
      ok: true,
      request: {
        action: "prepare_upload",
        customerId: input.customer_id.toLowerCase(),
        filename: input.filename,
        mimeType: input.mime_type,
        sizeBytes: input.size_bytes,
      },
    };
  }

  if (input.action === "download") {
    if (!hasOnlyKeys(input, ["action", "document_id"])) {
      return { ok: false, error: "Request contains unsupported fields." };
    }
    if (!isUuid(input.document_id)) {
      return { ok: false, error: "A valid document is required." };
    }
    return {
      ok: true,
      request: { action: "download", documentId: input.document_id.toLowerCase() },
    };
  }

  return { ok: false, error: "Unsupported action." };
}

// Same rule as the retired Storage policies: admins may reach every customer's
// documents; a sales rep only the customers assigned to them.
export function canAccessCustomerDocuments(
  role: string,
  callerId: string,
  assignedSalesRep: string | null,
): boolean {
  if (role === "admin") return true;
  return role === "sales_rep" && assignedSalesRep === callerId;
}

export function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return sanitized || "document";
}

// The server chooses the object path so a caller cannot aim an upload token at
// another customer's folder or at an existing object.
export function buildStoragePath(
  customerId: string,
  uniqueId: string,
  filename: string,
): string {
  return `${customerId}/${uniqueId}-${sanitizeFilename(filename)}`;
}

const ISSUED_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9_-][A-Za-z0-9._-]{0,179}$/;

// True only for the exact shape buildStoragePath issues inside this customer's
// folder: "<customer_id>/<uuid>-<safe name>". Mirrors the database constraint
// customer_documents_storage_path_shape_check. A look-alike such as a "#", "?"
// or "%" variant of another object's path must never reach Storage, which could
// resolve it to that object's bytes.
export function isServerIssuedPath(
  storagePath: string,
  customerId: string,
): boolean {
  const segments = storagePath.split("/");
  return segments.length === 2 &&
    segments[0] === customerId &&
    UUID_PATTERN.test(segments[0]) &&
    segments[0] === segments[0].toLowerCase() &&
    ISSUED_NAME_PATTERN.test(segments[1]);
}
