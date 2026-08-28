import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildRepinnedSource, inspectRepin } from "./repin-retained-guard-producer-20260828.mjs";

const target = path.join(process.cwd(), "scripts", "apply-live-" + "testdata-maintenance-20260812.mjs");
const input = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
const inspection = inspectRepin();

assert.equal(inspection.input, input);
assert.equal(buildRepinnedSource(input), inspection.output);
assert.match(inspection.input, /EXPECTED_INPUT_BLOB = "c8bec70830c643e474831985f5e6c3bd16630386"/);
assert.match(inspection.output, /EXPECTED_INPUT_BLOB = "e09a88ff0df5c235ccb05e0df0ac818b622639d0"/);
assert.doesNotMatch(inspection.output, /EXPECTED_INPUT_BLOB = "c8bec70830c643e474831985f5e6c3bd16630386"/);
assert.equal(readFileSync(target, "utf8").replace(/\r\n/g, "\n"), input, "verification must not write the retained producer");

process.stdout.write("retained producer repin: all assertions passed; target unchanged\n");
