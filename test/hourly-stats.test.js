'use strict';

// Run: npm test   (plain node, no Homey needed)
//
// Traffic counters of the settings page: current hour, previous hour, a 24 h window, reset.
// The page reads exactly these four fields (settings/index.html); the test pins that shape.

const assert = require('assert');
const { HourlyMessageStats } = require('../lib/HourlyMessageStats');

const HOUR = 60 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 12, 10, 30, 0);   // 10:30 UTC, mid-hour on purpose

const s = new HourlyMessageStats();
assert.deepStrictEqual(Object.keys(s.summary(t0)).sort(), ['currentHour', 'lastMessageAt', 'last24h', 'previousHour'].sort());
assert.deepStrictEqual(s.summary(t0), { currentHour: 0, previousHour: 0, last24h: 0, lastMessageAt: null }, 'starts empty');

s.record(t0); s.record(t0 + 5 * 60 * 1000); s.record(t0 + 10 * 60 * 1000);          // all inside the 10:00 hour
assert.deepStrictEqual(s.summary(t0 + 10 * 60 * 1000), { currentHour: 3, previousHour: 0, last24h: 3, lastMessageAt: t0 + 10 * 60 * 1000 });

// Next clock hour: the three become the previous hour, and a new frame is the current one.
s.record(t0 + HOUR);
const next = s.summary(t0 + HOUR);
assert.strictEqual(next.currentHour, 1);
assert.strictEqual(next.previousHour, 3);
assert.strictEqual(next.last24h, 4);

// 24 h window: hour 0 is still inside after 23 h, outside after 24 h.
assert.strictEqual(s.summary(t0 + 23 * HOUR).last24h, 4, 'still inside after 23 h');
assert.strictEqual(s.summary(t0 + 24 * HOUR).last24h, 1, 'the 10:00 hour fell out after 24 h');
assert.strictEqual(s.summary(t0 + 25 * HOUR).last24h, 0, 'everything older than the window is gone');

// Pruning also happens while recording, so the counters never grow past 24 hours.
const long = new HourlyMessageStats();
for (let h = 0; h < 100; h++) long.record(t0 + h * HOUR);
assert.ok(Object.keys(long.buckets).length <= 24, 'at most 24 buckets are kept');
assert.strictEqual(long.summary(t0 + 99 * HOUR).last24h, 24);

// record() with no argument uses the clock (what the availability hooks do).
const live = new HourlyMessageStats();
live.record();
assert.strictEqual(live.summary().currentHour, 1);
assert.ok(Number.isFinite(live.lastMessageAt));

live.reset();
assert.deepStrictEqual(live.summary(), { currentHour: 0, previousHour: 0, last24h: 0, lastMessageAt: null }, 'reset clears everything');

console.log('hourly stats OK: window, previous hour, pruning, reset, and the four fields the page reads');
