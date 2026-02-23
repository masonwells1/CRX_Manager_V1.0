import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the module-under-test is imported
// ---------------------------------------------------------------------------

// Mock pdfjs-dist
const mockGetPage = vi.fn();
const mockGetDocument = vi.fn();
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

// Mock pdfjs worker URL import (Vite asset import)
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'mock-worker.js',
}));

// Mock image compression — returns a mock File-like object with arrayBuffer()
const mockCompressImage = vi.fn();
vi.mock('./imageCompression', () => ({
  compressImage: (...args: unknown[]) => mockCompressImage(...args),
}));

// Mock supabase client
const mockInvoke = vi.fn();
vi.mock('./db', () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => mockInvoke(...args),
    },
    auth: {
      getSession: vi.fn(() => ({
        data: { session: { access_token: 'test-token' } },
      })),
    },
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  processDocumentWithOCR,
  isOCRSupported,
  isCSVFile,
  type DocumentType,
} from './documentOCR';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a File-like object that works in jsdom.
 * jsdom's File may not support .arrayBuffer(), so we polyfill it.
 */
function makeFile(
  name: string,
  sizeBytes: number,
  type: string,
): File {
  const bytes = new Uint8Array(sizeBytes);
  const file = new File([bytes], name, { type });
  // Polyfill arrayBuffer() for jsdom compatibility
  if (typeof file.arrayBuffer !== 'function') {
    (file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = () =>
      Promise.resolve(bytes.buffer.slice(0, sizeBytes));
  }
  return file;
}

/**
 * Create a mock compressed image result with a working arrayBuffer().
 * Contains minimal binary data that btoa() can encode.
 */
function makeCompressedResult(name: string, type: string): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // minimal binary data
  const file = new File([bytes], name, { type });
  if (typeof file.arrayBuffer !== 'function') {
    (file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = () => Promise.resolve(bytes.buffer.slice(0));
  }
  return file;
}

/** Build a minimal mock PDF document returned by pdfjsLib.getDocument */
function mockPdfDocument(numPages: number) {
  const mockCtx = {
    drawImage: vi.fn(),
  };

  // Each page renders to a canvas
  const mockPage = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 150 * scale,
    })),
    render: vi.fn(() => ({
      promise: Promise.resolve(),
    })),
  };

  // Stub document.createElement('canvas') to return a mock canvas
  vi.spyOn(document, 'createElement').mockImplementation(
    (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => mockCtx,
          toDataURL: () => 'data:image/jpeg;base64,AAAA',
        } as unknown as HTMLCanvasElement;
      }
      // Fall through to real createElement for non-canvas elements
      return Object.getPrototypeOf(document).createElement.call(document, tag);
    },
  );

  mockGetPage.mockResolvedValue(mockPage);

  mockGetDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages,
      getPage: mockGetPage,
    }),
  });

  return { mockPage, mockCtx };
}

/** Set up compressImage mock to return a proper File-like result */
function setupImageMock() {
  const compressed = makeCompressedResult('compressed.jpg', 'image/jpeg');
  mockCompressImage.mockResolvedValue(compressed);
  return compressed;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ── 1. Input validation ────────────────────────────────────────────────────

describe('processDocumentWithOCR — input validation', () => {
  it('rejects files over 10MB', async () => {
    const bigFile = makeFile('huge.pdf', 11 * 1024 * 1024, 'application/pdf');
    const result = await processDocumentWithOCR(bigFile, 'invoice');

    expect(result.success).toBe(false);
    expect(result.error).toContain('File too large');
    expect(result.error).toContain('10MB');
    expect(result.confidence).toBe(0);
    expect(result.processing_time_ms).toBe(0);
  });

  it('accepts a file at exactly 10MB', async () => {
    const exactFile = makeFile('exact.pdf', 10 * 1024 * 1024, 'application/pdf');
    mockPdfDocument(1);
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: 'text', parsed_data: {}, confidence: 0.9 },
      error: null,
    });

    const result = await processDocumentWithOCR(exactFile, 'invoice');
    // Should NOT be rejected for size — error is either undefined or does not mention size
    if (result.error) {
      expect(result.error).not.toContain('File too large');
    } else {
      expect(result.error).toBeUndefined();
    }
  });

  it('returns error for unsupported file type', async () => {
    const csvFile = makeFile('data.csv', 1024, 'text/csv');
    const result = await processDocumentWithOCR(csvFile, 'invoice');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported file type');
    expect(result.document_type).toBe('invoice');
  });

  it('handles empty file (0 bytes) gracefully', async () => {
    const emptyFile = makeFile('empty.jpg', 0, 'image/jpeg');
    setupImageMock();
    mockInvoke.mockResolvedValue({
      data: { success: false, raw_text: '', parsed_data: null, confidence: 0 },
      error: null,
    });

    const result = await processDocumentWithOCR(emptyFile, 'invoice');
    // Should not throw — returns an OCRResult either way
    expect(result.document_type).toBe('invoice');
  });
});

// ── 2. Document type handling ──────────────────────────────────────────────

describe('processDocumentWithOCR — document types', () => {
  const allTypes: DocumentType[] = [
    'invoice',
    'purchase_order',
    'price_list',
    'product_list',
    'customer_list',
    'quote_list',
  ];

  it.each(allTypes)(
    'accepts document type "%s" and passes it to the edge function',
    async (docType) => {
      const file = makeFile('test.png', 5000, 'image/png');
      setupImageMock();
      mockInvoke.mockResolvedValue({
        data: { success: true, raw_text: 'ok', parsed_data: null, confidence: 0.8 },
        error: null,
      });

      const result = await processDocumentWithOCR(file, docType);

      expect(result.document_type).toBe(docType);
      expect(mockInvoke).toHaveBeenCalledWith('process-document', {
        body: expect.objectContaining({ document_type: docType }),
      });
    },
  );
});

// ── 3. PDF processing ──────────────────────────────────────────────────────

describe('processDocumentWithOCR — PDF processing', () => {
  it('calls pdfjs getDocument for PDF files', async () => {
    const file = makeFile('invoice.pdf', 5000, 'application/pdf');
    mockPdfDocument(1);
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: 'text', parsed_data: {}, confidence: 0.95 },
      error: null,
    });

    await processDocumentWithOCR(file, 'invoice');

    expect(mockGetDocument).toHaveBeenCalled();
  });

  it('limits processing to MAX_PAGES (20) pages', async () => {
    const file = makeFile('big.pdf', 5000, 'application/pdf');
    mockPdfDocument(25); // 25 pages, but should only process 20
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: 'text', parsed_data: {}, confidence: 0.8 },
      error: null,
    });

    await processDocumentWithOCR(file, 'invoice');

    // getPage should have been called exactly 20 times (not 25)
    expect(mockGetPage).toHaveBeenCalledTimes(20);
  });

  it('creates canvas at 2x scale (RENDER_SCALE)', async () => {
    const file = makeFile('test.pdf', 5000, 'application/pdf');
    const { mockPage } = mockPdfDocument(1);
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: 'text', parsed_data: {}, confidence: 0.9 },
      error: null,
    });

    await processDocumentWithOCR(file, 'invoice');

    expect(mockPage.getViewport).toHaveBeenCalledWith({ scale: 2 });
  });

  it('sends pages with page_number starting at 1 for PDFs', async () => {
    const file = makeFile('two-page.pdf', 5000, 'application/pdf');
    mockPdfDocument(2);
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: 'text', parsed_data: {}, confidence: 0.9 },
      error: null,
    });

    await processDocumentWithOCR(file, 'invoice');

    // Edge function should receive pages with sequential page_numbers
    const callBody = mockInvoke.mock.calls[0][1].body;
    expect(callBody.pages).toHaveLength(2);
    expect(callBody.pages[0].page_number).toBe(1);
    expect(callBody.pages[1].page_number).toBe(2);
  });
});

// ── 4. Image processing ────────────────────────────────────────────────────

describe('processDocumentWithOCR — image processing', () => {
  it('calls compressImage for image files', async () => {
    const file = makeFile('photo.jpg', 5000, 'image/jpeg');
    setupImageMock();
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: 'text', parsed_data: {}, confidence: 0.7 },
      error: null,
    });

    await processDocumentWithOCR(file, 'invoice');

    expect(mockCompressImage).toHaveBeenCalledWith(file);
  });

  it('handles PNG images', async () => {
    const file = makeFile('scan.png', 5000, 'image/png');
    setupImageMock();
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: 'text', parsed_data: {}, confidence: 0.85 },
      error: null,
    });

    const result = await processDocumentWithOCR(file, 'product_list');

    expect(result.success).toBe(true);
    expect(mockCompressImage).toHaveBeenCalled();
  });

  it('handles WebP images', async () => {
    const file = makeFile('scan.webp', 5000, 'image/webp');
    setupImageMock();
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: 'text', parsed_data: {}, confidence: 0.8 },
      error: null,
    });

    const result = await processDocumentWithOCR(file, 'customer_list');

    expect(result.success).toBe(true);
  });

  it('sends single page with page_number 1 for images', async () => {
    const file = makeFile('photo.jpg', 5000, 'image/jpeg');
    setupImageMock();
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: 'text', parsed_data: {}, confidence: 0.9 },
      error: null,
    });

    await processDocumentWithOCR(file, 'invoice');

    const callBody = mockInvoke.mock.calls[0][1].body;
    expect(callBody.pages).toHaveLength(1);
    expect(callBody.pages[0].page_number).toBe(1);
    expect(typeof callBody.pages[0].base64).toBe('string');
  });
});

// ── 5. Edge function integration ───────────────────────────────────────────

describe('processDocumentWithOCR — edge function integration', () => {
  it('sends correct payload format to edge function', async () => {
    const file = makeFile('scan.jpg', 5000, 'image/jpeg');
    setupImageMock();
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: 'ok', parsed_data: { items: [] }, confidence: 0.9 },
      error: null,
    });

    await processDocumentWithOCR(file, 'purchase_order', { vendor_name: 'Acme' });

    expect(mockInvoke).toHaveBeenCalledWith('process-document', {
      body: {
        document_type: 'purchase_order',
        pages: expect.arrayContaining([
          expect.objectContaining({ page_number: 1, base64: expect.any(String) }),
        ]),
        metadata: { vendor_name: 'Acme' },
      },
    });
  });

  it('returns successful OCR result with all fields', async () => {
    const file = makeFile('doc.jpg', 5000, 'image/jpeg');
    setupImageMock();
    mockInvoke.mockResolvedValue({
      data: {
        success: true,
        raw_text: 'Invoice #1234',
        parsed_data: { invoice_number: '1234' },
        confidence: 0.95,
        warning: 'Low resolution on page 2',
      },
      error: null,
    });

    const result = await processDocumentWithOCR(file, 'invoice');

    expect(result.success).toBe(true);
    expect(result.raw_text).toBe('Invoice #1234');
    expect(result.parsed_data).toEqual({ invoice_number: '1234' });
    expect(result.confidence).toBe(0.95);
    expect(result.document_type).toBe('invoice');
    expect(result.warning).toBe('Low resolution on page 2');
    expect(result.processing_time_ms).toBeGreaterThanOrEqual(0);
  });

  it('handles edge function error response', async () => {
    const file = makeFile('doc.jpg', 5000, 'image/jpeg');
    setupImageMock();
    mockInvoke.mockResolvedValue({
      data: null,
      error: { message: 'Internal Server Error' },
    });

    const result = await processDocumentWithOCR(file, 'invoice');

    expect(result.success).toBe(false);
    expect(result.error).toContain('OCR processing failed');
    expect(result.error).toContain('Internal Server Error');
    expect(result.confidence).toBe(0);
  });

  it('handles network/timeout errors (thrown exception)', async () => {
    const file = makeFile('doc.jpg', 5000, 'image/jpeg');
    setupImageMock();
    mockInvoke.mockRejectedValue(new Error('Network request timed out'));

    const result = await processDocumentWithOCR(file, 'invoice');

    expect(result.success).toBe(false);
    expect(result.error).toContain('OCR processing error');
    expect(result.error).toContain('Network request timed out');
  });

  it('handles malformed response (missing fields)', async () => {
    const file = makeFile('doc.jpg', 5000, 'image/jpeg');
    setupImageMock();
    mockInvoke.mockResolvedValue({
      data: {}, // missing success, raw_text, parsed_data, confidence
      error: null,
    });

    const result = await processDocumentWithOCR(file, 'price_list');

    // Should use fallback values
    expect(result.success).toBe(false); // data.success is undefined -> ?? false
    expect(result.raw_text).toBe('');
    expect(result.parsed_data).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('passes empty metadata when none provided', async () => {
    const file = makeFile('doc.png', 5000, 'image/png');
    setupImageMock();
    mockInvoke.mockResolvedValue({
      data: { success: true, raw_text: '', parsed_data: null, confidence: 0.5 },
      error: null,
    });

    await processDocumentWithOCR(file, 'quote_list');

    expect(mockInvoke).toHaveBeenCalledWith('process-document', {
      body: expect.objectContaining({ metadata: {} }),
    });
  });
});

// ── 6. isOCRSupported helper ───────────────────────────────────────────────

describe('isOCRSupported', () => {
  it('returns true for PDF files', () => {
    expect(isOCRSupported(makeFile('doc.pdf', 100, 'application/pdf'))).toBe(true);
  });

  it('returns true for JPEG images', () => {
    expect(isOCRSupported(makeFile('photo.jpg', 100, 'image/jpeg'))).toBe(true);
  });

  it('returns true for PNG images', () => {
    expect(isOCRSupported(makeFile('scan.png', 100, 'image/png'))).toBe(true);
  });

  it('returns true for WebP images', () => {
    expect(isOCRSupported(makeFile('file.webp', 100, 'image/webp'))).toBe(true);
  });

  it('returns false for CSV files', () => {
    expect(isOCRSupported(makeFile('data.csv', 100, 'text/csv'))).toBe(false);
  });

  it('returns false for plain text files', () => {
    expect(isOCRSupported(makeFile('notes.txt', 100, 'text/plain'))).toBe(false);
  });
});

// ── 7. isCSVFile helper ────────────────────────────────────────────────────

describe('isCSVFile', () => {
  it('returns true for .csv extension', () => {
    expect(isCSVFile(makeFile('data.csv', 100, 'application/octet-stream'))).toBe(true);
  });

  it('returns true for text/csv MIME type', () => {
    expect(isCSVFile(makeFile('data.txt', 100, 'text/csv'))).toBe(true);
  });

  it('returns false for PDF', () => {
    expect(isCSVFile(makeFile('doc.pdf', 100, 'application/pdf'))).toBe(false);
  });

  it('returns false for images', () => {
    expect(isCSVFile(makeFile('photo.jpg', 100, 'image/jpeg'))).toBe(false);
  });
});
