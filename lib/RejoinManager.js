'use strict';

/**
 * @file RejoinManager.js
 * @description Fires the device_rejoined flow trigger after a power-cycle/rejoin. The decision
 * that a rejoin happened is made by the driver (see TuyaZclBase._trackBootBurst).
 * ```js
 * const RejoinManager = require('../../lib/RejoinManager');
 * RejoinManager.triggerRejoin(this);
 * ```
 */

const { getNodeDevices } = require('./connectedDevices');

class RejoinManager {
  /**
   * Fire the device_rejoined flow trigger.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {number} gapMs - Gap since last seen in milliseconds
   */
  static triggerRejoin(device, gapMs = 0) {
    const cardId = `${device.driver.id}_device_rejoined`;
    device.log(`[RejoinManager] Firing flow: ${cardId} (gap ${Math.round(gapMs / 1000)}s)`);

    // Rejoin counter + timestamp for the settings-page Rejoins tab (reset
    // globally alongside rejoin_tracking_since in app.js/api.js - see
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

    // DeviceTriggerCard - appears directly in each device's flow card list.
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
