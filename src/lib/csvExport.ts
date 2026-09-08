import { localToday, parseLocalDate } from './dateUtils';

const FORMULA_LEADING_CHAR = /^[=+\-@\t\r]/;

function quoteCsv(value: string): string {
  const safeValue = FORMULA_LEADING_CHAR.test(value) ? `'${value}` : value;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function formatCSVCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return String(value);
  return quoteCsv(String(value));
}

/**
 * Export data to a CSV file and trigger a download.
 * Works entirely in the browser - no server needed.
 *
 * @param data - Array of objects to export
 * @param columns - Which columns to include and what to call them
 * @param filename - Name for the downloaded file (without .csv extension)
 */
export function exportToCSV<T extends Record<string, unknown>>(
  data: T[],
  columns: { key: string; header: string; format?: (value: unknown, row: T) => string }[],
  filename: string
) {
  if (data.length === 0) return;

  // Build header row
  const headers = columns.map((col) => `"${col.header}"`).join(',');

  // Build data rows
  const rows = data.map((row) => {
    return columns
      .map((col) => {
        const value = row[col.key];
        if (col.format) {
          return quoteCsv(col.format(value, row));
        }
        return formatCSVCell(value);
      })
      .join(',');
  });

  const csvContent = [headers, ...rows].join('\n');

  // Create a download link and click it
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${filename}_${localToday()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

/**
 * Format a number as USD currency string for CSV export.
 */
export function fmtCSV(n: unknown): string {
  const num = Number(n);
  if (isNaN(num)) return '$0.00';
  return `$${num.toFixed(2)}`;
}

/**
 * Format a date string for CSV export.
 */
export function fmtDateCSV(d: unknown): string {
  if (!d) return '';
  return new Date(String(d)).toLocaleDateString();
}

/** Format PostgreSQL date-only values without interpreting them as UTC. */
export function fmtDateOnlyCSV(d: unknown): string {
  if (!d) return '';
  const text = String(d);
  return /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? parseLocalDate(text).toLocaleDateString()
    : fmtDateCSV(d);
}
