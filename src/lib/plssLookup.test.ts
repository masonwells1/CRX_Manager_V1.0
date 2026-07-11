import { describe, expect, it, vi } from 'vitest';
import { lookupPlss, parsePlssLookup, PlssLookupError } from './plssLookup';

const townshipResponse = {
  features: [{ attributes: {
    STATEABBR: 'IL',
    COUNTY: 'Sangamon',
    TWNSHPNO: '008',
    TWNSHPDIR: 'N',
    RANGENO: '012',
    RANGEDIR: 'W',
  } }],
};

const sectionResponse = {
  features: [{ attributes: { FRSTDIVNO: '17' } }],
};

describe('plssLookup', () => {
  it('looks up both BLM layers and builds a readable legal description', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(townshipResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sectionResponse), { status: 200 }));

    await expect(lookupPlss({ longitude: -89.4, latitude: 40 }, fetchMock)).resolves.toEqual({
      legalDescription: 'Sec 17, T08N R12W',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/1/query?');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/2/query?');
  });

  it('reports an eight-second abort as an unavailable lookup', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const lookup = lookupPlss({ longitude: -89.4, latitude: 40 }, fetchMock);
    const timedOut = expect(lookup).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(8_000);
    await timedOut;
    vi.useRealTimers();
  });

  it('fails readably when BLM changes the expected layer schema', () => {
    expect(() => parsePlssLookup(
      { features: [{ attributes: { TOWNSHIP_LABEL: '08N 12W' } }] },
      { features: [{ attributes: { DIVISION: '17' } }] },
    )).toThrow(PlssLookupError);
  });
});
