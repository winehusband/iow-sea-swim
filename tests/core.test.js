const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../swim-core.js');

test('swim rating model prefers high tide over low tide', () => {
  const rating = core.createRatingModel({ high: 3.8, inlet: 2.15, low: 1.55 });

  assert.equal(rating.stars(1.55, -0.1), 0);
  assert.equal(rating.stars(3.8, -0.1), 4.55);
  assert.ok(rating.stars(3.8, 0.1) > rating.stars(1.8, 0.1));
  assert.ok(rating.stars(2.2, 0.1) >= 3.0);
});

test('swim rating slightly prefers filling tide over dropping tide', () => {
  const rating = core.createRatingModel({ high: 3.8, inlet: 2.15, low: 1.55 });

  const falling = rating.stars(3.2, -0.2);
  const rising = rating.stars(3.2, 0.2);

  assert.ok(rising > falling);
  assert.ok(rising >= 3.0);
});

test('Admiralty event parsing treats timestamps without Z as UTC', () => {
  assert.equal(
    core.parseEventMs('2026-05-20T06:40:00'),
    Date.UTC(2026, 4, 20, 6, 40, 0),
  );
});

test('apiHeight interpolates between consecutive high and low water events', () => {
  const events = [
    { EventType: 'HighWater', DateTime: '2026-05-20T00:00:00', Height: 4 },
    { EventType: 'LowWater', DateTime: '2026-05-20T06:00:00', Height: 1 },
  ];

  assert.equal(core.apiHeight(events, new Date('2026-05-20T00:00:00Z')), 4);
  assert.equal(core.apiHeight(events, new Date('2026-05-20T06:00:00Z')), 1);
  assert.equal(core.apiHeight(events, new Date('2026-05-20T03:00:00Z')), 2.5);
});

test('nextApiEvent selects the next matching high or low event', () => {
  const events = [
    { EventType: 'HighWater', DateTime: '2026-05-20T00:00:00', Height: 4.2 },
    { EventType: 'LowWater', DateTime: '2026-05-20T06:00:00', Height: 0.8 },
    { EventType: 'HighWater', DateTime: '2026-05-20T12:00:00', Height: 4.1 },
  ];

  const from = new Date('2026-05-20T01:00:00Z');
  assert.equal(core.nextApiEvent(events, from, 'low').time.toISOString(), '2026-05-20T06:00:00.000Z');
  assert.equal(core.nextApiEvent(events, from, 'high').time.toISOString(), '2026-05-20T12:00:00.000Z');
});

test('beach config normalizes and selects requested beaches', () => {
  const configPath = path.join(__dirname, '..', 'beaches.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const beach = core.normalizeBeachConfig(config, 'gurnard');

  assert.equal(beach.id, 'gurnard');
  assert.equal(beach.stationId, '0060');
  assert.equal(beach.thresholds.inlet, 2.15);
  assert.equal(typeof beach.coordinates.latitude, 'number');
});

test('beach catalog contains the Isle of Wight swim rollout set', () => {
  const configPath = path.join(__dirname, '..', 'beaches.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const catalog = core.normalizeBeachCatalog(config);
  const stationIds = new Set(catalog.beaches.map((beach) => beach.stationId));

  assert.equal(catalog.beaches.length, 21);
  assert.ok(stationIds.has('0060'));
  assert.ok(stationIds.has('0058'));
  assert.ok(stationIds.has('0053'));
  assert.ok(stationIds.has('0046'));

  for (const beach of catalog.beaches) {
    assert.equal(typeof beach.id, 'string');
    assert.equal(typeof beach.name, 'string');
    assert.equal(typeof beach.coordinates.latitude, 'number');
    assert.equal(typeof beach.coordinates.longitude, 'number');
    assert.equal(typeof beach.confidence.thresholds, 'string');
  }
});

test('tide proxy default allowlist covers every configured station', () => {
  const configPath = path.join(__dirname, '..', 'beaches.json');
  const proxyPath = path.join(__dirname, '..', 'supabase', 'functions', 'tide-proxy', 'index.ts');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const proxySource = fs.readFileSync(proxyPath, 'utf8');
  const stationIds = new Set(config.beaches.map((beach) => beach.stationId));

  for (const stationId of stationIds) {
    assert.ok(proxySource.includes(`'${stationId}'`), `missing proxy station ${stationId}`);
  }
});

test('beach selection prefers URL, then saved default, then config default', () => {
  const config = {
    defaultBeachId: 'gurnard',
    beaches: [
      { id: 'gurnard', stationId: '0060', coordinates: { latitude: 1, longitude: 1 } },
      { id: 'totland-bay', stationId: '0046', coordinates: { latitude: 2, longitude: 2 } },
      { id: 'ryde-west', stationId: '0058', coordinates: { latitude: 3, longitude: 3 } },
    ],
  };

  assert.equal(core.selectBeachConfig(config, 'ryde-west', 'totland-bay').beach.id, 'ryde-west');
  assert.equal(core.selectBeachConfig(config, null, 'totland-bay').beach.id, 'totland-bay');
  assert.equal(core.selectBeachConfig(config, null, null).beach.id, 'gurnard');

  const invalid = core.selectBeachConfig(config, 'missing', 'totland-bay');
  assert.equal(invalid.beach.id, 'totland-bay');
  assert.equal(invalid.invalidRequested, true);
});

test('findSwimWindow returns the current window when tide depth is already good', () => {
  const rating = core.createRatingModel({ high: 3.8, inlet: 2.15, low: 1.55 });
  const start = new Date('2026-05-20T10:00:00Z');

  const window = core.findSwimWindow(
    start,
    2,
    () => 3.7,
    () => 0.1,
    rating,
  );

  assert.equal(window.currentlyInside, true);
  assert.equal(window.start, start);
  assert.ok(window.peakStars >= 4);
});
