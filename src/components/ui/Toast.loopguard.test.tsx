import { describe, it, expect } from 'vitest';
import { useCallback, useEffect, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';

// Regression guard (Sol 3.G, 2026-07-16): a page whose load FAILS and fires a
// toast must not reload forever. That loop only occurs if `toast` changes
// identity across renders — the real provider must keep it stable even while
// toasts are being added (which re-renders the provider). An unstable test
// stub reproduced exactly this loop as a 4GB worker OOM.
function FailingLoader({ onLoad }: { onLoad: () => void }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<string[]>([]);
  const load = useCallback(async () => {
    onLoad();
    await Promise.resolve();
    toast('error', 'load failed');
  }, [onLoad, toast]);
  useEffect(() => {
    setRows([]);
    void load();
  }, [load]);
  return <div data-testid="rows">{rows.length}</div>;
}

describe('ToastProvider loop guard', () => {
  it('a failing load that toasts runs exactly once (stable toast identity)', async () => {
    let loads = 0;
    render(
      <ToastProvider>
        <FailingLoader onLoad={() => { loads += 1; }} />
      </ToastProvider>,
    );
    // The toast renders (provider re-rendered) …
    await waitFor(() => expect(screen.getByText('load failed')).toBeInTheDocument());
    // … and even after provider re-renders settle, the loader has not re-fired.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loads).toBe(1);
  });
});
