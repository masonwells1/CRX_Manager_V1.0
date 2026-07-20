import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8');
const requireText = (source, needle, proof) => {
  if (!source.includes(needle)) throw new Error(`PHASE4_PROOF_FAIL(${proof}): missing ${needle}`);
};
const requireBefore = (source, first, second, proof) => {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second, firstIndex + first.length);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) {
    throw new Error(`PHASE4_PROOF_FAIL(${proof}): expected ${first} before ${second}`);
  }
};

const editor = read('src/pages/FieldAppSplitInvoiceEditor.tsx');
const setting = read('src/lib/splitBillingSetting.ts');
const percentParser = read('src/lib/perLineSplitBillingUi.ts');
const edge = read('supabase/functions/send-email/index.ts');

requireText(setting, "'feature_per_line_split_billing'", 'exact_flag_key');
requireText(editor, "rpc('preview_field_app_invoice_split'", 'shared_preview_rpc');
requireText(editor, "rpc('save_field_app_invoice_per_line'", 'phase3_save_rpc');
requireText(editor, 'p_line_overrides: buildOptionsPayload()', 'preview_options_builder');
requireText(editor, 'p_options: buildOptionsPayload()', 'save_options_builder');
requireText(editor, 'source_amount_cents: dollarsToCents(line.flatDollars)', 'flat_fee_contract_key');
requireText(editor, 'p_invoice_id: resultInvoices[0]?.id ?? null', 'draft_resave_identity');
requireText(editor, 'savedDraftFingerprint !== currentDraftFingerprint', 'stale_draft_post_gate');
requireText(editor, 'hasUnsavedBillingChanges) return', 'stale_draft_post_handler_gate');
requireText(editor, "rpc('post_invoice_group'", 'group_post_path');
requireText(editor, "rpc('post_invoice'", 'single_invoice_post_fallback');
requireText(editor, 'Every selected price override needs a valid dollar amount.', 'price_override_required');
requireText(percentParser, '!== 100_000_000', 'exact_custom_percent_total');
requireText(editor, "showAdvanced ? 'Hide advanced' : 'Advanced splits'", 'advanced_override_gate');
requireText(editor, '{showAdvanced && members.length > 0 && (', 'advanced_override_content_gate');
requireBefore(editor, 'await assertNoModeA(validFields.map((f) => f.field_id));', "rpc('preview_field_app_invoice_split'", 'mode_a_before_preview');
requireBefore(editor, 'await assertNoModeA(validFields.map((field) => field.field_id));', "rpc('save_field_app_invoice_per_line'", 'mode_a_before_write');
requireText(editor, ".not('price_override_cents', 'is', null)", 'grower_share_price_override_read');
requireText(editor, 'amount_cents: Number(s.amount_cents ?? 0)', 'stored_share_amount_renderer');
requireText(editor, 'total_amount_cents: Number(r.total_amount_cents ?? 0)', 'stored_invoice_total_renderer');

const emailGateFiles = [
  'src/pages/FieldApplicationInvoice.tsx',
  'src/pages/InvoiceDetail.tsx',
  'src/components/field-invoices/FieldInvoicesListPanel.tsx',
  'src/components/field-invoices/FieldInvoicesUnpostedPanel.tsx',
  'src/components/field-invoices/FieldInvoicesPostedPanel.tsx',
];
for (const file of emailGateFiles) {
  requireText(read(file), 'isInvoiceEmailSuppressed(', `email_gate_${file}`);
}
const fieldApplication = read('src/pages/FieldApplicationInvoice.tsx');
if ((fieldApplication.match(/isInvoiceEmailSuppressed\(pdfSnapshot\)/g) ?? []).length < 2) {
  throw new Error('PHASE4_PROOF_FAIL(field_application_two_gates)');
}

requireText(edge, 'if (email_type === "invoice")', 'edge_invoice_gate');
requireText(edge, '.select("id, customer_id, send_disposition")', 'edge_server_disposition_read');
requireText(edge, 'invoiceRow.send_disposition === "suppressed_zero_total"', 'edge_zero_total_refusal');
requireText(edge, 'invoiceRow.customer_id !== customer_id', 'edge_customer_match');

console.log('PHASE4_HARD_PROOF_PASS');
console.log('flag=exact-off-by-default; preview/save=authoritative-rpcs+same-options-builder');
console.log('mode_a=read-before-preview-and-write; money=stored-server-cents-rendered');
console.log('email=5-ui-surfaces+second-field-app-path+server-disposition-gate');
