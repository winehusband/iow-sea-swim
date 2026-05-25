const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const EA_BASE = 'https://environment.data.gov.uk';
const CACHE_TTL_MS = 30 * 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  body: string;
  status: number;
};

type LinkedValue = {
  _about?: string;
  _value?: string;
  label?: unknown;
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

function cacheResponse(cacheKey: string, body: unknown, status = 200, ttlMs = CACHE_TTL_MS) {
  const encoded = JSON.stringify(body);
  cache.set(cacheKey, {
    body: encoded,
    status,
    expiresAt: Date.now() + ttlMs,
  });
  return new Response(encoded, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800',
      'X-Cache': 'MISS',
    },
  });
}

function labelOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const label = labelOf(item);
      if (label) return label;
    }
    return null;
  }
  if (typeof value === 'object') {
    const linked = value as LinkedValue;
    if (typeof linked._value === 'string') return linked._value;
    return labelOf(linked.label);
  }
  return null;
}

function valueOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const linked = value as LinkedValue;
    if (typeof linked._value === 'string') return linked._value;
    if (typeof linked._about === 'string') return linked._about;
  }
  return null;
}

function aboutOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof (value as LinkedValue)._about === 'string') {
    return (value as LinkedValue)._about || null;
  }
  return null;
}

function endpointForResource(resource: string | null): string | null {
  if (!resource) return null;
  let url: URL;
  try {
    url = new URL(resource);
  } catch (_e) {
    return null;
  }
  if (url.hostname !== 'environment.data.gov.uk') return null;
  if (!url.pathname.endsWith('.json')) url.pathname += '.json';
  url.protocol = 'https:';
  url.search = '_view=all';
  return url.toString();
}

async function fetchEaJson(url: string | null) {
  if (!url) return null;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) return null;
  return await resp.json();
}

function parseSampleDate(value: unknown): string | null {
  const raw = valueOf(value);
  if (!raw) return null;
  const match = raw.match(/(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  if (!match) return null;
  return match[2] ? `${match[1]}T${match[2]}:00` : match[1];
}

function parseClassification(complianceTopic: Record<string, unknown> | null) {
  if (!complianceTopic) return null;
  const finalSampleDate = valueOf(complianceTopic.finalSampleDate);
  const firstSampleDate = valueOf(complianceTopic.firstSampleDate);
  const classification = labelOf(complianceTopic.complianceClassification);
  const yearLabel = labelOf(complianceTopic.sampleYear);
  const yearMatch = yearLabel?.match(/(\d{4})/);
  return {
    year: yearMatch ? yearMatch[1] : null,
    classification,
    firstSampleDate,
    finalSampleDate,
  };
}

function parseSample(sampleTopic: Record<string, unknown> | null) {
  if (!sampleTopic) return null;
  return {
    dateTime: parseSampleDate(sampleTopic.sampleDateTime),
    recordDate: valueOf(sampleTopic.recordDate),
    eColi: typeof sampleTopic.escherichiaColiCount === 'number'
      ? sampleTopic.escherichiaColiCount
      : null,
    eColiQualifier: labelOf(sampleTopic.escherichiaColiQualifier),
    intestinalEnterococci: typeof sampleTopic.intestinalEnterococciCount === 'number'
      ? sampleTopic.intestinalEnterococciCount
      : null,
    intestinalEnterococciQualifier: labelOf(sampleTopic.intestinalEnterococciQualifier),
  };
}

function parseRisk(riskTopic: Record<string, unknown> | null) {
  if (!riskTopic) return null;
  const level = labelOf(riskTopic.riskLevel);
  const comment = labelOf(riskTopic.comment);
  const normal = (level || '').toLowerCase() === 'normal';
  return {
    level,
    comment,
    predictedAt: valueOf(riskTopic.predictedAt),
    publishedAt: valueOf(riskTopic.publishedAt),
    expiresAt: valueOf(riskTopic.expiresAt),
    activeWarning: Boolean(level && !normal),
  };
}

function classifyStatus(
  risk: ReturnType<typeof parseRisk>,
  compliance: ReturnType<typeof parseClassification>,
) {
  const classification = (compliance?.classification || '').toLowerCase();

  if (risk?.activeWarning) {
    return {
      level: 'warning',
      label: 'EA pollution warning',
      message: risk.comment || 'The Environment Agency has a current short-term pollution risk warning here.',
    };
  }

  if (classification === 'poor') {
    return {
      level: 'warning',
      label: 'Poor annual rating',
      message: 'This bathing water has a Poor annual EA classification. Treat it as advice against bathing unless local guidance says otherwise.',
    };
  }

  if (risk?.level) {
    return {
      level: 'good',
      label: 'No current EA warning',
      message: 'EA short-term pollution forecast has no warning for this bathing water.',
    };
  }

  return {
    level: 'unknown',
    label: 'No live EA forecast',
    message: 'No current EA short-term forecast was available for this bathing water.',
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
  const eubwid = url.searchParams.get('eubwid') || '';
  if (!/^[a-z0-9-]+$/i.test(eubwid)) {
    return jsonResponse({ error: 'Invalid bathing water ID' }, { status: 400 });
  }

  const cacheKey = eubwid.toLowerCase();
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

  const profileUrl = `${EA_BASE}/doc/bathing-water/${encodeURIComponent(eubwid)}.json?_view=all`;
  const profileJson = await fetchEaJson(profileUrl).catch(() => null);
  const profile = profileJson?.result?.primaryTopic as Record<string, unknown> | undefined;
  if (!profile) {
    return cacheResponse(cacheKey, { error: 'Bathing water not found' }, 404, 5 * 60 * 1000);
  }

  const complianceUrl = endpointForResource(aboutOf(profile.latestComplianceAssessment));
  const sampleUrl = endpointForResource(aboutOf(profile.latestSampleAssessment));
  const riskUrl = endpointForResource(aboutOf(profile.latestRiskPrediction));

  const [complianceJson, sampleJson, riskJson] = await Promise.all([
    fetchEaJson(complianceUrl).catch(() => null),
    fetchEaJson(sampleUrl).catch(() => null),
    fetchEaJson(riskUrl).catch(() => null),
  ]);

  const compliance = parseClassification(complianceJson?.result?.primaryTopic || null);
  const sample = parseSample(sampleJson?.result?.primaryTopic || null);
  const risk = parseRisk(riskJson?.result?.primaryTopic || null);
  const impactedByHeavyRain = profile.waterQualityImpactedByHeavyRain === true;
  const status = classifyStatus(risk, compliance);

  return cacheResponse(cacheKey, {
    source: {
      name: 'Environment Agency bathing-water data',
      url: 'https://environment.data.gov.uk/bwq/profiles/',
    },
    bathingWater: {
      id: eubwid,
      name: labelOf(profile.label) || valueOf(profile.name) || eubwid,
      samplingPoint: labelOf(profile.samplingPoint),
    },
    status,
    risk,
    compliance,
    sample,
    impactedByHeavyRain,
    updatedAt: new Date().toISOString(),
  });
});
