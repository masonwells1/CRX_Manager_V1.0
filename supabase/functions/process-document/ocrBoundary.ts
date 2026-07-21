import { validateDocumentType, type DocumentType } from "./documentTypes.ts";

export interface PageInput {
  base64: string;
  page_number: number;
}

export type OcrProvider = (pages: PageInput[], apiKey: string) => Promise<string>;

/**
 * Final fail-closed boundary immediately before the paid OCR provider call.
 * The request handler also validates early for a clear 400 response, while this
 * guard guarantees a retired pricing type cannot reach Vision if that earlier
 * request-validation path is changed later.
 */
export async function ocrSupportedDocument(
  documentType: unknown,
  pages: PageInput[],
  apiKey: string,
  provider: OcrProvider,
): Promise<{ documentType: DocumentType; rawText: string }> {
  const typeResult = validateDocumentType(documentType);
  if (!typeResult.ok) {
    throw new Error(typeResult.error);
  }

  return {
    documentType: typeResult.documentType,
    rawText: await provider(pages, apiKey),
  };
}
