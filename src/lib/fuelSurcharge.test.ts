import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FUEL_SURCHARGE,
  parseFuelSurchargeConfig,
  serializeFuelSurchargeConfig,
  fuelSurchargeIsActive,
  validateFuelSurchargeConfig,
  fuelSurchargeRateUnit,
} from './fuelSurcharge';

describe('fuelSurcharge config helpers (#32)', () => {
  describe('default is inert (OFF + blank)', () => {
    it('DEFAULT_FUEL_SURCHARGE is off, no basis, blank rate', () => {
      expect(DEFAULT_FUEL_SURCHARGE).toEqual({ enabled: false, basis: '', rate: '' });
    });
    it('the default config is NOT active (no surcharge applies)', () => {
      expect(fuelSurchargeIsActive(DEFAULT_FUEL_SURCHARGE)).toBe(false);
    });
  });

  describe('parse', () => {
    it('parses the shipped default JSON', () => {
      expect(parseFuelSurchargeConfig('{"enabled": false, "basis": "", "rate": ""}')).toEqual({
        enabled: false,
        basis: '',
        rate: '',
      });
    });
    it('parses an enabled per_acre config keeping the rate string verbatim', () => {
      expect(parseFuelSurchargeConfig('{"enabled":true,"basis":"per_acre","rate":"2.50"}')).toEqual({
        enabled: true,
        basis: 'per_acre',
        rate: '2.50',
      });
    });
    it.each([null, undefined, '', 'not json', '[]', '42', '{"basis":"bogus"}'])(
      'falls back to the inert default for malformed input %p (never invents a rate)',
      (raw) => {
        const cfg = parseFuelSurchargeConfig(raw as string);
        expect(cfg.rate).toBe('');
        expect(cfg.basis).toBe('');
        // enabled may be coerced false; the key invariant is rate stays blank.
        expect(fuelSurchargeIsActive(cfg)).toBe(false);
      },
    );
    it('coerces a non-string rate to blank', () => {
      expect(parseFuelSurchargeConfig('{"enabled":true,"basis":"flat","rate":5}').rate).toBe('');
    });
    it('rejects an unknown basis (falls back to blank)', () => {
      expect(parseFuelSurchargeConfig('{"enabled":true,"basis":"weird","rate":"3"}').basis).toBe('');
    });
  });

  describe('serialize round-trips and trims the rate', () => {
    it('round-trips an enabled config', () => {
      const cfg = { enabled: true, basis: 'percent' as const, rate: '5' };
      expect(parseFuelSurchargeConfig(serializeFuelSurchargeConfig(cfg))).toEqual(cfg);
    });
    it('trims surrounding whitespace from the rate', () => {
      const out = serializeFuelSurchargeConfig({ enabled: true, basis: 'flat', rate: '  12.00  ' });
      expect(JSON.parse(out).rate).toBe('12.00');
    });
    it('serializes the inert default unchanged', () => {
      expect(JSON.parse(serializeFuelSurchargeConfig(DEFAULT_FUEL_SURCHARGE))).toEqual({
        enabled: false,
        basis: '',
        rate: '',
      });
    });
  });

  describe('fuelSurchargeIsActive (UI hint mirroring the server gate)', () => {
    it('off => inert even with a rate set', () => {
      expect(fuelSurchargeIsActive({ enabled: false, basis: 'per_acre', rate: '2.50' })).toBe(false);
    });
    it('on + blank rate => inert', () => {
      expect(fuelSurchargeIsActive({ enabled: true, basis: 'per_acre', rate: '' })).toBe(false);
    });
    it('on + non-numeric rate => inert', () => {
      expect(fuelSurchargeIsActive({ enabled: true, basis: 'per_acre', rate: 'abc' })).toBe(false);
    });
    it('on + zero rate => inert', () => {
      expect(fuelSurchargeIsActive({ enabled: true, basis: 'per_acre', rate: '0' })).toBe(false);
    });
    it('on + blank basis => inert', () => {
      expect(fuelSurchargeIsActive({ enabled: true, basis: '', rate: '2.50' })).toBe(false);
    });
    it('on + basis + positive rate => active', () => {
      expect(fuelSurchargeIsActive({ enabled: true, basis: 'per_acre', rate: '2.50' })).toBe(true);
      expect(fuelSurchargeIsActive({ enabled: true, basis: 'percent', rate: '5' })).toBe(true);
      expect(fuelSurchargeIsActive({ enabled: true, basis: 'flat', rate: '15' })).toBe(true);
    });
  });

  describe('validate (UI guard; OFF/blank are never errors)', () => {
    it('off is always valid', () => {
      expect(validateFuelSurchargeConfig({ enabled: false, basis: '', rate: '' })).toBeNull();
      expect(validateFuelSurchargeConfig({ enabled: false, basis: 'per_acre', rate: 'abc' })).toBeNull();
    });
    it('on + blank rate is valid (inert; lets the owner flip on first)', () => {
      expect(validateFuelSurchargeConfig({ enabled: true, basis: 'per_acre', rate: '' })).toBeNull();
    });
    it('on + rate but no basis is an error', () => {
      expect(validateFuelSurchargeConfig({ enabled: true, basis: '', rate: '2.50' })).toMatch(/basis/i);
    });
    it('on + non-numeric rate is an error', () => {
      expect(validateFuelSurchargeConfig({ enabled: true, basis: 'per_acre', rate: 'abc' })).toMatch(/number/i);
    });
    it('on + negative rate is an error', () => {
      expect(validateFuelSurchargeConfig({ enabled: true, basis: 'per_acre', rate: '-1' })).toMatch(/negative/i);
    });
    it('on + valid positive rate is valid', () => {
      expect(validateFuelSurchargeConfig({ enabled: true, basis: 'flat', rate: '15' })).toBeNull();
    });
  });

  describe('rate unit labels', () => {
    it('labels each basis', () => {
      expect(fuelSurchargeRateUnit('per_acre')).toMatch(/acre/i);
      expect(fuelSurchargeRateUnit('percent')).toMatch(/%/);
      expect(fuelSurchargeRateUnit('flat')).toMatch(/flat/i);
      expect(fuelSurchargeRateUnit('')).toBe('');
    });
  });
});
