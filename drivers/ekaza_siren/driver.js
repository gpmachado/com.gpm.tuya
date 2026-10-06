'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class EkazaSirenDriver extends ZigBeeDriver {

  async onInit() {
    await super.onInit();
    this.log('initialized');

    // Action: play with specific melody + duration (volume is the one selected on the device)
    this.homey.flow
      .getActionCard('siren_play')
      .registerRunListener(async (args) => {
        const melody   = Number(args.melody);
        const duration = Number(args.duration);
        const volume   = args.device._currentVolumeWire();
        await args.device._playSiren(melody, volume, duration);
      });

    // Actions: change the melody / volume used when the siren is switched on (do not start it)
    this.homey.flow
      .getActionCard('siren_set_melody')
      .registerRunListener(async (args) => {
        await args.device._setMelody(Number(args.melody));
      });

    this.homey.flow
      .getActionCard('siren_set_volume')
      .registerRunListener(async (args) => {
        await args.device._setVolume(Number(args.volume));
      });

    this.homey.flow
      .getActionCard('siren_set_duration')
      .registerRunListener(async (args) => {
        await args.device._setDuration(Number(args.duration));
      });

    // Action: stop siren immediately
    this.homey.flow
      .getActionCard('siren_stop')
      .registerRunListener(async (args) => {
        await args.device._stopSiren();
      });

    // Condition: is siren currently playing?
    this.homey.flow
      .getConditionCard('is_playing')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('onoff') === true;
      });
  }

}

module.exports = EkazaSirenDriver;
