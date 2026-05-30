/**
 * Single source of truth for company identity shown on customer-facing and
 * internal PDFs (invoices, statements, quotes, delivery receipts, etc.).
 *
 * WHY THIS EXISTS: before the 2026-05-29 review, each PDF module hardcoded the
 * company location as a string literal, and they had drifted — invoices/
 * statements/year-end said "Martinsville, IL" while quotes/deliveries/order
 * summaries said "Robinson, IL". A customer could receive a quote from one town
 * and an invoice from another. Now the location lives here once.
 *
 * FUTURE: SettingsPage already stores company_name/phone/email/address; a later
 * change should thread those values in here so the address is editable from the
 * UI without a code change.
 */

export const COMPANY_NAME = 'Crop RX Solutions';
export const COMPANY_LEGAL_NAME = 'Crop RX Solutions, Inc.';
export const COMPANY_TAGLINE = 'Agricultural Input Solutions';
export const COMPANY_CITY = 'West York, IL';
export const COMPANY_PHONE = '618-843-0413';
export const COMPANY_WEBSITE = 'www.croprxsolutions.com';

// ── Composed strings used by the PDF footers/headers ──────────────────────
// Letterhead tagline WITH phone (invoice, statement, year-end summary headers).
export const COMPANY_TAGLINE_HEADER = `${COMPANY_TAGLINE}  •  ${COMPANY_CITY}  •  ${COMPANY_PHONE}`;
// Letterhead tagline WITHOUT phone (quote, report headers — preserve prior format).
export const COMPANY_TAGLINE_HEADER_NO_PHONE = `${COMPANY_TAGLINE}  •  ${COMPANY_CITY}`;
// Centered footer on receipts / ops docs.
export const COMPANY_FOOTER_THANKS = `${COMPANY_NAME}  •  ${COMPANY_CITY}  •  Thank you for your business!`;
// Internal-only pick list footer.
export const COMPANY_FOOTER_INTERNAL = `${COMPANY_NAME}  •  ${COMPANY_CITY}  •  Internal Use Only`;

/**
 * Remit-to mailing block for statements — the address customers physically MAIL
 * CHECKS to.
 *
 * Confirmed by Mason on 2026-05-30: this matches app_settings.company_address in
 * the live DB ("9100 E 2000th ave Annapolis, IL 62413"). It replaced the stale
 * pre-relocation "PO Box 123, Martinsville, IL 62442" literal flagged by the
 * 2026-05-30 whole-codebase audit (finding M2).
 *
 * NOTE: the letterhead COMPANY_CITY above ("West York, IL") legitimately
 * differs from this remit address (Annapolis, IL). Confirmed by Mason on
 * 2026-05-30 that the office/letterhead town and the check-mailing address
 * are two distinct, correct locations.
 */
export const COMPANY_REMIT_ADDRESS = `${COMPANY_LEGAL_NAME}\n9100 E 2000th Ave\nAnnapolis, IL 62413`;
