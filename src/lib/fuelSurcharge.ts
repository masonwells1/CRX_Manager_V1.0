/**
 * Field-app parity #32 — Fuel Surcharge config helpers (pure, tested).
 *
 * ⚠️ MONEY-RULE SAFETY: the surcharge rate/formula is a BILLING DECISION ONLY THE
 * OWNER CAN MAKE. This module NEVER supplies a default rate. The shipped/empty
 * config is OFF with a BLANK rate, and that means ZERO surcharge — the app behaves
 * exactly as it did before the feature existed. A surcharge is only ever computed
 * (server-side, in cents) when an admin both enables it AND types a positive rate.
 *
 * This file is presentation/serialization ONLY. The authoritative cents math lives
 * in the DB function compute_fuel_surcharge_cents() — STABLE (reads app_settings),
 * NOT IMMUTABLE: marking it IMMUTABLE would let Postgres cache a stale surcharge
 * after the owner edits the rate. The editor preview, the saved invoice, the PDF
 * and the share split all read that one function so they can never disagree.
 */

export type FuelSurchargeBasis = '' | 'per_acre' | 'percent' | 'flat';

export interface FuelSurchargeConfig {
  enabled: boolean;
  /** Empty until the owner picks one. */
  basis: FuelSurchargeBasis;
  /**
   * The owner's number, kept as the raw string they typed (blank by default).
   * per_acre / flat = DOLLARS; percent = a percentage. Blank => no surcharge.
   */
  rate: string;
}

/** The shipped, inert default: OFF, no basis, blank rate. */
export const DEFAULT_FUEL_SURCHARGE: FuelSurchargeConfig = {
  enabled: false,
  basis: '',
  rate: '',
};

const VALID_BASES: FuelSurchargeBasis[] = ['', 'per_acre', 'percent', 'flat'];

/**
 * Parse the app_settings.fuel_surcharge string value into a config. Anything
 * malformed/missing falls back to the inert OFF default (never invents a rate).
 */
export function parseFuelSurchargeConfig(raw: string | null | undefined): FuelSurchargeConfig {
  if (!raw) return { ...DEFAULT_FUEL_SURCHARGE };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_FUEL_SURCHARGE };
  }
  if (typeof obj !== 'object' || obj === null) return { ...DEFAULT_FUEL_SURCHARGE };
  const rec = obj as Record<string, unknown>;
  const basis = VALID_BASES.includes(rec.basis as FuelSurchargeBasis)
    ? (rec.basis as FuelSurchargeBasis)
    : '';
  return {
    enabled: rec.enabled === true,
    basis,
    rate: typeof rec.rate === 'string' ? rec.rate : '',
  };
}

/** Serialize a config to the JSON string stored in app_settings. */
export function serializeFuelSurchargeConfig(cfg: FuelSurchargeConfig): string {
  return JSON.stringify({
    enabled: cfg.enabled === true,
    basis: cfg.basis,
    rate: (cfg.rate ?? '').trim(),
  });
}

/**
 * Would this config actually apply a surcharge? Mirrors the server's gate:
 * enabled AND a basis chosen AND a positive numeric rate. Used only for the UI
 * "active / inert" hint — the DB is the source of truth for the money.
 */
export function fuelSurchargeIsActive(cfg: FuelSurchargeConfig): boolean {
  if (!cfg.enabled) return false;
  if (cfg.basis !== 'per_acre' && cfg.basis !== 'percent' && cfg.basis !== 'flat') return false;
  const trimmed = (cfg.rate ?? '').trim();
  if (trimmed === '') return false;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0;
}

/** Returns an error string if the config is internally inconsistent (UI guard), else null. */
export function validateFuelSurchargeConfig(cfg: FuelSurchargeConfig): string | null {
  // OFF is always valid (the safe default), regardless of the other fields.
  if (!cfg.enabled) return null;
  const trimmed = (cfg.rate ?? '').trim();
  // Enabled with a blank rate is allowed and inert (no surcharge) — not an error,
  // so the owner can flip the switch on first and fill the number later.
  if (trimmed === '') return null;
  if (cfg.basis === '') return 'Choose a basis (per acre, percent, or flat) before entering a rate.';
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return 'Rate must be a number.';
  if (n < 0) return 'Rate cannot be negative.';
  return null;
}

/** Human label for a basis, for the UI helper text / unit suffix. */
export function fuelSurchargeRateUnit(basis: FuelSurchargeBasis): string {
  switch (basis) {
    case 'per_acre':
      return '$ / acre';
    case 'percent':
      return '% of invoice';
    case 'flat':
      return '$ flat per invoice';
    default:
      return '';
  }
}
