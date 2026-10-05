'use strict';

/**
 * @file AvailabilityManager.js
 * @description Zigbee device availability, kept deliberately small. Three signals:
 *  1. Seen:        any inbound frame marks the device available and resets the failure count.
 *  2. Silent:      no frame for `timeout` marks it unavailable ("No activity for Nmin").
 *  3. No response: `failuresToOffline` failed sends in a row, with no frame in between, mark it
 *                  unavailable ("No response to commands"). Passive managers only: sleepy
 *                  battery devices fail sends all the time and never use this signal.
 * Homey does not mark a Zigbee device unavailable on silence, and does not mark it available
 * again when it talks (verified on a ZBMINIR2), so both directions are done here.
 *
 * Everything is in memory. Nothing is written to the Store, and nothing is restored after an
 * app restart: every device restarts as "seen now" and gets a boot grace before the watchdog
 * and the send-failure counter are allowed to act. Homey runs for long periods, so restarts are
 * rare and not worth code. RejoinManager is separate (see ./RejoinManager.js).
 *
 * ## AvailabilityManagerPassive - mains-powered devices
 * Hooks node.handleFrame (through FrameMiddleware) to see ANY inbound frame with no extra
 * traffic, and wraps zclNode.sendFrame to count failed sends.
 * ```js
 * const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
 * // main device only (one per Zigbee node):
 * this._availability = new AvailabilityManagerPassive(this, { timeout: 25 * 60 * 1000 });
 * await this._availability.install();
 * // in onDeleted/onUninit:
 * this._availability?.uninstall().catch(() => {});
 * ```
 *
 * ## AvailabilityManagerCallback - battery sensors
 * Injects device._markAliveFromAvailability(source); the driver calls it from every inbound
 * data handler.
 * ```js
 * this._availability = new AvailabilityManagerCallback(this, { timeout: 90 * 60 * 1000 });
 * await this._availability.install();
 * this._markAliveFromAvailability?.('reporting');
 * ```
 *
 * ## Global on/off switch
 * The homey.settings key `availability_enabled` (settings page, api.js getAvailabilitySetting /
 * setAvailabilitySetting). When off, nothing is marked unavailable. The check lives inside
 * markUnavailable(), the single way to go unavailable, so no caller can bypass it.
 * Activity tracking and statistics keep running, and switching off restores every device
 * that is currently unavailable.
 *
 * ## Transition effects (Tuya)
 * markAvailable()/markUnavailable() keep what the Tuya drivers rely on: the is_availability
 * capability (false BEFORE setUnavailable so Homey fires the capability flow, true after
 * setAvailable; as in Nova Digital, Moes has no such capability) and the
 * `<driver>_availability_turned_on/off` flow triggers (as in Moes), fired once per real
 * transition, after the state change.
 *
 * Statistics (Traffic tab): hourly buckets in memory. Passive counts raw inbound frames,
 * Callback counts explicit activity callbacks. They never influence availability decisions.
 */

const { AVAILABILITY_ENABLED_SETTING_KEY, ZCL_DEBUG } = require('./constants');
const { HourlyMessageStats } = require('./HourlyMessageStats');
const { applyAvailabilityHooks } = require('./availabilityHooks');

const CHECK_INTERVAL_MS = 60 * 1000;
const BOOT_GRACE_MS = 5 * 60 * 1000;
// Failed sends in a row (no frame in between) before a device is marked unavailable. No minimum
// gap between failures: a user pressing "on" five times in a row is five commands. Above the
// 4 attempts of a single SonoffBase.readAttribute retry chain, so one read alone never trips it.
const FAILURES_TO_OFFLINE = 5;

/**
 * Fire the driver's availability flow trigger (`<driver>_availability_turned_on/off`).
 * @param {import('homey-zigbeedriver').ZigBeeDevice} device
 * @param {boolean} available
 */
function triggerAvailabilityFlow(device, available) {
  const cardId = `${device.driver.id}_availability_turned_${available ? 'on' : 'off'}`;
  let tz = 'UTC';
  try {
    const result = device.homey.clock.getTimezone();
    if (typeof result === 'string' && result.length > 0) tz = result;
  } catch { /* UTC fallback */ }
  const timestamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, dateStyle: 'short', timeStyle: 'medium',
  }).format(new Date());

  // getDeviceTriggerCard() throws synchronously for an unregistered card id.
  try {
    device.homey.flow.getDeviceTriggerCard(cardId)
      .trigger(device, { device_name: device.getName(), timestamp })
      .catch(err => device.error(`[Availability] ${cardId} trigger failed:`, err.message));
  } catch (err) {
    device.error(`[Availability] ${cardId} error:`, err.message);
  }
}

// -----------------------------------------------------------------------------
// Base
// -----------------------------------------------------------------------------

class AvailabilityManagerBase {

  static STATS_MODE = 'activity';

  /**
   * @param {import('homey-zigbeedriver').ZigBeeDevice} device
   * @param {object} options
   * @param {number} options.timeout              - Silence before "unavailable", in ms
   * @param {number} [options.checkInterval]      - Watchdog tick in ms (default 60 s)
   * @param {number} [options.bootGraceMs]        - Quiet period after install (default 5 min)
   * @param {number} [options.failuresToOffline]  - Failed sends in a row (default 5, Passive only)
   */
  constructor(device, options = {}) {
    if (!device) throw new Error('[Availability] device is required');
    if (!options.timeout || options.timeout <= 0) throw new Error('[Availability] timeout must be positive');

    this.device = device;
    this.options = {
      checkInterval: CHECK_INTERVAL_MS,
      bootGraceMs: BOOT_GRACE_MS,
      failuresToOffline: FAILURES_TO_OFFLINE,
      logIdle: ZCL_DEBUG,
      ...options,
    };
    this._installed = false;
    this._installedAt = 0;
    this._lastSeen = 0;              // in memory only
    this._failures = 0;              // failed sends in a row, reset by any frame
    this._watchdogStart = null;
    this._watchdogInterval = null;
    this._frameHookInstalled = false;
    this._zigbeeNode = null;         // kept for cleanup (unregister from FrameMiddleware)
    this._markingAvailable = false;  // reentrancy guards: one onBecame* call per transition
    this._markingUnavailable = false;
    this._messageStats = new HourlyMessageStats();
  }

  // -- Signal 1: seen ---------------------------------------------------------

  /**
   * Any sign of life: remember it, forget earlier send failures, restore availability.
   * @param {string} source - Log label (e.g. 'ep1 cl:0x0006', 'reporting')
   */
  async _markAlive(source) {
    this._lastSeen = Date.now();
    this._failures = 0;
    if (!this.device.getAvailable()) {
      this.device.log(`[Availability] Restoring (${source})`);
      await this.markAvailable();
    }
  }

  // -- Signal 2: silent -------------------------------------------------------

  /** True when this manager is allowed to mark the device unavailable right now. */
  _canMarkUnavailable() {
    return this._installed
      && this._isGloballyEnabled()
      && this.device.getAvailable()
      && Date.now() - this._installedAt >= this.options.bootGraceMs;
  }

  _startWatchdog() {
    this._stopWatchdog();
    this.device.log('[Availability] Watchdog starting...');

    const tick = () => {
      if (!this._canMarkUnavailable()) return;
      const idle = Date.now() - this._lastSeen;
      if (idle > this.options.timeout) {
        this.markUnavailable(`No activity for ${Math.round(idle / 60000)}min`)
          .catch(err => this.device.error('[Availability] Watchdog error:', err.message));
      }
    };

    // Random phase within one interval: otherwise every watchdog started at boot ticks on the
    // same second.
    this._watchdogStart = this.device.homey.setTimeout(() => {
      this._watchdogStart = null;
      this._watchdogInterval = this.device.homey.setInterval(tick, this.options.checkInterval);
    }, Math.floor(Math.random() * this.options.checkInterval));
  }

  _stopWatchdog() {
    if (this._watchdogStart) {
      this.device.homey.clearTimeout(this._watchdogStart);
      this._watchdogStart = null;
    }
    if (this._watchdogInterval) {
      this.device.homey.clearInterval(this._watchdogInterval);
      this._watchdogInterval = null;
      this.device.log('[Availability] Watchdog stopped');
    }
  }

  // -- Global switch ----------------------------------------------------------

  /**
   * The app-wide availability_enabled setting. Read fresh every time (homey.settings.get is an
   * in-memory read); it is the authoritative check inside markUnavailable().
   */
  _isGloballyEnabled() {
    return this.device.homey.settings.get(AVAILABILITY_ENABLED_SETTING_KEY) !== false;
  }

  // -- Sibling cascade --------------------------------------------------------

  /** Mark all sibling devices (gangs of one Zigbee node) available. Use instead of device.setAvailable(). */
  async markAvailable() {
    if (this._markingAvailable) return;
    this._markingAvailable = true;
    try {
      const wasUnavailable = !this.device.getAvailable();
      const changed = this._getSiblings().filter(s => !s.getAvailable());

      await Promise.allSettled(
        changed.map(s => {
          s.log('[Availability] Available');
          return s.setAvailable().catch(() => {});
        }),
      );

      // Main device only; the other gangs show the state through setAvailable/setUnavailable.
      // Set AFTER setAvailable() so Homey fires the capability flow on an available device.
      if (this.device.hasCapability('is_availability')) {
        await this.device.setCapabilityValue('is_availability', true).catch(() => {});
      }

      this._failures = 0;
      if (wasUnavailable) triggerAvailabilityFlow(this.device, true);

      if (wasUnavailable && typeof this.device.onBecameAvailable === 'function') {
        try {
          await this.device.onBecameAvailable();
        } catch (err) {
          this.device.error('[Availability] onBecameAvailable error:', err.message);
        }
      }
    } finally {
      this._markingAvailable = false;
    }
  }

  /**
   * The only way a device goes unavailable (watchdog, failed sends, or a caller; use it instead of
   * device.setUnavailable()). The global switch is checked here, right before the state change.
   * @param {string} reason
   */
  async markUnavailable(reason) {
    if (!this._isGloballyEnabled()) return;
    if (this._markingUnavailable) return;
    this._markingUnavailable = true;
    try {
      const wasAvailable = this.device.getAvailable();
      const changed = this._getSiblings().filter(s => s.getAvailable());

      // BEFORE setUnavailable(), so Homey fires the capability flow while the device is available.
      if (this.device.hasCapability('is_availability')) {
        await this.device.setCapabilityValue('is_availability', false).catch(() => {});
      }

      await Promise.allSettled(
        changed.map(s => {
          s.log(`[Availability] Unavailable: ${reason}`);
          return s.setUnavailable(reason).catch(() => {});
        }),
      );
      this._failures = 0;
      if (wasAvailable) triggerAvailabilityFlow(this.device, false);

      if (wasAvailable && typeof this.device.onBecameUnavailable === 'function') {
        try {
          await this.device.onBecameUnavailable(reason);
        } catch (err) {
          this.device.error('[Availability] onBecameUnavailable error:', err.message);
        }
      }
    } finally {
      this._markingUnavailable = false;
    }
  }

  /** All Homey device instances sharing this physical Zigbee node. */
  _getSiblings() {
    try {
      const { getNodeDevices } = require('./connectedDevices');
      const siblings = getNodeDevices(this.device);
      return siblings.length ? siblings : [this.device];
    } catch (err) {
      this.device.error('[Availability] _getSiblings error:', err.message);
      return [this.device];
    }
  }

  // -- Lifecycle --------------------------------------------------------------

  async uninstall() {
    if (!this._installed) return;
    // Set synchronously, before any await: onUninit and onDeleted both call _teardown().
    this._installed = false;
    this._stopWatchdog();
    await this._cleanup();
    this.device.log('[Availability] Uninstalled');
  }

  /** @protected Override in subclass for additional cleanup */
  async _cleanup() {}

  /**
   * Seed is_availability to true only when it has never been set (fresh pairing, or capability
   * just added to an existing device). Homey persists capability values across app restarts, so
   * an existing false is left alone here.
   */
  _initAlarmCapability() {
    if (!this.device.hasCapability('is_availability')) return;
    const current = this.device.getCapabilityValue('is_availability');
    if (current === null || current === undefined) {
      this.device.setCapabilityValue('is_availability', true).catch(() => {});
    }
  }

  /** @protected Complete common setup after subclass-specific hooks are installed. */
  async _completeInstall(message) {
    this._lastSeen = Date.now();   // baseline; the boot grace covers the rest
    this._installedAt = Date.now();
    this._initAlarmCapability();
    this._startWatchdog();
    this._installed = true;
    this.device.log(message);
  }

  /** @protected Roll back partial setup and preserve the original install error. */
  async _abortInstall(err) {
    this._stopWatchdog();
    await this._cleanup().catch(() => {});
    this.device.error('[Availability] Installation failed:', err.message);
    throw err;
  }

  // -- Public API -------------------------------------------------------------

  /**
   * Signal device activity from an explicit caller (e.g. report parser, active poll).
   * @param {string} [source]
   */
  async notifyActivity(source = 'activity') {
    this._messageStats.record(source);
    return this._markAlive(source);
  }

  getMessageStats() {
    return {
      mode: this.constructor.STATS_MODE,
      ...this._messageStats.summary(),
    };
  }

  async resetMessageStats() {
    this._messageStats.reset();
    return this.getMessageStats();
  }

  /** Last confirmed activity, as a Date. */
  getLastSeen() {
    return this._lastSeen ? new Date(this._lastSeen) : null;
  }
}

// -----------------------------------------------------------------------------
// Passive - handleFrame hook plus failed-send counter
// -----------------------------------------------------------------------------

class AvailabilityManagerPassive extends AvailabilityManagerBase {

  static STATS_MODE = 'frames';

  // Passive statistics count raw handleFrame invocations only; a report parser calling
  // notifyActivity() as a fallback must not count the same message twice.
  async notifyActivity(source = 'activity') {
    return this._markAlive(source);
  }

  async install() {
    if (this._installed) { this.device.error('[Availability] Already installed'); return; }

    try {
      await this._installHandleFrameHook();
      this._installSendFailureHook();
      await this._completeInstall('[Availability] Passive monitoring enabled');
    } catch (err) {
      // Also handles partial hook installation before _installed becomes true.
      return this._abortInstall(err);
    }
  }

  /**
   * Signal 3. Called by the zclNode.sendFrame wrapper (see availabilityHooks.js) for every failed
   * send. Homey's send error carries no code, only the text "Could not reach device".
   */
  _onSendFailure(err) {
    if (!/could not reach device/i.test(err?.message || '')) return;
    if (!this._canMarkUnavailable()) return;

    this._failures += 1;
    this.device.log(`[Availability] Send failed (${this._failures}/${this.options.failuresToOffline}): ${err.message}`);
    if (this._failures >= this.options.failuresToOffline) {
      this.markUnavailable('No response to commands')
        .catch(e => this.device.error('[Availability] Send-failure error:', e.message));
    }
  }

  async _cleanup() {
    this._removeHooks();
    this._lastSeen = 0;
    this._installedAt = 0;
    this.device.log('[Availability] handleFrame hook restored');
  }
}

applyAvailabilityHooks(AvailabilityManagerPassive);

// -----------------------------------------------------------------------------
// Callback - battery sensors
// -----------------------------------------------------------------------------

/**
 * Injects device._markAliveFromAvailability(source) for explicit signalling. Sleepy end devices
 * miss most sends by design, so there is no failed-send counter here.
 */
class AvailabilityManagerCallback extends AvailabilityManagerBase {

  async install() {
    if (this._installed) { this.device.error('[Availability] Already installed'); return; }

    try {
      this.device._markAliveFromAvailability = async (source = 'activity') => {
        await this.notifyActivity(source);
      };
      await this._completeInstall('[Availability] Monitoring enabled (callback-driven)');
    } catch (err) {
      return this._abortInstall(err);
    }
  }

  async _cleanup() {
    delete this.device._markAliveFromAvailability;
  }
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  AvailabilityManagerPassive,
  AvailabilityManagerCallback,
  HourlyMessageStats,
};
