'use strict';

/**
 * @file batteryAlarm.js
 * @description Shared helper for the low-battery flow capability (`alarm_battery`)
 * on drivers that only report battery as a raw percentage (powerConfiguration /
 * a Tuya datapoint), with no IAS Zone battery bit to derive it from for free
 * (doorwindowsensor/doorwindowsensor_2 get alarm_battery straight from the zone
 * status bitmap and don't need this helper).
 *
 * Threshold is a per-device setting (`battery_low_threshold`, default 20%) so
 * the user can tune it per driver/device instead of a fixed cutoff.
 *
 * ```js
 * const { applyBatteryAlarm } = require('../../lib/batteryAlarm');
 * // wherever the driver already sets measure_battery:
 * applyBatteryAlarm(this, percent);
 * // in onSettings, when battery_low_threshold changes:
 * reapplyBatteryAlarm(this);
 * ```
 */

const DEFAULT_BATTERY_LOW_THRESHOLD = 20;

function _effectiveThreshold(device) {
  const raw = Number(device.getSetting('battery_low_threshold'));
  return Number.isFinite(raw) ? raw : DEFAULT_BATTERY_LOW_THRESHOLD;
}

/**
 * Set alarm_battery from a freshly-reported battery percentage, using this
 * device's configured (or default) threshold. No-op if the driver doesn't
 * declare alarm_battery. Remembers the percentage so reapplyBatteryAlarm()
 * can re-evaluate it immediately when the threshold setting changes, instead
 * of waiting for the next spontaneous battery report (which can be hours or
 * days away on a sleepy device).
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device
 * @param {number} percent - 0-100
 */
function applyBatteryAlarm(device, percent) {
  if (typeof percent !== 'number' || Number.isNaN(percent)) return;
  device._lastBatteryPercent = percent;

  if (!device.hasCapability('alarm_battery')) return;

  const low = percent < _effectiveThreshold(device);
  device.setCapabilityValue('alarm_battery', low)
    .catch(err => device.error('[Battery] alarm_battery:', err.message));
}

/**
 * Re-evaluate alarm_battery against the last known percentage — call from
 * onSettings when battery_low_threshold changes, so the alarm reflects the
 * new threshold immediately instead of on the next report.
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device
 */
function reapplyBatteryAlarm(device) {
  if (typeof device._lastBatteryPercent === 'number') {
    applyBatteryAlarm(device, device._lastBatteryPercent);
  }
}

module.exports = { applyBatteryAlarm, reapplyBatteryAlarm, DEFAULT_BATTERY_LOW_THRESHOLD };
