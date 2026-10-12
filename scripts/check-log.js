'use strict';

// Reads a `homey app run` log (ZCL_DEBUG on) and checks it against docs/TESTE-REMOTO.md. Prints
// PASS / WARN / FAIL / INFO lines, no raw frames and no keys, so the summary is safe to paste.
// Exit code 1 when something FAILed.
//   node scripts/check-log.js logs/teste.log

const fs = require('node:fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-log.js <log file>');
  process.exit(2);
}

// PowerShell's ">" writes UTF-16 with a BOM; Tee-Object and the shell redirect write UTF-8.
const raw = fs.readFileSync(file);
const text = (raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8'))
  .replace(/\x1b\[[0-9;]*m/g, '');

const results = [];
const add = (level, name, detail = '') => results.push({ level, name, detail });
const ms = iso => Date.parse(iso);
const hhmmss = t => new Date(t).toISOString().slice(11, 19) + 'Z';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// -- app lines of every driver: { t, err, driver, dev, msg } ------------------------------------------
const lineRe = /^(\S+Z) \[(log|err)\] \[ManagerDrivers\] \[Driver:(\w+)\] \[Device:([^\]]+)\] (.*)$/gm;
const lines = [...text.matchAll(lineRe)].map(m => ({ t: ms(m[1]), err: m[2] === 'err', driver: m[3], dev: m[4], msg: m[5] }));
const devices = [...new Set(lines.map(l => `${l.driver}|${l.dev}`))].map(k => {
  const [driver, dev] = k.split('|');
  return { driver, dev, name: `${driver} ${dev.slice(0, 8)}`, lines: lines.filter(l => l.driver === driver && l.dev === dev) };
});
const driverLines = driver => lines.filter(l => l.driver === driver);

// -- version ---------------------------------------------------------------------------------------
const version = text.match(/My Tuya Devices v(\S+) started \(ZCL_DEBUG (on|off)\)/);
if (!version) add('FAIL', 'version', 'no version line: the log is from a build older than the one that logs it (git pull and run again)');
else add('INFO', 'version', `v${version[1]}, ZCL_DEBUG ${version[2]}`);
if (version?.[2] === 'off') add('WARN', 'frames', 'ZCL_DEBUG is off, so the time cluster check below cannot see anything');

// -- start-up of each device -------------------------------------------------------------------------
const started = devices.filter(d => d.lines.some(l => /ZigBeeDevice has been initialized/.test(l.msg)));
add(started.length ? 'PASS' : 'FAIL', 'devices start', started.length ? `${plural(started.length, 'device')}: ${[...new Set(started.map(d => d.driver))].join(', ')}` : 'no device initialized');
const noNode = started.filter(d => !d.lines.some(l => /^\[Node\] ieee=\S+ nwk=\S+/.test(l.msg)));
add(noNode.length ? 'WARN' : 'PASS', 'node address logged', noNode.length ? `no [Node] line for ${noNode.map(d => d.name).join(', ')}` : 'every device logged its ieee and nwk');

const failedInstall = lines.filter(l => /\[Availability\] Installation failed|node\.handleFrame already hooked/.test(l.msg));
add(failedInstall.length ? 'FAIL' : 'PASS', 'availability installs', failedInstall.length ? failedInstall[0].msg.slice(0, 140) : `${lines.filter(l => /\[Availability\] (Passive monitoring enabled|Monitoring enabled)/.test(l.msg)).length} managers installed`);

// -- signal 3: five failed sends in a row -> unavailable, and the way back ---------------------------
let sawRun = false;
for (const d of devices) {
  const fails = d.lines.filter(l => /\[Availability\] Send failed \((\d)\/5\)/.test(l.msg));
  const last = fails.find(l => /\(5\/5\)/.test(l.msg));
  if (!last) continue;
  sawRun = true;
  const down = d.lines.find(l => /\[Availability\] Unavailable: No response to commands/.test(l.msg) && l.t >= last.t && l.t <= last.t + 2000);
  add(down ? 'PASS' : 'FAIL', `${d.name} 5 failed sends`, down ? `unavailable ${((down.t - last.t) / 1000).toFixed(1)} s after the 5th failure` : 'the 5th failed send did not mark it unavailable');
  if (!down) continue;
  const back = d.lines.find(l => /\[Availability\] Restoring/.test(l.msg) && l.t > down.t);
  const ok = back && d.lines.find(l => /\[Availability\] Available/.test(l.msg) && l.t >= back.t);
  add(ok ? 'PASS' : 'WARN', `${d.name} comes back`, ok ? `restored by the first frame at ${hhmmss(back.t)}` : 'still unavailable at the end of the log: plug it back in and wait 10 s');
}
if (!sawRun) add('INFO', 'failed sends', 'not exercised: take a mains device off the power and tap it 5 times in Homey');

// -- power-cut trigger: one per cut, the module's repeated dump must not give a second ----------------
const rejoinTimes = new Map();
for (const l of lines) {
  const m = l.msg.match(/^\[RejoinManager\] Firing flow: (\w+)_device_rejoined/);
  if (m) rejoinTimes.set(`${l.driver}|${l.dev}`, [...(rejoinTimes.get(`${l.driver}|${l.dev}`) || []), l.t]);
}
let twice = false;
for (const [key, ts] of rejoinTimes) {
  const [driver, dev] = key.split('|');
  const name = `${driver} ${dev.slice(0, 8)}`;
  const dup = ts.some((t, i) => i && t - ts[i - 1] < 30000);
  twice = twice || dup;
  add(dup ? 'FAIL' : 'PASS', `${name} power-cut trigger`, dup ? 'two triggers within 30 s for one power cut' : `${plural(ts.length, 'trigger')} at ${ts.map(hhmmss).join(' ')}`);
}
if (!rejoinTimes.size) add('WARN', 'power-cut trigger', 'none: unplug a mains device for 5 s, plug it back and wait 1 min');
const suppressed = lines.filter(l => /\[rejoin\] Power restore detected/.test(l.msg)).length - [...rejoinTimes.values()].flat().length;
if (rejoinTimes.size && suppressed > 0) add('INFO', 'repeated boot dumps', `${suppressed} "Power restore detected" lines without a trigger (the 30 s cooldown; expected, the module repeats its dump)`);

// -- time cluster (needs ZCL_DEBUG): the app must answer localTime in the Homey zone, not UTC ------------
// "return read attributes response { attributes: <Buffer 07 00 00 23 <4 bytes LE>> }" = attribute 0x0007, status 0, uint32
const ZIGBEE_EPOCH = 946684800;
const timeRe = /^(\S+Z) zigbee-clusters:bound-cluster ep: \d+, cl: time \(10\) return read attributes response \{ attributes: <Buffer 07 00 00 23 ([0-9a-f]{2}) ([0-9a-f]{2}) ([0-9a-f]{2}) ([0-9a-f]{2})>/gm;
const reads = [...text.matchAll(timeRe)].map(m => {
  const local = Buffer.from(m.slice(2, 6).map(h => parseInt(h, 16))).readUInt32LE(0) + ZIGBEE_EPOCH;
  return Math.round(((local * 1000 - ms(m[1])) / 3600000) * 2) / 2;   // hours, to the half hour
});
if (reads.length) {
  const offsets = [...new Set(reads)];
  const utcOnly = offsets.length === 1 && offsets[0] === 0;
  add(utcOnly ? 'WARN' : 'PASS', 'time cluster', `${plural(reads.length, 'localTime read')} answered at UTC${offsets.map(o => (o >= 0 ? '+' : '') + o.toFixed(1)).join(' / ')} h${utcOnly ? ' (the Homey zone is not applied, or the Homey is set to UTC)' : ''}`);
} else {
  add('INFO', 'time cluster', 'no device asked for the time: pair or power-cycle a mains device (the repeater, the 1CH, the siren) with ZCL_DEBUG on');
}

// -- ekaza_siren -------------------------------------------------------------------------------------
const siren = driverLines('ekaza_siren');
if (!siren.length) {
  add('INFO', 'siren', 'not in this log');
} else {
  const starts = siren.filter(l => /^Siren: melody=\d+, volume=\d, duration=\d+s/.test(l.msg));
  const confirmed = starts.filter(s => siren.some(l => /^Alarm: ON/.test(l.msg) && l.t >= s.t && l.t <= s.t + 4000)).length;
  const gaveUp = siren.filter(l => /Siren did not confirm the start/.test(l.msg)).length;
  const retries = siren.filter(l => /Siren: start not confirmed, retrying/.test(l.msg)).length;
  if (!starts.length) add('WARN', 'siren starts', 'no start seen: change the melody and turn it on, twice');
  else add(gaveUp || confirmed < starts.length - retries ? 'FAIL' : 'PASS', 'siren starts', `${confirmed} of ${starts.length} starts confirmed by the device${retries ? `, ${plural(retries, 'retry')} needed` : ', no retry needed'}${gaveUp ? `, ${gaveUp} gave up` : ''}`);
  const durations = [...new Set(starts.map(l => l.msg.match(/duration=(\d+)s/)[1]))];
  add('INFO', 'siren durations used', durations.map(d => `${d} s`).join(', ') || 'none');
}

// -- wireless remote ---------------------------------------------------------------------------------
const remote = driverLines('wireless_switch_remote_2_gang').filter(l => /^Button: \d-(single|double|long)$/.test(l.msg));
if (!remote.length) {
  add('INFO', 'wireless remote', 'no button press in this log');
} else {
  const seen = new Set(remote.map(l => l.msg.slice(8)));
  const missing = ['1', '2'].flatMap(b => ['single', 'double', 'long'].map(t => `${b}-${t}`)).filter(k => !seen.has(k));
  add(missing.length ? 'WARN' : 'PASS', 'wireless remote buttons', missing.length ? `${remote.length} presses; not seen: ${missing.join(' ')}` : `${remote.length} presses, all six combinations seen`);
}

// -- errors ----------------------------------------------------------------------------------------
const expectedDown = /Could not reach device|command failed after \d+ attempts/;
const errs = lines.filter(l => l.err);
const unexpected = [...new Set(errs.filter(l => !expectedDown.test(l.msg)).map(l => `${l.driver}: ${l.msg.slice(0, 120)}`))];
const expected = errs.length - errs.filter(l => !expectedDown.test(l.msg)).length;
add(unexpected.length ? 'WARN' : 'PASS', 'driver errors', unexpected.length ? unexpected.slice(0, 5).join(' | ') : 'none besides the unreachable-device ones');
if (expected) add('INFO', 'unreachable-device errors', `${expected} (expected while a device is unplugged)`);

// -- print -----------------------------------------------------------------------------------------
for (const r of results) console.log(`${r.level.padEnd(5)} ${r.name}${r.detail ? ' - ' + r.detail : ''}`);
const count = lv => results.filter(r => r.level === lv).length;
console.log(`\n${count('PASS')} PASS, ${count('WARN')} WARN, ${count('FAIL')} FAIL`);
process.exit(count('FAIL') ? 1 : 0);
