import { supabase } from './db';

const DOCUMENT_BUCKET = 'customer-documents';
const FILES_FUNCTION = 'customer-document-files';

/**
 * Customer-document bytes move only through the customer-document-files Edge
 * Function. Browser users have no Storage read access to the bucket, so they
 * cannot mint a signed download URL that would keep working after a soft
 * delete. Do not reintroduce createSignedUrl or a direct Storage download here.
 */

// The Edge Function answers errors as JSON { error }; surface that message
// instead of the client's generic "non-2xx status code" text.
async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      const body: unknown = await context.clone().json();
      const message = (body as { error?: unknown } | null)?.error;
      if (typeof message === 'string' && message) return message;
    } catch {
      // Not JSON — fall through to the fallback text.
    }
  }
  return fallback;
}

async function invokeFiles<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(FILES_FUNCTION, { body });
  if (error) throw new Error(await functionErrorMessage(error, fallback));
  if (data === null || data === undefined) throw new Error(fallback);
  return data;
}

/** Uploads the bytes and returns the server-chosen storage path. */
export async function uploadCustomerDocumentFile(customerId: string, file: File): Promise<string> {
  const prepared = await invokeFiles<{ storage_path?: unknown; token?: unknown }>(
    {
      action: 'prepare_upload',
      customer_id: customerId,
      filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    },
    'Could not prepare the upload.',
  );
  if (typeof prepared.storage_path !== 'string' || typeof prepared.token !== 'string') {
    throw new Error('Could not prepare the upload.');
  }

  const { error } = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .uploadToSignedUrl(prepared.storage_path, prepared.token, file, { contentType: file.type });
  if (error) throw error;
  return prepared.storage_path;
}

export async function downloadCustomerDocumentFile(
  documentId: string,
  filename: string,
  mimeType: string,
): Promise<void> {
  const data = await invokeFiles<unknown>(
    { action: 'download', document_id: documentId },
    'Could not download the document.',
  );
  if (!(data instanceof Blob)) throw new Error('Could not download the document.');

  // The function sends octet-stream; restore the real type so the saved file opens correctly.
  const file = new Blob([data], { type: mimeType });
  const objectUrl = URL.createObjectURL(file);
  const link = window.document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.rel = 'noopener';
  window.document.body.appendChild(link);

  try {
    link.click();
  } finally {
    link.remove();
    // Revoking immediately can cancel the save in some browsers (notably Safari).
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}
