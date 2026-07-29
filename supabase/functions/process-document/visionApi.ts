import type { PageInput } from "./ocrBoundary.ts";

export const VISION_API_TIMEOUT_MS = 45_000;
export const VISION_OCR_TOTAL_TIMEOUT_MS = 120_000;

type VisionFetch = typeof fetch;

interface VisionRequestOptions {
  fetchImpl?: VisionFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface VisionBatchOptions {
  batchSize?: number;
  fetchImpl?: VisionFetch;
  totalTimeoutMs?: number;
}

export async function callVisionAPI(
  imageBase64: string,
  apiKey: string,
  options: VisionRequestOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? VISION_API_TIMEOUT_MS;

  try {
    const response = await fetchImpl(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content: imageBase64 },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            },
          ],
        }),
        signal: options.signal ?? AbortSignal.timeout(timeoutMs),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Vision API error (${response.status}): ${errBody}`);
    }

    const data = await response.json();
    const annotation = data.responses?.[0]?.fullTextAnnotation;
    return annotation?.text || "";
  } catch (error) {
    const errorName =
      typeof error === "object" && error !== null && "name" in error
        ? String(error.name)
        : "";
    if (errorName === "TimeoutError" || errorName === "AbortError") {
      throw new Error(`Vision API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

export async function ocrAllPages(
  pages: PageInput[],
  apiKey: string,
  options: VisionBatchOptions = {},
): Promise<string> {
  const batchSize = options.batchSize ?? 5;
  const totalTimeoutMs =
    options.totalTimeoutMs ?? VISION_OCR_TOTAL_TIMEOUT_MS;
  const overallSignal = AbortSignal.timeout(totalTimeoutMs);
  const allTexts: string[] = [];

  for (let i = 0; i < pages.length; i += batchSize) {
    const batch = pages.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((page) =>
        callVisionAPI(page.base64, apiKey, {
          fetchImpl: options.fetchImpl,
          signal: overallSignal,
          timeoutMs: totalTimeoutMs,
        })
      ),
    );
    allTexts.push(...results);
  }

  return allTexts.join("\n\n--- PAGE BREAK ---\n\n");
}
