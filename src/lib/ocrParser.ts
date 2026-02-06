import type { Product, Customer } from '../types';

export interface ParsedTicketData {
  ticketDate: string | null;
  customerName: string | null;
  driverName: string | null;
  tankNumber: string | null;
  applicatorName: string | null;
  signatureDetected: boolean;
  products: Array<{
    productName: string;
    quantity: number;
    unit: string | null;
    lotNumber: string | null;
    confidenceScore: number;
  }>;
  overallConfidence: number;
}

export function parseOCRText(rawText: string): ParsedTicketData {
  const lines = rawText.split('\n').map(line => line.trim()).filter(line => line.length > 0);

  const parsed: ParsedTicketData = {
    ticketDate: extractDate(rawText),
    customerName: extractCustomerName(lines),
    driverName: extractFieldValue(lines, ['driver', 'delivered by']),
    tankNumber: extractFieldValue(lines, ['tank', 'tank #', 'tank no']),
    applicatorName: extractFieldValue(lines, ['applicator', 'applied by', 'operator']),
    signatureDetected: detectSignature(rawText),
    products: extractProducts(lines),
    overallConfidence: 0,
  };

  parsed.overallConfidence = calculateOverallConfidence(parsed);

  return parsed;
}

function extractDate(text: string): string | null {
  const datePatterns = [
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/,
    /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/,
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i,
  ];

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const dateStr = match[0];
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString().split('T')[0];
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

function extractCustomerName(lines: string[]): string | null {
  const customerIndicators = ['customer', 'farm', 'grower', 'account'];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    for (const indicator of customerIndicators) {
      if (line.includes(indicator) && line.includes(':')) {
        const value = lines[i].split(':')[1]?.trim();
        if (value && value.length > 0) {
          return value;
        }
      }
      if (line.includes(indicator) && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (nextLine.length > 0 && !nextLine.match(/^\d/)) {
          return nextLine;
        }
      }
    }
  }

  return null;
}

function extractFieldValue(lines: string[], keywords: string[]): string | null {
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    for (const keyword of keywords) {
      if (lowerLine.includes(keyword)) {
        const parts = line.split(':');
        if (parts.length > 1) {
          const value = parts[1].trim();
          if (value.length > 0) {
            return value;
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

function extractProducts(lines: string[]): Array<{
  productName: string;
  quantity: number;
  unit: string | null;
  lotNumber: string | null;
  confidenceScore: number;
}> {
  const products: Array<{
    productName: string;
    quantity: number;
    unit: string | null;
    lotNumber: string | null;
    confidenceScore: number;
  }> = [];

  const productSectionStart = lines.findIndex(line =>
    line.toLowerCase().includes('product') ||
    line.toLowerCase().includes('chemical') ||
    line.toLowerCase().includes('material')
  );

  const startIndex = productSectionStart > 0 ? productSectionStart + 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    const quantityMatch = line.match(/(\d+\.?\d*)\s*(gal|gallon|gallons|lb|lbs|pound|pounds|oz|ounce|ounces|qt|quart|quarts|pt|pint|pints)?/i);

    if (quantityMatch) {
      const quantity = parseFloat(quantityMatch[1]);
      const unit = quantityMatch[2] || null;

      let productName = line.replace(quantityMatch[0], '').trim();
      productName = productName.replace(/lot[:\s#]?\w*/gi, '').trim();

      if (productName.length > 2) {
        const lotMatch = line.match(/lot[:\s#]?(\w+)/i);
        const lotNumber = lotMatch ? lotMatch[1] : null;

        products.push({
          productName,
          quantity,
          unit,
          lotNumber,
          confidenceScore: calculateProductConfidence(productName, quantity, unit),
        });
      }
    }
  }

  return products;
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

  if (parsed.customerName && parsed.customerName.length > 3) {
    totalScore += 100;
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
    if (score > bestScore && score > 0.7) {
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

    if (score > bestScore && score > 0.7) {
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

  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) {
      matches++;
    }
  }

  return matches / longer.length;
}
