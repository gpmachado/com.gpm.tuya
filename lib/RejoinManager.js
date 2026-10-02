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
const { FrameMiddleware, FRAME_PRIORITY } = require('./FrameMiddleware');
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
    RejoinManager._debouncedRejoin(device, `Datapoint ${dp}`);
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
   * Watches the raw frame stream for boot-only signals of the Tuya module,
   * as a fallback for devices whose rejoin DP arrives inside the post-boot
   * DP dump — that dump can be lost while the router re-establishes its
   * route. Two signals, both seen only after a boot (confirmed via sniffer
   * on com.gpm.moes hardware — see _bootSignal below):
   *  - Basic (0x0000) reportAttributes carrying private attribute 0xFFE4 = 1
   *    (0 in every steady-state heartbeat; 1 in the first report(s) after
   *    boot, which the module keeps sending even when the dump is lost).
   *  - Tuya (0xEF00) heartbeat command 0x11 (never seen in steady state).
   * Shares the notifyIfRejoinDatapoint() debounce, so a boot that delivers
   * several signals fires once. Observer on FrameMiddleware at
   * FRAME_PRIORITY.REJOIN, like watchAnnounceFrame().
   *
   * CAUTION: these two signal patterns were measured on com.gpm.moes models,
   * not on this app's own Tuya-branded hardware. Both apps' devices run the
   * same TuyaMCU module family, so the signals are plausible here too — but
   * per the portability checklist, wire this into a specific driver only
   * after confirming with a sniffer capture on that model's boot, not by
   * assuming the Moes result carries over.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   */
  static async watchBootSignals(device) {
    await RejoinManager._registerFrameHandler(device, 'rejoin-boot', (current, clusterId, frame) => {
      const signal = RejoinManager._bootSignal(clusterId, frame);
      if (signal) RejoinManager._debouncedRejoin(current, signal);
    });
  }

  /** @returns {string|null} label of the boot signal carried by this frame */
  static _bootSignal(clusterId, frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 3) return null;
    // ZCL header: frameControl, [manufacturerCode x2 if bit 2], seq, cmdId
    const headerLen = (frame[0] & 0x04) ? 5 : 3;
    const cmdId = frame[headerLen - 1];

    if (clusterId === 0xEF00 && cmdId === 0x11) return 'Tuya heartbeat 0x11';

    if (clusterId === 0x0000 && cmdId === 0x0A) {
      // Attribute records: id (uint16 LE), dataType, value. Only fixed-size
      // types are walked — anything else ends the scan (0xFFE4 comes first
      // among the fixed-size records in every report seen so far).
      const SIZES = { 0x10: 1, 0x18: 1, 0x20: 1, 0x21: 2, 0x23: 4, 0x28: 1, 0x30: 1 };
      let i = headerLen;
      while (i + 3 <= frame.length) {
        const attrId = frame.readUInt16LE(i);
        const size = SIZES[frame[i + 2]];
        if (!size || i + 3 + size > frame.length) break;
        if (attrId === 0xFFE4 && frame[i + 3] === 1) return 'Basic 0xFFE4=1';
        i += 3 + size;
      }
    }
    return null;
  }

  static _debouncedRejoin(device, reason) {
    const now = Date.now();
    if (now - (lastRejoinTs.get(device) ?? 0) < REJOIN_DEBOUNCE_MS) return;
    lastRejoinTs.set(device, now);
    device.log(`[RejoinManager] ${reason} detected — treating as rejoin`);
    RejoinManager.triggerRejoin(device);
  }

  /**
   * Watches the raw node frame stream for the device's (re)join announce
   * frame and fires triggerRejoin() when seen. The announce cluster ID is
   * device-specific (see REJOIN_ANNOUNCE_CLUSTERS in constants.js) — each
   * model emits a different, undocumented packet on (re)join. Observer on
   * FrameMiddleware at FRAME_PRIORITY.REJOIN.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   */
  static async watchAnnounceFrame(device) {
    const clusterId = REJOIN_ANNOUNCE_CLUSTERS[device.driver.id];
    if (clusterId === undefined) {
      device.error(`[RejoinManager] watchAnnounceFrame: no announce cluster configured for driver "${device.driver.id}"`);
      return;
    }

    await RejoinManager._registerFrameHandler(device, 'rejoin-announce', (current, incomingClusterId) => {
      if (incomingClusterId !== clusterId) return;
      RejoinManager._debouncedRejoin(current, 'Announce frame');
    });
  }

  /**
   * Register a rejoin observer on the node's FrameMiddleware (FRAME_PRIORITY.REJOIN, never
   * swallows a frame). The id is node-level, so a re-init replaces the handler instead of
   * stacking a second one, and the handler reaches the current device instance through the
   * node rather than a closure over the instance that first installed it. Like Sonoff's
   * rejoinDetection.js, it lives for the life of the node — no teardown needed.
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {string} id
   * @param {(device: object, clusterId: number, frame: Buffer) => void} fn
   */
  static async _registerFrameHandler(device, id, fn) {
    const node = await device.homey.zigbee.getNode(device);
    if (!node) {
      device.error(`[RejoinManager] ${id}: no ZigBee node`);
      return;
    }
    node._rejoinDevice = device;
    FrameMiddleware.for(node).register(id, FRAME_PRIORITY.REJOIN, (endpointId, clusterId, frame) => {
      const current = node._rejoinDevice;
      if (current) fn(current, clusterId, frame);
    });
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
