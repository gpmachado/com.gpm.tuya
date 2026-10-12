'use strict';

/**
 * @file HourlyMessageStats.js
 * @description Hourly message counters for the Traffic tab in the app settings, in memory only.
 * Kept apart from the availability policy: the statistics never influence availability decisions.
 * It stores one counter per clock hour (the current one and the previous 23), not one timestamp
 * per frame. The settings page reads currentHour, previousHour, last24h and lastMessageAt.
 */

const HOUR_MS = 60 * 60 * 1000;
const BUCKETS = 24;

class HourlyMessageStats {

  constructor() {
    this.buckets = {};          // hour start (ms) -> messages in that hour
    this.lastMessageAt = null;
  }

  record(timestamp = Date.now()) {
    this._prune(timestamp);
    const hour = this._hourStart(timestamp);
    this.buckets[hour] = (this.buckets[hour] || 0) + 1;
    this.lastMessageAt = timestamp;
  }

  summary(timestamp = Date.now()) {
    this._prune(timestamp);
    const hour = this._hourStart(timestamp);
    return {
      currentHour: this.buckets[hour] || 0,
      previousHour: this.buckets[hour - HOUR_MS] || 0,
      last24h: Object.values(this.buckets).reduce((sum, n) => sum + n, 0),
      lastMessageAt: this.lastMessageAt,
    };
  }

  reset() {
    this.buckets = {};
    this.lastMessageAt = null;
  }

  // Drop the hours that fell out of the 24 h window.
  _prune(timestamp) {
    const oldest = this._hourStart(timestamp) - ((BUCKETS - 1) * HOUR_MS);
    for (const hour of Object.keys(this.buckets)) {
      if (Number(hour) < oldest) delete this.buckets[hour];
    }
  }

  _hourStart(timestamp) {
    return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
  }
}

module.exports = { HourlyMessageStats };
