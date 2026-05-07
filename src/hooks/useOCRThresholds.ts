interface OCRThresholds {
  auto_approve: number;
  needs_review: number;
}

export const OCR_CONFIDENCE_THRESHOLD = 70;

export function useOCRThresholds(): OCRThresholds {
  return {
    auto_approve: OCR_CONFIDENCE_THRESHOLD,
    needs_review: OCR_CONFIDENCE_THRESHOLD,
  };
}
