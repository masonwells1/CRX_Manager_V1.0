import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

// IMPORTANT: Set ALLOWED_ORIGIN in Supabase Function secrets for production.
// e.g. supabase secrets set ALLOWED_ORIGIN=https://your-domain.com
function getAllowedOrigin(): string {
  const origin = Deno.env.get("ALLOWED_ORIGIN");
  if (origin) return origin;
  const url = Deno.env.get("SUPABASE_URL") || "";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "http://localhost:5173";
  console.warn("ALLOWED_ORIGIN not set — CORS will block all requests");
  return "";
}

const corsHeaders = {
  "Access-Control-Allow-Origin": getAllowedOrigin(),
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── OCR Text Parsing (CropRx Blend Ticket format) ─────────────────────────

interface ParsedTicketData {
  ticketDate: string | null;
  customerName: string | null;
  driverName: string | null;
  tankNumber: string | null;
  applicatorName: string | null;
  signatureDetected: boolean;
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

function parseOCRText(rawText: string): ParsedTicketData {
  const lines = rawText.split("\n").map((l) => l.trim()).filter((l) =>
    l.length > 0
  );

  const parsed: ParsedTicketData = {
    ticketDate: extractDate(rawText, lines),
    customerName: extractCustomerName(lines),
    driverName: extractFieldValue(lines, ["driver", "delivered by"]),
    tankNumber: extractFieldValue(lines, ["tank", "tank #", "tank no"]),
    applicatorName: extractCircledName(lines, [
      "applicator",
      "applied by",
      "operator",
    ]),
    signatureDetected: detectSignature(rawText),
    jobNumber: extractFieldValue(lines, ["job #", "job#", "job number"]),
    ticketTime: extractFieldValue(lines, ["time"]),
    vehicleInfo: extractCircledName(lines, ["vehicle"]),
    mixerName: extractCircledName(lines, ["mixer name", "mixer"]),
    fieldNames: extractFieldValue(lines, ["fields", "field"], true),
    totalAcres: extractNumericValue(lines, ["total acres", "acres"]),
    applicationRate: extractFieldValue(lines, [
      "application rate",
      "app rate",
    ]),
    totalVolume: extractNumericValue(lines, ["total volume", "volume"]),
    invoiceNumber: extractFieldValue(lines, [
      "invoice #",
      "invoice#",
      "invoice number",
      "invoice",
    ]),
    notes: extractFieldValue(lines, ["notes", "note"], true),
    products: extractProducts(lines),
    overallConfidence: 0,
  };

  parsed.overallConfidence = calculateOverallConfidence(parsed);
  return parsed;
}

function extractDate(text: string, lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes("date")) {
      const colonIdx = lines[i].indexOf(":");
      if (colonIdx !== -1) {
        const afterColon = lines[i].substring(colonIdx + 1).trim();
        const parsed = parseDateString(afterColon);
        if (parsed) return parsed;
      }
      if (i + 1 < lines.length) {
        const parsed = parseDateString(lines[i + 1].trim());
        if (parsed) return parsed;
      }
    }
  }

  const dateMatch = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (dateMatch) return parseDateString(dateMatch[0]);

  return null;
}

function parseDateString(dateStr: string): string | null {
  const match = dateStr.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!match) return null;

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  let year = parseInt(match[3], 10);

  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 ||
    year > 2099) return null;

  return `${year}-${String(month).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
}

function extractCustomerName(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();

    if (lower.startsWith("name:") || lower.startsWith("name :")) {
      const value = lines[i].substring(lines[i].indexOf(":") + 1).trim();
      if (value.length > 0) return value;
    }

    if (
      (lower.includes("customer") && lower.includes("name")) &&
      lines[i].includes(":")
    ) {
      const value = lines[i].substring(lines[i].lastIndexOf(":") + 1).trim();
      if (value.length > 0) return value;
    }

    if (lower.includes("customer") && lower.includes(":")) {
      const value = lines[i].substring(lines[i].indexOf(":") + 1).trim();
      if (value.length > 0 && !value.toLowerCase().startsWith("other")) {
        return value;
      }
    }

    if (lower === "customer" || lower === "customer name") {
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (
          nextLine.toLowerCase().startsWith("name:") ||
          nextLine.toLowerCase().startsWith("name :")
        ) {
          const value = nextLine.substring(nextLine.indexOf(":") + 1).trim();
          if (value.length > 0) return value;
        }
        if (
          nextLine.length > 0 && !nextLine.match(/^\d/) &&
          !nextLine.toLowerCase().startsWith("date")
        ) {
          return nextLine;
        }
      }
    }

    const otherIndicators = ["farm", "grower", "account"];
    for (const indicator of otherIndicators) {
      if (lower.includes(indicator) && lines[i].includes(":")) {
        const value = lines[i].substring(lines[i].indexOf(":") + 1).trim();
        if (value.length > 0) return value;
      }
    }
  }

  return null;
}

function looksLikeLabel(line: string): boolean {
  const lower = line.toLowerCase();
  if (/^[a-z\s]+:/i.test(line)) return true;
  if (/^\d[\d,]*\.?\d*$/.test(line.trim())) return true;
  const headers = [
    "total acres", "total volume", "application rate", "product",
    "rate/", "notes", "signature", "invoice", "mixer", "vehicle",
    "applicator", "customer", "date", "time", "job", "driver", "tank",
  ];
  return headers.some((h) => lower.startsWith(h) || lower === h);
}

function extractFieldValue(
  lines: string[],
  keywords: string[],
  multiLine = false,
): string | null {
  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();
    for (const keyword of keywords) {
      if (lowerLine.includes(keyword)) {
        let value = "";
        const colonIdx = lines[i].indexOf(":");
        if (colonIdx !== -1) {
          value = lines[i].substring(colonIdx + 1).trim();
        }

        if (value.length === 0 && i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (nextLine.length > 0 && !looksLikeLabel(nextLine)) {
            value = nextLine;
            if (multiLine) {
              for (let j = i + 2; j < lines.length; j++) {
                const cont = lines[j].trim();
                if (cont.length === 0 || looksLikeLabel(cont)) break;
                value += " " + cont;
              }
            }
            if (value.length > 0) return value;
          }
        }

        if (value.length > 0 && multiLine) {
          for (let j = i + 1; j < lines.length; j++) {
            const cont = lines[j].trim();
            if (cont.length === 0 || looksLikeLabel(cont)) break;
            value += " " + cont;
          }
        }

        if (value.length > 0) return value;
      }
    }
  }
  return null;
}

function extractCircledName(
  lines: string[],
  keywords: string[],
): string | null {
  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();
    for (const keyword of keywords) {
      if (lowerLine.includes(keyword)) {
        const colonIdx = lines[i].indexOf(":");
        if (colonIdx !== -1) {
          let value = lines[i].substring(colonIdx + 1).trim();

          if (value.includes("/")) {
            const firstName = value.split("/")[0].trim();
            if (
              firstName.length > 0 &&
              !firstName.toLowerCase().includes("other") &&
              firstName.length <= 50
            ) {
              return firstName;
            }
          }

          value = value
            .replace(
              /\s*\/\s*(chance|clayton|other|customer)[^]*/i,
              "",
            )
            .trim();
          if (value.length > 0) return value;
        }
      }
    }
  }
  return null;
}

function extractNumericValue(
  lines: string[],
  keywords: string[],
): number | null {
  const raw = extractFieldValue(lines, keywords);
  if (raw) {
    const numMatch = raw.match(/[\d,]+\.?\d*/);
    if (numMatch) {
      const num = parseFloat(numMatch[0].replace(/,/g, ""));
      if (!isNaN(num) && num >= 0) return num;
    }
  }

  // Fallback: look at the line BEFORE the label (OCR may put value above label)
  for (let i = 0; i < lines.length; i++) {
    const lowerLine = lines[i].toLowerCase();
    for (const keyword of keywords) {
      if (lowerLine.includes(keyword)) {
        if (i > 0) {
          const prevLine = lines[i - 1].trim();
          const prevNumMatch = prevLine.match(/^[\d,]+\.?\d*$/);
          if (prevNumMatch) {
            const num = parseFloat(prevNumMatch[0].replace(/,/g, ""));
            if (!isNaN(num) && num >= 0) return num;
          }
        }
      }
    }
  }

  return null;
}

function detectSignature(text: string): boolean {
  const keywords = ["signature", "signed", "sign here", "x_____"];
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function isNumericLine(line: string): boolean {
  const trimmed = line.trim();
  if (
    /^[\d,]+\.?\d*\s*(pt|gal|gals|gallons?|lb|lbs|oz|qt|ml|l|g|gools)?$/i
      .test(trimmed)
  ) return true;
  if (/^gools$/i.test(trimmed)) return true;
  return false;
}

function parseMultiLineProducts(
  pLines: string[],
): ParsedTicketData["products"] {
  const products: ParsedTicketData["products"] = [];
  let i = 0;

  while (i < pLines.length) {
    const line = pLines[i].trim();
    const lower = line.toLowerCase();
    if (
      lower === "product" || lower.includes("rate/acre") ||
      lower === "acre" || lower === "total product" || lower === "total"
    ) {
      i++;
      continue;
    }

    if (!isNumericLine(line) && line.length >= 2) {
      const productName = line;
      const numericValues: string[] = [];
      let j = i + 1;
      while (j < pLines.length && numericValues.length < 3) {
        const nextLine = pLines[j].trim();
        if (isNumericLine(nextLine)) {
          numericValues.push(nextLine);
          j++;
        } else break;
      }

      if (numericValues.length > 0) {
        const ratePerAcre = numericValues[0] || null;
        const totalProduct = numericValues.length > 1
          ? numericValues[1]
          : null;
        const qtyStr = totalProduct || ratePerAcre || "0";
        const qtyMatch = qtyStr.match(/([\d,]+\.?\d*)/);
        const quantity = qtyMatch
          ? parseFloat(qtyMatch[1].replace(/,/g, ""))
          : 0;
        const unitMatch = (totalProduct || ratePerAcre || "").match(
          /(gal|gals|gallons?|lb|lbs|oz|qt|pt|pint|quart|l|ml|g|gools)/i,
        );

        products.push({
          productName,
          quantity,
          unit: unitMatch ? unitMatch[1] : null,
          ratePerAcre,
          totalProduct,
          lotNumber: null,
          confidenceScore: calcProductConfidence(
            productName,
            quantity,
            unitMatch?.[1] || null,
          ),
        });
        i = j;
        continue;
      }
    }
    i++;
  }
  return products;
}

function extractProducts(lines: string[]): ParsedTicketData["products"] {
  const products: ParsedTicketData["products"] = [];

  let productSectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (
      (lower.includes("product") &&
        (lower.includes("rate") || lower.includes("total") ||
          lower.includes("acre"))) ||
      lower === "product"
    ) {
      productSectionStart = i;
      break;
    }
  }

  if (productSectionStart === -1) {
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      if (lower.includes("rate/") && lower.includes("total")) {
        productSectionStart = i;
        break;
      }
    }
  }

  const startIndex = productSectionStart >= 0 ? productSectionStart + 1 : -1;
  if (startIndex === -1) return products;

  let actualStart = startIndex;
  for (
    let i = startIndex;
    i < Math.min(startIndex + 3, lines.length);
    i++
  ) {
    const lower = lines[i].toLowerCase().trim();
    if (
      lower === "acre" || lower === "rate/" ||
      lower === "total product" || lower === "total"
    ) {
      actualStart = i + 1;
    }
  }

  // Collect product section lines
  const productLines: string[] = [];
  for (let i = actualStart; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    const lower = line.toLowerCase();
    if (lower.includes("signature") || lower.includes("signed") ||
        lower.includes("notes:")) break;
    productLines.push(line);
  }

  // Strategy 1: single-line parsing
  const singleLine: ParsedTicketData["products"] = [];
  for (const line of productLines) {
    const product = parseProductLine(line);
    if (product) singleLine.push(product);
  }

  // Strategy 2: multi-line parsing
  const multiLine = parseMultiLineProducts(productLines);

  // Use whichever found more products
  return singleLine.length >= multiLine.length ? singleLine : multiLine;
}

function parseProductLine(
  line: string,
): ParsedTicketData["products"][0] | null {
  const lower = line.toLowerCase();
  if (
    lower === "product" || lower.includes("rate/acre") || lower === "acre" ||
    lower === "total product" || lower === "total"
  ) {
    return null;
  }

  if (line.includes("|")) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length >= 2 && parts[0].length > 0) {
      const productName = parts[0];
      const ratePerAcre = parts[1] || null;
      const totalProduct = parts.length >= 3 ? parts[2] : null;

      const qtyMatch = (totalProduct || ratePerAcre || "").match(
        /([\d,]+\.?\d*)/,
      );
      const quantity = qtyMatch
        ? parseFloat(qtyMatch[1].replace(/,/g, ""))
        : 0;
      const unitMatch = (totalProduct || ratePerAcre || "").match(
        /(gal|gallon|gallons|lb|lbs|oz|qt|pt|pint|quart|l|ml)/i,
      );

      return {
        productName,
        quantity,
        unit: unitMatch ? unitMatch[1] : null,
        ratePerAcre,
        totalProduct,
        lotNumber: null,
        confidenceScore: calcProductConfidence(
          productName,
          quantity,
          unitMatch?.[1] || null,
        ),
      };
    }
  }

  const tokens = line.split(/\s+/);
  if (tokens.length < 2) return null;

  let numIdx = -1;
  for (let t = 0; t < tokens.length; t++) {
    if (tokens[t].match(/^\d+\.?\d*$/)) {
      numIdx = t;
      break;
    }
    if (tokens[t].match(/^\d+\.?\d*(pt|gal|lb|oz|qt|ml|l|g)$/i)) {
      numIdx = t;
      break;
    }
  }

  if (numIdx <= 0) return null;

  const productName = tokens.slice(0, numIdx).join(" ");
  if (productName.length < 2) return null;

  const numToken = tokens[numIdx];
  const qtyUnitMatch = numToken.match(
    /^([\d,]+\.?\d*)(pt|gal|lb|oz|qt|ml|l|g)?$/i,
  );
  const quantity = qtyUnitMatch
    ? parseFloat(qtyUnitMatch[1].replace(/,/g, ""))
    : 0;
  const unitFromQty = qtyUnitMatch?.[2] || null;

  const ratePerAcre = tokens[numIdx] || null;
  const totalProduct = tokens.length > numIdx + 1
    ? tokens.slice(numIdx + 1).join(" ")
    : null;

  const unitMatch = (totalProduct || "").match(
    /(gal|gallon|gallons|lb|lbs|oz|qt|pt|pint|quart|l|ml|g)/i,
  );
  const unit = unitFromQty || (unitMatch ? unitMatch[1] : null);

  return {
    productName,
    quantity,
    unit,
    ratePerAcre,
    totalProduct,
    lotNumber: null,
    confidenceScore: calcProductConfidence(productName, quantity, unit),
  };
}

function calcProductConfidence(
  name: string,
  qty: number,
  unit: string | null,
): number {
  let c = 50;
  if (name.length > 3) c += 15;
  if (qty > 0) c += 20;
  if (unit) c += 15;
  return Math.min(c, 100);
}

function calculateOverallConfidence(parsed: ParsedTicketData): number {
  let total = 0;
  let factors = 0;

  if (parsed.ticketDate) {
    total += 100;
    factors++;
  }
  if (parsed.customerName && parsed.customerName.length > 1) {
    total += 100;
    factors++;
  }
  if (parsed.applicatorName) {
    total += 90;
    factors++;
  }
  if (parsed.vehicleInfo) {
    total += 80;
    factors++;
  }
  if (parsed.mixerName) {
    total += 80;
    factors++;
  }
  if (parsed.fieldNames) {
    total += 90;
    factors++;
  }
  if (parsed.totalAcres) {
    total += 90;
    factors++;
  }
  if (parsed.products.length > 0) {
    const avg = parsed.products.reduce((s, p) => s + p.confidenceScore, 0) /
      parsed.products.length;
    total += avg;
    factors++;
  }
  if (parsed.driverName) {
    total += 80;
    factors++;
  }

  return factors > 0 ? Math.round(total / factors) : 0;
}

// ─── Fuzzy Matching ─────────────────────────────────────────────────────────

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
  is_active: boolean;
}

interface CustomerRow {
  id: string;
  farm_name: string;
  contact_name: string | null;
  is_active: boolean;
}

function fuzzyMatchProduct(
  name: string,
  products: ProductRow[],
): ProductRow | null {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best: ProductRow | null = null;
  let bestScore = 0;

  for (const p of products) {
    if (!p.is_active) continue;
    const normP = p.product_name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normP === norm) return p;
    const score = calculateSimilarity(norm, normP);
    if (score > bestScore && score > 0.6) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

function fuzzyMatchCustomer(
  name: string,
  customers: CustomerRow[],
): CustomerRow | null {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best: CustomerRow | null = null;
  let bestScore = 0;

  for (const c of customers) {
    if (!c.is_active) continue;
    const normFarm = c.farm_name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normContact = (c.contact_name || "").toLowerCase().replace(
      /[^a-z0-9]/g,
      "",
    );
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

// ─── Google Vision AI ───────────────────────────────────────────────────────

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

// ─── Main Handler ───────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const visionApiKey = Deno.env.get("GOOGLE_VISION_API_KEY");

  if (!visionApiKey) {
    return jsonResponse(
      { error: "GOOGLE_VISION_API_KEY secret not configured" },
      500,
    );
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

  // Role check — only admin, sales_rep, and applicator can process blend tickets
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: callerProfile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", caller.id)
    .single();
  if (
    !callerProfile ||
    !["admin", "sales_rep", "applicator"].includes(callerProfile.role)
  ) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  let blendTicketId: string;
  try {
    const body = await req.json();
    blendTicketId = body.blend_ticket_id;
    if (!blendTicketId) throw new Error("missing");
  } catch {
    return jsonResponse({ error: "blend_ticket_id is required" }, 400);
  }

  // Find or create queue entry
  const { data: existingQueue } = await adminClient
    .from("ocr_processing_queue")
    .select("*")
    .eq("blend_ticket_id", blendTicketId)
    .in("status", ["pending", "processing"])
    .limit(1)
    .maybeSingle();

  const queueId = existingQueue?.id;

  try {
    // Mark as processing
    if (queueId) {
      await adminClient
        .from("ocr_processing_queue")
        .update({
          status: "processing",
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", queueId);
    }

    await adminClient
      .from("blend_tickets")
      .update({ status: "processing" })
      .eq("id", blendTicketId);

    // Fetch images
    const { data: images, error: imgErr } = await adminClient
      .from("blend_ticket_images")
      .select("*")
      .eq("blend_ticket_id", blendTicketId)
      .order("upload_order");

    if (imgErr) throw imgErr;
    if (!images || images.length === 0) {
      throw new Error("No images found for ticket");
    }

    // OCR each image via Google Vision AI
    let combinedText = "";
    for (const image of images) {
      let imageUrl = image.image_url;
      if (image.storage_path) {
        const { data: signedData } = await adminClient.storage
          .from("blend-ticket-images")
          .createSignedUrl(image.storage_path, 3600);
        if (signedData?.signedUrl) imageUrl = signedData.signedUrl;
      }

      const response = await fetch(imageUrl);
      if (!response.ok) {
        console.warn(
          `Failed to fetch image ${image.id}: ${response.status}`,
        );
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          "",
        ),
      );

      const text = await callVisionAPI(base64, visionApiKey);
      combinedText += text + "\n\n";
    }

    if (combinedText.trim().length === 0) {
      throw new Error("No text extracted from images");
    }

    // Parse extracted text
    const parsedData = parseOCRText(combinedText);

    // Fuzzy match products & customers
    const { data: products } = await adminClient
      .from("products")
      .select("id, product_name, is_active")
      .eq("is_active", true);

    const { data: customers } = await adminClient
      .from("customers")
      .select("id, farm_name, contact_name, is_active")
      .eq("is_active", true);

    let matchedCustomerId: string | null = null;
    if (parsedData.customerName && customers) {
      const matched = fuzzyMatchCustomer(parsedData.customerName, customers);
      if (matched) matchedCustomerId = matched.id;
    }

    // Update blend ticket with ALL extracted fields
    const ticketUpdate: Record<string, unknown> = {
      status: parsedData.overallConfidence >= 70 ? "completed" : "needs_review",
      raw_ocr_text: combinedText,
      ocr_confidence_score: parsedData.overallConfidence,
      ticket_date: parsedData.ticketDate,
      driver_name: parsedData.driverName,
      tank_number: parsedData.tankNumber,
      applicator_name: parsedData.applicatorName,
      signature_detected: parsedData.signatureDetected,
      // Extended CropRx fields
      job_number: parsedData.jobNumber,
      ticket_time: parsedData.ticketTime,
      vehicle_info: parsedData.vehicleInfo,
      mixer_name: parsedData.mixerName,
      field_names: parsedData.fieldNames,
      total_acres: parsedData.totalAcres,
      application_rate: parsedData.applicationRate,
      total_volume: parsedData.totalVolume,
      invoice_number: parsedData.invoiceNumber,
      notes: parsedData.notes,
      updated_at: new Date().toISOString(),
    };

    if (matchedCustomerId) {
      ticketUpdate.customer_id = matchedCustomerId;
    }

    await adminClient
      .from("blend_tickets")
      .update(ticketUpdate)
      .eq("id", blendTicketId);

    // Insert product records
    for (let i = 0; i < parsedData.products.length; i++) {
      const prod = parsedData.products[i];
      let matchedProductId: string | null = null;

      if (products) {
        const matched = fuzzyMatchProduct(prod.productName, products);
        if (matched) matchedProductId = matched.id;
      }

      await adminClient.from("blend_ticket_products").insert({
        blend_ticket_id: blendTicketId,
        product_id: matchedProductId,
        product_name: prod.productName,
        quantity: prod.quantity,
        unit: prod.unit,
        lot_number: prod.lotNumber,
        sequence_order: i + 1,
        confidence_score: prod.confidenceScore,
        manually_corrected: false,
      });
    }

    // Mark queue complete
    if (queueId) {
      await adminClient
        .from("ocr_processing_queue")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", queueId);
    }

    // Notify uploader
    const { data: ticket } = await adminClient
      .from("blend_tickets")
      .select("uploaded_by, ticket_number")
      .eq("id", blendTicketId)
      .maybeSingle();

    if (ticket?.uploaded_by) {
      await adminClient.from("notifications").insert({
        user_id: ticket.uploaded_by,
        title: "Blend Ticket Processed",
        message:
          `Ticket ${ticket.ticket_number} has been processed with ${parsedData.overallConfidence}% confidence`,
        notification_type: "blend_ticket_processed",
        related_entity_type: "blend_ticket",
        related_entity_id: blendTicketId,
      });
    }

    return jsonResponse({
      success: true,
      blend_ticket_id: blendTicketId,
      confidence: parsedData.overallConfidence,
      products_found: parsedData.products.length,
      customer_matched: !!matchedCustomerId,
      fields_extracted: {
        date: !!parsedData.ticketDate,
        customer: !!parsedData.customerName,
        applicator: !!parsedData.applicatorName,
        vehicle: !!parsedData.vehicleInfo,
        mixer: !!parsedData.mixerName,
        fields: !!parsedData.fieldNames,
        acres: !!parsedData.totalAcres,
        volume: !!parsedData.totalVolume,
      },
      status: ticketUpdate.status,
    });
  } catch (err) {
    console.warn("OCR processing error:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";

    // Handle retry logic
    if (queueId && existingQueue) {
      const newRetryCount = (existingQueue.retry_count || 0) + 1;

      if (newRetryCount >= (existingQueue.max_retries || 3)) {
        await adminClient
          .from("ocr_processing_queue")
          .update({
            status: "failed",
            error_message: errorMessage,
            retry_count: newRetryCount,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", queueId);

        await adminClient
          .from("blend_tickets")
          .update({ status: "failed" })
          .eq("id", blendTicketId);
      } else {
        await adminClient
          .from("ocr_processing_queue")
          .update({
            status: "pending",
            error_message: errorMessage,
            retry_count: newRetryCount,
            updated_at: new Date().toISOString(),
          })
          .eq("id", queueId);

        await adminClient
          .from("blend_tickets")
          .update({ status: "pending" })
          .eq("id", blendTicketId);
      }
    }

    return jsonResponse({ error: errorMessage }, 500);
  }
});
