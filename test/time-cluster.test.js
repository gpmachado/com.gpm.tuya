'use strict';

// Run: npm test   (plain node, no Homey needed)
//
// The app runs on the Homey, whose process zone is UTC. The Time cluster must report the zone of
// the user (homey.clock.getTimezone()), or a device that rolls its day on local time rolls it at
// UTC midnight (PORTAR_MELHORIAS_SONOFF.md, item 1).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { TimeServerBoundCluster } = require('../lib/TimeCluster');

const RealDate = Date;
function freezeClock(iso) {
  const t = new RealDate(iso).getTime();
  global.Date = class extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(t); }
    static now() { return t; }
  };
}
function unfreezeClock() { global.Date = RealDate; }

const offsetOf = zone => new TimeServerBoundCluster({ getTimeZone: () => zone }).timeZone;

// Northern summer and winter, so DST is covered.
const SUMMER = '2026-07-15T12:00:00Z';
const WINTER = '2026-01-15T12:00:00Z';
const processOffset = () => new Date().getTimezoneOffset() * -60;

try {
  freezeClock(SUMMER);
  assert.strictEqual(offsetOf('America/Sao_Paulo'), -3 * 3600, 'Sao Paulo (no DST since 2019)');
  assert.strictEqual(offsetOf('Europe/Lisbon'), 1 * 3600, 'Lisbon in summer time');
  assert.strictEqual(offsetOf('America/New_York'), -4 * 3600, 'New York in summer time');
  assert.strictEqual(offsetOf('Asia/Kolkata'), 5.5 * 3600, 'half-hour zone');

  freezeClock(WINTER);
  assert.strictEqual(offsetOf('America/Sao_Paulo'), -3 * 3600);
  assert.strictEqual(offsetOf('Europe/Lisbon'), 0, 'Lisbon in winter');
  assert.strictEqual(offsetOf('America/New_York'), -5 * 3600, 'New York in winter');

  // localTime is UTC time plus the zone, and standardTime follows it.
  freezeClock(SUMMER);
  const sp = new TimeServerBoundCluster({ getTimeZone: () => 'America/Sao_Paulo' });
  assert.strictEqual(sp.localTime - sp.time, -10800);
  assert.strictEqual(sp.standardTime, sp.localTime);

  // No zone given, or a name Intl does not know: fall back to the process zone, never throw.
  assert.strictEqual(new TimeServerBoundCluster().timeZone, processOffset(), 'no getTimeZone');
  assert.strictEqual(offsetOf(undefined), processOffset(), 'undefined zone');
  assert.strictEqual(offsetOf('Not/AZone'), processOffset(), 'invalid zone name');

  // The zone is read on every query: a zone changed in Homey settings is picked up.
  let zone = 'America/Sao_Paulo';
  const live = new TimeServerBoundCluster({ getTimeZone: () => zone });
  assert.strictEqual(live.timeZone, -10800);
  zone = 'Europe/Lisbon';
  assert.strictEqual(live.timeZone, 3600);
} finally {
  unfreezeClock();
}

// Guard: every place that creates the time server must pass the Homey zone. A new driver that
// forgets it would silently answer in UTC again.
const root = path.join(__dirname, '..');
const files = [];
for (const dir of ['lib', 'drivers']) {
  const walk = d => fs.readdirSync(path.join(root, d), { withFileTypes: true }).forEach(e => {
    const rel = path.join(d, e.name);
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith('.js') && rel !== path.join('lib', 'TimeCluster.js')) files.push(rel);
  });
  walk(dir);
}
const missing = [];
let sites = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/new (?:Sonoff)?TimeServerBoundCluster\(/g)) {
    sites += 1;
    // The constructor argument is short; 200 characters cover the multi-line form.
    if (!/getTimeZone/.test(src.slice(m.index, m.index + 200))) missing.push(f);
  }
}
assert.ok(sites >= 11, `expected at least 11 call sites, found ${sites}`);
assert.deepStrictEqual(missing, [], `these files create a time server without getTimeZone: ${missing.join(', ')}`);

console.log(`time cluster OK: zones with DST, fallback, live zone, ${sites} call sites pass the Homey zone`);
