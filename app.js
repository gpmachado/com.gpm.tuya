'use strict';

const Homey = require('homey');
const { debug } = require('zigbee-clusters');
const { ZCL_DEBUG } = require('./lib/constants');

const { registerCustomClusters } = require('./lib/clusterRegistry');
registerCustomClusters();

// --- ZCL debug verbosity ------------------------------------------------------
// true  -> verbose ZCL frame logging (useful during development / sniffing)
// false -> silent (production)
// Flip ZCL_DEBUG in lib/constants.js instead of hunting across every device.js.
debug(ZCL_DEBUG);
// -----------------------------------------------------------------------------


class MyTuyaApp extends Homey.App {

  async onInit() {
    // First line of every log: which build is running (and whether frame dumps are on).
    this.log(`My Tuya Devices v${this.homey.manifest?.version ?? '?'} started (ZCL_DEBUG ${ZCL_DEBUG ? 'on' : 'off'})`);
    this._registerFlowCards();

    // Baseline for the settings-page "Rejoins" counter - only set once;
    // resetRejoinStats (api.js) moves it forward when the user resets.
    if (!this.homey.settings.get('rejoin_tracking_since')) {
      this.homey.settings.set('rejoin_tracking_since', Date.now());
    }
  }

  _registerFlowCards() {
    // Condition: availability is on (reads available state natively)
    this.homey.flow.getConditionCard('availability_is_on')
      .registerRunListener(async ({ device }) => {
        return device.getAvailable();
      });
  }

};

module.exports = MyTuyaApp;
