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
