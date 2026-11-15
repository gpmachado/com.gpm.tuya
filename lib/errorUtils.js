'use strict';

/**
 * Returns true when a ZCL/Zigbee error is a reachability failure
 * ("Could not reach device", "Timeout") rather than an attribute/feature error.
 * @param {Error} err
 * @returns {boolean}
 */
function isDeviceUnreachable(err) {
  if (!err || !err.message) return false;
  return err.message.includes('Could not reach device') ||
         err.message.includes('Timeout');
}

/**
 * Returns a `.catch()` handler for readAttributes calls.
 * Reachability errors are expected when a device is powered off -
 * logged at info level to keep the log clean.
 *
 * Options:
 *   markOffline {boolean} - mark the device unavailable when it can't be reached, through its
 *                           availability manager (global switch, flow cards, is_availability).
 *
 * @param {object} device
 * @param {string} label
 * @param {object} [opts]
 * @param {boolean} [opts.markOffline]
 * @returns {function}
 */
function readAttrCatch(device, label, { markOffline = false } = {}) {
  return err => {
    if (isDeviceUnreachable(err)) {
      device.log(`${label}: device offline (not powered)`);
      if (markOffline) {
        device._availability?.markUnavailable('Device not reachable').catch(() => {});
      }
    } else {
      device.error(`${label}:`, err);
    }
  };
}

module.exports = { isDeviceUnreachable, readAttrCatch };
