'use strict';

/**
 * @file availability.js
 * @description Device availability for Zigbee devices: one file, one timer for the whole app.
 * Same model as homey.gpm.sonoff lib/availability.js, plus the two transition effects the Tuya
 * drivers rely on (is_availability and the `<driver>_availability_turned_on/off` flow cards).
 *
 * Signals:
 * 1. Seen - any inbound frame (passive mode) or an explicit notifyActivity() / callback
 *    (callback mode, battery sensors) marks the device alive and restores it if needed.
 * 2. Silent - no sign of life for longer than `timeout` marks it unavailable (checked by one
 *    app-wide 60 s tick, after a 5 min boot grace).
 * 3. Unreachable - `failuresToOffline` failed sends in a row ("Could not reach device" or a
 *    timeout, passive mode only) mark it unavailable before the timeout.
 *
 * ```js
 * const availability = require('../../lib/availability');
 * this._availability = await availability.install(this, { timeout: HEARTBEAT_FAST_MS });               // mains
 * this._availability = await availability.install(this, { timeout: HEARTBEAT_SLOW_MS, passive: false }); // battery
 * this._markAliveFromAvailability?.('reporting');   // callback mode: from every data handler
 * await this._availability?.uninstall();
 * ```
 *
 * install() never throws: on failure it logs and returns null, and the device runs without
 * availability monitoring. Passive mode hooks the node, so install it on exactly one device per
 * Zigbee node (the main / endpoint 1 device); gangs follow it through the sibling cascade.
 *
 * Transition effects, on the installing device only (the gangs follow through setAvailable /
 * setUnavailable): `capability` (is_availability by default, when the device has it) is set
 * false BEFORE setUnavailable, so Homey fires its flow while the device is still available, and
 * true after setAvailable; `flows` fires the driver's availability_turned_on/off card after the
 * state change. Both once per real transition.
 *
 * Global switch: the homey.settings key `availability_enabled` (settings page, api.js). When off,
 * nothing is marked unavailable; activity tracking and statistics keep running.
 *
 * Statistics (Traffic tab): hourly counts for the last 24 h. Passive counts raw inbound frames,
 * callback mode counts activity calls. They never influence availability.
 */

const { AVAILABILITY_ENABLED_SETTING_KEY, ZCL_DEBUG } = require('./constants');
const { FrameMiddleware, FRAME_PRIORITY } = require('./FrameMiddleware');
const { getNodeDevices } = require('./connectedDevices');
const { isDeviceUnreachable } = require('./errorUtils');

const TICK_MS = 60 * 1000;
const BOOT_GRACE_MS = 5 * 60 * 1000;
// Failed sends in a row (no frame in between) before a device is marked unavailable. Above the
// 3 attempts of a single TuyaZclBase command retry, so one command alone never trips it.
// The default responses zigbee-clusters sends on its own also go through zclNode.sendFrame and
// count when they fail; harmless, since they answer a frame that has just reset the count, so
// they add at most one failure per received frame.
const FAILURES_TO_OFFLINE = 5;
const HOUR_MS = 60 * 60 * 1000;
const STATS_HOURS = 24;

// One timer for the app: N devices cost N subtractions a minute, not N timers.
const managers = new Set();
let timer = null;
let timerHomey = null;

function tick() {
  const now = Date.now();
  for (const manager of managers) {
    try {
      manager._tick(now);
    } catch (err) {
      manager.device.error('[Availability] tick error:', err.message);
    }
  }
}

function startTimer(homey) {
  if (timer) return;
  timerHomey = homey;
  timer = homey.setInterval(tick, TICK_MS);
}

function stopTimerIfIdle() {
  if (!timer || managers.size > 0) return;
  timerHomey.clearInterval(timer);
  timer = null;
  timerHomey = null;
}

function isGloballyEnabled(device) {
  return device.homey.settings.get(AVAILABILITY_ENABLED_SETTING_KEY) !== false;
}

/** The driver's `<driver>_availability_turned_on/off` card, with device_name and a local timestamp. */
function triggerFlow(device, available) {
  const cardId = `${device.driver.id}_availability_turned_${available ? 'on' : 'off'}`;
  let timeZone = 'UTC';
  try {
    const zone = device.homey.clock.getTimezone();
    if (typeof zone === 'string' && zone) timeZone = zone;
  } catch { /* UTC fallback */ }
  const timestamp = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'short', timeStyle: 'medium' })
    .format(new Date());
  // getDeviceTriggerCard() throws synchronously for an unregistered card id.
  try {
    device.homey.flow.getDeviceTriggerCard(cardId)
      .trigger(device, { device_name: device.getName(), timestamp })
      .catch(err => device.error(`[Availability] ${cardId} trigger failed:`, err.message));
  } catch (err) {
    device.error(`[Availability] ${cardId} error:`, err.message);
  }
}

function create(device, {
  timeout,
  passive = true,
  capability = 'is_availability',
  flows = true,
  failuresToOffline = FAILURES_TO_OFFLINE,
} = {}) {
  if (!timeout || timeout <= 0) throw new Error('timeout must be positive');

  let installed = false;
  let installedAt = 0;
  let lastSeen = 0;
  let failures = 0;
  let markingAvailable = false;
  let markingUnavailable = false;
  const hourly = new Map(); // hour start (ms) -> count
  let lastMessageAt = null;

  // Set only once this manager owns them, so a failed install never undoes another's hooks.
  let hookedNode = null;
  let sendNode = null;
  let originalSend = null;
  let wrappedSend = null;
  let aliveCallback = null;

  const hasCapability = () => !!capability && device.hasCapability(capability);

  const siblings = () => {
    try {
      const found = getNodeDevices(device);
      return found.length ? found : [device];
    } catch (err) {
      device.error('[Availability] sibling lookup error:', err.message);
      return [device];
    }
  };

  const hourOf = now => Math.floor(now / HOUR_MS) * HOUR_MS;

  const prune = now => {
    const oldest = hourOf(now) - (STATS_HOURS - 1) * HOUR_MS;
    for (const hour of hourly.keys()) if (hour < oldest) hourly.delete(hour);
  };

  const record = () => {
    const now = Date.now();
    prune(now);
    const hour = hourOf(now);
    hourly.set(hour, (hourly.get(hour) || 0) + 1);
    lastMessageAt = now;
  };

  // Not while a markUnavailable is in flight: the device still reads available until
  // setUnavailable resolves, and a send failing in that gap would log "Send failed (6/5)".
  const canMarkUnavailable = now => installed
    && !markingUnavailable
    && device.getAvailable()
    && now - installedAt >= BOOT_GRACE_MS
    && isGloballyEnabled(device);

  const manager = {
    device,

    async _markAlive(source) {
      lastSeen = Date.now();
      failures = 0;
      if (installed && !device.getAvailable()) {
        device.log(`[Availability] Restoring (${source})`);
        await manager.markAvailable();
      }
    },

    /** Explicit sign of life (report parser, rejoin, callback). */
    async notifyActivity(source = 'activity') {
      if (!passive) record(); // passive mode already counted the frame in the hook
      return manager._markAlive(source);
    },

    /** Mark this device and its gangs available. Use instead of device.setAvailable(). */
    async markAvailable() {
      if (!installed || markingAvailable) return;
      markingAvailable = true;
      try {
        // Baseline: otherwise a restore by a caller (API, announce) is undone by the next tick.
        lastSeen = Date.now();
        failures = 0;
        const wasUnavailable = !device.getAvailable();
        await Promise.allSettled(siblings().filter(s => !s.getAvailable()).map(s => {
          s.log('[Availability] Available');
          return s.setAvailable().catch(() => {});
        }));
        // After setAvailable, so the capability flow runs on an available device.
        if (hasCapability()) await device.setCapabilityValue(capability, true).catch(() => {});
        if (wasUnavailable && flows) triggerFlow(device, true);
        if (wasUnavailable && typeof device.onBecameAvailable === 'function') {
          try {
            await device.onBecameAvailable();
          } catch (err) {
            device.error('[Availability] onBecameAvailable error:', err.message);
          }
        }
      } finally {
        markingAvailable = false;
      }
    },

    /**
     * The only way a device goes unavailable (use instead of device.setUnavailable()). The global
     * switch is checked here, right before the state change, so no caller can bypass it.
     */
    async markUnavailable(reason) {
      if (!installed || markingUnavailable || !isGloballyEnabled(device)) return;
      markingUnavailable = true;
      try {
        const wasAvailable = device.getAvailable();
        // Before setUnavailable: a flow on the capability still sees the device available.
        if (hasCapability()) await device.setCapabilityValue(capability, false).catch(() => {});
        await Promise.allSettled(siblings().filter(s => s.getAvailable()).map(s => {
          s.log(`[Availability] Unavailable: ${reason}`);
          return s.setUnavailable(reason).catch(() => {});
        }));
        failures = 0;
        if (wasAvailable && flows) triggerFlow(device, false);
        if (wasAvailable && typeof device.onBecameUnavailable === 'function') {
          try {
            await device.onBecameUnavailable(reason);
          } catch (err) {
            device.error('[Availability] onBecameUnavailable error:', err.message);
          }
        }
      } finally {
        markingUnavailable = false;
      }
    },

    /** Last confirmed activity, as a Date. */
    getLastSeen() {
      return lastSeen ? new Date(lastSeen) : null;
    },

    getMessageStats() {
      const now = Date.now();
      prune(now);
      const hour = hourOf(now);
      let last24h = 0;
      for (const count of hourly.values()) last24h += count;
      return {
        mode: passive ? 'frames' : 'activity',
        currentHour: hourly.get(hour) || 0,
        previousHour: hourly.get(hour - HOUR_MS) || 0,
        last24h,
        lastMessageAt,
      };
    },

    async resetMessageStats() {
      hourly.clear();
      lastMessageAt = null;
      return manager.getMessageStats();
    },

    _tick(now) {
      if (!canMarkUnavailable(now)) return;
      const idle = now - lastSeen;
      if (idle <= timeout) return;
      manager.markUnavailable(`No activity for ${Math.round(idle / 60000)}min`)
        .catch(err => device.error('[Availability] watchdog error:', err.message));
    },

    _onSendFailure(err) {
      if (!isDeviceUnreachable(err) || !canMarkUnavailable(Date.now())) return;
      failures += 1;
      device.log(`[Availability] Send failed (${failures}/${failuresToOffline}): ${err.message}`);
      if (failures >= failuresToOffline) {
        manager.markUnavailable('No response to commands')
          .catch(e => device.error('[Availability] send-failure error:', e.message));
      }
    },

    async _install() {
      if (!passive) {
        aliveCallback = (source = 'activity') => manager.notifyActivity(source);
        device._markAliveFromAvailability = aliveCallback;
        return;
      }

      const node = await device.homey.zigbee.getNode(device);
      if (!node) throw new Error('no Zigbee node');
      if (node._availabilityHookInstalled) {
        // A second manager on the same node would watch a node it never hears from. The
        // existing hook belongs to the other device: leave it alone.
        throw new Error('node already monitored - install on one device per Zigbee node');
      }
      // Priority 0: dispatched first, so it sees every frame before any layer can swallow it.
      FrameMiddleware.for(node).register('availability', FRAME_PRIORITY.AVAILABILITY,
        (endpointId, clusterId, frame) => {
          if (ZCL_DEBUG) {
            // The zigbee-clusters dump has no device id; this line ties a frame to its device.
            const hex = Buffer.isBuffer(frame) ? frame.toString('hex') : '';
            device.log(`[Availability] frame ep${endpointId} cl:0x${clusterId.toString(16)} ${hex}`);
          }
          record();
          // Fire-and-forget: availability bookkeeping must not serialize the frame path.
          manager._markAlive(`ep${endpointId} cl:0x${clusterId.toString(16)}`)
            .catch(err => device.error('[Availability] frame hook error:', err.message));
        });
      node._availabilityHookInstalled = true;
      hookedNode = node;

      // Outbound evidence: every cluster call goes through zclNode.sendFrame.
      const zclNode = device.zclNode;
      if (zclNode && typeof zclNode.sendFrame === 'function') {
        const original = zclNode.sendFrame;
        wrappedSend = async (...args) => {
          try {
            return await original(...args);
          } catch (err) {
            manager._onSendFailure(err);
            throw err;
          }
        };
        originalSend = original;
        sendNode = zclNode;
        zclNode.sendFrame = wrappedSend;
      }
    },

    _activate() {
      installed = true;
      installedAt = Date.now();
      lastSeen = installedAt; // baseline; the boot grace covers the rest
      // Seed only a never-set capability (fresh pairing, or just added): Homey keeps its value
      // across restarts, so an existing false stays until the device is heard from.
      if (hasCapability() && device.getCapabilityValue(capability) == null) {
        device.setCapabilityValue(capability, true).catch(() => {});
      }
      managers.add(manager);
      startTimer(device.homey);
    },

    /** Idempotent: safe from both onUninit and onDeleted. */
    async uninstall() {
      installed = false; // synchronously, before anything else
      managers.delete(manager);
      stopTimerIfIdle();
      // Restore only what this manager installed, and the send hook only while it is still the
      // current sendFrame, so a wrapper added after us is never overwritten.
      if (hookedNode) {
        FrameMiddleware.unregister(hookedNode, 'availability');
        hookedNode._availabilityHookInstalled = false;
        hookedNode = null;
      }
      if (sendNode && sendNode.sendFrame === wrappedSend) sendNode.sendFrame = originalSend;
      sendNode = null;
      originalSend = null;
      wrappedSend = null;
      if (aliveCallback && device._markAliveFromAvailability === aliveCallback) delete device._markAliveFromAvailability;
      aliveCallback = null;
    },
  };

  return manager;
}

/**
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device
 * @param {object} options
 * @param {number} options.timeout                        silence before "unavailable", in ms
 * @param {boolean} [options.passive=true]                false: battery device, callback-driven
 * @param {string|null} [options.capability='is_availability'] boolean capability mirroring
 *   availability, used only when the device has it; null for none
 * @param {boolean} [options.flows=true]                  fire the driver's availability_turned_on/off cards
 * @param {number} [options.failuresToOffline=5]          failed sends in a row (passive only)
 * @returns {Promise<object|null>} the manager, or null when monitoring could not be installed
 */
async function install(device, options) {
  let manager = null;
  try {
    manager = create(device, options);
    await manager._install();
    manager._activate();
    device.log(`[Availability] Monitoring enabled (${options.passive === false ? 'callback' : 'passive'})`);
    return manager;
  } catch (err) {
    await manager?.uninstall().catch(() => {});
    device.error('[Availability] disabled for this device:', err.message);
    return null;
  }
}

module.exports = { install };
