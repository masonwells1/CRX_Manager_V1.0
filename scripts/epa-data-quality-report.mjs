#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFindingsForRegistration,
  buildLookupErrorFindings,
  classifyRegistrationNumber,
  groupProductsByRegistration,
} from '../src/lib/epaDataQualityReport.ts';
import { normalizeEpaPayload } from '../supabase/functions/epa-lookup/logic.ts';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, '.epa-data-quality');
const DEFAULT_PROJECT_REF = 'rhyzpcqhnizqbxphqdkr';
const EPA_BASE_URL = 'https://ordspub.epa.gov/ords/pesticides/cswu/ppls/';
const REQUEST_INTERVAL_MS = 500;
const EPA_TIMEOUT_MS = 30_000;
const EPA_RESPONSE_LIMIT_BYTES = 5_000_000;
const MANIFEST_SCHEMA_VERSION = 1;
const FINDING_TYPES = [
  'NAME_MISMATCH',
  'DISTRIBUTOR_NAME_DIFF',
  'CANCELLED',
  'RUP_DISAGREE',
  'UNSUPPORTED_REGNUM',
  'NOT_FOUND',
  'SIGNAL_WORD_AVAILABLE',
  'NEEDS_MANUAL',
  'LOOKUP_ERROR',
];

function usage() {
  return [
    'Usage: node scripts/epa-data-quality-report.mjs [--refresh] [--chunk-size N]',
    '',
    'Required environment variable:',
    '  SUPABASE_ACCESS_TOKEN  Supabase Management API token (never written or printed)',
    '',
    'Optional environment variable:',
    `  SUPABASE_PROJECT_REF   Defaults to ${DEFAULT_PROJECT_REF}`,
    '',
    'This command is read-only: one fixed SELECT against products, then public EPA GET requests.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    refresh: false,
    chunkSize: 25,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--refresh') {
      args.refresh = true;
    } else if (arg === '--chunk-size') {
      args.chunkSize = Number(argv[++index]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.chunkSize) || args.chunkSize < 1 || args.chunkSize > 100) {
    throw new Error('--chunk-size must be an integer between 1 and 100');
  }
  return args;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeError(error) {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `request timed out after ${EPA_TIMEOUT_MS / 1000} seconds`;
    }
    return error.message.slice(0, 300);
  }
  return 'unknown error';
}

async function fetchActiveProducts(projectRef, accessToken) {
  const query = `SELECT id::text, product_name, btrim(epa_registration) AS epa_registration, is_rup, signal_word
FROM public.products
WHERE is_active IS TRUE
  AND NULLIF(btrim(epa_registration), '') IS NOT NULL
ORDER BY btrim(epa_registration), id`;

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase read failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload.result ?? payload.rows;
  if (!Array.isArray(rows)) {
    throw new Error('Supabase read returned an unexpected response shape');
  }

  return rows.map((row) => {
    if (
      !row ||
      typeof row.id !== 'string' ||
      typeof row.product_name !== 'string' ||
      typeof row.epa_registration !== 'string' ||
      typeof row.is_rup !== 'boolean' ||
      (row.signal_word !== null && typeof row.signal_word !== 'string')
    ) {
      throw new Error('Supabase read returned an invalid product row');
    }
    return row;
  });
}

async function fetchEpa(registrationNumber, regType) {
  const response = await fetch(`${EPA_BASE_URL}${encodeURIComponent(registrationNumber)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(EPA_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`EPA returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(`EPA returned unexpected content type ${contentType || '(missing)'}`);
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > EPA_RESPONSE_LIMIT_BYTES) {
    throw new Error('EPA response exceeded the 5 MB safety limit');
  }

  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > EPA_RESPONSE_LIMIT_BYTES) {
    throw new Error('EPA response exceeded the 5 MB safety limit');
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('EPA returned invalid JSON');
  }

  let result;
  try {
    result = normalizeEpaPayload(payload, regType, registrationNumber);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'EPA response registration did not match the request'
    ) {
      result = normalizeEpaPayload({ items: [] }, regType, registrationNumber);
    } else {
      throw error;
    }
  }

  return { result, responseHash: sha256(stableJson(payload)) };
}

function summarizeEpaResult(result) {
  if (!result) return null;
  return {
    found: result.found,
    regType: result.regType,
    eparegno: result.eparegno,
    productname: result.productname,
    signalWordCanonical: result.signalWordCanonical,
    needsManual: result.needsManual,
    manufacturer: result.manufacturer,
    rupYn: result.rupYn,
    productStatus: result.productStatus,
    isCancelled: result.isCancelled,
    latestLabelPdfUrl: result.latestLabelPdfUrl,
  };
}

function wave4IdentityKeys(products, registrationNumber, responseHash, found) {
  if (!responseHash || !found) return [];
  return products.map((product) => ({
    productId: product.id,
    key: `epa:${sha256(stableJson({
      productId: product.id,
      source: 'epa',
      registrationNumber,
      epaResponseHash: responseHash,
    }))}`,
  }));
}

async function readExistingManifest(manifestPath) {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.registrations) {
      throw new Error('existing manifest does not contain a registrations object');
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonCheckpoint(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, manifestPath);
}

function markdownEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function countFindings(entries) {
  const counts = Object.fromEntries(FINDING_TYPES.map((type) => [type, 0]));
  for (const entry of entries) {
    for (const item of entry.findings) counts[item.type] = (counts[item.type] ?? 0) + 1;
  }
  return counts;
}

function buildMarkdownReport(manifest, productCount) {
  const entries = Object.values(manifest.registrations);
  const counts = countFindings(entries);
  const lines = [
    '# EPA Product Data-Quality Report',
    '',
    `Generated: ${manifest.meta.generatedAt}`,
    '',
    `- Active products with a nonblank EPA registration: ${productCount}`,
    `- Distinct registration numbers: ${entries.length}`,
    `- Lookupable registrations: ${entries.filter((entry) => entry.classification.supported).length}`,
    `- Unsupported registrations: ${entries.filter((entry) => !entry.classification.supported).length}`,
    '',
    '## Finding counts',
    '',
    '| Finding | Products |',
    '|---|---:|',
    ...FINDING_TYPES.map((type) => `| ${type} | ${counts[type] ?? 0} |`),
  ];

  for (const type of FINDING_TYPES) {
    const findings = entries.flatMap((entry) => entry.findings)
      .filter((item) => item.type === type);
    lines.push('', `## ${type} (${findings.length})`, '');
    if (findings.length === 0) {
      lines.push('None.');
      continue;
    }
    lines.push(
      '| Registration | Product | Product ID | Ours | EPA | Detail |',
      '|---|---|---|---|---|---|',
      ...findings.map((item) => [
        item.registrationNumber,
        item.productName,
        item.productId,
        item.ourValue,
        item.epaValue,
        item.message,
      ].map(markdownEscape).join(' | ')).map((row) => `| ${row} |`),
    );
  }

  return `${lines.join('\n')}\n`;
}

async function waitForThrottle(lastStartedAt) {
  const waitMs = REQUEST_INTERVAL_MS - (Date.now() - lastStartedAt);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = process.env.SUPABASE_PROJECT_REF || DEFAULT_PROJECT_REF;
  if (!accessToken) throw new Error('SUPABASE_ACCESS_TOKEN is not set');
  if (!/^[a-z0-9]{20}$/.test(projectRef)) throw new Error('SUPABASE_PROJECT_REF is invalid');

  await mkdir(DEFAULT_OUTPUT_DIR, { recursive: true });
  const manifestPath = path.join(DEFAULT_OUTPUT_DIR, 'manifest.json');
  const reportPath = path.join(DEFAULT_OUTPUT_DIR, 'report.md');
  const existing = args.refresh ? null : await readExistingManifest(manifestPath);

  console.log('Reading active products from Supabase with one SELECT...');
  const products = await fetchActiveProducts(projectRef, accessToken);
  const groups = groupProductsByRegistration(products);
  const registrations = [...groups.keys()];
  const manifest = {
    meta: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      source: 'Supabase products SELECT + EPA public PPLS API',
      readOnly: true,
      productCount: products.length,
      registrationCount: registrations.length,
    },
    registrations: {},
  };

  let skipped = 0;
  let lookedUp = 0;
  let lastEpaRequestStartedAt = 0;

  for (let offset = 0; offset < registrations.length; offset += args.chunkSize) {
    const chunk = registrations.slice(offset, offset + args.chunkSize);
    console.log(`Chunk ${Math.floor(offset / args.chunkSize) + 1}/${Math.ceil(registrations.length / args.chunkSize)} (${chunk.length} registrations)`);

    for (const registrationNumber of chunk) {
      const groupedProducts = groups.get(registrationNumber);
      const priorEntry = existing?.registrations?.[registrationNumber];
      if (priorEntry) {
        manifest.registrations[registrationNumber] = priorEntry;
        skipped += 1;
        continue;
      }

      const classification = classifyRegistrationNumber(registrationNumber);
      let epaResult = null;
      let responseHash = null;
      let hashOrError;
      let findings;

      if (!classification.supported) {
        hashOrError = `UNSUPPORTED:${classification.kind}`;
        findings = buildFindingsForRegistration(
          registrationNumber,
          classification,
          groupedProducts,
          null,
        );
      } else {
        try {
          await waitForThrottle(lastEpaRequestStartedAt);
          lastEpaRequestStartedAt = Date.now();
          const fetched = await fetchEpa(
            classification.normalized,
            classification.kind,
          );
          epaResult = fetched.result;
          responseHash = fetched.responseHash;
          hashOrError = `sha256:${responseHash}`;
          findings = buildFindingsForRegistration(
            registrationNumber,
            classification,
            groupedProducts,
            epaResult,
          );
          lookedUp += 1;
        } catch (error) {
          const message = safeError(error);
          hashOrError = `ERROR:${message}`;
          findings = buildLookupErrorFindings(
            registrationNumber,
            groupedProducts,
            message,
          );
          console.warn(`  ${registrationNumber}: ${message}`);
        }
      }

      manifest.registrations[registrationNumber] = {
        classification,
        epaResult: summarizeEpaResult(epaResult),
        affectedProductIds: groupedProducts.map((product) => product.id),
        findings,
        epaResponseHashOrError: hashOrError,
        wave4IdentityKeys: wave4IdentityKeys(
          groupedProducts,
          registrationNumber,
          responseHash,
          epaResult?.found === true,
        ),
      };
      await writeJsonCheckpoint(manifestPath, manifest);
    }
  }

  manifest.meta.completedAt = new Date().toISOString();
  await writeJsonCheckpoint(manifestPath, manifest);
  await writeFile(reportPath, buildMarkdownReport(manifest, products.length), 'utf8');

  const counts = countFindings(Object.values(manifest.registrations));
  console.log('');
  console.log(`Completed read-only report: ${products.length} products, ${registrations.length} registrations`);
  console.log(`EPA lookups this run: ${lookedUp}; resumed/skipped: ${skipped}`);
  for (const type of FINDING_TYPES) console.log(`${type}: ${counts[type] ?? 0}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => {
  console.error(`FATAL: ${safeError(error)}`);
  process.exitCode = 1;
});
