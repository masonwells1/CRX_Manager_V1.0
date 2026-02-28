import { useRef, useEffect, useCallback } from 'react';
import SignaturePad from 'signature_pad';

interface SignatureCanvasProps {
  onSignatureChange: (dataUrl: string | null) => void;
  width?: number;
  height?: number;
  label?: string;
  disabled?: boolean;
}

export default function SignatureCanvas({
  onSignatureChange,
  width = 400,
  height = 150,
  label = 'Signature',
  disabled = false,
}: SignatureCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Handle high-DPI displays
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d')?.scale(ratio, ratio);

    const pad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)',
    });

    pad.addEventListener('endStroke', () => {
      if (!pad.isEmpty()) {
        onSignatureChange(pad.toDataURL('image/png'));
      }
    });

    if (disabled) {
      pad.off();
    }

    padRef.current = pad;

    return () => {
      pad.off();
    };
  }, [disabled, onSignatureChange]);

  const handleClear = useCallback(() => {
    padRef.current?.clear();
    onSignatureChange(null);
  }, [onSignatureChange]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-secondary">{label}</label>
        {!disabled && (
          <button
            type="button"
            onClick={handleClear}
            className="text-xs text-red-500 hover:text-red-700 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        className="border border-gray-200 rounded-lg cursor-crosshair touch-none w-full"
      />
    </div>
  );
}
