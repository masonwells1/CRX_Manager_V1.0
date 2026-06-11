// Offline fidelity gate for scripts/.staging-migrations/idempotency_operation_scope_sweep.sql
// (originally written for the superseded phantom draft 20260611080937; the
// baselines below were re-verified IDENTICAL against live on 2026-06-11 by the
// second DRAFT session — live bodies stable all day).
// For each CREATE OR REPLACE FUNCTION block: extract the $function$ body,
// strip the single added ` AND operation = '<fn>'` clause, md5 the result,
// and compare against the live prosrc md5 manifest.
// PASS = byte-identical to live for all 20 swept functions, the added clause
// appears exactly once per function, and the 2 CARVED-OUT functions
// (create_planned_holds, save_quote — rebuilt with scoped lookups by the
// pending 20260611132115_planned_holds_drawn_sync.sql) are ABSENT.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const LIVE_MD5 = {
  batch_approve_blend_tickets: "ecef62c9154d1246e0df5715d1d7ae82",
  batch_post_invoices: "8414b078aa51d5774960c22387d9c3cc",
  batch_reject_blend_tickets: "5619eafd51a48b0d44e17fb2b77cc9ff",
  complete_job: "8620e40a6f5f8ae2634815f818005c4e",
  create_invoice_from_blend_ticket: "036091796baa73eb0754e5c2dd4de95b",
  create_job_from_quote_section: "79f38c109f6549c5808ba7fec5f373cb",
  create_planned_holds: "912db30f89fce14b0d114f6c1ea20c01",
  create_quote_from_template: "d8d57dca6f3f5f091e7a2a754bef2a5f",
  create_quote_version: "06ac27b08a9714130d02a1a326bcd188",
  create_split_invoices_from_order: "d515f71b72dfbcf290ec258776b46502",
  delete_prepay_credit: "77b21cf7ef8fbbbb711eedd057178706",
  edit_delivery: "06cce0a277cf84cd8605712d6be03d0c",
  edit_prepay_credit: "5f3a14d6abd35301db438d3dd72075a4",
  post_invoice_group: "767b0fbb8954f1009112c0b6880b34f3",
  reverse_receiving_record: "08d1026caed844d7ba41bf43e825d378",
  rollover_quote_to_season: "dda42120a85a4fb4c3d0c5751fd97c65",
  save_blend_ticket_fields: "4b642537dfdf73b3c25d4ce9d024c5bb",
  save_field_app_invoice: "76b1e62b6bec2ee5aecb9ca482d00abb",
  save_quote: "980a624c4e29ce01de0c977a007c0a15",
  save_quote_template: "afc3a240238f9049c3d94239b81522cc",
  start_job: "72a2fb6ff788378b216e9dd84f4a423c",
  void_payment: "8e18a5090bc1093b1836651beba3a780",
};

// Carved out of the sweep (race-safety vs the pending planned-holds-drawn-sync
// rebuild). Their live baselines, for the record:
//   create_planned_holds 912db30f89fce14b0d114f6c1ea20c01
//   save_quote           980a624c4e29ce01de0c977a007c0a15
const CARVED_OUT = new Set(["create_planned_holds", "save_quote"]);
for (const fn of CARVED_OUT) delete LIVE_MD5[fn];

const file = process.argv[2];
const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const blockRe = /CREATE OR REPLACE FUNCTION public\.([a-z_0-9]+)\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$/g;
const seen = new Map();
let m;
while ((m = blockRe.exec(raw)) !== null) {
  seen.set(m[1], m[2]);
}

let fail = 0;
for (const [fn, liveMd5] of Object.entries(LIVE_MD5)) {
  const body = seen.get(fn);
  if (body === undefined) {
    console.log(`FAIL ${fn}: no CREATE OR REPLACE block found in file`);
    fail++;
    continue;
  }
  const clause = ` AND operation = '${fn}'`;
  const occurrences = body.split(clause).length - 1;
  if (occurrences !== 1) {
    console.log(`FAIL ${fn}: added clause appears ${occurrences} times (expected 1)`);
    fail++;
    continue;
  }
  const stripped = body.replace(clause, "");
  const md5 = createHash("md5").update(stripped, "utf8").digest("hex");
  if (md5 !== liveMd5) {
    console.log(`FAIL ${fn}: body-minus-clause md5 ${md5} != live ${liveMd5} (len ${stripped.length})`);
    fail++;
  } else {
    console.log(`PASS ${fn}`);
  }
}
const extra = [...seen.keys()].filter((k) => !(k in LIVE_MD5));
if (extra.length) {
  console.log(`FAIL: unexpected function blocks in file: ${extra.join(", ")}`);
  fail++;
}
console.log(fail === 0 ? `\nALL ${Object.keys(LIVE_MD5).length} FUNCTIONS BYTE-IDENTICAL TO LIVE (minus the one added clause)` : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
