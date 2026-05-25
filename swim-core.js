(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SwimCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_THRESHOLDS = {
    high: 3.8,
    inlet: 2.15,
    low: 1.55,
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function createRatingModel(thresholds) {
    const limits = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
    const HIGH = Number(limits.high);
    const INLET = Number(limits.inlet);
    const LOW = Number(limits.low);

    function stars(height, rate) {
      if (height <= LOW) return 0;

      let score;
      if (height >= HIGH) {
        score = 5;
      } else if (height >= INLET) {
        const x = (height - INLET) / (HIGH - INLET);
        score = 3.2 + 1.8 * Math.pow(x, 0.8);
      } else {
        const x = (height - LOW) / (INLET - LOW);
        score = 1.1 + 2.1 * Math.pow(x, 0.9);
      }

      if (rate < -0.05 && score > 3.2) {
        score -= 0.45;
      } else if (rate > 0.05 && score >= 2.5) {
        score += 0.25;
      }

      return clamp(score, 0, 5);
    }

    function verdict(score, isRising) {
      if (score < 1) {
        return {
          text: 'Too Shallow',
          desc: isRising ? 'Tide is rising, but there is still a long wade to deeper water.' : 'Low water - poor swim depth close to shore.',
        };
      }
      if (score < 2.8) {
        if (isRising) return { text: 'Depth Building', desc: 'Better later as the tide fills in.' };
        return { text: 'Getting Shallow', desc: 'Swim depth is dropping away from the beach.' };
      }
      if (score < 3.8) {
        if (isRising) return { text: 'Swimmable Soon', desc: 'Usable depth is coming in; high tide will be better.' };
        return { text: 'Usable, Dropping', desc: 'Still swimmable, but the tide is heading out.' };
      }
      if (score < 4.6) {
        if (isRising) return { text: 'Good Swim Tide', desc: 'Good depth now, with more water still coming in.' };
        return { text: 'Good Swim Tide', desc: 'Good depth now, but it will slowly shallow.' };
      }
      return { text: 'Best Around High Tide', desc: 'Best tide depth for an easier shore swim.' };
    }

    return { stars, verdict, thresholds: { high: HIGH, inlet: INLET, low: LOW } };
  }

  function parseEventMs(dateTime) {
    if (!dateTime) return NaN;
    return /[Zz]$|[+-]\d{2}:\d{2}$/.test(dateTime)
      ? new Date(dateTime).getTime()
      : new Date(dateTime + 'Z').getTime();
  }

  function eventKind(event) {
    const raw = String(event && event.EventType || '').toLowerCase();
    if (raw.includes('low')) return 'low';
    if (raw.includes('high')) return 'high';
    return raw;
  }

  function eventTime(event) {
    return new Date(parseEventMs(event.DateTime));
  }

  function eventHeight(event) {
    return Number(event.Height);
  }

  function apiHeight(events, date) {
    if (!Array.isArray(events) || events.length < 2) return null;
    const t = date.getTime();
    const sorted = [...events].sort((a, b) => parseEventMs(a.DateTime) - parseEventMs(b.DateTime));

    for (let i = 0; i < sorted.length - 1; i++) {
      const t0 = parseEventMs(sorted[i].DateTime);
      const t1 = parseEventMs(sorted[i + 1].DateTime);
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) continue;
      if (t >= t0 && t <= t1) {
        const h0 = eventHeight(sorted[i]);
        const h1 = eventHeight(sorted[i + 1]);
        if (!Number.isFinite(h0) || !Number.isFinite(h1)) return null;
        const frac = (t - t0) / (t1 - t0);
        return (h0 + h1) / 2 + (h0 - h1) / 2 * Math.cos(Math.PI * frac);
      }
    }

    return null;
  }

  function nextApiEvent(events, fromDate, type) {
    if (!Array.isArray(events)) return null;
    const fromMs = fromDate.getTime();
    const matches = events
      .filter((event) => eventKind(event) === type && parseEventMs(event.DateTime) > fromMs)
      .sort((a, b) => parseEventMs(a.DateTime) - parseEventMs(b.DateTime));

    if (matches.length === 0) return null;
    const event = matches[0];
    return {
      type,
      time: eventTime(event),
      height: eventHeight(event),
      source: 'api',
    };
  }

  function findSwimWindow(fromDate, maxHoursAhead, tideHeight, tideRate, ratingModel) {
    const ENTRY_STARS = 3.6;
    const EXIT_STARS = 3.0;
    const step = 5 * 60000;
    const startMs = fromDate.getTime();
    const endMs = startMs + (maxHoursAhead || 24) * 3600000;

    const currentH = tideHeight(fromDate);
    const currentR = tideRate(fromDate);
    const currentStars = ratingModel.stars(currentH, currentR);
    const insideNow = currentStars >= ENTRY_STARS;

    let windowStart = insideNow ? fromDate : null;
    let windowEnd = null;
    let peakTime = insideNow ? fromDate : null;
    let peakStars = insideNow ? currentStars : 0;

    for (let t = startMs + step; t < endMs; t += step) {
      const d = new Date(t);
      const h = tideHeight(d);
      const r = tideRate(d);
      const score = ratingModel.stars(h, r);

      if (!windowStart) {
        if (score >= ENTRY_STARS) {
          windowStart = d;
          peakTime = d;
          peakStars = score;
        }
      } else {
        if (score > peakStars) {
          peakStars = score;
          peakTime = d;
        }
        if (score < EXIT_STARS) {
          windowEnd = d;
          break;
        }
      }
    }

    if (!windowStart) return null;
    if (!windowEnd) windowEnd = new Date(endMs);

    return { start: windowStart, end: windowEnd, peakTime, peakStars, currentlyInside: insideNow };
  }

  function normalizeBeachConfig(config, requestedId) {
    return selectBeachConfig(config, requestedId).beach;
  }

  function normalizeBeachEntry(beach) {
    if (!beach.stationId || !beach.coordinates) {
      throw new Error('Beach config is missing station or coordinates');
    }
    return {
      ...beach,
      thresholds: { ...DEFAULT_THRESHOLDS, ...(beach.thresholds || {}) },
      copy: { ...(beach.copy || {}) },
      confidence: { ...(beach.confidence || {}) },
    };
  }

  function normalizeBeachCatalog(config) {
    if (!config || !Array.isArray(config.beaches) || config.beaches.length === 0) {
      throw new Error('No beaches configured');
    }
    return {
      ...config,
      defaultBeachId: config.defaultBeachId || config.beaches[0].id,
      beaches: config.beaches.map(normalizeBeachEntry),
      sources: Array.isArray(config.sources) ? config.sources : [],
    };
  }

  function findBeachById(catalog, id) {
    if (!id) return null;
    return catalog.beaches.find((item) => item.id === id) || null;
  }

  function selectBeachConfig(config, requestedId, savedDefaultId) {
    const catalog = normalizeBeachCatalog(config);
    const candidates = [
      { id: requestedId, source: 'url' },
      { id: savedDefaultId, source: 'saved' },
      { id: catalog.defaultBeachId, source: 'config' },
    ];

    for (const candidate of candidates) {
      const beach = findBeachById(catalog, candidate.id);
      if (beach) {
        return {
          catalog,
          beach,
          source: candidate.source,
          invalidRequested: Boolean(requestedId && !findBeachById(catalog, requestedId)),
        };
      }
    }

    return {
      catalog,
      beach: catalog.beaches[0],
      source: 'fallback',
      invalidRequested: Boolean(requestedId),
    };
  }

  return {
    DEFAULT_THRESHOLDS,
    createRatingModel,
    parseEventMs,
    apiHeight,
    nextApiEvent,
    findSwimWindow,
    normalizeBeachCatalog,
    normalizeBeachConfig,
    selectBeachConfig,
  };
});
