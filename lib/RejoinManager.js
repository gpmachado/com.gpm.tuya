'use strict';

/**
 * @file RejoinManager.js
 * @description Fires the device_rejoined flow trigger after a power-cycle/rejoin.
 * ```js
 * const RejoinManager = require('../../lib/RejoinManager');
 * RejoinManager.triggerRejoin(this);
 * ```
 */

const { getNodeDevices } = require('./connectedDevices');
const { REJOIN_ANNOUNCE_CLUSTERS, REJOIN_ANNOUNCE_DPS, REJOIN_DEBOUNCE_MS } = require('./constants');

// Per-device last-rejoin timestamp, for the debounce in notifyIfRejoinDatapoint().
const lastRejoinTs = new WeakMap();

class RejoinManager {
  /**
   * Call from a DP dispatch handler on every incoming datapoint. Fires
   * triggerRejoin() if `dp` is this driver's configured rejoin-signal
   * datapoint (see REJOIN_ANNOUNCE_DPS in constants.js), debounced by
   * REJOIN_DEBOUNCE_MS. No-op for drivers with no configured DP, or devices
   * whose rejoin protocol is a raw cluster frame instead (see
   * watchAnnounceFrame for that case).
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {number} dp
   */
  static notifyIfRejoinDatapoint(device, dp) {
    if (REJOIN_ANNOUNCE_DPS[device.driver.id] !== dp) return;

    const now = Date.now();
    if (now - (lastRejoinTs.get(device) ?? 0) < REJOIN_DEBOUNCE_MS) return;
    lastRejoinTs.set(device, now);

    device.log(`[RejoinManager] Datapoint ${dp} detected — treating as rejoin`);
    RejoinManager.triggerRejoin(device);
  }

  /**
   * Call right before writing `dp` to the device (e.g. a settings change).
   * If `dp` is this driver's configured rejoin-signal datapoint, the write's
   * own echo (reporting/response) would otherwise look identical to a
   * genuine rejoin announce — this suppresses it for REJOIN_DEBOUNCE_MS.
   * No-op for any other dp.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {number} dp
   */
  static markSelfWrite(device, dp) {
    if (REJOIN_ANNOUNCE_DPS[device.driver.id] !== dp) return;
    lastRejoinTs.set(device, Date.now());
  }

  /**
   * Call right before writing any configuration to a device whose rejoin
   * signal is watchAnnounceFrame() (a raw cluster frame). Confirmed via
   * sniffer (see README): the moes_radar_sensor_mmwave re-sends its announce
   * frame after ANY config write (sensitivity, distance, LED, fading time),
   * not just after a genuine rejoin — this suppresses that echo for
   * REJOIN_DEBOUNCE_MS. Unconditional: harmless to call for any driver.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   */
  static suppressAnnounce(device) {
    lastRejoinTs.set(device, Date.now());
  }

  /**
   * Watches the raw node frame stream for the device's (re)join announce
   * frame and fires triggerRejoin() when seen. The announce cluster ID is
   * device-specific (see REJOIN_ANNOUNCE_CLUSTERS in constants.js) — each
   * model emits a different, undocumented packet on (re)join. Chains onto
   * whatever is already assigned to node.handleFrame, so it composes safely
   * if anything else also hooks the frame stream.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   */
  static async watchAnnounceFrame(device) {
    const clusterId = REJOIN_ANNOUNCE_CLUSTERS[device.driver.id];
    if (clusterId === undefined) {
      device.error(`[RejoinManager] watchAnnounceFrame: no announce cluster configured for driver "${device.driver.id}"`);
      return;
    }

    const node = await device.homey.zigbee.getNode(device);
    if (!node) {
      device.error('[RejoinManager] watchAnnounceFrame: no ZigBee node');
      return;
    }

    const original = node.handleFrame;
    node.handleFrame = (endpointId, incomingClusterId, frame, meta) => {
      if (incomingClusterId === clusterId) {
        const now = Date.now();
        if (now - (lastRejoinTs.get(device) ?? 0) >= REJOIN_DEBOUNCE_MS) {
          lastRejoinTs.set(device, now);
          device.log('[RejoinManager] Announce frame detected — treating as rejoin');
          RejoinManager.triggerRejoin(device);
        }
      }
      if (typeof original === 'function') {
        return original.call(node, endpointId, incomingClusterId, frame, meta);
      }
      return undefined;
    };
  }

  /**
   * Fire the device_rejoined flow trigger.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {number} gapMs - Gap since last seen in milliseconds
   */
  static triggerRejoin(device, gapMs = 0) {
    const cardId = `${device.driver.id}_device_rejoined`;
    device.log(`[RejoinManager] Firing flow: ${cardId} (gap ${Math.round(gapMs / 1000)}s)`);

    // Rejoin counter + timestamp for the settings-page Rejoins tab (reset
    // globally alongside rejoin_tracking_since in app.js/api.js — see
    // resetRejoinStats).
    const count = (device.getStoreValue('rejoin_count') || 0) + 1;
    device.setStoreValue('rejoin_count', count).catch(() => {});
    device.setStoreValue('rejoin_last_at', Date.now()).catch(() => {});

    // Resolve siblings so the DeviceTriggerCard fires for every gang,
    // not just the EP1 device that detected the rejoin.
    let siblings = [device];
    try {
      siblings = getNodeDevices(device);
    } catch (err) {
      device.error('[RejoinManager] getNodeDevices error:', err.message);
    }

    // DeviceTriggerCard — appears directly in each device's flow card list.
    // Fired for every sibling so a flow set up on any gang works correctly.
    try {
      const card = device.homey.flow.getDeviceTriggerCard(cardId);
      for (const dev of siblings) {
        card
          .trigger(dev)
          .catch(err => device.error(`[RejoinManager] ${cardId} trigger failed:`, err.message));
      }
    } catch (err) {
      device.error(`[RejoinManager] ${cardId} error:`, err.message);
    }
  }
}

module.exports = RejoinManager;
