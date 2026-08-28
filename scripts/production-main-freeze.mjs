import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FREEZE_PREFIX = "crx-production-migration-freeze-";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;
const RELEASE_ATTEMPTS = 3;
export const RELEASE_RETRY_DELAY_MS = 250;

function assertRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository))) {
    throw new Error("repository must be an exact owner/name pair");
  }
  return String(repository);
}

function assertCommit(commit) {
  if (!/^[a-f0-9]{40}$/.test(String(commit))) throw new Error("expected main must be a full lowercase commit id");
  return String(commit);
}

export function freezeName(runId, runAttempt) {
  if (!/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(runAttempt))) {
    throw new Error("workflow run identity must be numeric");
  }
  return `${FREEZE_PREFIX}${runId}-${runAttempt}`;
}

export function buildFreezeRuleset(name) {
  if (!String(name).startsWith(FREEZE_PREFIX)) throw new Error("unexpected freeze name");
  return {
    name,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: false } }],
  };
}

export function assertExactFreezeRuleset(ruleset, expectedName) {
  buildFreezeRuleset(expectedName);
  const refCondition = ruleset?.conditions?.ref_name;
  const updateRule = Array.isArray(ruleset?.rules) && ruleset.rules.length === 1 ? ruleset.rules[0] : null;
  if (ruleset?.name !== expectedName
      || ruleset?.target !== "branch"
      || ruleset?.enforcement !== "active"
      || !Array.isArray(ruleset?.bypass_actors)
      || ruleset.bypass_actors.length !== 0
      || !Array.isArray(refCondition?.include)
      || refCondition.include.length !== 1
      || refCondition.include[0] !== "refs/heads/main"
      || !Array.isArray(refCondition?.exclude)
      || refCondition.exclude.length !== 0
      || updateRule?.type !== "update"
      || updateRule?.parameters?.update_allows_fetch_and_merge !== false
      || !Number.isSafeInteger(ruleset?.id)) {
    throw new Error("production main freeze did not match the fail-closed ruleset");
  }
  return ruleset.id;
}

export async function apiRequest(apiPath, { method = "GET", body, token, fetchImpl = fetch, allow404 = false } = {}) {
  if (typeof token !== "string" || token.length === 0) throw new Error("branch-freeze credential is unavailable");
  const response = await fetchImpl(`https://api.github.com${apiPath}`, {
    method,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "crx-production-migration-gate",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  const parseBody = () => {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`GitHub API ${method} ${apiPath} returned a non-JSON body with ${response.status}`);
    }
  };
  if (allow404 && response.status === 404) return { status: 404, body: parseBody(), link: response.headers.get("link") || "" };
  if (!response.ok) throw new Error(`GitHub API ${method} ${apiPath} failed with ${response.status}`);
  return { status: response.status, body: parseBody(), link: response.headers.get("link") || "" };
}

async function retryReleaseStep(operation, description) {
  let lastError;
  for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < RELEASE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_DELAY_MS));
      }
    }
  }
  throw new Error(`${description} failed after ${RELEASE_ATTEMPTS} attempts: ${lastError?.message || lastError}`);
}

async function currentMain(repository, request) {
  const result = await request(`/repos/${repository}/git/ref/heads/main`);
  return assertCommit(result?.body?.object?.sha);
}

async function listRepositoryRulesets(repository, request) {
  const result = await request(`/repos/${repository}/rulesets?includes_parents=false&per_page=100&page=1`);
  if (!Array.isArray(result?.body)) throw new Error("repository ruleset list was not an array");
  if (/rel="next"/.test(String(result.link))) throw new Error("repository ruleset list exceeded the fail-closed page limit");
  return result.body;
}

export async function acquireMainFreeze({ repository, expectedCommit, name, request, onCreated = () => {} }) {
  const exactRepository = assertRepository(repository);
  const expected = assertCommit(expectedCommit);
  const definition = buildFreezeRuleset(name);
  if (await currentMain(exactRepository, request) !== expected) throw new Error("main moved before the production freeze");
  const existing = await listRepositoryRulesets(exactRepository, request);
  if (existing.some((ruleset) => String(ruleset?.name).startsWith(FREEZE_PREFIX))) {
    throw new Error("an existing production migration freeze requires manual inspection");
  }
  const created = await request(`/repos/${exactRepository}/rulesets`, { method: "POST", body: definition });
  const id = assertExactFreezeRuleset(created?.body, name);
  onCreated({ id, name });
  if (await currentMain(exactRepository, request) !== expected) {
    throw new Error("main moved while the production freeze was being acquired");
  }
  return { id, name };
}

export async function verifyMainFreeze({ repository, expectedCommit, name, request }) {
  const exactRepository = assertRepository(repository);
  const expected = assertCommit(expectedCommit);
  const matches = (await listRepositoryRulesets(exactRepository, request)).filter((ruleset) => ruleset?.name === name);
  if (matches.length !== 1) throw new Error("the exact production migration freeze is not active");
  if (!Number.isSafeInteger(matches[0]?.id)) throw new Error("production migration freeze id was invalid");
  const exact = await request(`/repos/${exactRepository}/rulesets/${matches[0].id}`);
  assertExactFreezeRuleset(exact?.body, name);
  if (await currentMain(exactRepository, request) !== expected) throw new Error("main moved despite the production freeze");
}

export async function releaseMainFreeze({ repository, name, request }) {
  const exactRepository = assertRepository(repository);
  const matches = (await listRepositoryRulesets(exactRepository, request)).filter((ruleset) => ruleset?.name === name);
  if (matches.length === 0) return { released: false };
  if (matches.length !== 1) throw new Error("multiple exact production migration freezes require manual inspection");
  if (!Number.isSafeInteger(matches[0]?.id)) throw new Error("production migration freeze id was invalid");
  const exact = await request(`/repos/${exactRepository}/rulesets/${matches[0].id}`);
  const id = assertExactFreezeRuleset(exact?.body, name);
  await retryReleaseStep(
    () => request(`/repos/${exactRepository}/rulesets/${id}`, { method: "DELETE", allow404: true }),
    "production migration freeze deletion",
  );
  await retryReleaseStep(async () => {
    const after = await request(`/repos/${exactRepository}/rulesets/${id}`, { allow404: true });
    if (after?.status !== 404) throw new Error("production migration freeze still exists after release");
    return after;
  }, "production migration freeze absence confirmation");
  return { released: true, id };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const command = process.argv[2];
  if (!new Set(["acquire", "verify", "release"]).has(command)) throw new Error("usage: production-main-freeze.mjs acquire|verify|release");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const name = freezeName(requiredEnvironment("GITHUB_RUN_ID"), requiredEnvironment("GITHUB_RUN_ATTEMPT"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- Production main freeze: \`${name}\`\n`, "utf8");
  }
  const token = requiredEnvironment("PRODUCTION_BRANCH_FREEZE_TOKEN");
  const request = (apiPath, options = {}) => apiRequest(apiPath, { ...options, token });
  if (command === "acquire") {
    const expectedCommit = requiredEnvironment("EXPECTED_COMMIT");
    const stateFile = requiredEnvironment("FREEZE_STATE_FILE");
    await acquireMainFreeze({
      repository,
      expectedCommit,
      name,
      request,
      onCreated: (state) => writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx" }),
    });
    console.log("Production main freeze acquired and current main reverified.");
    return;
  }
  if (command === "verify") {
    await verifyMainFreeze({ repository, expectedCommit: requiredEnvironment("EXPECTED_COMMIT"), name, request });
    console.log("Production main freeze remains exact and current main is unchanged.");
    return;
  }
  const stateFile = requiredEnvironment("FREEZE_STATE_FILE");
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (state?.name !== name || !Number.isSafeInteger(state?.id)) throw new Error("freeze state file did not match this workflow run");
  }
  const released = await releaseMainFreeze({ repository, name, request });
  if (released.released && existsSync(stateFile)) rmSync(stateFile);
  console.log(released.released ? "Production main freeze released." : "No exact production main freeze existed for this run.");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
