import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { captureEdgeException } from "../_shared/sentry.ts";
import { requireActiveProfile } from "../_shared/auth.ts";
import { corsHeaders, preflightResponse } from "../_shared/cors.ts";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

type DocumentType =
  | "invoice"
  | "purchase_order"
  | "price_list"
  | "product_list"
  | "customer_list"
  | "quote_list";

interface PageInput {
  base64: string;
  page_number: number;
}

interface ParsedInvoice {
  order_number: string;
  customer_name: string;
  order_date: string;
  status: string;
  notes: string;
  items: Array<{
    product_name: string;
    quantity: number;
    price_per_unit: number;
    unit_size: string;
    notes: string;
  }>;
}

interface ParsedPurchaseOrder {
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  items: Array<{
    product_name: string;
    quantity: number;
    unit_cost: number;
    unit_size: string;
    notes: string;
  }>;
}

interface ParsedPriceList {
  vendor_name: string;
  items: Array<{
    sku: string;
    product_name: string;
    cost: number;
    tier1_price: number;
    tier2_price: number;
    tier3_price: number;
  }>;
}

interface ParsedProductList {
  items: Array<{
    product_name: string;
    sku: string;
    category: string;
    vendor: string;
    cost: number;
    tier1_price: number;
    unit_size: string;
    epa_registration: string;
  }>;
}

interface ParsedCustomerList {
  items: Array<{
    farm_name: string;
    contact_name: string;
    phone: string;
    email: string;
    address: string;
    tier: number;
  }>;
}

interface ParsedQuoteList {
  items: Array<{
    quote_number: string;
    customer_name: string;
    product_name: string;
    acres: number;
    price: number;
    rate: number;
  }>;
}

type ParsedData =
  | ParsedInvoice
  | ParsedPurchaseOrder
  | ParsedPriceList
  | ParsedProductList
  | ParsedCustomerList
  | ParsedQuoteList;

// ─── Google Vision API ───────────────────────────────────────────────────────

async function callVisionAPI(
  imageBase64: string,
  apiKey: string,
): Promise<string> {
  const response = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Vision API error (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  const annotation = data.responses?.[0]?.fullTextAnnotation;
  return annotation?.text || "";
}

async function ocrAllPages(
  pages: PageInput[],
  apiKey: string,
): Promise<string> {
  // Process pages in parallel (max 5 concurrent)
  const BATCH_SIZE = 5;
  const allTexts: string[] = [];

  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    const batch = pages.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((p) => callVisionAPI(p.base64, apiKey)),
    );
    allTexts.push(...results);
  }

  return allTexts.join("\n\n--- PAGE BREAK ---\n\n");
}

// ─── Shared Parsing Helpers ──────────────────────────────────────────────────

function parseDateString(dateStr: string): string | null {
  // Try MM/DD/YYYY or MM-DD-YYYY
  const match = dateStr.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!match) return null;
  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  let year = parseInt(match[3], 10);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2099) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractLabelledValue(lines: string[], keywords: string[]): string {
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        const colonIdx = lines[i].indexOf(":");
        if (colonIdx !== -1) {
          const val = lines[i].substring(colonIdx + 1).trim();
          if (val.length > 0) return val;
        }
        // Check next line
        if (i + 1 < lines.length) {
          const next = lines[i + 1].trim();
          if (next.length > 0 && !/^[a-z\s]+:/i.test(next)) return next;
        }
      }
    }
  }
  return "";
}

function extractFirstDate(text: string): string {
  // Try labelled dates first
  const labelPatterns = [
    /(?:Invoice|PO|Order|Ship|Purchase)\s*Date\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /Date\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
  ];
  for (const pat of labelPatterns) {
    const m = text.match(pat);
    if (m) {
      const parsed = parseDateString(m[1]);
      if (parsed) return parsed;
    }
  }
  // Fallback: first date found
  const dateMatch = text.match(/(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/);
  if (dateMatch) {
    const parsed = parseDateString(dateMatch[1]);
    if (parsed) return parsed;
  }
  return new Date().toISOString().split("T")[0];
}

function extractCompanyName(lines: string[], skipKeywords: string[]): string {
  // Look for company-like names in the first 20 lines
  for (const line of lines.slice(0, 20)) {
    const trimmed = line.trim();
    if (
      trimmed.length > 4 &&
      trimmed.length < 80 &&
      /(?:LLC|INC|CORP|LTD|CO\.|COMPANY|CHEMICAL|SUPPLY|SOLUTIONS|INDUSTRIES|FARMS?|RANCH)/i.test(trimmed) &&
      !skipKeywords.some((kw) => trimmed.toLowerCase().includes(kw))
    ) {
      return trimmed;
    }
  }
  return "";
}

function parseNumber(str: string): number {
  const cleaned = str.replace(/[$,]/g, "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// ─── Fuzzy Matching ──────────────────────────────────────────────────────────

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

function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;
  if (str1.includes(str2) || str2.includes(str1)) return 0.85;
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  if (longer.length === 0) return 1;
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

interface ProductRow {
  id: string;
  product_name: string;
  sku: string | null;
  is_active: boolean;
}

interface CustomerRow {
  id: string;
  farm_name: string;
  contact_name: string | null;
  is_active: boolean;
}

function _fuzzyMatchProduct(name: string, products: ProductRow[]): { product: ProductRow | null; score: number } {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best: ProductRow | null = null;
  let bestScore = 0;

  for (const p of products) {
    if (!p.is_active) continue;
    const normP = p.product_name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normP === norm) return { product: p, score: 1 };
    // Also check SKU
    if (p.sku) {
      const normSku = p.sku.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normSku === norm) return { product: p, score: 1 };
    }
    const score = calculateSimilarity(norm, normP);
    if (score > bestScore && score > 0.6) {
      bestScore = score;
      best = p;
    }
  }
  return { product: bestScore >= 0.6 ? best : null, score: bestScore };
}

function _fuzzyMatchCustomer(name: string, customers: CustomerRow[]): CustomerRow | null {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best: CustomerRow | null = null;
  let bestScore = 0;

  for (const c of customers) {
    if (!c.is_active) continue;
    const normFarm = c.farm_name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normContact = (c.contact_name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normFarm === norm || normContact === norm) return c;
    const score = Math.max(
      calculateSimilarity(norm, normFarm),
      calculateSimilarity(norm, normContact),
    );
    if (score > bestScore && score > 0.6) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// ─── Document Parsers ────────────────────────────────────────────────────────

function parseInvoice(rawText: string, lines: string[]): { data: ParsedInvoice; confidence: number } {
  let invoiceNumber = "";
  let customerName = "";
  const invoiceDate = extractFirstDate(rawText);
  const items: ParsedInvoice["items"] = [];

  // Extract invoice number
  const invPatterns = [
    /Invoice\s*#?\s*:?\s*([A-Z0-9][\w-]+)/i,
    /Order\s*#?\s*:?\s*([A-Z0-9][\w-]+)/i,
    /Ref(?:erence)?\s*#?\s*:?\s*([A-Z0-9][\w-]+)/i,
  ];
  for (const pat of invPatterns) {
    const m = rawText.match(pat);
    if (m) { invoiceNumber = m[1]; break; }
  }

  // Extract customer name
  customerName = extractLabelledValue(lines, ["bill to", "sold to", "customer", "buyer"]);
  if (!customerName) {
    customerName = extractCompanyName(lines, ["invoice", "crop rx", "date", "chemical", "total", "page"]);
  }

  // Extract line items - CropRx vendor invoice pattern:
  // date product_name [EPA] quantity GL $cost GL $total
  const crxPattern =
    /(\d{2}\/\d{2}\/\d{4})\s+([A-Za-z0-9\s.\-()]+?)\s+(?:(\d+-\d+(?:-\d+)?))?\s*([\d,]+\.?\d*)\s*GL\s*\$?([\d,]+\.?\d*)\s*(?:GL)?\s*\$?([\d,]+\.?\d*)/g;
  let match;
  while ((match = crxPattern.exec(rawText)) !== null) {
    const [, , productName, epaReg, quantity, cost] = match;
    const cleanQty = parseNumber(quantity);
    const cleanCost = parseNumber(cost);
    if (cleanQty > 0) {
      items.push({
        product_name: productName.trim(),
        quantity: cleanQty,
        price_per_unit: cleanCost,
        unit_size: "GL",
        notes: epaReg ? `EPA Reg: ${epaReg}` : "",
      });
    }
  }

  // Fallback: generic tabular parsing
  if (items.length === 0) {
    const _unitPat = /\b(GL|GAL|GALLON|LB|LBS|OZ|QT|QUART|PT|PINT|CASE|EA|EACH|TON|BAG|JUG|DRUM|TOTE)\b/i;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5) continue;
      if (/^\s*(product|item|description|qty|quantity|price|amount|total|unit|#|sub\s*total|grand\s*total|tax|freight|shipping|discount|balance|due)\s/i.test(trimmed)) continue;

      // Match: text ... qty [unit] price [total]
      const lineMatch = trimmed.match(
        /^(.{4,60}?)\s{2,}([\d,]+\.?\d*)\s*(?:([A-Za-z]{1,6})\s+)?\$?\s*([\d,]+\.?\d{2})\s*(?:\$?\s*[\d,]+\.?\d{2})?$/,
      );
      if (lineMatch) {
        const [, name, qty, unit, price] = lineMatch;
        const cleanQty = parseNumber(qty);
        const cleanPrice = parseNumber(price);
        if (cleanQty > 0 && cleanPrice > 0) {
          items.push({
            product_name: name.trim(),
            quantity: cleanQty,
            price_per_unit: cleanPrice,
            unit_size: unit || "",
            notes: "",
          });
        }
      }
    }
  }

  // Calculate confidence
  let confidence = 30;
  if (invoiceNumber) confidence += 20;
  if (customerName) confidence += 20;
  if (invoiceDate !== new Date().toISOString().split("T")[0]) confidence += 10;
  if (items.length > 0) confidence += 20;

  return {
    data: {
      order_number: invoiceNumber,
      customer_name: customerName,
      order_date: invoiceDate,
      status: "confirmed",
      notes: "",
      items,
    },
    confidence: Math.min(confidence, 100),
  };
}

function parsePurchaseOrder(rawText: string, lines: string[]): { data: ParsedPurchaseOrder; confidence: number } {
  const invoiceDate = extractFirstDate(rawText);
  const items: ParsedPurchaseOrder["items"] = [];

  // Vendor name
  let vendorName = extractLabelledValue(lines, ["vendor", "supplier", "from", "sold by", "shipped from"]);
  if (!vendorName) {
    vendorName = extractCompanyName(lines, ["invoice", "purchase", "order", "date", "bill to", "ship to", "page", "total"]);
  }

  // Invoice/PO number
  let invoiceNumber = "";
  const invPatterns = [
    /(?:Invoice|Inv)\s*#?\s*:?\s*([A-Z0-9][\w-]+)/i,
    /(?:PO|P\.?O\.?)\s*#?\s*:?\s*([A-Z0-9][\w-]+)/i,
    /(?:Order|Ref(?:erence)?)\s*#?\s*:?\s*([A-Z0-9][\w-]+)/i,
    /(?:Document|Doc)\s*#?\s*:?\s*([A-Z0-9][\w-]+)/i,
  ];
  for (const pat of invPatterns) {
    const m = rawText.match(pat);
    if (m) { invoiceNumber = m[1]; break; }
  }

  // Extract line items — same CRX pattern + generic fallback
  const crxPattern =
    /(\d{2}\/\d{2}\/\d{4})\s+([A-Za-z0-9\s.\-()]+?)\s+(?:(\d+-\d+(?:-\d+)?))?\s*([\d,]+\.?\d*)\s*GL\s*\$?([\d,]+\.?\d*)\s*(?:GL)?\s*\$?([\d,]+\.?\d*)/g;
  let match;
  while ((match = crxPattern.exec(rawText)) !== null) {
    const [, , productName, epaReg, quantity, cost] = match;
    const cleanQty = parseNumber(quantity);
    const cleanCost = parseNumber(cost);
    if (cleanQty > 0) {
      items.push({
        product_name: productName.trim(),
        quantity: cleanQty,
        unit_cost: cleanCost,
        unit_size: "GL",
        notes: epaReg ? `EPA Reg: ${epaReg}` : "",
      });
    }
  }

  // Generic tabular fallback
  if (items.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5) continue;
      if (/^\s*(product|item|description|qty|quantity|price|amount|total|unit|#|sub\s*total|grand\s*total|tax|freight|shipping|discount|balance|due)\s/i.test(trimmed)) continue;

      const lineMatch = trimmed.match(
        /^(.{4,60}?)\s{2,}([\d,]+\.?\d*)\s*(?:([A-Za-z]{1,6})\s+)?\$?\s*([\d,]+\.?\d{2})\s*(?:\$?\s*[\d,]+\.?\d{2})?$/,
      );
      if (lineMatch) {
        const [, name, qty, unit, price] = lineMatch;
        const cleanQty = parseNumber(qty);
        const cleanPrice = parseNumber(price);
        if (cleanQty > 0 && cleanPrice > 0) {
          items.push({
            product_name: name.trim(),
            quantity: cleanQty,
            unit_cost: cleanPrice,
            unit_size: unit || "",
            notes: "",
          });
        }
      }
    }
  }

  // Strategy 3: Supplier order confirmation format (e.g. BASF/Shopify)
  // Lines look like: "ZIDUA SC - 2.5 GAL  90 Gal  $508.56  $45,770.40  12037 E 1700th Ave..."
  // Uses qty+unit as an anchor — product name is everything before it, price is first $X.XX after it.
  // Works regardless of trailing ship-to address or strict column whitespace.
  if (items.length === 0) {
    const skipLine = /^\s*(product|item|description|qty|quantity|price|amount|total|unit|financing|ship\s*to|#|sub\s*total|grand\s*total|tax|freight|shipping|discount|balance|due)\s/i;
    const unitPattern = /^([\s\S]*?)\b([\d,]+\.?\d*)\s+(Gal|Gallon|GL|LB|LBS|OZ|QT|Quart|PT|Pint|EA|Each|CASE|BAG|DRUM|TOTE|JUG)\b([\s\S]*)$/i;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5) continue;
      if (skipLine.test(trimmed)) continue;

      const m = trimmed.match(unitPattern);
      if (!m) continue;

      const productName = m[1].trim();
      if (!productName || productName.length < 3) continue;

      const priceMatch = m[4].match(/\$?\s*([\d,]+\.\d{2})/);
      if (!priceMatch) continue;

      const cleanQty = parseNumber(m[2]);
      const cleanPrice = parseNumber(priceMatch[1]);
      if (cleanQty <= 0 || cleanPrice <= 0) continue;

      const rawUnit = m[3].toUpperCase();
      const normalizedUnit = rawUnit === "GALLON" || rawUnit === "GAL" ? "GL" : rawUnit;
      items.push({
        product_name: productName.replace(/-\s*$/, "").trim(),
        quantity: cleanQty,
        unit_cost: cleanPrice,
        unit_size: normalizedUnit,
        notes: "",
      });
    }
  }

  let confidence = 30;
  if (vendorName) confidence += 20;
  if (invoiceNumber) confidence += 20;
  if (invoiceDate !== new Date().toISOString().split("T")[0]) confidence += 10;
  if (items.length > 0) confidence += 20;

  return {
    data: { vendor_name: vendorName, invoice_number: invoiceNumber, invoice_date: invoiceDate, items },
    confidence: Math.min(confidence, 100),
  };
}

function parsePriceList(rawText: string, lines: string[]): { data: ParsedPriceList; confidence: number } {
  // Vendor name
  let vendorName = extractLabelledValue(lines, ["vendor", "supplier", "manufacturer", "company"]);
  if (!vendorName) {
    vendorName = extractCompanyName(lines, ["price", "list", "catalog", "date", "page", "effective"]);
  }

  const items: ParsedPriceList["items"] = [];

  // Strategy: look for rows with product name + price columns
  // Common patterns:
  //   SKU    ProductName    Cost    Tier1    Tier2    Tier3
  //   ProductName    $XX.XX    $XX.XX    $XX.XX
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;
    if (/^\s*(sku|product|item|description|cost|price|tier|#|total)\s/i.test(trimmed)) continue;

    // Extract all dollar amounts from the line
    const priceMatches = [...trimmed.matchAll(/\$?\s*([\d,]+\.?\d{2})/g)];

    if (priceMatches.length >= 1) {
      // The text before the first price is the product name/SKU
      const firstPriceIdx = trimmed.indexOf(priceMatches[0][0]);
      const nameSection = trimmed.substring(0, firstPriceIdx).trim();

      if (nameSection.length >= 3) {
        // Try to split SKU from product name
        const skuMatch = nameSection.match(/^([A-Z0-9-]{3,15})\s+(.+)/);
        const sku = skuMatch ? skuMatch[1] : "";
        const productName = skuMatch ? skuMatch[2].trim() : nameSection;

        const prices = priceMatches.map((m) => parseNumber(m[1]));

        items.push({
          sku,
          product_name: productName,
          cost: prices[0] || 0,
          tier1_price: prices[1] || 0,
          tier2_price: prices[2] || 0,
          tier3_price: prices[3] || 0,
        });
      }
    }
  }

  let confidence = 30;
  if (vendorName) confidence += 15;
  if (items.length > 0) confidence += 25;
  if (items.length > 3) confidence += 15;
  if (items.some((i) => i.sku)) confidence += 15;

  return {
    data: { vendor_name: vendorName, items },
    confidence: Math.min(confidence, 100),
  };
}

function parseProductList(rawText: string, lines: string[]): { data: ParsedProductList; confidence: number } {
  const items: ParsedProductList["items"] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;
    if (/^\s*(product|sku|item|description|category|vendor|cost|price|epa|#)\s/i.test(trimmed)) continue;

    // Look for lines with product-like data: name, prices, maybe SKU
    const priceMatches = [...trimmed.matchAll(/\$?\s*([\d,]+\.?\d{2})/g)];
    if (priceMatches.length >= 1) {
      const firstPriceIdx = trimmed.indexOf(priceMatches[0][0]);
      const nameSection = trimmed.substring(0, firstPriceIdx).trim();
      if (nameSection.length >= 3) {
        const skuMatch = nameSection.match(/^([A-Z0-9-]{3,15})\s+(.+)/);
        const epaMatch = trimmed.match(/(\d+-\d+-\d+)/);
        const unitMatch = trimmed.match(/\b(GL|GAL|LB|OZ|QT|PT|CASE|EA|JUG|DRUM|TOTE|BAG)\b/i);

        items.push({
          product_name: skuMatch ? skuMatch[2].trim() : nameSection,
          sku: skuMatch ? skuMatch[1] : "",
          category: "",
          vendor: "",
          cost: priceMatches[0] ? parseNumber(priceMatches[0][1]) : 0,
          tier1_price: priceMatches[1] ? parseNumber(priceMatches[1][1]) : 0,
          unit_size: unitMatch ? unitMatch[1].toUpperCase() : "",
          epa_registration: epaMatch ? epaMatch[1] : "",
        });
      }
    }
  }

  let confidence = 30;
  if (items.length > 0) confidence += 30;
  if (items.length > 5) confidence += 20;
  if (items.some((i) => i.sku)) confidence += 10;
  if (items.some((i) => i.epa_registration)) confidence += 10;

  return {
    data: { items },
    confidence: Math.min(confidence, 100),
  };
}

function parseCustomerList(rawText: string, lines: string[]): { data: ParsedCustomerList; confidence: number } {
  const items: ParsedCustomerList["items"] = [];

  // Look for tabular data with name, phone, email patterns
  const phonePattern = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
  const emailPattern = /[\w.-]+@[\w.-]+\.\w+/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;
    if (/^\s*(name|farm|customer|contact|phone|email|address|tier|#)\s/i.test(trimmed)) continue;

    // Split by common delimiters (tab, multiple spaces, comma)
    const parts = trimmed.split(/\t|,|\s{3,}/).map((p) => p.trim()).filter((p) => p);
    if (parts.length < 2) continue;

    // Try to identify fields
    const phoneIdx = parts.findIndex((p) => phonePattern.test(p));
    const emailIdx = parts.findIndex((p) => emailPattern.test(p));

    // First non-number, non-phone, non-email part is likely the name
    const farmName = parts[0] || "";
    if (!farmName || /^\d+$/.test(farmName)) continue;

    items.push({
      farm_name: farmName,
      contact_name: parts.length > 1 && !phonePattern.test(parts[1]) && !emailPattern.test(parts[1]) ? parts[1] : "",
      phone: phoneIdx >= 0 ? parts[phoneIdx] : "",
      email: emailIdx >= 0 ? parts[emailIdx] : "",
      address: "",
      tier: 1,
    });
  }

  let confidence = 30;
  if (items.length > 0) confidence += 25;
  if (items.length > 3) confidence += 15;
  if (items.some((i) => i.phone)) confidence += 15;
  if (items.some((i) => i.email)) confidence += 15;

  return {
    data: { items },
    confidence: Math.min(confidence, 100),
  };
}

function parseQuoteList(rawText: string, lines: string[]): { data: ParsedQuoteList; confidence: number } {
  const items: ParsedQuoteList["items"] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;
    if (/^\s*(quote|customer|product|acres|price|rate|total|#|item)\s/i.test(trimmed)) continue;

    const parts = trimmed.split(/\t|,|\s{3,}/).map((p) => p.trim()).filter((p) => p);
    if (parts.length < 3) continue;

    // Extract numbers from parts
    const numericParts = parts.filter((p) => /^\$?[\d,]+\.?\d*$/.test(p.replace(/[$,]/g, "")));
    const textParts = parts.filter((p) => !/^\$?[\d,]+\.?\d*$/.test(p.replace(/[$,]/g, "")));

    if (textParts.length >= 1 && numericParts.length >= 1) {
      items.push({
        quote_number: textParts.length >= 3 ? textParts[0] : "",
        customer_name: textParts.length >= 3 ? textParts[1] : textParts[0],
        product_name: textParts.length >= 3 ? textParts[2] : (textParts[1] || ""),
        acres: numericParts[0] ? parseNumber(numericParts[0]) : 0,
        price: numericParts[1] ? parseNumber(numericParts[1]) : 0,
        rate: numericParts[2] ? parseNumber(numericParts[2]) : 0,
      });
    }
  }

  let confidence = 30;
  if (items.length > 0) confidence += 30;
  if (items.length > 3) confidence += 15;
  if (items.some((i) => i.quote_number)) confidence += 10;
  if (items.some((i) => i.acres > 0)) confidence += 15;

  return {
    data: { items },
    confidence: Math.min(confidence, 100),
  };
}

// ─── Router ──────────────────────────────────────────────────────────────────

function parseDocument(
  documentType: DocumentType,
  rawText: string,
): { data: ParsedData; confidence: number } {
  const lines = rawText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  switch (documentType) {
    case "invoice":
      return parseInvoice(rawText, lines);
    case "purchase_order":
      return parsePurchaseOrder(rawText, lines);
    case "price_list":
      return parsePriceList(rawText, lines);
    case "product_list":
      return parseProductList(rawText, lines);
    case "customer_list":
      return parseCustomerList(rawText, lines);
    case "quote_list":
      return parseQuoteList(rawText, lines);
    default:
      throw new Error(`Unknown document_type: ${documentType}`);
  }
}

// ─── Main Handler ────────────────────────────────────────────────────────────

// PARKED-011 (codex-driven cycle 7, MED): bound the request body + per-page
// decoded size BEFORE forwarding to Google Vision, to cap Edge Function memory
// and Vision API cost. Streams the body counting bytes (a lying/absent
// Content-Length can't bypass it) and aborts past the cap.
const MAX_REQUEST_BODY_BYTES = 52_000_000;     // ~50 MB on the wire
const MAX_DECODED_BYTES_PER_PAGE = 5_000_000;  // 5 MB decoded per page
const MAX_DECODED_BYTES_TOTAL = 37_000_000;    // 37 MB decoded across all pages

async function readBodyWithCap(req: Request, maxBytes: number): Promise<unknown> {
  if (!req.body) throw new Error("Request body is required");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Request body exceeds limit");
        throw Object.assign(new Error(`Request body exceeds ${maxBytes} bytes`), { __status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function approxDecodedBytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return preflightResponse(req);
  }

  const startTime = Date.now();

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const visionApiKey = Deno.env.get("GOOGLE_VISION_API_KEY");

  if (!visionApiKey) {
    return jsonResponse({ error: "GOOGLE_VISION_API_KEY secret not configured" }, 500);
  }

  // Authenticate caller
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing authorization" }, 401);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller } } = await callerClient.auth.getUser();
  if (!caller) {
    return jsonResponse({ error: "Invalid token" }, 401);
  }

  // Codex audit F1 (P1, 2026-05-16): is_active gate enforced server-side.
  // Only admin, sales_rep, and applicator can process documents.
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const gate = await requireActiveProfile(adminClient, caller.id, ["admin", "sales_rep", "applicator"]);
  if ("error" in gate) {
    return jsonResponse({ error: gate.error }, gate.status);
  }

  // Parse request body
  let documentType: DocumentType;
  let pages: PageInput[];
  let _metadata: Record<string, string> = {};

  // PARKED-011: read the body with a hard byte cap (replaces await req.json()),
  // then validate the pages array (length, per-page magic-byte + decoded-size caps).
  let body: { document_type?: DocumentType; pages?: PageInput[]; metadata?: Record<string, string> };
  try {
    body = await readBodyWithCap(req, MAX_REQUEST_BODY_BYTES) as typeof body;
  } catch (e) {
    const status = (e as { __status?: number }).__status === 413 ? 413 : 400;
    return jsonResponse({ error: (e as Error).message }, status);
  }

  try {
    documentType = body.document_type as DocumentType;
    pages = body.pages as PageInput[];
    _metadata = body.metadata || {};

    if (!documentType) throw new Error("document_type is required");
    if (!pages || !Array.isArray(pages) || pages.length === 0) {
      throw new Error("pages array is required and must not be empty");
    }
    if (pages.length > 20) {
      throw new Error("Maximum 20 pages per request");
    }

    // PARKED-011: per-page magic-byte sniff (PNG/JPEG/PDF) + decoded-size caps,
    // so a handful of huge or garbage base64 blobs can't OOM the function or run
    // up the Vision bill.
    let totalDecodedBytes = 0;
    for (const [i, p] of pages.entries()) {
      if (typeof p?.base64 !== "string" || p.base64.length === 0) {
        throw new Error(`pages[${i}].base64 must be a non-empty string`);
      }
      const headB64 = p.base64.slice(0, 8);
      // Accept every image/PDF format the frontend advertises AND actually sends. The
      // client (documentOCR.ts isOCRSupported / imageToPage, BulkPOImport.tsx) accepts
      // jpg/png/webp/bmp/tiff + pdf, and imageCompression returns the ORIGINAL bytes
      // unchanged for small/already-compact files — so a WebP/BMP/TIFF reaches here in
      // its NATIVE format, not JPEG. The old allow-list only passed JPEG/PNG/PDF, so
      // advertised WebP/BMP/TIFF uploads 400'd (Codex bug-hunt F3). All of these are
      // Google Vision-supported. Base64 magic-byte prefixes: JPEG \/9j\/, PNG iVBOR,
      // PDF JVBER (%PDF), WebP UklGR (RIFF), BMP Qk (BM), TIFF SUkq (II*) / TU0A (MM*).
      if (!/^(\/9j\/|iVBOR|JVBER|UklGR|Qk|SUkq|TU0A)/.test(headB64)) {
        throw new Error(`pages[${i}].base64 does not look like a supported image (JPEG / PNG / WebP / BMP / TIFF / PDF)`);
      }
      const decoded = approxDecodedBytes(p.base64);
      if (decoded > MAX_DECODED_BYTES_PER_PAGE) {
        throw new Error(`pages[${i}] is ~${decoded} decoded bytes; max ${MAX_DECODED_BYTES_PER_PAGE} per page`);
      }
      totalDecodedBytes += decoded;
    }
    if (totalDecodedBytes > MAX_DECODED_BYTES_TOTAL) {
      throw new Error(`total decoded bytes across all pages is ~${totalDecodedBytes}; max ${MAX_DECODED_BYTES_TOTAL}`);
    }

    const validTypes: DocumentType[] = [
      "invoice", "purchase_order", "price_list",
      "product_list", "customer_list", "quote_list",
    ];
    if (!validTypes.includes(documentType)) {
      throw new Error(`Invalid document_type. Must be one of: ${validTypes.join(", ")}`);
    }
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 400);
  }

  try {
    // OCR all pages via Google Vision
    const rawText = await ocrAllPages(pages, visionApiKey);

    if (rawText.trim().length === 0) {
      return jsonResponse({
        success: true,
        raw_text: "",
        document_type: documentType,
        parsed_data: null,
        confidence: 0,
        processing_time_ms: Date.now() - startTime,
        warning: "No text extracted from document. The image may be too low quality or contain no readable text.",
      });
    }

    // Parse the extracted text
    const { data: parsedData, confidence } = parseDocument(documentType, rawText);

    return jsonResponse({
      success: true,
      raw_text: rawText,
      document_type: documentType,
      parsed_data: parsedData,
      confidence,
      processing_time_ms: Date.now() - startTime,
    });
  } catch (e) {
    console.warn("Document processing error:", e);
    // Sprint F #7 — alert on document parse failures.
    await captureEdgeException(e, {
      function: "process-document",
      level: "error",
      extra: { processing_time_ms: Date.now() - startTime },
    });
    return jsonResponse({
      success: false,
      error: (e as Error).message,
      processing_time_ms: Date.now() - startTime,
    }, 500);
  }
});
