const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const OPEN_METEO_BASE = 'https://marine-api.open-meteo.com/v1/marine';
const CCO_BASE = 'https://coastalmonitoring.org/observations/waves/latest.geojson';
const CCO_DEV_API_KEY = '6cefd36d8e12a4dead4cf06d4dbd09c0';
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CCO_AGE_MS = 6 * 60 * 60 * 1000;
const CALIBRATION_VERSION = '2026-05-25-gurnard-v1';

type CacheEntry = {
  expiresAt: number;
  body: string;
  status: number;
};

type MarineModel = {
  temperatureC: number;
  time: string;
  grid: {
    latitude: number;
    longitude: number;
  };
};

type CcoObservation = {
  sensor: string;
  temperatureC: number;
  time: string;
  ageMinutes: number;
  coordinates: {
    latitude: number;
    longitude: number;
  } | null;
};

type LocalCalibrationReading = {
  time: string;
  temperatureC: number;
};

type LocalCalibration = {
  label: string;
  timezone: string;
  readings: LocalCalibrationReading[];
};

type CalibrationResult = {
  source: string;
  correctionC: number;
  observationCount: number;
  modelledTemperatureC: number;
  adjustedTemperatureC: number;
  latestObservation: LocalCalibrationReading;
  comparisons: {
    time: string;
    observedC: number;
    modelledC: number;
    deltaC: number;
  }[];
};

const cache = new Map<string, CacheEntry>();
const LOCAL_CALIBRATIONS_BY_BEACH_ID: Record<string, LocalCalibration> = {
  gurnard: {
    label: 'Gurnard local swimmer readings',
    timezone: 'Europe/London',
    readings: [
      { time: '2026-05-23T08:00', temperatureC: 14 },
      { time: '2026-05-24T08:00', temperatureC: 14 },
      { time: '2026-05-25T08:00', temperatureC: 15 },
    ],
  },
};

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

function validCoordinate(value: number, min: number, max: number) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function parseNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCcoTimestamp(value: unknown) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})#(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
}

async function fetchOpenMeteo(latitude: number, longitude: number): Promise<MarineModel | null> {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'sea_surface_temperature',
    forecast_days: '1',
    timezone: 'auto',
    cell_selection: 'sea',
  });
  const resp = await fetch(`${OPEN_METEO_BASE}?${params.toString()}`);
  if (!resp.ok) return null;

  const data = await resp.json();
  const temperatureC = parseNumber(data?.current?.sea_surface_temperature);
  const time = typeof data?.current?.time === 'string' ? data.current.time : null;
  const gridLatitude = parseNumber(data?.latitude);
  const gridLongitude = parseNumber(data?.longitude);
  if (temperatureC === null || !time || gridLatitude === null || gridLongitude === null) {
    return null;
  }

  return {
    temperatureC,
    time,
    grid: {
      latitude: gridLatitude,
      longitude: gridLongitude,
    },
  };
}

async function fetchLocalCalibration(
  beachId: string,
  latitude: number,
  longitude: number,
  modelled: MarineModel,
): Promise<CalibrationResult | null> {
  const calibration = LOCAL_CALIBRATIONS_BY_BEACH_ID[beachId];
  if (!calibration || calibration.readings.length < 2) return null;

  const dates = calibration.readings.map((reading) => reading.time.slice(0, 10)).sort();
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: 'sea_surface_temperature',
    start_date: dates[0],
    end_date: dates[dates.length - 1],
    timezone: calibration.timezone,
    cell_selection: 'sea',
  });
  const resp = await fetch(`${OPEN_METEO_BASE}?${params.toString()}`);
  if (!resp.ok) return null;

  const data = await resp.json();
  const times = Array.isArray(data?.hourly?.time) ? data.hourly.time : [];
  const temperatures = Array.isArray(data?.hourly?.sea_surface_temperature)
    ? data.hourly.sea_surface_temperature
    : [];
  const modelByTime = new Map<string, number>();
  times.forEach((time: unknown, index: number) => {
    if (typeof time !== 'string') return;
    const temperatureC = parseNumber(temperatures[index]);
    if (temperatureC !== null) modelByTime.set(time, temperatureC);
  });

  const comparisons = calibration.readings
    .map((reading) => {
      const modelledC = modelByTime.get(reading.time);
      if (typeof modelledC !== 'number') return null;
      const deltaC = reading.temperatureC - modelledC;
      return {
        time: reading.time,
        observedC: reading.temperatureC,
        modelledC,
        deltaC: Math.round(deltaC * 10) / 10,
      };
    })
    .filter((comparison): comparison is CalibrationResult['comparisons'][number] => comparison !== null);

  if (comparisons.length < 2) return null;

  const averageDelta = comparisons.reduce((sum, comparison) => sum + comparison.deltaC, 0) / comparisons.length;
  const correctionC = Math.round(averageDelta * 10) / 10;
  const adjustedTemperatureC = Math.round((modelled.temperatureC + correctionC) * 10) / 10;
  const latestObservation = [...calibration.readings].sort((a, b) => a.time.localeCompare(b.time)).at(-1);
  if (!latestObservation) return null;

  return {
    source: calibration.label,
    correctionC,
    observationCount: comparisons.length,
    modelledTemperatureC: modelled.temperatureC,
    adjustedTemperatureC,
    latestObservation,
    comparisons,
  };
}

async function fetchCcoObservation(sensor: string): Promise<CcoObservation | null> {
  const apiKey = Deno.env.get('CCO_API_KEY') || CCO_DEV_API_KEY;
  const referer = Deno.env.get('CCO_REFERER') || 'https://coastalmonitoring.org';
  const params = new URLSearchParams({
    key: apiKey,
    sensor,
  });
  const resp = await fetch(`${CCO_BASE}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      Referer: referer,
    },
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  const feature = Array.isArray(data?.features) ? data.features[0] : null;
  const properties = feature?.properties;
  const temperatureC = parseNumber(properties?.sst);
  const observedAt = parseCcoTimestamp(properties?.date);
  if (temperatureC === null || !observedAt) return null;

  const ageMs = Date.now() - observedAt.getTime();
  if (ageMs < 0 || ageMs > MAX_CCO_AGE_MS) return null;

  const coords = Array.isArray(feature?.geometry?.coordinates)
    ? feature.geometry.coordinates
    : null;
  const lon = coords ? parseNumber(coords[0]) : null;
  const lat = coords ? parseNumber(coords[1]) : null;

  return {
    sensor: typeof properties?.sensor === 'string' ? properties.sensor : sensor,
    temperatureC,
    time: observedAt.toISOString(),
    ageMinutes: Math.round(ageMs / 60000),
    coordinates: lat !== null && lon !== null ? { latitude: lat, longitude: lon } : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }

  const url = new URL(req.url);
  const latitude = Number(url.searchParams.get('latitude'));
  const longitude = Number(url.searchParams.get('longitude'));
  const ccoSensor = url.searchParams.get('ccoSensor') || '';
  const beachId = (url.searchParams.get('beachId') || '').trim().toLowerCase();

  if (!validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180)) {
    return jsonResponse({ error: 'Invalid coordinates' }, { status: 400 });
  }

  const cacheKey = `${latitude.toFixed(4)}:${longitude.toFixed(4)}:${ccoSensor}:${beachId}:${CALIBRATION_VERSION}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return new Response(cached.body, {
      status: cached.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800',
        'X-Cache': 'HIT',
      },
    });
  }

  const [modelled, observed] = await Promise.all([
    fetchOpenMeteo(latitude, longitude).catch(() => null),
    ccoSensor ? fetchCcoObservation(ccoSensor).catch(() => null) : Promise.resolve(null),
  ]);
  const calibration = !observed && modelled
    ? await fetchLocalCalibration(beachId, latitude, longitude, modelled).catch(() => null)
    : null;

  if (!modelled && !observed) {
    const body = JSON.stringify({ error: 'Failed to fetch water temperature data' });
    cache.set(cacheKey, { body, status: 502, expiresAt: Date.now() + 5 * 60 * 1000 });
    return new Response(body, {
      status: 502,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'X-Cache': 'MISS',
      },
    });
  }

  const primaryTemperature = observed
    ? observed.temperatureC
    : calibration?.adjustedTemperatureC ?? modelled?.temperatureC;
  const body = JSON.stringify({
    temperatureC: primaryTemperature,
    source: observed ? 'observed' : calibration ? 'calibrated' : 'modelled',
    label: observed
      ? `Observed nearby at ${observed.sensor}`
      : calibration
        ? 'Local-calibrated sea temperature'
      : 'Modelled sea surface temperature',
    observed,
    modelled,
    calibration,
  });
  cache.set(cacheKey, { body, status: 200, expiresAt: Date.now() + CACHE_TTL_MS });

  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800',
      'X-Cache': 'MISS',
    },
  });
});
