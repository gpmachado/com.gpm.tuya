'use strict';

// Run: npm test   (plain node, no Homey needed)
//
// scripts/check-log.js reads a `homey app run` log and prints PASS / WARN / FAIL. This test feeds it
// small synthetic logs (UTF-8 with colour codes, and the UTF-16 that PowerShell's ">" writes) and
// checks the verdicts, so a change to the script or to a log line it relies on shows up here.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-log.js');
const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const iso = sec => new Date(T0 + sec * 1000).toISOString();
const COLOR = '\x1b[32m';                              // the CLI colours the "[log]" tag; the script strips it
const RESET = '\x1b[0m';

const dev = (driver, id) => (sec, msg, kind = 'log') =>
  `${iso(sec)} ${kind === 'err' ? '\x1b[31m' : COLOR}[${kind}]${RESET} [ManagerDrivers] [Driver:${driver}] [Device:${id}] ${msg}`;
const relay = dev('switch_1_ch', 'aaaaaaaa-1111');
const siren = dev('ekaza_siren', 'bbbbbbbb-2222');
const remote = dev('wireless_switch_remote_2_gang', 'cccccccc-3333');

// A localTime read answered by the app: attribute 0x0007, status 0, uint32, seconds since 2000-01-01.
const timeLine = (sec, offsetHours) => {
  const t = T0 + sec * 1000;
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(Math.floor(t / 1000) + offsetHours * 3600 - 946684800);
  const bytes = ['07', '00', '00', '23', ...[...buf].map(b => b.toString(16).padStart(2, '0'))].join(' ');
  return `${iso(sec)} zigbee-clusters:bound-cluster ep: 1, cl: time (10) return read attributes response { attributes: <Buffer ${bytes}> }`;
};

const goodLog = ({ offsetHours = -3 } = {}) => [
  `${iso(0)} [log] [MyTuyaApp] My Tuya Devices v1.0.2 started (ZCL_DEBUG on)`,
  relay(1, 'ZigBeeDevice has been initialized { firstInit: false, isSubDevice: false }'),
  relay(1, '[Node] ieee=00:00:00:00:00:00:00:01 nwk=1111'),
  relay(2, '[Availability] Passive monitoring enabled'),
  siren(1, 'ZigBeeDevice has been initialized { firstInit: false, isSubDevice: false }'),
  siren(1, '[Node] ieee=00:00:00:00:00:00:00:02 nwk=2222'),
  remote(1, 'ZigBeeDevice has been initialized { firstInit: false, isSubDevice: false }'),
  remote(1, '[Node] ieee=00:00:00:00:00:00:00:03 nwk=3333'),
  // five failed sends in a row -> unavailable, then the first frame brings it back
  ...[1, 2, 3, 4, 5].map(n => relay(400 + n, `[Availability] Send failed (${n}/5): Could not reach device. Is it powered on?`)),
  relay(405.2, '[Availability] Unavailable: No response to commands'),
  relay(406, '[Gang 1] command failed after 3 attempts: Could not reach device. Is it powered on?', 'err'),
  relay(500, '[Availability] Restoring (ep1 cl:0x6)'),
  relay(500, '[Availability] Available'),
  // one power cut: one trigger, and the module repeats its dump 14 s later
  relay(503, '[rejoin] Power restore detected - triggering re-enforce'),
  relay(503, '[RejoinManager] Firing flow: switch_1_ch_device_rejoined (gap 0s)'),
  relay(517, '[rejoin] Power restore detected - triggering re-enforce'),
  timeLine(2448.544, offsetHours),          // 10:40:48.544Z
  siren(600, 'Siren: melody=5, volume=0, duration=3s'),
  siren(600.5, 'Alarm: ON'),
  siren(660, 'Siren: melody=6, volume=0, duration=45s'),
  siren(660.4, 'Alarm: ON'),
  ...['1-single', '1-double', '1-long', '2-single', '2-double', '2-long'].map((b, i) => remote(700 + i, `Button: ${b}`)),
].join('\n') + '\n';

function check(content, { utf16 = false } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'checklog-')), 'test.log');
  fs.writeFileSync(file, utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]) : content);
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const line = (out, level, name) => out.split('\n').find(l => l.startsWith(level.padEnd(5)) && l.includes(name));

// 1. a healthy run
let r = check(goodLog());
assert.strictEqual(r.code, 0, r.out);
assert.ok(!/^FAIL/m.test(r.out), r.out);
for (const [level, name] of [
  ['PASS', 'devices start'], ['PASS', 'node address logged'], ['PASS', 'availability installs'],
  ['PASS', '5 failed sends'], ['PASS', 'comes back'], ['PASS', 'power-cut trigger'],
  ['PASS', 'time cluster'], ['PASS', 'siren starts'], ['PASS', 'wireless remote buttons'], ['PASS', 'driver errors'],
]) assert.ok(line(r.out, level, name), `missing "${level} ${name}":\n${r.out}`);
assert.ok(line(r.out, 'PASS', 'time cluster').includes('UTC-3.0 h'), 'time zone offset is decoded');
assert.ok(line(r.out, 'INFO', 'repeated boot dumps'), 'the repeated dump is reported, not counted as a second trigger');
assert.ok(!r.out.includes('\x1b'), 'colour codes are stripped');

// 2. the same log as PowerShell writes it (UTF-16 LE with a BOM)
const u16 = check(goodLog(), { utf16: true });
assert.strictEqual(u16.code, 0, u16.out);
assert.strictEqual(u16.out, r.out, 'UTF-16 and UTF-8 give the same verdicts');

// 3. failures
r = check(goodLog().replace(/^.*My Tuya Devices v.*\n/m, ''));
assert.strictEqual(r.code, 1);
assert.ok(line(r.out, 'FAIL', 'version'), 'no version line fails');

r = check(goodLog().replace(/^.*Unavailable: No response to commands.*\n/m, ''));
assert.strictEqual(r.code, 1);
assert.ok(line(r.out, 'FAIL', '5 failed sends'), 'a 5th failed send that does not mark the device unavailable fails');

r = check(goodLog() + relay(505, '[RejoinManager] Firing flow: switch_1_ch_device_rejoined (gap 0s)') + '\n');
assert.strictEqual(r.code, 1);
assert.ok(line(r.out, 'FAIL', 'power-cut trigger'), 'two triggers within 30 s for one cut fail');

r = check(goodLog() + siren(700, 'Siren did not confirm the start') + '\n');
assert.strictEqual(r.code, 1);
assert.ok(line(r.out, 'FAIL', 'siren starts'), 'a siren start that gave up fails');

// 4. a log answered in UTC only warns (the Homey may really be set to UTC), it does not fail
r = check(goodLog({ offsetHours: 0 }));
assert.strictEqual(r.code, 0, r.out);
assert.ok(line(r.out, 'WARN', 'time cluster'), 'UTC answers are flagged');

// 5. no argument: usage, exit code 2
assert.strictEqual(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);

console.log('check-log OK: healthy run, UTF-16, version / failed-send / double-trigger / siren failures, UTC warning, usage');
