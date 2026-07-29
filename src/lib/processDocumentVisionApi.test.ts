import { describe, expect, it, vi } from 'vitest';
import {
  callVisionAPI,
  ocrAllPages,
  VISION_API_TIMEOUT_MS,
  VISION_OCR_TOTAL_TIMEOUT_MS,
} from '../../supabase/functions/process-document/visionApi';

describe('process-document Google Vision client', () => {
  it('sends the OCR request with the production timeout signal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      responses: [{ fullTextAnnotation: { text: 'recognized text' } }],
    }), { status: 200 }));

    await expect(callVisionAPI('base64-image', 'test-key', { fetchImpl }))
      .resolves.toBe('recognized text');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://vision.googleapis.com/v1/images:annotate?key=test-key',
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(VISION_API_TIMEOUT_MS).toBe(45_000);
    expect(VISION_OCR_TOTAL_TIMEOUT_MS).toBe(120_000);
  });

  it('converts an upstream timeout into a controlled error', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason);
        }, { once: true });
      }));

    await expect(callVisionAPI('base64-image', 'test-key', {
      fetchImpl,
      timeoutMs: 5,
    })).rejects.toThrow('Vision API request timed out after 5ms');
  });

  it('preserves non-timeout provider errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('quota exceeded', {
      status: 429,
    }));

    await expect(callVisionAPI('base64-image', 'test-key', { fetchImpl }))
      .rejects.toThrow('Vision API error (429): quota exceeded');
  });

  it('shares one total deadline across sequential page batches', async () => {
    const observedSignals = new Set<AbortSignal>();
    let callCount = 0;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      if (init?.signal) observedSignals.add(init.signal);

      if (callCount <= 5) {
        return Promise.resolve(new Response(JSON.stringify({
          responses: [{ fullTextAnnotation: { text: `page ${callCount}` } }],
        }), { status: 200 }));
      }

      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason);
        }, { once: true });
      });
    });

    const pages = Array.from({ length: 6 }, (_, index) => ({
      base64: `page-${index + 1}`,
      page_number: index + 1,
    }));

    await expect(ocrAllPages(pages, 'test-key', {
      fetchImpl,
      totalTimeoutMs: 10,
    })).rejects.toThrow('Vision API request timed out after 10ms');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(observedSignals.size).toBe(1);
  });
});
