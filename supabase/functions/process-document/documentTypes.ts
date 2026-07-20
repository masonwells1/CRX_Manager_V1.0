export const SUPPORTED_DOCUMENT_TYPES = [
  "invoice",
  "purchase_order",
  "customer_list",
  "quote_list",
] as const;

export const RETIRED_PRICING_DOCUMENT_TYPES = [
  "price_list",
  "product_list",
] as const;

export type DocumentType = (typeof SUPPORTED_DOCUMENT_TYPES)[number];

type DocumentTypeResult =
  | { ok: true; documentType: DocumentType }
  | { ok: false; error: string };

/**
 * Fail closed before OCR. These retired values used to extract supplier cost
 * and sell-price data, so callers receive a deliberate error rather than
 * falling through to Google Vision or a generic parser.
 */
export function validateDocumentType(value: unknown): DocumentTypeResult {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "document_type is required" };
  }

  if ((RETIRED_PRICING_DOCUMENT_TYPES as readonly string[]).includes(value)) {
    return {
      ok: false,
      error: `Document type '${value}' is retired. Supplier and product pricing documents are not processed by OCR.`,
    };
  }

  if (!(SUPPORTED_DOCUMENT_TYPES as readonly string[]).includes(value)) {
    return {
      ok: false,
      error: `Invalid document_type. Must be one of: ${SUPPORTED_DOCUMENT_TYPES.join(", ")}`,
    };
  }

  return { ok: true, documentType: value as DocumentType };
}
