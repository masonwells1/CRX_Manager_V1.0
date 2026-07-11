export type SupportedRegistrationType = "section3" | "distributor";

export type RegistrationClassification =
  | {
    kind: SupportedRegistrationType;
    supported: true;
    normalized: string;
  }
  | {
    kind: "sln_24c" | "section18" | "malformed";
    supported: false;
  };

export type SignalWordCanonical = "Danger" | "Warning" | "Caution";

export interface SignalWordNormalization {
  canonical: SignalWordCanonical | null;
  needsManual: boolean;
}

export interface EpaActiveIngredient {
  name: string;
  percent: number | null;
  pcCode: string | null;
  casNumber: string | null;
}

export interface EpaLabelPdf {
  fileName: string;
  acceptedDate: string | null;
  url: string;
}

export interface EpaLookupResult {
  found: boolean;
  regType: SupportedRegistrationType;
  eparegno: string | null;
  productname: string | null;
  signalWordCanonical: SignalWordCanonical | null;
  needsManual: boolean;
  manufacturer: string | null;
  rupYn: "Yes" | "No" | null;
  productStatus: string | null;
  isCancelled: boolean;
  activeIngredients: EpaActiveIngredient[];
  latestLabelPdfUrl: string | null;
  labelPdfs: EpaLabelPdf[];
}

const SECTION_3_PATTERN = /^[1-9]\d{0,5}-[1-9]\d{0,4}$/;
const DISTRIBUTOR_PATTERN = /^[1-9]\d{0,5}-[1-9]\d{0,4}-[1-9]\d{0,5}$/;
const SLN_NUMBER_PATTERN =
  /^(?:EPA\s+SLN\s+(?:NO\.?\s*)?)?[A-Z]{2}(?:\d{6}|-\d{2}-\d{4})$/i;
const SLN_MARKER_PATTERN = /\bSLN\b|\b24\s*\(?\s*C\s*\)?\b/i;
const SECTION_18_PATTERN =
  /\b(?:FIFRA\s+)?SECTION\s*18\b|\bSEC(?:TION)?\.?\s*18\b|\bEMERGENCY\s+EXEMPTION\b/i;

/**
 * Classify an EPA registration identifier before it is permitted into a URL.
 * Only numeric Section 3 and distributor registrations are lookup-supported.
 */
export function classifyRegistrationNumber(
  input: unknown,
): RegistrationClassification {
  if (typeof input !== "string") {
    return { kind: "malformed", supported: false };
  }

  const value = input.trim();
  if (!value) {
    return { kind: "malformed", supported: false };
  }

  if (SECTION_18_PATTERN.test(value)) {
    return { kind: "section18", supported: false };
  }

  if (SLN_NUMBER_PATTERN.test(value) || SLN_MARKER_PATTERN.test(value)) {
    return { kind: "sln_24c", supported: false };
  }

  if (SECTION_3_PATTERN.test(value)) {
    return { kind: "section3", supported: true, normalized: value };
  }

  if (DISTRIBUTOR_PATTERN.test(value)) {
    return { kind: "distributor", supported: true, normalized: value };
  }

  return { kind: "malformed", supported: false };
}

/** Normalize EPA signal words to the exact values accepted by products.signal_word. */
export function normalizeSignalWord(input: unknown): SignalWordNormalization {
  if (typeof input !== "string") {
    return { canonical: null, needsManual: true };
  }

  const value = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (value === "danger") return { canonical: "Danger", needsManual: false };
  if (value === "warning") return { canonical: "Warning", needsManual: false };
  if (value === "caution") return { canonical: "Caution", needsManual: false };
  if (value === "no signal word") {
    return { canonical: null, needsManual: false };
  }
  return { canonical: null, needsManual: true };
}

const LABEL_PDF_BASE_URL = "https://www3.epa.gov/pesticides/chem_search/ppls/";
const SAFE_PDF_FILE_NAME = /^[A-Z0-9][A-Z0-9._-]{0,199}\.PDF$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  return null;
}

function normalizeYesNo(value: unknown): "Yes" | "No" | null {
  const normalized = cleanString(value, 20)?.toLowerCase();
  if (normalized === "yes") return "Yes";
  if (normalized === "no") return "No";
  return null;
}

function pdfSortKey(pdf: EpaLabelPdf): number {
  const fileDate = pdf.fileName.match(/-(\d{8})\.pdf$/i)?.[1];
  if (fileDate) return Number(fileDate);
  const acceptedDate = pdf.acceptedDate
    ? Date.parse(pdf.acceptedDate)
    : Number.NaN;
  return Number.isFinite(acceptedDate) ? acceptedDate : 0;
}

function normalizeLabelPdfs(value: unknown): EpaLabelPdf[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap((entry): EpaLabelPdf[] => {
      if (!isRecord(entry)) return [];
      const fileName = cleanString(entry.pdffile, 204);
      if (!fileName || !SAFE_PDF_FILE_NAME.test(fileName)) return [];
      return [{
        fileName,
        acceptedDate: cleanString(entry.pdffile_accepted_date, 100),
        url: `${LABEL_PDF_BASE_URL}${encodeURIComponent(fileName)}`,
      }];
    })
    .sort((left, right) => pdfSortKey(right) - pdfSortKey(left));
}

function normalizeActiveIngredients(value: unknown): EpaActiveIngredient[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): EpaActiveIngredient[] => {
    if (!isRecord(entry)) return [];
    const name = cleanString(entry.active_ing, 300);
    if (!name) return [];
    return [{
      name,
      percent: finiteNumber(entry.active_ing_percent),
      pcCode: cleanString(entry.pc_code, 50),
      casNumber: cleanString(entry.cas_number, 100),
    }];
  });
}

function firstCompanyName(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = cleanString(entry.name, 300);
    if (name) return name;
  }
  return null;
}

export function normalizeEpaPayload(
  payload: unknown,
  regType: SupportedRegistrationType,
  requestedRegNumber: string,
): EpaLookupResult {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error("EPA response did not contain an items array");
  }

  if (payload.items.length === 0) {
    return {
      found: false,
      regType,
      eparegno: null,
      productname: null,
      signalWordCanonical: null,
      needsManual: false,
      manufacturer: null,
      rupYn: null,
      productStatus: null,
      isCancelled: false,
      activeIngredients: [],
      latestLabelPdfUrl: null,
      labelPdfs: [],
    };
  }

  const item = payload.items.find((candidate) =>
    isRecord(candidate) &&
    cleanString(candidate.eparegno, 50) === requestedRegNumber
  );
  if (!isRecord(item)) {
    throw new Error("EPA response registration did not match the request");
  }

  const signalWord = normalizeSignalWord(item.signal_word);
  const productStatus = cleanString(item.product_status, 100);
  const cancelFlag = normalizeYesNo(item.cancel_flag);
  const labelPdfs = normalizeLabelPdfs(item.pdffiles);

  return {
    found: true,
    regType,
    eparegno: requestedRegNumber,
    productname: cleanString(item.productname, 500),
    signalWordCanonical: signalWord.canonical,
    needsManual: signalWord.needsManual,
    manufacturer: firstCompanyName(item.companyinfo),
    rupYn: normalizeYesNo(item.rup_yn),
    productStatus,
    isCancelled: cancelFlag === "Yes" ||
      productStatus?.toLowerCase() === "cancelled",
    activeIngredients: normalizeActiveIngredients(item.active_ingredients),
    latestLabelPdfUrl: labelPdfs[0]?.url ?? null,
    labelPdfs,
  };
}
