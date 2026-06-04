/**
 * pdfTheme.ts — shared typing for all CRX PDF generators.
 *
 * jsPDF + jspdf-autotable are dynamically imported at runtime inside each
 * generator (to keep them out of the main bundle). This module only provides
 * the augmented instance type the autoTable plugin produces (`lastAutoTable`).
 * Type-only — no runtime cost.
 */
import type jsPDF from 'jspdf';

/** jsPDF instance with `lastAutoTable` from the jspdf-autotable plugin. */
export type JsPDFWithAutoTable = InstanceType<typeof jsPDF> & {
  lastAutoTable: { finalY: number };
};

// ── CRX brand palette (RGB tuples, spread into jsPDF set*Color calls) ────────
export const CRX_GREEN: [number, number, number] = [40, 162, 106]; // #28A26A
export const CHARCOAL: [number, number, number] = [46, 46, 46]; // #2E2E2E
export const GRAY: [number, number, number] = [78, 78, 78]; // #4E4E4E
export const LIGHT_BG: [number, number, number] = [245, 250, 247]; // light green tint
export const RED: [number, number, number] = [220, 38, 38];
export const AMBER: [number, number, number] = [217, 119, 6];
export const TABLE_HEADER_BG: [number, number, number] = [240, 240, 240];
export const ALT_ROW_BG: [number, number, number] = [252, 252, 252];
export const BLUE: [number, number, number] = [37, 99, 235];
