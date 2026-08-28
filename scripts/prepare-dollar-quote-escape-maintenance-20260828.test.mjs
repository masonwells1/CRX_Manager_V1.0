import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildMaintainedSource, gitBlob } from "./prepare-dollar-quote-escape-maintenance-20260828.mjs";

const built = buildMaintainedSource();
assert.equal(gitBlob(built.output), built.blob, "reported blob must bind the generated output");
assert.throws(() => buildMaintainedSource(`${built.output}\n// stale`), /stale dollar-quote scanner input/);

const tempDir = mkdtempSync(path.join(os.tmpdir(), "crx-dollar-quote-escape-test-"));
try {
  const candidate = path.join(tempDir, "candidate.mjs");
  writeFileSync(candidate, built.output, "utf8");
  const { destructiveMigrationCheck } = await import(pathToFileURL(candidate).href + `?test=${Date.now()}`);
  const suffixes = ["", " ", "\nSELECT 1;", "\r\nSELECT 1;", "\n/* trailing */"];
  const tags = ["$x$", "$body$", "$a1$", "$$"];
  const prefixes = ["E", "e"];
  let mutations = 0;
  for (const prefix of prefixes) {
    for (const tag of tags) {
      for (const suffix of suffixes) {
        const payload = `COMMENT ON TABLE public.customers IS ${prefix}'foo\\' AS ${tag} junk'; DELETE FROM public.customers; -- ${tag}${suffix}`;
        assert.equal(destructiveMigrationCheck(payload).destructive, true, `must block payload ${JSON.stringify(payload)}`);
        mutations++;
      }
    }
  }
  assert.equal(mutations, 40);
  assert.equal(destructiveMigrationCheck("CREATE FUNCTION f() RETURNS void AS $x$ BEGIN DELETE FROM customers; END $x$ LANGUAGE plpgsql;").destructive, false);
  assert.equal(destructiveMigrationCheck("DO $x$ BEGIN DELETE FROM customers; END $x$;").destructive, true);
  assert.equal(destructiveMigrationCheck("COMMENT ON TABLE public.customers IS E'plain\\' text'; SELECT 1;").destructive, false);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

process.stdout.write(`dollar-quote escape producer assertions passed; proposed blob ${built.blob}\n`);
