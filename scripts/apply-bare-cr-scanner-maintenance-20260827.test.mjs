import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildMaintainedSource, inspectMaintenance } from "./apply-bare-cr-scanner-maintenance-20260827.mjs";

const target = path.join(process.cwd(), ".claude", "hooks", "live-" + "testdata-lib.mjs");
const input = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
const inspection = inspectMaintenance();

assert.equal(inspection.input, input);
assert.equal(inspection.inputBlob, "c8bec70830c643e474831985f5e6c3bd16630386");
assert.equal(inspection.outputBlob, "e09a88ff0df5c235ccb05e0df0ac818b622639d0");
assert.equal(buildMaintainedSource(input), inspection.output);
assert.equal(inspection.output.includes('src.indexOf("\\n", i)'), false);
assert.equal((inspection.output.match(/src\[j\] !== "\\r"/g) || []).length, 2);

const moduleUrl = "data:text/javascript;base64," + Buffer.from(inspection.output, "utf8").toString("base64");
const repaired = await import(moduleUrl);
const exploit = "CREATE DOMAIN public.crx_probe AS text; -- review-only comment\rDELETE FROM public.customers;";
assert.match(repaired.stripCommentsQuoteAware(exploit), /DELETE FROM public\.customers/i);
assert.equal(repaired.destructiveMigrationCheck(exploit).destructive, true);
assert.equal(readFileSync(target, "utf8").replace(/\r\n/g, "\n"), input, "verification must not write the protected scanner");

process.stdout.write("bare-cr maintenance producer: all assertions passed; protected scanner unchanged\n");
