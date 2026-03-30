import { useState, useEffect } from 'react';
import { Save } from 'lucide-react';
import Card, { CardHeader } from '../ui/Card';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { logActivity } from '../../lib/activityLogger';
import { useAuth } from '../../contexts/AuthContext';

export function OCRThresholdSettings() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [autoApprove, setAutoApprove] = useState('85');
  const [needsReview, setNeedsReview] = useState('50');
  const [saving, setSaving] = useState(false);

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
            if (parsed.auto_approve != null) setAutoApprove(String(parsed.auto_approve));
            if (parsed.needs_review != null) setNeedsReview(String(parsed.needs_review));
          } catch {
            // keep defaults
          }
        }
      });
  }, []);

  const handleSave = async () => {
    const autoVal = Number(autoApprove);
    const reviewVal = Number(needsReview);
    if (isNaN(autoVal) || isNaN(reviewVal) || autoVal < 0 || autoVal > 100 || reviewVal < 0 || reviewVal > 100) {
      toast('error', 'Thresholds must be between 0 and 100');
      return;
    }
    if (reviewVal >= autoVal) {
      toast('error', 'Needs review threshold must be less than auto-approve threshold');
      return;
    }

    setSaving(true);
    try {
      const value = JSON.stringify({ auto_approve: autoVal, needs_review: reviewVal });
      const result = await supabase
        .from('app_settings')
        .upsert(
          { setting_key: 'ocr_confidence_threshold', setting_value: value, updated_at: new Date().toISOString() },
          { onConflict: 'setting_key' }
        )
        .select();
      checkMutationResult(result, 'Save OCR thresholds');
      toast('success', 'OCR thresholds saved');
      if (profile) {
        await logActivity({
          event: 'settings_updated',
          description: `OCR thresholds updated: auto-approve=${autoVal}%, needs-review=${reviewVal}%`,
          performedBy: profile.id,
        });
      }
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to save');
    }
    setSaving(false);
  };

  return (
    <Card>
      <CardHeader
        title="OCR"
        accent="Thresholds"
        action={
          <Button size="sm" icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
            Save
          </Button>
        }
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          label="Auto-Approve Threshold (%)"
          type="number"
          min="0"
          max="100"
          value={autoApprove}
          onChange={(e) => setAutoApprove(e.target.value)}
          placeholder="e.g. 85"
        />
        <Input
          label="Needs Review Threshold (%)"
          type="number"
          min="0"
          max="100"
          value={needsReview}
          onChange={(e) => setNeedsReview(e.target.value)}
          placeholder="e.g. 50"
        />
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Green = above auto-approve | Yellow = between thresholds | Red = below needs review
      </p>
    </Card>
  );
}
