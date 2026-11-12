'use strict';

/**
 * @file device.js
 * @description Tuya TS0207 Rain Sensor.
 * Manufacturers: _TZ3000_u9mio4qb
 * Protocol: ZCL IAS Zone (cluster 0x0500), battery-powered.
 * Zone type: waterSensor. The Tuya app shows only the rain state and the
 * battery level; its "Rain reminder push" and "Lower battery" switches are
 * cloud notifications, not device attributes.
 *
 * Same IAS Zone + battery structure as ../doorwindowsensor_2 (a sleepy end
 * device: no polling, enrollment and battery reporting retried on wake-up).
 *
 * IAS Zone zoneStatus bitmap (ZCL spec 8.2.2.2.1.6):
 *   Bit 0 (0x0001) alarm1   -> alarm_water (raining = true)
 *   Bit 3 (0x0008) battery  -> alarm_battery (low battery = true)
 *
 * Dry delay: the plate flickers between wet and dry while drops land on it
 * (field log: 9 changes in 13 s). alarm_water turns on at once and only turns
 * off after the plate stayed dry for `rain_clear_delay` minutes (setting).
 *
 * Availability: AvailabilityManagerPassive with the 24 h door-sensor tier. The
 * sensor can stay quiet for days without rain, so the tier still has to be
 * checked against a real log (battery reports or check-ins inside 24 h).
 */

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');
const { AvailabilityManagerPassive } = require('../../lib/AvailabilityManager');
const { TimeServerBoundCluster } = require('../../lib/TimeCluster');
const IASZoneHelper = require('../../lib/IASZoneHelper');
const { APP_VERSION, DOOR_SENSOR_HEARTBEAT_MS } = require('../../lib/constants');

// -----------------------------------------------------------------------------

const DRIVER_NAME  = 'Rain Sensor';
const ENDPOINT_ID  = 1;
const IAS_ZONE_ID  = 1;

// IAS zoneStatus bitmask positions (ZCL spec 8.2.2.2.1.6)
const IAS_BIT_ALARM1   = 0x0001; // raining
const IAS_BIT_BATTERY  = 0x0008; // low battery

const BATTERY_REPORT_MAX_INTERVAL_S = 14400; // 4 h
const BATTERY_REPORT_MIN_INTERVAL_S = 3600;  // 1 h
const BATTERY_REPORT_MIN_CHANGE = 1;

// -----------------------------------------------------------------------------

class RainSensorDevice extends ZigBeeDevice {

  // --- Init --------------------------------------------------------------

  /**
   * @param {object} params
   * @param {import('zigbee-clusters').ZCLNode} params.zclNode
   */
  async onNodeInit({ zclNode }) {
    this.log(`${DRIVER_NAME} v${APP_VERSION} - init`);
    this.printNode();
    // The node's address next to the device id of every log line: ties a Zigbee frame, a sniffer
    // capture or a binding error to the device it came from.
    this.log(`[Node] ieee=${this.getData()?.ieeeAddress ?? '-'} nwk=${this.node?.networkAddress ?? '-'}`);
    this._zclNode = zclNode;
    this._batteryReportingConfigured = false;
    this._batteryReportingConfiguring = false;
    this._lastBatteryReportingAttemptTs = 0;

    if (!this.hasCapability('is_availability'))
      await this.addCapability('is_availability')
        .catch(err => this.error('addCapability is_availability:', err));

    this._availability = new AvailabilityManagerPassive(this, {
      timeout: DOOR_SENSOR_HEARTBEAT_MS,
    });
    await this._availability.install();

    this._bindTimeServerCluster(zclNode);
    await this._setupIASZone(zclNode);
    await this._setupBatteryReporting(zclNode);

    await this.ready();
    this.log(`${DRIVER_NAME} - ready`);
  }

  // --- IAS Zone ----------------------------------------------------------

  /**
   * Configure IAS Zone cluster: enroll, listen for status changes, write CIE Address.
   * @param {import('zigbee-clusters').ZCLNode} zclNode
   */
  async _setupIASZone(zclNode) {
    this._iasHelper = new IASZoneHelper(this, {
      endpointId: ENDPOINT_ID,
      zoneId: IAS_ZONE_ID,
      configureCieAddress: true,
      onActivity: source => {
        this._notifyAvailability(source);
        this._retryBatteryReportingOnWake(source);
      },
      onStatus: zoneStatus => this._applyZoneStatus(zoneStatus),
    });

    this._iasZone = await this._iasHelper.init(zclNode);
  }

  // --- Battery -----------------------------------------------------------

  /**
   * Listen for battery percentage reports and configure periodic reporting.
   * @param {import('zigbee-clusters').ZCLNode} zclNode
   */
  async _setupBatteryReporting(zclNode) {
    const powerConfiguration = zclNode.endpoints[ENDPOINT_ID].clusters.powerConfiguration;
    if (!powerConfiguration) {
      this.log('[Battery] Power Configuration cluster missing on endpoint 1');
      return;
    }
    this._powerConfiguration = powerConfiguration;
    this._absorbLateGlobalResponses(powerConfiguration);

    this._onBatteryPercentage ??= value => {
      this._applyBatteryPercentage(value, 'battery');
    };
    powerConfiguration.removeListener('attr.batteryPercentageRemaining', this._onBatteryPercentage);
    powerConfiguration.on('attr.batteryPercentageRemaining', this._onBatteryPercentage);

    if (!this.isFirstInit()) {
      this.log('[Battery] Initial read/reporting deferred until wake');
      return;
    }

    try {
      const attrs = await powerConfiguration.readAttributes(['batteryPercentageRemaining']);
      if (attrs.batteryPercentageRemaining !== undefined) {
        this._applyBatteryPercentage(attrs.batteryPercentageRemaining, 'battery-read');
      }
    } catch (err) {
      this.log('[Battery] Could not read initial battery percentage (non-fatal):', err.message);
    }

    await this._configureBatteryReporting('init');
  }

  /**
   * Configure periodic battery reporting. A sleepy sensor often rejects this
   * at app boot, so IAS wake-ups retry it.
   * @param {string} source
   */
  async _configureBatteryReporting(source) {
    if (this._batteryReportingConfigured || this._batteryReportingConfiguring) return;

    this._batteryReportingConfiguring = true;
    this._lastBatteryReportingAttemptTs = Date.now();
    try {
      await this.configureAttributeReporting([{
        endpointId:    ENDPOINT_ID,
        cluster:       CLUSTER.POWER_CONFIGURATION,
        attributeName: 'batteryPercentageRemaining',
        minInterval:   BATTERY_REPORT_MIN_INTERVAL_S,
        maxInterval:   BATTERY_REPORT_MAX_INTERVAL_S,
        minChange:     BATTERY_REPORT_MIN_CHANGE,
      }]);
      this._batteryReportingConfigured = true;
      this.log(`[Battery] Reporting configured (${source})`);
    } catch (err) {
      this.log(`Battery reporting config failed (${source}, non-fatal):`, err.message);
    } finally {
      this._batteryReportingConfiguring = false;
    }
  }

  // --- Zone status -------------------------------------------------------

  /**
   * Parse IAS zoneStatus bitmap and update capabilities.
   * @param {number|Buffer|object} zoneStatus
   */
  _applyZoneStatus(zoneStatus) {
    const bitmap = IASZoneHelper.toUint16(zoneStatus);
    const raining = !!(bitmap & IAS_BIT_ALARM1);
    const batteryLow = !!(bitmap & IAS_BIT_BATTERY);

    this.log(`[IAS] raining=${raining} batteryLow=${batteryLow} (0x${bitmap.toString(16).padStart(4, '0')})`);

    this._applyRain(raining);
    this._setCapSafe('alarm_battery', batteryLow);
  }

  /**
   * Rain turns on at once; dry only after the plate stayed dry for the
   * configured delay. A new wet report cancels a pending dry.
   * @param {boolean} raining
   */
  _applyRain(raining) {
    if (raining) {
      if (this._dryTimer) {
        this.homey.clearTimeout(this._dryTimer);
        this._dryTimer = null;
        this.log('[Rain] wet again, dry cancelled');
      }
      this._setCapSafe('alarm_water', true);
      return;
    }

    const delayMin = Number(this.getSetting('rain_clear_delay')) || 0;
    if (delayMin <= 0 || this.getCapabilityValue('alarm_water') !== true) {
      this._setCapSafe('alarm_water', false);
      return;
    }
    if (this._dryTimer) return;

    this.log(`[Rain] dry, turning off in ${delayMin} min unless wet again`);
    this._dryTimer = this.homey.setTimeout(() => {
      this._dryTimer = null;
      this.log('[Rain] stayed dry, rain off');
      this._setCapSafe('alarm_water', false);
    }, delayMin * 60_000);
  }

  // --- Availability ------------------------------------------------------

  onEndDeviceAnnounce() {
    this.log('Device rejoined network (End Device Announce)');
    this._notifyAvailability('rejoin');
    this._iasHelper?.retryOnWake('rejoin').catch(() => {});
    this._retryBatteryReportingOnWake('end-device-announce');
  }

  async onBecameAvailable() {
    this.log('Device became available');
  }

  async onBecameUnavailable(reason) {
    this.log(`Device became unavailable (${reason})`);
  }

  // --- Helpers -----------------------------------------------------------

  /**
   * Set capability only when value changes; silently skip missing capabilities.
   * @param {string} capability
   * @param {*} value
   */
  _setCapSafe(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value)
      .catch(err => this.error(`Failed to set ${capability}:`, err.message));
  }

  /**
   * Convert ZCL batteryPercentageRemaining (0-200) to Homey percent (0-100).
   * 0xFF means "unknown" and is ignored.
   * @param {number} value
   * @param {string} source
   */
  _applyBatteryPercentage(value, source) {
    if (typeof value !== 'number' || value > 200) return;
    const percentage = Math.max(0, Math.min(100, Math.round(value / 2)));
    this._notifyAvailability(source);
    this.log(`[Battery] ${percentage}% (raw=${value})`);
    this._setCapSafe('measure_battery', percentage);
  }

  /**
   * Explicit activity marker for events that may not pass through handleFrame.
   * @param {string} source
   */
  _notifyAvailability(source) {
    this._availability?.notifyActivity?.(source).catch(() => {});
  }

  /**
   * Retry battery reporting when the sensor is known to be awake.
   * @param {string} source
   */
  _retryBatteryReportingOnWake(source) {
    if (this._batteryReportingConfigured || !this._zclNode) return;
    const now = Date.now();
    if ((now - this._lastBatteryReportingAttemptTs) < 60_000) return;
    this._configureBatteryReporting(`${source}-wake`).catch(err => {
      this.log(`Battery reporting retry failed (${source}, non-fatal):`, err.message);
    });
  }

  /**
   * Sleepy devices may repeat global responses after the transaction handler
   * has already resolved or timed out. Absorb them so zigbee-clusters does not
   * log unknown_command_received for successful reads/reporting configuration.
   * @param {object} cluster
   */
  _absorbLateGlobalResponses(cluster) {
    if (!cluster || cluster._homeSuiteLateResponseHandlers) return;
    cluster._homeSuiteLateResponseHandlers = true;

    const noop = () => {};
    cluster['onReadAttributes.response'] = noop;
    cluster['onReadAttributesStructured.response'] = noop;
    cluster['onConfigureReporting.response'] = noop;
    cluster.onDefaultResponse = noop;
  }

  _bindTimeServerCluster(zclNode) {
    try {
      const endpoint = zclNode.endpoints[ENDPOINT_ID];
      if (!endpoint) return;
      endpoint.bind('time', new TimeServerBoundCluster({ getTimeZone: () => this.homey.clock.getTimezone() }));
      this.log('[Time] Silent bound cluster installed');
    } catch (err) {
      this.log('[Time] Silent bind skipped:', err.message);
    }
  }

  // --- Lifecycle ---------------------------------------------------------

  async onUninit() {
    this.homey.clearTimeout(this._dryTimer);
    this._iasHelper?.dispose();
    this._powerConfiguration?.removeListener?.('attr.batteryPercentageRemaining', this._onBatteryPercentage);
    await this._availability?.uninstall().catch(() => {});
  }

  onDeleted() {
    this.homey.clearTimeout(this._dryTimer);
    this._iasHelper?.dispose();
    this._powerConfiguration?.removeListener?.('attr.batteryPercentageRemaining', this._onBatteryPercentage);
    this._availability?.uninstall().catch(() => {});
    this.log(`${DRIVER_NAME} - removed`);
  }

}

module.exports = RainSensorDevice;
