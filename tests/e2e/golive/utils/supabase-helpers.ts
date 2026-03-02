/**
 * Supabase REST & RPC helpers for go-live validation tests.
 *
 * Runs DB queries from within the Playwright browser context by extracting
 * the user's JWT from localStorage and making fetch() calls to the
 * Supabase REST API. This lets us cross-reference UI values against the
 * actual database without needing a separate Supabase client.
 */

import { Page } from '@playwright/test';

const SUPABASE_URL = 'https://rhyzpcqhnizqbxphqdkr.supabase.co';
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoeXpwY3Fobml6cWJ4cGhxZGtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzOTM2NDAsImV4cCI6MjA4NTk2OTY0MH0.WR0vAi_KeGF0OoJ8_dFH7uW6ael9M5xnm6OUo2IZy7U';

/** Extract the access_token from Supabase's localStorage entry */
async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('sb-rhyzpcqhnizqbxphqdkr-auth-token');
    if (!raw) return '';
    try {
      const session = JSON.parse(raw);
      return session.access_token || '';
    } catch {
      return '';
    }
  });
}

/**
 * Make a Supabase REST API call from the browser context.
 *
 * @example
 *   // Fetch all invoices
 *   const invoices = await supabaseRest(page, 'GET', 'invoices?select=*&status=eq.posted');
 *
 *   // Fetch with PostgREST embedding
 *   const items = await supabaseRest(page, 'GET', 'orders?select=id,order_items(quantity,price_per_unit)');
 */
export async function supabaseRest(
  page: Page,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const token = await getToken(page);

  return page.evaluate(
    async ({ method, path, body, token, url, key }) => {
      const resp = await fetch(`${url}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: key,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    { method, path, body, token, url: SUPABASE_URL, key: ANON_KEY },
  );
}

/**
 * Call a Supabase RPC function from the browser context.
 *
 * @example
 *   const summary = await supabaseRpc(page, 'financial_dashboard_summary');
 *   const periodOk = await supabaseRpc(page, 'check_period_open', { p_date: '2026-03-01' });
 */
/**
 * Validate that a Supabase REST response is an array.
 * If it's an error object from PostgREST, throw with a clear message.
 * If it's not an array for any other reason, throw with details.
 */
export function asArray<T = Record<string, unknown>>(
  result: unknown,
  context: string,
): T[] {
  if (Array.isArray(result)) return result as T[];

  // PostgREST error objects have { message, code, details, hint }
  if (result && typeof result === 'object') {
    const err = result as Record<string, unknown>;
    if ('message' in err || 'code' in err) {
      throw new Error(
        `Supabase REST error in ${context}: ${err.message || ''} ` +
          `(code: ${err.code || 'unknown'}, hint: ${err.hint || 'none'})`,
      );
    }
  }

  throw new Error(
    `Expected array from ${context}, got ${typeof result}: ${JSON.stringify(result)?.slice(0, 200)}`,
  );
}

export async function supabaseRpc(
  page: Page,
  functionName: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const token = await getToken(page);

  return page.evaluate(
    async ({ functionName, params, token, url, key }) => {
      const resp = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params || {}),
      });
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    { functionName, params, token, url: SUPABASE_URL, key: ANON_KEY },
  );
}
