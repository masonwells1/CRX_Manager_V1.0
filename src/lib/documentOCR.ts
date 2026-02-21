/**
 * Document OCR helper — converts PDF/image files to page images,
 * sends them to the `process-document` Supabase Edge Function
 * for Google Vision OCR processing, and returns structured parsed data.
 *
 * Usage:
 *   const result = await processDocumentWithOCR(file, 'invoice');
 *   if (result.success) { ... result.parsed_data ... }
 */

import * as pdfjsLib from 'pdfjs-dist';
import { compressImage } from './imageCompression';
import { supabase } from './db';

// Ensure PDF.js worker is configured
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

// ─── Types ───────────────────────────────────────────────────────────────────

export type DocumentType =
  | 'invoice'
  | 'purchase_order'
  | 'price_list'
  | 'product_list'
  | 'customer_list'
  | 'quote_list';

export interface OCRResult {
  success: boolean;
  raw_text: string;
  document_type: DocumentType;
  parsed_data: unknown;
  confidence: number;
  processing_time_ms: number;
  warning?: string;
  error?: string;
}

interface PageImage {
  base64: string;
  page_number: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_PAGES = 20;
const RENDER_SCALE = 2; // 2x resolution for OCR quality
const JPEG_QUALITY = 0.85;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file

// ─── PDF → Image Conversion ─────────────────────────────────────────────────

/**
 * Renders each page of a PDF to a JPEG image at 2x resolution.
 * Returns an array of base64-encoded page images.
 */
async function pdfToImages(file: File): Promise<PageImage[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = Math.min(pdf.numPages, MAX_PAGES);
  const pages: PageImage[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(`Failed to create canvas context for page ${i}`);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Export as JPEG base64 (strip data:image/jpeg;base64, prefix)
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const base64 = dataUrl.split(',')[1];

    pages.push({ base64, page_number: i });

    // Clean up
    canvas.width = 0;
    canvas.height = 0;
  }

  if (pdf.numPages > MAX_PAGES) {
    console.warn(`PDF has ${pdf.numPages} pages, only processing first ${MAX_PAGES}`);
  }

  return pages;
}

/**
 * Converts an image file to a base64-encoded page image.
 * Compresses first using existing imageCompression utility.
 */
async function imageToPage(file: File): Promise<PageImage[]> {
  const compressed = await compressImage(file);
  const arrayBuffer = await compressed.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return [{ base64, page_number: 1 }];
}

// ─── Main API ────────────────────────────────────────────────────────────────

/**
 * Process a file (PDF or image) through Google Vision OCR via Edge Function.
 *
 * @param file - The PDF or image file to process
 * @param documentType - Type of document for parsing strategy
 * @param metadata - Optional metadata (e.g. vendor_name)
 * @returns OCRResult with parsed data and confidence score
 */
export async function processDocumentWithOCR(
  file: File,
  documentType: DocumentType,
  metadata?: Record<string, string>,
): Promise<OCRResult> {
  // Validate file size
  if (file.size > MAX_FILE_SIZE) {
    return {
      success: false,
      raw_text: '',
      document_type: documentType,
      parsed_data: null,
      confidence: 0,
      processing_time_ms: 0,
      error: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is ${MAX_FILE_SIZE / 1024 / 1024}MB.`,
    };
  }

  const startTime = Date.now();

  try {
    // Convert file to page images
    let pages: PageImage[];
    const fileName = file.name.toLowerCase();
    const isPDF = fileName.endsWith('.pdf') || file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|bmp|tiff?)$/i.test(fileName);

    if (isPDF) {
      pages = await pdfToImages(file);
    } else if (isImage) {
      pages = await imageToPage(file);
    } else {
      return {
        success: false,
        raw_text: '',
        document_type: documentType,
        parsed_data: null,
        confidence: 0,
        processing_time_ms: Date.now() - startTime,
        error: 'Unsupported file type. Upload a PDF or image (JPEG, PNG, WebP).',
      };
    }

    if (pages.length === 0) {
      return {
        success: false,
        raw_text: '',
        document_type: documentType,
        parsed_data: null,
        confidence: 0,
        processing_time_ms: Date.now() - startTime,
        error: 'No pages extracted from document.',
      };
    }

    // Call Edge Function
    const { data, error } = await supabase.functions.invoke('process-document', {
      body: {
        document_type: documentType,
        pages,
        metadata: metadata || {},
      },
    });

    if (error) {
      return {
        success: false,
        raw_text: '',
        document_type: documentType,
        parsed_data: null,
        confidence: 0,
        processing_time_ms: Date.now() - startTime,
        error: `OCR processing failed: ${error.message}`,
      };
    }

    return {
      success: data?.success ?? false,
      raw_text: data?.raw_text || '',
      document_type: documentType,
      parsed_data: data?.parsed_data || null,
      confidence: data?.confidence || 0,
      processing_time_ms: Date.now() - startTime,
      warning: data?.warning,
      error: data?.error,
    };
  } catch (err) {
    return {
      success: false,
      raw_text: '',
      document_type: documentType,
      parsed_data: null,
      confidence: 0,
      processing_time_ms: Date.now() - startTime,
      error: `OCR processing error: ${(err as Error).message}`,
    };
  }
}

/**
 * Check if a file type is suitable for OCR processing.
 */
export function isOCRSupported(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.pdf') ||
    file.type === 'application/pdf' ||
    file.type.startsWith('image/') ||
    /\.(jpg|jpeg|png|webp|bmp|tiff?)$/i.test(name)
  );
}

/**
 * Check if a file is a CSV (should use client-side parsing, not OCR).
 */
export function isCSVFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv';
}
