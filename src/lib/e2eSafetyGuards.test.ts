import { describe, expect, it } from 'vitest';
import {
  assertNoProductionEndpointReferences,
  resolveSafeE2EConfig,
} from '../../tests/e2e/utils/safety-guards';

const stagingEnv = {
  E2E_TARGET_ENV: 'staging',
  E2E_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  E2E_SUPABASE_ANON_KEY: 'staging-anon-key',
} satisfies NodeJS.ProcessEnv;

describe('resolveSafeE2EConfig', () => {
  it('accepts an explicit non-production Supabase staging target', () => {
    expect(resolveSafeE2EConfig(stagingEnv)).toEqual({
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      supabaseAnonKey: 'staging-anon-key',
    });
  });

  it('fails closed when the staging target is not explicit', () => {
    expect(() =>
      resolveSafeE2EConfig({
        E2E_SUPABASE_URL: stagingEnv.E2E_SUPABASE_URL,
        E2E_SUPABASE_ANON_KEY: stagingEnv.E2E_SUPABASE_ANON_KEY,
      }),
    ).toThrow('E2E_TARGET_ENV must be explicitly set to "staging"');
  });

  it('fails closed when staging credentials are missing', () => {
    expect(() => resolveSafeE2EConfig({ E2E_TARGET_ENV: 'staging' })).toThrow(
      'E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY are required',
    );
  });

  it('categorically rejects the production project even if an old override is present', () => {
    expect(() =>
      resolveSafeE2EConfig({
        ...stagingEnv,
        E2E_SUPABASE_URL: 'https://rhyzpcqhnizqbxphqdkr.supabase.co',
        E2E_ALLOW_PROD: 'true',
      }),
    ).toThrow('fixture mutations may never target production Supabase');
  });

  it('rejects non-Supabase and non-HTTPS targets', () => {
    expect(() =>
      resolveSafeE2EConfig({
        ...stagingEnv,
        E2E_SUPABASE_URL: 'http://localhost:54321',
      }),
    ).toThrow('staging must use an https://*.supabase.co URL');
  });
});

describe('assertNoProductionEndpointReferences', () => {
  it('blocks E2E source that bypasses the staging URL', () => {
    expect(() =>
      assertNoProductionEndpointReferences([
        {
          path: 'unsafe.spec.ts',
          content:
            'fetch("https://rhyzpcqhnizqbxphqdkr.supabase.co/rest/v1/jobs")',
        },
      ]),
    ).toThrow('production Supabase endpoint literals remain in E2E code');
  });

  it('accepts source that reads the canonical E2E environment', () => {
    expect(() =>
      assertNoProductionEndpointReferences([
        {
          path: 'safe.spec.ts',
          content: 'fetch(`${process.env.E2E_SUPABASE_URL}/rest/v1/jobs`)',
        },
      ]),
    ).not.toThrow();
  });
});
