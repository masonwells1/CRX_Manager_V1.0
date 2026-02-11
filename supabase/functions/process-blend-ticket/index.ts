import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "http://localhost:5173",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── OCR Text Parsing (ported from src/lib/ocrParser.ts) ────────────────────

interface ParsedTicketData {
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

function parseOCRText(rawText: string): ParsedTicketData {
  const lines = rawText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  const parsed: ParsedTicketData = {
    ticketDate: extractDate(rawText),
    customerName: extractCustomerName(lines),
    driverName: extractFieldValue(lines, ["driver", "delivered by"]),
    tankNumber: extractFieldValue(lines, ["tank", "tank #", "tank no"]),
    applicatorName: extractFieldValue(lines, ["applicator", "applied by", "operator"]),
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
        const parsed = new Date(match[0]);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString().split("T")[0];
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

function extractCustomerName(lines: string[]): string | null {
  const indicators = ["customer", "farm", "grower", "account"];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    for (const indicator of indicators) {
      if (line.includes(indicator) && line.includes(":")) {
        const value = lines[i].split(":")[1]?.trim();
        if (value && value.length > 0) return value;
      }
      if (line.includes(indicator) && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (nextLine.length > 0 && !nextLine.match(/^\d/)) return nextLine;
      }
    }
  }
  return null;
}

function extractFieldValue(lines: string[], keywords: string[]): string | null {
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        const parts = line.split(":");
        if (parts.length > 1) {
          const value = parts[1].trim();
          if (value.length > 0) return value;
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

function extractProducts(lines: string[]): ParsedTicketData["products"] {
  const products: ParsedTicketData["products"] = [];

  const sectionStart = lines.findIndex(
    (l) =>
      l.toLowerCase().includes("product") ||
      l.toLowerCase().includes("chemical") ||
      l.toLowerCase().includes("material"),
  );

  const startIdx = sectionStart > 0 ? sectionStart + 1 : 0;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const qtyMatch = line.match(
      /(\d+\.?\d*)\s*(gal|gallon|gallons|lb|lbs|pound|pounds|oz|ounce|ounces|qt|quart|quarts|pt|pint|pints)?/i,
    );

    if (qtyMatch) {
      const quantity = parseFloat(qtyMatch[1]);
      const unit = qtyMatch[2] || null;

      let productName = line.replace(qtyMatch[0], "").trim();
      productName = productName.replace(/lot[:\s#]?\w*/gi, "").trim();

      if (productName.length > 2) {
        const lotMatch = line.match(/lot[:\s#]?(\w+)/i);
        products.push({
          productName,
          quantity,
          unit,
          lotNumber: lotMatch ? lotMatch[1] : null,
          confidenceScore: calcProductConfidence(productName, quantity, unit),
        });
      }
    }
  }
  return products;
}

function calcProductConfidence(name: string, qty: number, unit: string | null): number {
  let c = 50;
  if (name.length > 3) c += 15;
  if (qty > 0) c += 20;
  if (unit) c += 15;
  return Math.min(c, 100);
}

function calculateOverallConfidence(parsed: ParsedTicketData): number {
  let total = 0;
  let factors = 0;

  if (parsed.ticketDate) { total += 100; factors++; }
  if (parsed.customerName && parsed.customerName.length > 3) { total += 100; factors++; }
  if (parsed.products.length > 0) {
    const avg = parsed.products.reduce((s, p) => s + p.confidenceScore, 0) / parsed.products.length;
    total += avg;
    factors++;
  }
  if (parsed.driverName) { total += 80; factors++; }

  return factors > 0 ? Math.round(total / factors) : 0;
}

// ─── Fuzzy Matching ─────────────────────────────────────────────────────────

function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;
  if (str1.includes(str2) || str2.includes(str1)) return 0.85;

  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  return matches / longer.length;
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

function fuzzyMatchProduct(name: string, products: ProductRow[]): ProductRow | null {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best: ProductRow | null = null;
  let bestScore = 0;

  for (const p of products) {
    if (!p.is_active) continue;
    const normP = p.product_name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normP === norm) return p;
    const score = calculateSimilarity(norm, normP);
    if (score > bestScore && score > 0.7) { bestScore = score; best = p; }
  }
  return best;
}

function fuzzyMatchCustomer(name: string, customers: CustomerRow[]): CustomerRow | null {
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
    if (score > bestScore && score > 0.7) { bestScore = score; best = c; }
  }
  return best;
}

// ─── Google Vision AI ───────────────────────────────────────────────────────

async function callVisionAPI(imageBase64: string, apiKey: string): Promise<string> {
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

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

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
    if (!images || images.length === 0) throw new Error("No images found for ticket");

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
        console.error(`Failed to fetch image ${image.id}: ${response.status}`);
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ""),
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

    // Update blend ticket
    const ticketUpdate: Record<string, unknown> = {
      status: parsedData.overallConfidence >= 70 ? "completed" : "needs_review",
      raw_ocr_text: combinedText,
      ocr_confidence_score: parsedData.overallConfidence,
      ticket_date: parsedData.ticketDate,
      driver_name: parsedData.driverName,
      tank_number: parsedData.tankNumber,
      applicator_name: parsedData.applicatorName,
      signature_detected: parsedData.signatureDetected,
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
        message: `Ticket ${ticket.ticket_number} has been processed with ${parsedData.overallConfidence}% confidence`,
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
      status: ticketUpdate.status,
    });
  } catch (err) {
    console.error("OCR processing error:", err);
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
