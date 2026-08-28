import assert from "node:assert/strict";

import { buildRepinnedProducer } from "./prepare-retained-live-scanner-harness-repin-20260828.mjs";

const built = await buildRepinnedProducer();
assert.equal((built.proposed.match(/const EXPECTED_INPUT_BLOB = /g) || []).length, 1);
assert.equal((built.proposed.match(/const EXPECTED_OUTPUT_BLOB = /g) || []).length, 1);
assert.match(built.proposed, new RegExp(`EXPECTED_INPUT_BLOB = "3875e085266f6f0395ea16ad2fa2032b56ae3373"`));
assert.doesNotMatch(built.proposed, /EXPECTED_OUTPUT_BLOB = "TO_BE_FILLED"/);
assert.equal(built.generatedBlob.length, 40);
assert.equal(built.producerBlob.length, 40);
process.stdout.write(JSON.stringify({ generatedBlob: built.generatedBlob, producerBlob: built.producerBlob }) + "\n");
