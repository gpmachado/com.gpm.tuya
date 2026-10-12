'use strict';

// Run: npm test   (plain node, no Homey needed)
//
// Every driver logs "[Node] ieee=... nwk=..." in onNodeInit. device.log prefixes each line with the
// device id, so this line is what ties a frame, a sniffer capture or a binding error to a device
// (PORTAR_MELHORIAS_SONOFF.md, item 5). There is no common base class, so each driver carries the
// line, and this test fails if a new driver forgets it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const driversDir = path.join(__dirname, '..', 'drivers');
const LINE = /^[ ]*(this\.log\(`\[Node\] ieee=.*`\);)$/m;

const missing = [];
let checked = 0;
let sample = null;
for (const name of fs.readdirSync(driversDir)) {
  const file = path.join(driversDir, name, 'device.js');
  if (!fs.existsSync(file)) continue;
  checked += 1;
  const m = fs.readFileSync(file, 'utf8').match(LINE);
  if (!m) missing.push(name);
  else sample = sample || m[1];
}
assert.ok(checked >= 11, `expected at least 11 drivers, found ${checked}`);
assert.deepStrictEqual(missing, [], `drivers without the [Node] line: ${missing.join(', ')}`);

// Run the real statement against a fake device.
const run = ctx => {
  const out = [];
  new Function(sample).call({ log: (...a) => out.push(a.join(' ')), ...ctx });
  return out[0];
};
assert.strictEqual(
  run({ getData: () => ({ ieeeAddress: 'a4:c1:38:ae:07:6a:93:20' }), node: { networkAddress: 39004 } }),
  '[Node] ieee=a4:c1:38:ae:07:6a:93:20 nwk=39004',
);
assert.strictEqual(run({ getData: () => ({}), node: undefined }), '[Node] ieee=- nwk=-', 'missing data must not throw');
assert.strictEqual(run({ getData: () => undefined }), '[Node] ieee=- nwk=-', 'missing getData() result must not throw');

console.log(`node log OK: ${checked} drivers log [Node] ieee/nwk, missing data shows '-'`);
