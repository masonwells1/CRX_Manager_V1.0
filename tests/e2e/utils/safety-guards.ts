/**
 * E2E safety configuration. The fixture suite creates and deletes data, so it
 * is staging-only: there is intentionally no production override.
 */

const PROD_PROJECT_ID = 'rhyzpcqhnizqbxphqdkr';

export interface SafeE2EConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface E2ESourceFile {
  path: string;
  content: string;
}

export function resolveSafeE2EConfig(
  env: NodeJS.ProcessEnv = process.env,
): SafeE2EConfig {
  const target = env.E2E_TARGET_ENV?.trim().toLowerCase();
  const supabaseUrl = env.E2E_SUPABASE_URL?.trim();
  const supabaseAnonKey = env.E2E_SUPABASE_ANON_KEY?.trim();

  if (target !== 'staging') {
    throw new Error(
      'E2E_SAFETY: E2E_TARGET_ENV must be explicitly set to "staging".',
    );
  }
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'E2E_SAFETY: E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY are required.',
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    throw new Error('E2E_SAFETY: E2E_SUPABASE_URL must be a valid URL.');
  }

  const isSupabaseHost = parsedUrl.hostname.endsWith('.supabase.co');
  const targetsProd = parsedUrl.hostname.includes(PROD_PROJECT_ID);
  if (parsedUrl.protocol !== 'https:' || !isSupabaseHost) {
    throw new Error(
      'E2E_SAFETY: staging must use an https://*.supabase.co URL.',
    );
  }
  if (targetsProd) {
    throw new Error(
      `E2E_SAFETY: fixture mutations may never target production Supabase (${PROD_PROJECT_ID}).`,
    );
  }

  return { supabaseUrl: parsedUrl.origin, supabaseAnonKey };
}

export function assertNoProductionEndpointReferences(
  sources: E2ESourceFile[],
): void {
  const productionEndpoint = `https://${PROD_PROJECT_ID}.supabase.co`;
  const violations = sources
    .filter(({ content }) => content.includes(productionEndpoint))
    .map(({ path }) => path);

  if (violations.length > 0) {
    throw new Error(
      'E2E_SAFETY: production Supabase endpoint literals remain in E2E code. ' +
        'Migrate them to E2E_SUPABASE_URL before enabling the suite:\n' +
        violations.map((path) => `  - ${path}`).join('\n'),
    );
  }
}
