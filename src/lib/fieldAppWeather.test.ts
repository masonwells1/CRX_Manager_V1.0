import { describe, it, expect } from 'vitest';
import {
  EMPTY_WEATHER_SET,
  normalizeTimeForInput,
  weatherSetFromRow,
  applyCapturedWeather,
  applyManualEdit,
  weatherSetHasData,
  computeManualOverride,
  buildWeatherRpcParams,
  invalidateAutoWeather,
  WEATHER_DISCLAIMER,
  WEATHER_FALLBACK_TIME,
  type InvoiceWeatherRow,
  type WeatherSetForm,
} from './fieldAppWeather';
import type { CapturedWeather } from './weatherCapture';

const CAPTURED: CapturedWeather = {
  temperature_f: 68,
  wind_speed_mph: 8.3,
  wind_direction: 'SSW',
  humidity_pct: 54,
};

const ROW: InvoiceWeatherRow = {
  start_temp_f: 68,
  start_wind_mph: 8.3,
  start_wind_direction: 'SSW',
  start_humidity_pct: 54,
  start_weather_time: '07:30:00',
  start_weather_source: 'auto',
  end_temp_f: 75,
  end_wind_mph: 11.2,
  end_wind_direction: 'WSW',
  end_humidity_pct: 47,
  end_weather_time: '10:15:00',
  end_weather_source: 'manual',
  weather_manual_override: true,
};

describe('normalizeTimeForInput', () => {
  it('truncates HH:MM:SS to HH:MM and passes HH:MM through', () => {
    expect(normalizeTimeForInput('07:30:00')).toBe('07:30');
    expect(normalizeTimeForInput('10:15')).toBe('10:15');
  });
  it('returns empty string for null/garbage', () => {
    expect(normalizeTimeForInput(null)).toBe('');
    expect(normalizeTimeForInput(undefined)).toBe('');
    expect(normalizeTimeForInput('nope')).toBe('');
  });
});

describe('weatherSetFromRow', () => {
  it('maps the START columns into a form set (auto source ⇒ hasAutoData)', () => {
    expect(weatherSetFromRow(ROW, 'start')).toEqual({
      time: '07:30',
      temp_f: '68',
      wind_mph: '8.3',
      wind_direction: 'SSW',
      humidity_pct: '54',
      source: 'auto',
      hasAutoData: true,
    });
  });
  it('maps the END columns into a form set (manual source ⇒ no auto data)', () => {
    expect(weatherSetFromRow(ROW, 'end')).toEqual({
      time: '10:15',
      temp_f: '75',
      wind_mph: '11.2',
      wind_direction: 'WSW',
      humidity_pct: '47',
      source: 'manual',
      hasAutoData: false,
    });
  });
  it('yields blanks (not "null"/"NaN") for an all-null row', () => {
    const empty: InvoiceWeatherRow = {
      start_temp_f: null, start_wind_mph: null, start_wind_direction: null,
      start_humidity_pct: null, start_weather_time: null, start_weather_source: null,
      end_temp_f: null, end_wind_mph: null, end_wind_direction: null,
      end_humidity_pct: null, end_weather_time: null, end_weather_source: null,
      weather_manual_override: null,
    };
    expect(weatherSetFromRow(empty, 'start')).toEqual(EMPTY_WEATHER_SET);
  });
});

describe('applyCapturedWeather', () => {
  it('fills the four readings and flags the set auto, preserving an entered time', () => {
    const prev: WeatherSetForm = { ...EMPTY_WEATHER_SET, time: '08:00' };
    expect(applyCapturedWeather(prev, CAPTURED)).toEqual({
      time: '08:00',
      temp_f: '68',
      wind_mph: '8.3',
      wind_direction: 'SSW',
      humidity_pct: '54',
      source: 'auto',
      hasAutoData: true,
    });
  });
  it('stamps the midday fallback time when the time was blank (compliance provenance)', () => {
    // Blank time -> the helper used the noon reading, so record 12:00 rather than null.
    expect(applyCapturedWeather(EMPTY_WEATHER_SET, CAPTURED)).toEqual({
      time: WEATHER_FALLBACK_TIME,
      temp_f: '68',
      wind_mph: '8.3',
      wind_direction: 'SSW',
      humidity_pct: '54',
      source: 'auto',
      hasAutoData: true,
    });
  });
});

describe('applyManualEdit', () => {
  it('writes the field, flips source to manual, but KEEPS hasAutoData (other values still modeled)', () => {
    const auto: WeatherSetForm = { ...EMPTY_WEATHER_SET, temp_f: '68', wind_mph: '8.3', source: 'auto', hasAutoData: true };
    const edited = applyManualEdit(auto, 'temp_f', '70');
    expect(edited.temp_f).toBe('70');
    expect(edited.source).toBe('manual');
    expect(edited.hasAutoData).toBe(true); // wind_mph is still the modeled value
  });
  it('clears stale AUTO readings when the time is changed (reading was keyed to the old hour)', () => {
    const auto: WeatherSetForm = { time: '08:00', temp_f: '68', wind_mph: '8.3', wind_direction: 'SSW', humidity_pct: '54', source: 'auto', hasAutoData: true };
    const edited = applyManualEdit(auto, 'time', '09:00');
    expect(edited).toEqual({ ...EMPTY_WEATHER_SET, time: '09:00' });
  });
  it('keeps MANUAL readings when the time is changed (user typed them deliberately)', () => {
    const manual: WeatherSetForm = { time: '08:00', temp_f: '70', wind_mph: '', wind_direction: 'N', humidity_pct: '', source: 'manual', hasAutoData: false };
    const edited = applyManualEdit(manual, 'time', '09:00');
    expect(edited).toEqual({ ...manual, time: '09:00' });
  });
});

describe('weatherSetHasData', () => {
  it('is false for an empty set and true when any field is set', () => {
    expect(weatherSetHasData(EMPTY_WEATHER_SET)).toBe(false);
    expect(weatherSetHasData({ ...EMPTY_WEATHER_SET, time: '08:00' })).toBe(true);
    expect(weatherSetHasData({ ...EMPTY_WEATHER_SET, temp_f: '70' })).toBe(true);
  });
});

describe('computeManualOverride', () => {
  it('is true when a populated set was last hand-edited', () => {
    const manual: WeatherSetForm = { ...EMPTY_WEATHER_SET, temp_f: '70', source: 'manual' };
    expect(computeManualOverride(manual, EMPTY_WEATHER_SET)).toBe(true);
  });
  it('is false for pristine auto sets and for empty sets', () => {
    const auto: WeatherSetForm = { ...EMPTY_WEATHER_SET, temp_f: '68', source: 'auto' };
    expect(computeManualOverride(auto, auto)).toBe(false);
    expect(computeManualOverride(EMPTY_WEATHER_SET, EMPTY_WEATHER_SET)).toBe(false);
  });
  it('ignores a manual flag on a set with no data', () => {
    const emptyManual: WeatherSetForm = { ...EMPTY_WEATHER_SET, source: 'manual' };
    expect(computeManualOverride(emptyManual, EMPTY_WEATHER_SET)).toBe(false);
  });
});

describe('buildWeatherRpcParams', () => {
  it('maps a full auto-start + manual-end pair (round-trips the smoke values)', () => {
    const start: WeatherSetForm = {
      time: '07:30', temp_f: '68', wind_mph: '8.3', wind_direction: 'SSW', humidity_pct: '54', source: 'auto', hasAutoData: true,
    };
    const end: WeatherSetForm = {
      time: '10:15', temp_f: '75', wind_mph: '11.2', wind_direction: 'WSW', humidity_pct: '47', source: 'manual', hasAutoData: false,
    };
    expect(buildWeatherRpcParams(start, end)).toEqual({
      p_start_temp_f: 68, p_start_wind_mph: 8.3, p_start_wind_direction: 'SSW',
      p_start_humidity_pct: 54, p_start_weather_time: '07:30', p_start_weather_source: 'auto',
      p_end_temp_f: 75, p_end_wind_mph: 11.2, p_end_wind_direction: 'WSW',
      p_end_humidity_pct: 47, p_end_weather_time: '10:15', p_end_weather_source: 'manual',
      p_weather_manual_override: true,
    });
  });

  it('sends nulls (clears columns) for empty sets and never a spurious source', () => {
    const params = buildWeatherRpcParams(EMPTY_WEATHER_SET, EMPTY_WEATHER_SET);
    expect(params.p_start_temp_f).toBeNull();
    expect(params.p_start_weather_source).toBeNull();
    expect(params.p_end_weather_source).toBeNull();
    expect(params.p_start_weather_time).toBeNull();
    expect(params.p_weather_manual_override).toBe(false);
  });

  it('drops a garbage/partial time to null but keeps the readings', () => {
    const start: WeatherSetForm = { ...EMPTY_WEATHER_SET, temp_f: '70', time: '7', source: 'manual' };
    const params = buildWeatherRpcParams(start, EMPTY_WEATHER_SET);
    expect(params.p_start_temp_f).toBe(70);
    expect(params.p_start_weather_time).toBeNull();
    expect(params.p_start_weather_source).toBe('manual');
  });

  it('defaults a data-bearing set with no source flag to manual provenance', () => {
    // Hand-typed set whose source was never set (typed directly, no fetch).
    const start: WeatherSetForm = { ...EMPTY_WEATHER_SET, temp_f: '70' };
    const params = buildWeatherRpcParams(start, EMPTY_WEATHER_SET);
    expect(params.p_start_weather_source).toBe('manual');
  });
});

describe('invalidateAutoWeather', () => {
  it('clears an auto-sourced set (stale once the field/date key changes)', () => {
    const auto: WeatherSetForm = { time: '08:00', temp_f: '68', wind_mph: '8.3', wind_direction: 'SSW', humidity_pct: '54', source: 'auto', hasAutoData: true };
    expect(invalidateAutoWeather(auto)).toEqual(EMPTY_WEATHER_SET);
  });
  it('clears a PARTIALLY hand-corrected auto set (source manual but readings still modeled)', () => {
    // Auto-filled, then one value corrected by hand → source flips to manual but the
    // other three readings are still modeled, so hasAutoData stays true and it must clear.
    const partlyEdited: WeatherSetForm = { time: '08:00', temp_f: '70', wind_mph: '8.3', wind_direction: 'SSW', humidity_pct: '54', source: 'manual', hasAutoData: true };
    expect(invalidateAutoWeather(partlyEdited)).toEqual(EMPTY_WEATHER_SET);
  });
  it('leaves a fully hand-typed set untouched (no modeled data left)', () => {
    const manual: WeatherSetForm = { ...EMPTY_WEATHER_SET, temp_f: '70', source: 'manual' };
    expect(invalidateAutoWeather(manual)).toBe(manual);
  });
  it('leaves an empty set untouched', () => {
    expect(invalidateAutoWeather(EMPTY_WEATHER_SET)).toBe(EMPTY_WEATHER_SET);
  });
});

describe('WEATHER_DISCLAIMER', () => {
  it('states modeled-not-measured + verify on-site for compliance', () => {
    expect(WEATHER_DISCLAIMER.toLowerCase()).toContain('modeled, not measured');
    expect(WEATHER_DISCLAIMER.toLowerCase()).toContain('verify on-site');
    expect(WEATHER_DISCLAIMER.toLowerCase()).toContain('compliance');
  });
});
