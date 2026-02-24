/**
 * sentry.test.ts — Tests for Sentry initialization + config
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock @sentry/react ───────────────────────────────────────────────────

const mockInit = vi.fn();

vi.mock('@sentry/react', () => ({
  init: mockInit,
}));

// ── Tests ────────────────────────────────────────────────────────────────

describe('initSentry', () => {
  const originalEnv = { ...import.meta.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original env
    Object.assign(import.meta.env, originalEnv);
  });

  it('does nothing when VITE_SENTRY_DSN is not set', async () => {
    import.meta.env.VITE_SENTRY_DSN = '';
    const { initSentry } = await import('./sentry');
    initSentry();
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('calls Sentry.init when DSN is provided', async () => {
    import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
    const { initSentry } = await import('./sentry');
    initSentry();
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('passes correct DSN and sample rates', async () => {
    import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
    const { initSentry } = await import('./sentry');
    initSentry();
    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://abc@o123.ingest.sentry.io/456',
        sampleRate: 1.0,
        tracesSampleRate: 0.1,
      }),
    );
  });

  it('includes ignoreErrors list', async () => {
    import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
    const { initSentry } = await import('./sentry');
    initSentry();
    const config = mockInit.mock.calls[0][0];
    expect(config.ignoreErrors).toContain('ResizeObserver loop');
    expect(config.ignoreErrors).toContain('Failed to fetch');
    expect(config.ignoreErrors).toContain('NetworkError');
  });

  it('beforeSend redacts JWT tokens from messages', async () => {
    import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
    const { initSentry } = await import('./sentry');
    initSentry();

    const config = mockInit.mock.calls[0][0];
    const event = {
      message: 'Error with token eyJhbGciOiJIUzI1NiJ9.payload.signature',
    };
    const result = config.beforeSend(event);
    expect(result.message).toContain('[JWT_REDACTED]');
    expect(result.message).not.toContain('eyJ');
  });

  it('beforeSend passes through events without messages', async () => {
    import.meta.env.VITE_SENTRY_DSN = 'https://abc@o123.ingest.sentry.io/456';
    const { initSentry } = await import('./sentry');
    initSentry();

    const config = mockInit.mock.calls[0][0];
    const event = { exception: { values: [] } };
    const result = config.beforeSend(event);
    expect(result).toEqual(event);
  });
});
