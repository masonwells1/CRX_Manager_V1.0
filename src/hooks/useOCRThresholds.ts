import { useState, useEffect } from 'react';
import { supabase } from '../lib/db';

interface OCRThresholds {
  auto_approve: number;
  needs_review: number;
}

const DEFAULT_THRESHOLDS: OCRThresholds = { auto_approve: 85, needs_review: 50 };

export function useOCRThresholds(): OCRThresholds {
  const [thresholds, setThresholds] = useState<OCRThresholds>(DEFAULT_THRESHOLDS);

  useEffect(() => {
    supabase
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', 'ocr_confidence_threshold')
      .single()
      .then(({ data }) => {
        if (data?.setting_value) {
          try {
            const parsed = typeof data.setting_value === 'string'
              ? JSON.parse(data.setting_value)
              : data.setting_value;
            if (parsed.auto_approve != null && parsed.needs_review != null) {
              setThresholds(parsed as OCRThresholds);
            }
          } catch {
            // Keep defaults on parse failure
          }
        }
      });
  }, []);

  return thresholds;
}
