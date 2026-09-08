import { supabase } from './db';

const DOCUMENT_BUCKET = 'customer-documents';

/**
 * Download through the authenticated Storage endpoint so every server byte
 * request is authorized by the current RLS policy. Do not replace this with a
 * signed bearer URL: a URL minted before soft delete remains usable until it
 * expires even though the metadata and Storage row are no longer selectable.
 */
export async function downloadCustomerDocumentFile(storagePath: string, filename: string): Promise<void> {
  const { data, error } = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .download(storagePath);

  if (error) throw error;
  if (!data) throw new Error('Could not download the document.');

  const objectUrl = URL.createObjectURL(data);
  const link = window.document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.rel = 'noopener';
  window.document.body.appendChild(link);

  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}
