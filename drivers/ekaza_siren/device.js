'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { HEARTBEAT_FAST_MS, APP_VERSION } = require('../../lib/constants');
const { TimeServerBoundCluster } = require('../../lib/TimeCluster');

const DRIVER_NAME = 'Ekaza Smart Siren';

// ─── Tuya Datapoints ─────────────────────────────────────────────────────────
// Confirmed by ZigBee sniffer (TS0601 / _TZE204_q76rtoa9)
const DP = {
  VOLUME:   5,   // enum    0=low  1=medium  2=high  (sniffer originally noted inverse; corrected by user testing)
  DURATION: 7,   // value   alarm duration in seconds (0–1800)
  ALARM:    13,  // bool    alarm active (true=on, false=off)
  BATTERY:  15,  // value   battery level 0–100 %
  MELODY:   21,  // enum    sound type 0–17 (18 melodies)
};

// ─── Melody name lookup (mirrors alarmtune dropdown labels in driver.compose.json) ──
const MELODY_NAMES = [
  'Doorbell Chime',           // 0
  'Für Elise',                // 1
  'Westminster Chimes',       // 2
  'Fast Double Doorbell',     // 3
  'William Tell Overture',    // 4
  'Turkish March',            // 5
  'Safe / Security Alarm',    // 6
  'Chemical Spill Alert',     // 7
  'Piercing Alarm Clock',     // 8
  'Smoke Alarm',              // 9
  'Dog Barking',              // 10
  'Police Siren',             // 11
  'Doorbell Chime (reverb)',  // 12
  'Mechanical Telephone',     // 13
  'Fire / Ambulance',         // 14
  '3/1 Elevator',             // 15
  'Buzzing Alarm Clock',      // 16
  'School Bell',              // 17
];

const DEFAULT_MELODY = 5;  // Turkish March
const DEFAULT_VOLUME = 2;  // high

// The device has 3 volume levels (wire 0 low, 1 medium, 2 high). Homey's standard volume_set
// capability is 0..1, driver.compose.json limits it to 3 stops (0, 0.5, 1) so the slider shows
// the native speaker +/- volume control.
// Presets of the siren_duration picker (seconds; the capability value is the seconds as a string).
// Settings keep the exact seconds; the picker shows the nearest preset.
const DURATION_PRESETS = [3, 5, 10, 30, 60, 120, 300, 600, 1800];
const nearestDuration = sec => String(DURATION_PRESETS.reduce(
  (best, p) => (Math.abs(p - sec) < Math.abs(best - sec) ? p : best), DURATION_PRESETS[0]));

const volumeToWire = v => (v < 0.34 ? 0 : v < 0.67 ? 1 : 2);
const wireToVolume = w => w / 2;

// ─────────────────────────────────────────────────────────────────────────────

class EkazaSiren extends TuyaSpecificClusterDevice {

  async onNodeInit({ zclNode }) {
    await super.onNodeInit({ zclNode });

    this.log(`${DRIVER_NAME} v${APP_VERSION}`);
    try { zclNode.endpoints[1].bind('time', new TimeServerBoundCluster()); } catch {}
    this.printNode();

    this._alarmAutoResetTimer = null;

    // Migrate existing paired devices: add is_availability if missing
    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability').catch(err => this.error('addCapability is_availability:', err));

    // Availability management (non-fatal: getNode() may fail on first pairing)
    try {
      this._availability = new AvailabilityManagerPassive(this, {
        timeout: HEARTBEAT_FAST_MS,
      });
      await this._availability.install();
    } catch (err) {
      this.error('[Siren] AvailabilityManager install failed (non-fatal):', err.message);
      this._availability = null;
    }

    this._setupTuyaListeners(zclNode);

    // Melody and volume used to be settings (alarmtune / alarmvolume). Melody is a picker on the
    // device screen now and volume the standard volume_set slider with 3 stops (a second picker
    // would be merged into the same dropdown as the melody one). Add them to devices paired
    // before, seeded from the old settings when Homey still has them, else from the defaults
    // (the device reports its real values on the next DP report and the controls follow).
    // 'siren_volume' and 'siren_volume_level' only existed in development builds.
    for (const stale of ['siren_volume', 'siren_volume_level']) {
      if (this.hasCapability(stale))
        await this.removeCapability(stale).catch(err => this.error(`removeCapability ${stale}:`, err));
    }
    if (!this.hasCapability('siren_melody')) {
      await this.addCapability('siren_melody').catch(err => this.error('addCapability siren_melody:', err));
      await this.setCapabilityValue('siren_melody', String(this.getSetting('alarmtune') ?? DEFAULT_MELODY)).catch(() => {});
    }
    if (!this.hasCapability('volume_set')) {
      await this.addCapability('volume_set').catch(err => this.error('addCapability volume_set:', err));
      await this.setCapabilityValue('volume_set', wireToVolume(Number(this.getSetting('alarmvolume') ?? DEFAULT_VOLUME))).catch(() => {});
    }

    if (!this.hasCapability('siren_duration')) {
      await this.addCapability('siren_duration').catch(err => this.error('addCapability siren_duration:', err));
    }
    // The picker always mirrors the Settings value (the exact seconds live in Settings).
    await this.setCapabilityValue('siren_duration', nearestDuration(Number(this.getSetting('alarmsoundtime') ?? 10))).catch(() => {});

    this.registerCapabilityListener('onoff', v => this._onCapabilityOnOff(v));
    this.registerCapabilityListener('siren_melody', v => this._setMelody(Number(v)));
    this.registerCapabilityListener('siren_duration', v => this._setDuration(Number(v)));
    this.registerCapabilityListener('volume_set', v => this._setVolume(volumeToWire(Number(v))));

    this.log('Ekaza Siren ready');
  }

  // ─── Tuya cluster listeners ────────────────────────────────────────────────

  _setupTuyaListeners(zclNode) {
    const tuya = zclNode.endpoints[1]?.clusters?.tuya;
    if (!tuya) { this.error('Tuya cluster not found on EP1'); return; }

    const dispatch = async (data) => {
      await this._processDatapoint(data).catch(e => this.error('DP dispatch error:', e));
    };

    tuya.on('reporting', dispatch);
    tuya.on('response',  dispatch);
    tuya.on('datapoint', dispatch);
    this.log('Tuya listeners attached');
  }

  // ─── Datapoint → capability / setting ────────────────────────────────────

  async _processDatapoint(data) {
    const value = this._parseDataValue(data);
    if (value === null || value === undefined) return;

    switch (data.dp) {

      // ── alarm active ──────────────────────────────────────────────────────
      case DP.ALARM:
        // The OFF reported for the stop we send while retrying a start is not a real stop.
        if (!value && this._retryingStart) { this.log('Alarm: OFF (start retry)'); break; }
        if (value && this._alarmOnWaiter) this._alarmOnWaiter();
        if (this.getCapabilityValue('onoff') !== value)
          await this.setCapabilityValue('onoff', value)
            .catch(e => this.error('alarm update:', e));
        // Device reports stopped → cancel auto-reset + fire deactivated trigger
        if (!value) {
          clearTimeout(this._alarmAutoResetTimer);
          this._alarmAutoResetTimer = null;
          this._triggerFlow('siren_deactivated', { reason: 'auto' });
        }
        this.log(`Alarm: ${value ? 'ON' : 'OFF'}`);
        break;

      // ── battery level ─────────────────────────────────────────────────────
      case DP.BATTERY:
        if (typeof value === 'number' && value >= 0 && value <= 100)
          await this.setCapabilityValue('measure_battery', value)
            .catch(e => this.error('battery update:', e));
        this.log(`Battery: ${value}%`);
        break;

      // ── volume (volume_set slider, wire 0-2 -> 0 / 0.5 / 1) ──
      // Volume, duration and melody reports are only logged. Homey (screen, Settings or a
      // "Set ..." flow action) is the source of truth, and every start re-sends the three, so
      // the device never overwrites what you chose (a flow's siren_play is a one-shot).
      case DP.VOLUME:
        this.log(`Volume: ${value} (device report, not mirrored)`);
        break;

      case DP.DURATION:
        this.log(`Duration: ${value}s (device report, not mirrored)`);
        break;

      case DP.MELODY:
        this.log(`Melody: ${value} (${MELODY_NAMES[value] ?? `Melody ${value}`}) (device report, not mirrored)`);
        break;
    }
  }

  // ─── Capability → device ──────────────────────────────────────────────────

  async _onCapabilityOnOff(value) {
    if (value) {
      await this._startSiren();
    } else {
      await this._stopSiren();
    }
  }

  /**
   * Start siren using the melody picker, the volume slider and the duration setting.
   * Sends melody + volume + duration before triggering.
   */
  async _startSiren() {
    const melody   = Number(this.getCapabilityValue('siren_melody') ?? DEFAULT_MELODY);
    const volume   = this._currentVolumeWire();  // 2=high
    const duration = Number(this.getSetting('alarmsoundtime') ?? 10);

    await this._playSiren(melody, volume, duration);
  }

  /**
   * Play siren with explicit parameters (used by flow action).
   * @param {number} melody   Wire melody 0–17
   * @param {number} volume   Wire volume 0–2
   * @param {number} duration Seconds 1–1800
   */
  async _playSiren(melody, volume, duration) {
    this.log(`Siren: melody=${melody}, volume=${volume}, duration=${duration}s`);

    // Send configuration before triggering alarm
    await this.sendBulkCommands([
      { type: 'enum',   dp: DP.MELODY,   value: melody   },
      { type: 'enum',   dp: DP.VOLUME,   value: volume   },
      { type: 'data32', dp: DP.DURATION, value: duration },
    ], 200);

    // Trigger alarm. The device sometimes ignores the first start right after a melody change
    // (it answers SUCCESS but never reports the alarm as ON), so the start is confirmed.
    if (!(await this._startAlarm())) {
      this.error('Siren did not confirm the start');
      throw new Error('The siren did not start');
    }

    // Schedule UI auto-reset (device does not send DP13=false automatically)
    if (duration > 0) {
      clearTimeout(this._alarmAutoResetTimer);
      this._alarmAutoResetTimer = this.homey.setTimeout(async () => {
        await this.setCapabilityValue('onoff', false).catch(() => {});
        this._triggerFlow('siren_deactivated', { reason: 'auto' });
        this._alarmAutoResetTimer = null;
        this.log('Siren auto-reset after duration');
      }, (duration + 2) * 1000);
    }

    this._triggerFlow('siren_activated', { duration });
    this.log('Siren started');
  }

  /**
   * Change the alarm duration (picker and flow action): Settings keep the exact seconds, the
   * picker shows the nearest preset. The last change wins, wherever it was made.
   * @param {number} seconds 1-1800
   */
  async _setDuration(seconds) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error('Duration must be 1-1800 s');
    await this.writeValue(DP.DURATION, seconds)
      .catch(err => { this.error('Duration write:', err.message); throw err; });
    await this.setSettings({ alarmsoundtime: seconds }).catch(err => this.error('Duration setting:', err.message));
    await this.setCapabilityValue('siren_duration', nearestDuration(seconds)).catch(() => {});
    this.log(`Duration -> ${seconds}s`);
  }

  /**
   * Switch the alarm on and wait for the device to report it (DP13 = true, normally within
   * ~100 ms). If it does not, retry once the way that works in practice: stop, then start.
   * @returns {Promise<boolean>} true once the device reported the alarm as ON
   */
  async _startAlarm() {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          this.log('Siren: start not confirmed, retrying (stop, then start)');
          this._retryingStart = true;
          await this.writeBool(DP.ALARM, false).catch(() => {});
          await new Promise(resolve => this.homey.setTimeout(resolve, 300));
        }
        const confirmed = this._waitAlarmOn(1500);
        await this.writeBool(DP.ALARM, true);
        if (await confirmed) return true;
      }
      return false;
    } finally {
      this._retryingStart = false;
    }
  }

  /** Resolves true when the device reports the alarm ON (see _processDatapoint), false on timeout. */
  _waitAlarmOn(ms) {
    return new Promise(resolve => {
      const timer = this.homey.setTimeout(() => { this._alarmOnWaiter = null; resolve(false); }, ms);
      this._alarmOnWaiter = () => {
        this.homey.clearTimeout(timer);
        this._alarmOnWaiter = null;
        resolve(true);
      };
    });
  }

  /**
   * Change the melody used when the siren is switched on (picker and flow action).
   * @param {number} melody Wire melody 0-17
   */
  async _setMelody(melody) {
    if (!Number.isInteger(melody) || melody < 0 || melody > 17) throw new Error('Melody must be 0-17');
    await this.writeEnum(DP.MELODY, melody)
      .catch(err => { this.error('Melody write:', err.message); throw err; });
    await this.setCapabilityValue('siren_melody', String(melody)).catch(() => {});
    this.log(`Melody -> ${melody} (${MELODY_NAMES[melody] ?? melody})`);
  }

  /** Volume currently selected on the device screen, as the wire value 0-2. */
  _currentVolumeWire() {
    const v = this.getCapabilityValue('volume_set');
    return typeof v === 'number' ? volumeToWire(v) : DEFAULT_VOLUME;
  }

  /**
   * Change the volume used when the siren is switched on (slider and flow action).
   * @param {number} volume Wire volume 0-2
   */
  async _setVolume(volume) {
    if (!Number.isInteger(volume) || volume < 0 || volume > 2) throw new Error('Volume must be 0-2');
    await this.writeEnum(DP.VOLUME, volume)
      .catch(err => { this.error('Volume write:', err.message); throw err; });
    await this.setCapabilityValue('volume_set', wireToVolume(volume)).catch(() => {});
    this.log(`Volume -> ${volume}`);
  }

  /**
   * Stop siren immediately.
   */
  async _stopSiren() {
    await this.writeBool(DP.ALARM, false);
    clearTimeout(this._alarmAutoResetTimer);
    this._alarmAutoResetTimer = null;
    this._triggerFlow('siren_deactivated', { reason: 'manual' });
    this.log('Siren stopped');
  }

  /**
   * Fire a device trigger flow card.
   */
  _triggerFlow(flowId, tokens = {}) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard(flowId);
      if (trigger) trigger.trigger(this, tokens, {});
    } catch (err) {
      this.error(`Flow trigger ${flowId} failed:`, err);
    }
  }

  // ─── Settings → device ────────────────────────────────────────────────────

  async onSettings({ changedKeys, newSettings }) {
    for (const key of changedKeys) {
      switch (key) {

        case 'alarmsoundtime': {
          const duration = Number(newSettings.alarmsoundtime);
          if (duration < 1 || duration > 1800) throw new Error('Duration must be 1–1800s');
          await this.writeValue(DP.DURATION, duration)
            .catch(err => { this.error('Duration write:', err.message); throw err; });
          await this.setCapabilityValue('siren_duration', nearestDuration(duration)).catch(() => {});
          this.log(`Duration → ${duration}s`);
          break;
        }
      }
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  // _teardown is invoked by both onUninit (re-init/restart) and onDeleted
  // (user removal) via TuyaSpecificClusterDevice. Clearing the timer here
  // prevents a leaked auto-reset timeout on app restart.
  async _teardown() {
    clearTimeout(this._alarmAutoResetTimer);
    await super._teardown();
  }

  onDeleted() {
    this._teardown();
    this.log('Ekaza Siren removed');
  }
}

module.exports = EkazaSiren;
