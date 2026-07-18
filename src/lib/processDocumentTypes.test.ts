import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RETIRED_PRICING_DOCUMENT_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  validateDocumentType,
} from '../../supabase/functions/process-document/documentTypes';
import { ocrSupportedDocument } from '../../supabase/functions/process-document/ocrBoundary';

describe('process-document supported type guard', () => {
  it.each(RETIRED_PRICING_DOCUMENT_TYPES)('rejects retired pricing type %s before OCR', (documentType) => {
    const result = validateDocumentType(documentType);

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/retired.*not processed by OCR/i),
    });
  });

  it.each(SUPPORTED_DOCUMENT_TYPES)('keeps unrelated supported type %s', (documentType) => {
    expect(validateDocumentType(documentType)).toEqual({ ok: true, documentType });
  });

  it('fails closed for missing and unknown document types', () => {
    expect(validateDocumentType(undefined)).toEqual({ ok: false, error: 'document_type is required' });
    expect(validateDocumentType('other')).toEqual({
      ok: false,
      error: `Invalid document_type. Must be one of: ${SUPPORTED_DOCUMENT_TYPES.join(', ')}`,
    });
  });

  it.each(RETIRED_PRICING_DOCUMENT_TYPES)(
    'blocks retired type %s at the production OCR boundary with zero provider calls',
    async (documentType) => {
      const provider = vi.fn().mockResolvedValue('must not run');

      await expect(ocrSupportedDocument(
        documentType,
        [{ base64: '/9j/AA==', page_number: 1 }],
        'test-key',
        provider,
      )).rejects.toThrow(/retired.*not processed by OCR/i);
      expect(provider).not.toHaveBeenCalled();
    },
  );

  it('wires the supported-type guard into the actual handler before its OCR boundary', () => {
    const handlerSource = readFileSync(
      resolve(process.cwd(), 'supabase/functions/process-document/index.ts'),
      'utf8',
    );
    const guardCall = handlerSource.indexOf('validateDocumentType(body.document_type)');
    const providerBoundary = handlerSource.indexOf('ocrSupportedDocument(');

    expect(guardCall).toBeGreaterThan(-1);
    expect(providerBoundary).toBeGreaterThan(guardCall);
    expect(handlerSource).not.toContain('case "price_list"');
    expect(handlerSource).not.toContain('case "product_list"');
  });
});
