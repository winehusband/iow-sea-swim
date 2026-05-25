const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const DEFAULT_STATION_ID = '0060'; // Cowes, Isle of Wight
const DEFAULT_STATION_IDS = [
  '0046', // Totland Bay
  '0048', // Freshwater
  '0051', // Ventnor
  '0053', // Sandown
  '0054', // Bembridge Harbour
  '0058', // Ryde
  '0060', // Cowes
];
const ADMIRALTY_BASE = 'https://admiraltyapi.azure-api.net/uktidalapi/api/V1';
const CACHE_TTL_MS = 30 * 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  body: string;
};

const cache = new Map<string, CacheEntry>();

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

function allowedStationIds() {
  return new Set(
    (Deno.env.get('ALLOWED_STATION_IDS') || DEFAULT_STATION_IDS.join(','))
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }

  const apiKey = Deno.env.get('ADMIRALTY_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'API key not configured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '3', 10), 1), 7);
  const stationId = url.searchParams.get('station') || DEFAULT_STATION_ID;

  if (!/^\d{4}$/.test(stationId)) {
    return jsonResponse({ error: 'Invalid station id' }, { status: 400 });
  }
  if (!allowedStationIds().has(stationId)) {
    return jsonResponse({ error: 'Station not allowed' }, { status: 403 });
  }

  const cacheKey = `${stationId}:${days}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return new Response(cached.body, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800',
        'X-Cache': 'HIT',
      },
    });
  }

  const admiraltyUrl = `${ADMIRALTY_BASE}/Stations/${stationId}/TidalEvents?duration=${days}`;

  try {
    const resp = await fetch(admiraltyUrl, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    });

    if (!resp.ok) {
      return jsonResponse(
        { error: `Admiralty API returned ${resp.status}` },
        { status: resp.status },
      );
    }

    const data = await resp.json();
    const body = JSON.stringify(data);
    cache.set(cacheKey, { body, expiresAt: Date.now() + CACHE_TTL_MS });
    return new Response(body, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800',
        'X-Cache': 'MISS',
      },
    });
  } catch (err) {
    return jsonResponse({ error: 'Failed to fetch tide data' }, { status: 502 });
  }
});
