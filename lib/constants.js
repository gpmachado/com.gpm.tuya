'use strict';

// Single source of truth - matches app.json "version" field.
const { version: APP_VERSION } = require('../app.json');

module.exports = {

  APP_VERSION,

  // -- Debug ------------------------------------------------------------------
  // true  -> verbose zigbee-clusters frame logging and extra app-side ZCL diagnostics.
  // false -> production logging.
  ZCL_DEBUG: false,

  // -- Availability watchdog timeouts ----------------------------------------
  // Time without any Zigbee frame before a device is marked unavailable.
  // Named by expected silence tolerance, not by device brand - any device
  // whose reporting cadence fits a tier uses that tier, regardless of family.

  // Fast tier - mains-powered devices with active onOff/cluster-6 reporting
  // every <=10 min (switches, power strip, smart plug). 2.5x the report interval.
  HEARTBEAT_FAST_MS: 25 * 60 * 1000, // 25 min

  // Medium tier - mains-powered devices with slower or heartbeat-only reporting:
  // Tuya-cluster-only switches (heartbeat every 30-60 min), Sonoff onOff
  // (hourly), Zigbee repeater (30 min active ping, no spontaneous frames).
  HEARTBEAT_MEDIUM_MS: 90 * 60 * 1000, // 90 min

  // Slow tier - any device legitimately silent for hours: battery/sleepy end
  // devices (LCD temp/humid sensor, SNZB-0x motion/contact, door/window
  // sensor) and mains-powered IAS Zone devices that only report on alarm or
  // keepalive (gas detector). Grouped by silence tolerance, not power source.
  HEARTBEAT_SLOW_MS: 4 * 60 * 60 * 1000, // 4 h

  // Very slow tier - longest-tolerance sleepy device (Tuya temp/humidity clock).
  HEARTBEAT_VERY_SLOW_MS: 12 * 60 * 60 * 1000, // 12 h

  // ZCL attribute reporting - max interval for all onOff clusters (switches, plugs, strip).
  // Device will send at least one report every 10 min even if state has not changed.
  ONOFF_REPORT_MAX_INTERVAL_S: 600,               // 10 min (in seconds - ZCL unit)

  // Zigbee repeater (TS0207) - no spontaneous ZCL frames after init.
  // Active ping every 30 min (read basic 0x0004); 90 min = 3x ping interval.
  // Matches Hubitat's recovery threshold for router devices.
  ZIGBEE_REPEATER_PING_INTERVAL_MS: 30 * 60 * 1000,  // 30 min

  // Door & window sensor (TS0203, IAS Zone, battery CR2032 / 2xAAA).
  // Battery reporting is not a firmware limitation - the device does send
  // spontaneous reports, but only once its ZDO binding for Power
  // Configuration (0x0001) lands, which Homey's platform attempts once at
  // pairing with no retry API and often misses while the device sleeps.
  // Active readAttributes polling was tried as a fallback but dropped:
  // field-tested ~100% timeout rate while the device is genuinely idle
  // (sleepy end-device, Receive when idle: false) - dead traffic, no
  // benefit. Availability relies on passive activity + wake-triggered
  // retries instead. Its only organic traffic is a real contact event, so
  // overnight silence (~14 h field-confirmed) is normal, not a fault - own
  // tier, not shared HEARTBEAT_SLOW_MS, with margin above that baseline.
  // Full writeup: drivers/doorwindowsensor(_2)/device.js.
  DOOR_SENSOR_HEARTBEAT_MS: 24 * 60 * 60 * 1000, // 24 h

  // homey.settings key (settings page switch): when its stored value is exactly `false`, no
  // device is ever marked unavailable (lib/AvailabilityManager.js#_isGloballyEnabled). Absent,
  // or any other value, means enabled.
  AVAILABILITY_ENABLED_SETTING_KEY: 'availability_enabled',


};
