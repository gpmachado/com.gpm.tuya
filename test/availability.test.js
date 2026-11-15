'use strict';

// Run: npm test   (plain node, no Homey needed)
//
// lib/availability.js against a fake device, node and clock: the three signals (seen, silent,
// unreachable), the boot grace, the global switch, the Tuya transition effects (is_availability
// order, flow cards), the four traffic fields the settings page reads, callback mode, a failed
// install returning null, and uninstall putting the node back as it was.

const assert = require('assert');
const availability = require('../lib/availability');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let now = Date.UTC(2026, 10, 15, 10, 30, 0);
Date.now = () => now;

const settings = new Map();
let interval = null;
const homey = {
  settings: { get: k => settings.get(k) },
  setInterval: fn => { interval = fn; return 1; },
  clearInterval: () => { interval = null; },
  clock: { getTimezone: () => 'America/Sao_Paulo' },
  flow: {
    getDeviceTriggerCard: id => {
      if (!id.startsWith('relay_')) throw new Error(`Invalid Flow Card ID: ${id}`);
      return { trigger: async (dev, tokens) => events.push(`flow:${id.endsWith('_on') ? 'on' : 'off'}:${tokens.device_name}`) };
    },
  },
  zigbee: { getNode: async dev => dev._node },
};

let events = [];
const advance = ms => { now += ms; interval?.(); };

function fakeDevice({ name = 'Relay', withCapability = true, sendFails = false, driverId = 'relay' } = {}) {
  const sent = [];
  const zclNode = {
    sendFrame: async (...args) => {
      sent.push(args);
      if (dev._sendFails) throw new Error('Could not reach device. Is it powered on?');
    },
  };
  const node = { handleFrame: () => 'original' };
  const caps = withCapability ? { is_availability: null } : {};
  const dev = {
    homey, zclNode, _node: node, _sent: sent, _sendFails: sendFails,
    _available: true, logs: [], errors: [],
    driver: { id: driverId, getDevices: () => [dev] },
    getName: () => name,
    getData: () => ({}),
    log: (...a) => dev.logs.push(a.join(' ')),
    error: (...a) => dev.errors.push(a.join(' ')),
    getAvailable: () => dev._available,
    setAvailable: async () => { dev._available = true; events.push('setAvailable'); },
    setUnavailable: async r => { dev._available = false; events.push(`setUnavailable:${r}`); },
    _origSend: zclNode.sendFrame,
    hasCapability: c => c in caps,
    getCapabilityValue: c => caps[c],
    setCapabilityValue: async (c, v) => { caps[c] = v; events.push(`${c}=${v}`); },
  };
  return dev;
}

const frame = (dev, cl = 6) => dev._node.handleFrame(1, cl, Buffer.from('18010a0000', 'hex'), {});
const settle = () => new Promise(r => setImmediate(r));

(async () => {
  // -- install, seed, frame hook ---------------------------------------------------------------
  const dev = fakeDevice();
  const m = await availability.install(dev, { timeout: 25 * MIN });
  assert.ok(m, 'installs');
  assert.ok(dev.logs.some(l => l.includes('[Availability] Monitoring enabled (passive)')), 'log line check-log.js looks for');
  await settle();
  assert.strictEqual(dev.getCapabilityValue('is_availability'), true, 'never-set capability seeded true');
  assert.strictEqual(frame(dev), 'original', 'the original handleFrame still runs');

  // -- signal 2: silence, only after the boot grace --------------------------------------------
  events = [];
  advance(4 * MIN);
  advance(26 * MIN);   // 30 min silent, past the 5 min grace
  await settle();
  assert.deepStrictEqual(events, ['is_availability=false', 'setUnavailable:No activity for 30min', 'flow:off:Relay'],
    'capability false BEFORE setUnavailable, flow after');

  // -- signal 1: a frame restores --------------------------------------------------------------
  events = [];
  frame(dev);
  await settle();
  assert.deepStrictEqual(events, ['setAvailable', 'is_availability=true', 'flow:on:Relay'], 'restore: available, capability, flow');
  assert.ok(dev.logs.some(l => l.includes('[Availability] Restoring (ep1 cl:0x6)')));

  // A caller's restore sets the baseline: the next tick must not undo it.
  await m.markUnavailable('test');
  await m.markAvailable();
  events = [];
  advance(MIN);
  await settle();
  assert.deepStrictEqual(events, [], 'restore by a caller is not undone by the next tick');

  // -- signal 3: five failed sends in a row; a frame in between resets the count ---------------
  dev._sendFails = true;
  for (let i = 0; i < 4; i++) await dev.zclNode.sendFrame(1, 6, Buffer.alloc(3)).catch(() => {});
  frame(dev);
  await settle();
  events = [];
  for (let i = 0; i < 4; i++) await dev.zclNode.sendFrame(1, 6, Buffer.alloc(3)).catch(() => {});
  assert.deepStrictEqual(events, [], 'a frame reset the count: 4 more failures are not 5');
  await dev.zclNode.sendFrame(1, 6, Buffer.alloc(3)).catch(() => {});
  await settle();
  assert.ok(events.includes('setUnavailable:No response to commands'), 'fifth failure in a row');
  assert.ok(dev.logs.some(l => /\[Availability\] Send failed \(5\/5\)/.test(l)), 'log line check-log.js looks for');
  const timeoutErr = new Error('Timeout: Expected Response');
  dev._sendFails = false;
  frame(dev);
  await settle();
  m._onSendFailure(timeoutErr);
  assert.ok(dev.logs.some(l => l.includes('Send failed (1/5): Timeout')), 'a timeout counts as a failed send');
  m._onSendFailure(new Error('UNSUPPORTED_ATTRIBUTE'));
  assert.ok(!dev.logs.some(l => l.includes('UNSUPPORTED_ATTRIBUTE')), 'other errors do not count');

  // -- global switch ---------------------------------------------------------------------------
  settings.set('availability_enabled', false);
  events = [];
  advance(60 * MIN);
  await m.markUnavailable('forced');
  await settle();
  assert.deepStrictEqual(events, [], 'switch off: neither the watchdog nor a caller can mark unavailable');
  settings.delete('availability_enabled');

  // -- statistics: the four fields the settings page reads, plus mode -------------------------
  await m.resetMessageStats();
  frame(dev); frame(dev);
  advance(HOUR);
  frame(dev);
  const stats = m.getMessageStats();
  assert.deepStrictEqual(stats, { mode: 'frames', currentHour: 1, previousHour: 2, last24h: 3, lastMessageAt: now });
  advance(24 * HOUR);
  assert.strictEqual(m.getMessageStats().last24h, 0, 'older than 24 h falls out');

  // -- one manager per node --------------------------------------------------------------------
  const gang2 = fakeDevice({ name: 'Gang 2' });
  gang2._node = dev._node;
  assert.strictEqual(await availability.install(gang2, { timeout: 25 * MIN }), null, 'second install on a node returns null');
  assert.ok(gang2.errors.some(e => e.includes('one device per Zigbee node')));
  assert.strictEqual(frame(dev), 'original', 'and leaves the first manager hooked');

  // -- uninstall puts back exactly what it replaced --------------------------------------------
  assert.notStrictEqual(dev.zclNode.sendFrame, dev._origSend, 'sendFrame wrapped while installed');
  await m.uninstall();
  await m.uninstall();   // idempotent (onUninit and onDeleted)
  assert.strictEqual(dev._node._frameMiddleware, undefined, 'FrameMiddleware removed');
  assert.strictEqual(dev._node.handleFrame(), 'original', 'handleFrame restored');
  assert.strictEqual(dev._node._availabilityHookInstalled, false);
  assert.strictEqual(dev.zclNode.sendFrame, dev._origSend, 'sendFrame restored');
  await settle();   // let the fire-and-forget restores of the frames above finish first
  events = [];
  await m.markUnavailable('after uninstall');
  assert.deepStrictEqual(events, [], 'no transition after uninstall');
  assert.strictEqual(interval, null, 'the app-wide timer stops with the last manager');

  // -- callback mode (battery): no node hook, activity counted per call ------------------------
  const sensor = fakeDevice({ name: 'Sensor', driverId: 'relay_sensor' });
  delete sensor._node.handleFrame;
  const cb = await availability.install(sensor, { timeout: 90 * MIN, passive: false });
  assert.ok(cb && typeof sensor._markAliveFromAvailability === 'function', 'callback injected');
  assert.strictEqual(sensor._node._frameMiddleware, undefined, 'callback mode does not hook the node');
  await sensor._markAliveFromAvailability('temperature');
  assert.strictEqual(cb.getMessageStats().mode, 'activity');
  assert.strictEqual(cb.getMessageStats().currentHour, 1);
  await cb.uninstall();
  assert.strictEqual(sensor._markAliveFromAvailability, undefined, 'callback removed');

  // -- flows: false, and a device without the capability ---------------------------------------
  const tank = fakeDevice({ name: 'Tank', withCapability: false, driverId: 'water_tank_monitor' });
  const t = await availability.install(tank, { timeout: 12 * HOUR, flows: false });
  events = [];
  await t.markUnavailable('x');
  await t.markAvailable();
  assert.deepStrictEqual(events, ['setUnavailable:x', 'setAvailable'], 'no capability, no flow card');
  assert.deepStrictEqual(tank.errors, [], 'no "Invalid Flow Card" error');
  await t.uninstall();

  // -- a failed install returns null and leaves nothing behind ---------------------------------
  const lost = fakeDevice();
  lost._node = null;
  assert.strictEqual(await availability.install(lost, { timeout: 25 * MIN }), null, 'no node: null, not a throw');
  assert.strictEqual(await availability.install(fakeDevice(), { timeout: 0 }).catch(() => 'threw'), null, 'bad options: null');

  console.log('availability OK: seen / silent / 5 failed sends (timeout counts), boot grace, global switch, '
    + 'is_availability before setUnavailable, flow cards, stats, one manager per node, uninstall, callback mode, install failure');
})().catch(err => { console.error(err); process.exit(1); });
