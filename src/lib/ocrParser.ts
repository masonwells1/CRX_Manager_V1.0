import type { Product, Customer } from '../types';

export interface ParsedTicketData {
  ticketDate: string | null;
  customerName: string | null;
  driverName: string | null;
  tankNumber: string | null;
  applicatorName: string | null;
  signatureDetected: boolean;
  // Extended fields for CropRx blend ticket
  jobNumber: string | null;
  ticketTime: string | null;
  vehicleInfo: string | null;
  mixerName: string | null;
  fieldNames: string | null;
  totalAcres: number | null;
  applicationRate: string | null;
  totalVolume: number | null;
  invoiceNumber: string | null;
  notes: string | null;
  products: Array<{
    productName: string;
    quantity: number;
    unit: string | null;
    ratePerAcre: string | null;
    totalProduct: string | null;
    lotNumber: string | null;
    confidenceScore: number;
  }>;
  overallConfidence: number;
}

/**
 * Parse OCR text from a CropRx Blend Ticket.
 *
 * The ticket format has labelled fields like:
 *   "Customer"
 *   "Name: Wells Farm LLC"
 *   "Date: 2/6/26"
 *   "Applicator: Mason / Chance / Clayton / Other"
 *   "Vehicle: Hagie / Rogator / Customer/Other:"
 *   "Mixer Name: Mason Chance / Clayton / Other:"
 *   "Fields: GI, A17 B Bam"
 *   "Total Acres: 200"
 *   "Application Rate: 15"
 *   "Total Volume: 3000"
 *   Then a product table with columns: Product | Rate/Acre | Total Product
 */
export function parseOCRText(rawText: string): ParsedTicketData {
  const lines = rawText.split('\n').map(line => line.trim()).filter(line => line.length > 0);

  const parsed: ParsedTicketData = {
    ticketDate: extractDate(rawText, lines),
    customerName: extractCustomerName(lines),
    driverName: extractFieldValue(lines, ['driver', 'delivered by']),
    tankNumber: extractFieldValue(lines, ['tank', 'tank #', 'tank no']),
    applicatorName: extractCircledName(lines, ['applicator', 'applied by', 'operator']),
    signatureDetected: detectSignature(rawText),
    jobNumber: extractFieldValue(lines, ['job #', 'job#', 'job number']),
    ticketTime: extractFieldValue(lines, ['time']),
    vehicleInfo: extractCircledName(lines, ['vehicle']),
    mixerName: extractCircledName(lines, ['mixer name', 'mixer']),
    fieldNames: extractFieldValue(lines, ['fields', 'field'], true),
    totalAcres: extractNumericValue(lines, ['total acres', 'acres']),
    applicationRate: extractFieldValue(lines, ['application rate', 'app rate']),
    totalVolume: extractNumericValue(lines, ['total volume', 'volume']),
    invoiceNumber: extractFieldValue(lines, ['invoice #', 'invoice#', 'invoice number', 'invoice']),
    notes: extractFieldValue(lines, ['notes', 'note'], true),
    products: extractProducts(lines),
    overallConfidence: 0,
  };

  parsed.overallConfidence = calculateOverallConfidence(parsed);

  return parsed;
}

/**
 * Extract date, handling short year formats like "2/6/26" → "2026-02-06"
 */
function extractDate(text: string, lines: string[]): string | null {
  // First try to find a date near a "Date:" label
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('date')) {
      // Check same line after colon
      const colonIdx = lines[i].indexOf(':');
      if (colonIdx !== -1) {
        const afterColon = lines[i].substring(colonIdx + 1).trim();
        const parsed = parseDateString(afterColon);
        if (parsed) return parsed;
      }
      // Check next line
      if (i + 1 < lines.length) {
        const parsed = parseDateString(lines[i + 1].trim());
        if (parsed) return parsed;
      }
    }
  }

  // Fallback: find any date pattern in the text
  const dateMatch = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (dateMatch) {
    return parseDateString(dateMatch[0]);
  }

  return null;
}

/**
 * Parse a date string, handling 2-digit years (e.g. "2/6/26" → "2026-02-06")
 */
function parseDateString(dateStr: string): string | null {
  const match = dateStr.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!match) return null;

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  let year = parseInt(match[3], 10);

  // Handle 2-digit year
  if (year < 100) {
    year += 2000;
  }

  // Validate ranges
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2099) {
    return null;
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Extract customer name.
 * CropRx format often has:
 *   "Customer"
 *   "Name: Wells Farm LLC"
 * OR
 *   "Customer Name: Wells Farm LLC"
 */
function extractCustomerName(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();

    // Pattern: "Name: Wells Farm LLC" (usually right after "Customer" line)
    if (lower.startsWith('name:') || lower.startsWith('name :')) {
      const value = lines[i].substring(lines[i].indexOf(':') + 1).trim();
      if (value.length > 0) return value;
    }

    // Pattern: "Customer Name: Wells Farm LLC"
    if ((lower.includes('customer') && lower.includes('name')) && lines[i].includes(':')) {
      const value = lines[i].substring(lines[i].lastIndexOf(':') + 1).trim();
      if (value.length > 0) return value;
    }

    // Pattern: "Customer:" on same line
    if (lower.includes('customer') && lower.includes(':')) {
      const value = lines[i].substring(lines[i].indexOf(':') + 1).trim();
      if (value.length > 0 && !value.toLowerCase().startsWith('other')) return value;
    }

    // Pattern: "Customer" on one line, value on next
    if (lower === 'customer' || lower === 'customer name') {
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        // If next line is "Name: value"
        if (nextLine.toLowerCase().startsWith('name:') || nextLine.toLowerCase().startsWith('name :')) {
          const value = nextLine.substring(nextLine.indexOf(':') + 1).trim();
          if (value.length > 0) return value;
        }
        // Otherwise just take the next line as customer name
        if (nextLine.length > 0 && !nextLine.match(/^\d/) && !nextLine.toLowerCase().startsWith('date')) {
          return nextLine;
        }
      }
    }

    // Pattern: "Farm:" or "Grower:" or "Account:"
    const otherIndicators = ['farm', 'grower', 'account'];
    for (const indicator of otherIndicators) {
      if (lower.includes(indicator) && lines[i].includes(':')) {
        const value = lines[i].substring(lines[i].indexOf(':') + 1).trim();
        if (value.length > 0) return value;
      }
    }
  }

  return null;
}

/**
 * Generic field value extraction for simple "Label: Value" patterns.
 * Handles same-line, next-line, and multi-line values.
 * For "Fields:" we concatenate continuation lines (lines that don't look like labels).
 */
function extractFieldValue(lines: string[], keywords: string[], multiLine = false): string | null {
  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();
    for (const keyword of keywords) {
      if (lowerLine.includes(keyword)) {
        let value = '';

        // Try same line with colon
        const colonIdx = lines[i].indexOf(':');
        if (colonIdx !== -1) {
          value = lines[i].substring(colonIdx + 1).trim();
        }

        // If no value on same line, try next line
        if (value.length === 0 && i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (nextLine.length > 0 && !looksLikeLabel(nextLine)) {
            value = nextLine;
            // If multiLine, also check further lines
            if (multiLine) {
              for (let j = i + 2; j < lines.length; j++) {
                const continuation = lines[j].trim();
                if (continuation.length === 0 || looksLikeLabel(continuation)) break;
                value += ' ' + continuation;
              }
            }
            if (value.length > 0) return value;
          }
        }

        // If we have a value from same line AND multiLine, check continuation
        if (value.length > 0 && multiLine) {
          for (let j = i + 1; j < lines.length; j++) {
            const continuation = lines[j].trim();
            if (continuation.length === 0 || looksLikeLabel(continuation)) break;
            value += ' ' + continuation;
          }
        }

        if (value.length > 0) return value;
      }
    }
  }
  return null;
}

/**
 * Check if a line looks like a label or a standalone number
 * (i.e., NOT a continuation of a text field like "Fields:").
 */
function looksLikeLabel(line: string): boolean {
  const lower = line.toLowerCase();
  // Contains colon after a word (label pattern)
  if (/^[a-z\s]+:/i.test(line)) return true;
  // Standalone number — not a text continuation
  if (/^\d[\d,]*\.?\d*$/.test(line.trim())) return true;
  // Known section headers
  const headers = ['total acres', 'total volume', 'application rate', 'product',
    'rate/', 'notes', 'signature', 'invoice', 'mixer', 'vehicle', 'applicator',
    'customer', 'date', 'time', 'job', 'driver', 'tank'];
  return headers.some(h => lower.startsWith(h) || lower === h);
}

/**
 * For fields like "Applicator: Mason / Chance / Clayton / Other"
 * where the ticket has a list of names and one is circled/selected.
 * We take the first name (before the first /) as the selected value.
 */
function extractCircledName(lines: string[], keywords: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();
    for (const keyword of keywords) {
      if (lowerLine.includes(keyword)) {
        const colonIdx = lines[i].indexOf(':');
        if (colonIdx !== -1) {
          let value = lines[i].substring(colonIdx + 1).trim();

          // If the value contains "/" separators (checkbox-style list), take the first name
          if (value.includes('/')) {
            const firstName = value.split('/')[0].trim();
            // Filter out generic options like "Other", "Customer"
            if (firstName.length > 0 &&
                !firstName.toLowerCase().includes('other') &&
                firstName.length <= 50) {
              return firstName;
            }
          }

          // Clean up trailing options like "/ Other:" or "/ Customer/Other:"
          value = value.replace(/\s*\/\s*(chance|clayton|other|customer)[^]*/i, '').trim();
          if (value.length > 0) return value;
        }
      }
    }
  }
  return null;
}

/**
 * Extract a numeric value from a field like "Total Acres: 200".
 * Also handles OCR layouts where the value appears on the line BEFORE the label
 * (common with Google Vision reading visual layouts out of order).
 * Allows zero values (e.g., total volume of 0).
 */
function extractNumericValue(lines: string[], keywords: string[]): number | null {
  // First try normal extraction (value after label)
  const raw = extractFieldValue(lines, keywords);
  if (raw) {
    const numMatch = raw.match(/[\d,]+\.?\d*/);
    if (numMatch) {
      const num = parseFloat(numMatch[0].replace(/,/g, ''));
      if (!isNaN(num) && num >= 0) return num;
    }
  }

  // Fallback: look at the line BEFORE the label (OCR sometimes puts value above label)
  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();
    for (const keyword of keywords) {
      if (lowerLine.includes(keyword)) {
        // Check previous line for a standalone number
        if (i > 0) {
          const prevLine = lines[i - 1].trim();
          const prevNumMatch = prevLine.match(/^[\d,]+\.?\d*$/);
          if (prevNumMatch) {
            const num = parseFloat(prevNumMatch[0].replace(/,/g, ''));
            if (!isNaN(num) && num >= 0) return num;
          }
        }
      }
    }
  }

  return null;
}

function detectSignature(text: string): boolean {
  const signatureKeywords = ['signature', 'signed', 'sign here', 'x_____'];
  const lowerText = text.toLowerCase();
  return signatureKeywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Extract products from the product table section.
 * CropRx format may have products on single lines or spread across multiple lines:
 *
 * Single-line formats:
 *   "AMS 243 Gools" or "Roundup | 2802 | 43.757"
 *
 * Multi-line formats (OCR reads columns separately):
 *   "AMS"
 *   "243"
 *   "Gools"
 *   "Roundup"
 *   "2802"
 *   "43.757"
 */
function extractProducts(lines: string[]): ParsedTicketData['products'] {
  const products: ParsedTicketData['products'] = [];

  // Find the product section — look for header row
  let productSectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if ((lower.includes('product') && (lower.includes('rate') || lower.includes('total') || lower.includes('acre'))) ||
        lower === 'product') {
      productSectionStart = i;
      break;
    }
  }

  // Also look for "Rate/" or "Total Product" headers
  if (productSectionStart === -1) {
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (lower.includes('rate/') && lower.includes('total')) {
        productSectionStart = i;
        break;
      }
    }
  }

  const startIndex = productSectionStart >= 0 ? productSectionStart + 1 : -1;
  if (startIndex === -1) return products;

  // Skip sub-header lines like "Acre", "Rate/", "Total Product"
  let actualStart = startIndex;
  for (let i = startIndex; i < Math.min(startIndex + 3, lines.length); i++) {
    const lower = lines[i].toLowerCase().trim();
    if (lower === 'acre' || lower === 'rate/' || lower === 'total product' || lower === 'total') {
      actualStart = i + 1;
    }
  }

  // Collect remaining lines for product parsing
  const productLines: string[] = [];
  for (let i = actualStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    const lower = line.toLowerCase();
    // Stop at end-of-products markers (only if we've already collected something)
    if (lower.includes('signature') || lower.includes('signed') ||
        lower.includes('notes:')) {
      break;
    }

    productLines.push(line);
  }

  // Strategy 1: Try parsing each line as a complete product (single-line format)
  const singleLineProducts: ParsedTicketData['products'] = [];
  for (const line of productLines) {
    const product = parseProductLine(line);
    if (product) singleLineProducts.push(product);
  }

  // Strategy 2: Try grouping lines as multi-line products
  // Pattern: product name (text) → number(s) on following lines
  const multiLineProducts = parseMultiLineProducts(productLines);

  // Use whichever strategy found more products
  if (singleLineProducts.length >= multiLineProducts.length) {
    return singleLineProducts;
  }
  return multiLineProducts;
}

/**
 * Parse products when OCR splits them across multiple lines.
 * Looks for pattern: text line (product name) → numeric line(s) (rate/total)
 */
function parseMultiLineProducts(lines: string[]): ParsedTicketData['products'] {
  const products: ParsedTicketData['products'] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    const lower = line.toLowerCase();

    // Skip known non-product lines
    if (lower === 'product' || lower.includes('rate/acre') || lower === 'acre' ||
        lower === 'total product' || lower === 'total') {
      i++;
      continue;
    }

    // Is this line a product name? (mostly alphabetic, not purely numeric)
    if (!isNumericLine(line) && line.length >= 2) {
      const productName = line;
      const numericValues: string[] = [];

      // Collect following numeric lines
      let j = i + 1;
      while (j < lines.length && numericValues.length < 3) {
        const nextLine = lines[j].trim();
        if (isNumericLine(nextLine)) {
          numericValues.push(nextLine);
          j++;
        } else {
          break;
        }
      }

      if (numericValues.length > 0) {
        const ratePerAcre = numericValues[0] || null;
        const totalProduct = numericValues.length > 1 ? numericValues[1] : null;

        const qtyStr = totalProduct || ratePerAcre || '0';
        const qtyMatch = qtyStr.match(/([\d,]+\.?\d*)/);
        const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(/,/g, '')) : 0;

        const unitMatch = (totalProduct || ratePerAcre || '').match(
          /(gal|gallon|gallons|lb|lbs|oz|qt|pt|pint|quart|l|ml|g)/i
        );

        products.push({
          productName,
          quantity,
          unit: unitMatch ? unitMatch[1] : null,
          ratePerAcre,
          totalProduct,
          lotNumber: null,
          confidenceScore: calculateProductConfidence(productName, quantity, unitMatch?.[1] || null),
        });

        i = j; // Skip past the numeric lines
        continue;
      }
    }

    i++;
  }

  return products;
}

/**
 * Check if a line is primarily numeric (a number with optional unit suffix).
 * Also matches common OCR misreads of units like "Gools" for "Gals".
 */
function isNumericLine(line: string): boolean {
  const trimmed = line.trim();
  // Pure number: "243", "43.757", "2,802", "1PT", "25g", "000"
  if (/^[\d,]+\.?\d*\s*(pt|gal|gals|gallons?|lb|lbs|oz|qt|ml|l|g|gools)?$/i.test(trimmed)) return true;
  // Common OCR misreads that are actually numbers+units: "Gools" is "Gals"
  if (/^gools$/i.test(trimmed)) return true;
  return false;
}

/**
 * Parse a single product line. Handles formats like:
 *   "AMS 243 Gools"
 *   "Roundup 2802 43.757"
 *   "eezy Moly-B 1PT 25g"
 *   "AMS | 2.43 | 486 gal"
 */
function parseProductLine(line: string): ParsedTicketData['products'][0] | null {
  // Skip header-like lines
  const lower = line.toLowerCase();
  if (lower === 'product' || lower.includes('rate/acre') || lower === 'acre' ||
      lower === 'total product' || lower === 'total') {
    return null;
  }

  // Try pipe-separated format first: "AMS | 2.43 | 486 gal"
  if (line.includes('|')) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length >= 2 && parts[0].length > 0) {
      const productName = parts[0];
      const ratePerAcre = parts[1] || null;
      const totalProduct = parts.length >= 3 ? parts[2] : null;

      const qtyMatch = (totalProduct || ratePerAcre || '').match(/([\d,]+\.?\d*)/);
      const quantity = qtyMatch ? parseFloat(qtyMatch[1].replace(/,/g, '')) : 0;
      const unitMatch = (totalProduct || ratePerAcre || '').match(/(gal|gallon|gallons|lb|lbs|oz|qt|pt|pint|quart|l|ml)/i);

      return {
        productName,
        quantity,
        unit: unitMatch ? unitMatch[1] : null,
        ratePerAcre,
        totalProduct,
        lotNumber: null,
        confidenceScore: calculateProductConfidence(productName, quantity, unitMatch?.[1] || null),
      };
    }
  }

  // Space-separated format: "AMS 243 Gools" or "Roundup 2802 43.757"
  // Split by whitespace but keep multi-word product names together
  const tokens = line.split(/\s+/);
  if (tokens.length < 2) return null;

  // Find the first token that looks like a number
  let numIdx = -1;
  for (let t = 0; t < tokens.length; t++) {
    if (tokens[t].match(/^\d+\.?\d*$/)) {
      numIdx = t;
      break;
    }
    // Also match patterns like "1PT", "25g"
    if (tokens[t].match(/^\d+\.?\d*(pt|gal|lb|oz|qt|ml|l|g)$/i)) {
      numIdx = t;
      break;
    }
  }

  if (numIdx <= 0) return null; // Need at least one name token before the number

  const productName = tokens.slice(0, numIdx).join(' ');
  if (productName.length < 2) return null;

  // Extract quantity and unit from the number token
  const numToken = tokens[numIdx];
  const qtyUnitMatch = numToken.match(/^([\d,]+\.?\d*)(pt|gal|lb|oz|qt|ml|l|g)?$/i);
  const quantity = qtyUnitMatch ? parseFloat(qtyUnitMatch[1].replace(/,/g, '')) : 0;
  const unitFromQty = qtyUnitMatch?.[2] || null;

  // Remaining tokens are rate/acre and total product info
  const ratePerAcre = tokens[numIdx] || null;
  const totalProduct = tokens.length > numIdx + 1 ? tokens.slice(numIdx + 1).join(' ') : null;

  // Try to find a unit in total product
  const unitMatch = (totalProduct || '').match(/(gal|gallon|gallons|lb|lbs|oz|qt|pt|pint|quart|l|ml|g)/i);
  const unit = unitFromQty || (unitMatch ? unitMatch[1] : null);

  return {
    productName,
    quantity,
    unit,
    ratePerAcre,
    totalProduct,
    lotNumber: null,
    confidenceScore: calculateProductConfidence(productName, quantity, unit),
  };
}

function calculateProductConfidence(name: string, quantity: number, unit: string | null): number {
  let confidence = 50;

  if (name.length > 3) confidence += 15;
  if (quantity > 0) confidence += 20;
  if (unit) confidence += 15;

  return Math.min(confidence, 100);
}

function calculateOverallConfidence(parsed: ParsedTicketData): number {
  let totalScore = 0;
  let factors = 0;

  if (parsed.ticketDate) {
    totalScore += 100;
    factors++;
  }

  if (parsed.customerName && parsed.customerName.length > 1) {
    totalScore += 100;
    factors++;
  }

  if (parsed.applicatorName) {
    totalScore += 90;
    factors++;
  }

  if (parsed.vehicleInfo) {
    totalScore += 80;
    factors++;
  }

  if (parsed.mixerName) {
    totalScore += 80;
    factors++;
  }

  if (parsed.fieldNames) {
    totalScore += 90;
    factors++;
  }

  if (parsed.totalAcres) {
    totalScore += 90;
    factors++;
  }

  if (parsed.products.length > 0) {
    const avgProductConfidence = parsed.products.reduce((sum, p) => sum + p.confidenceScore, 0) / parsed.products.length;
    totalScore += avgProductConfidence;
    factors++;
  }

  if (parsed.driverName) {
    totalScore += 80;
    factors++;
  }

  return factors > 0 ? Math.round(totalScore / factors) : 0;
}

export function fuzzyMatchProduct(extractedName: string, products: Product[]): Product | null {
  const normalizedSearch = extractedName.toLowerCase().replace(/[^a-z0-9]/g, '');

  let bestMatch: Product | null = null;
  let bestScore = 0;

  for (const product of products) {
    if (!product.is_active) continue;

    const normalizedProductName = product.product_name.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (normalizedProductName === normalizedSearch) {
      return product;
    }

    const score = calculateSimilarity(normalizedSearch, normalizedProductName);
    if (score > bestScore && score > 0.6) {
      bestScore = score;
      bestMatch = product;
    }
  }

  return bestMatch;
}

export function fuzzyMatchCustomer(extractedName: string, customers: Customer[]): Customer | null {
  const normalizedSearch = extractedName.toLowerCase().replace(/[^a-z0-9]/g, '');

  let bestMatch: Customer | null = null;
  let bestScore = 0;

  for (const customer of customers) {
    if (!customer.is_active) continue;

    const normalizedFarmName = customer.farm_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedContactName = (customer.contact_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    if (normalizedFarmName === normalizedSearch || normalizedContactName === normalizedSearch) {
      return customer;
    }

    const farmScore = calculateSimilarity(normalizedSearch, normalizedFarmName);
    const contactScore = calculateSimilarity(normalizedSearch, normalizedContactName);
    const score = Math.max(farmScore, contactScore);

    if (score > bestScore && score > 0.6) {
      bestScore = score;
      bestMatch = customer;
    }
  }

  return bestMatch;
}

function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;

  if (str1.includes(str2) || str2.includes(str1)) {
    return 0.85;
  }

  // Levenshtein-based similarity
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1;

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(s1: string, s2: string): number {
  const costs: number[] = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}
