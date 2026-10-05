'use strict';

/**
 * @file HourlyMessageStats.js
 * @description Hourly message counters for the Traffic tab in the app settings. Kept apart
 * from the availability policy: the statistics never influence availability decisions.
 */

const MESSAGE_STATS_VERSION = 1;
const MESSAGE_STATS_HOUR_MS = 60 * 60 * 1000;
const MESSAGE_STATS_BUCKETS = 24;

/**
 * Compact hourly message counter. It stores only the current clock hour and
 * the previous 23 buckets instead of retaining one timestamp per frame.
 */
class HourlyMessageStats {

  constructor(snapshot = null) {
    this.total = Number.isFinite(snapshot?.total) ? snapshot.total : 0;
    this.lastMessageAt = Number.isFinite(snapshot?.lastMessageAt)
      ? snapshot.lastMessageAt
      : null;
    this.buckets = this._normalizeBuckets(snapshot?.buckets);
    this.prune();
  }

  record(source = 'unknown', timestamp = Date.now()) {
    const key = String(this._hourStart(timestamp));
    const normalizedSource = this._normalizeSource(source);
    this.prune(timestamp);

    if (!this.buckets[key]) this.buckets[key] = { total: 0, bySource: {} };
    this.buckets[key].total += 1;
    this.buckets[key].bySource[normalizedSource] =
      (this.buckets[key].bySource[normalizedSource] || 0) + 1;
    this.total += 1;
    this.lastMessageAt = timestamp;
  }

  summary(timestamp = Date.now()) {
    this.prune(timestamp);
    const currentHourStart = this._hourStart(timestamp);
    const previousHourStart = currentHourStart - MESSAGE_STATS_HOUR_MS;
    const hourly = [];
    const bySource = {};
    let last24h = 0;

    for (let index = MESSAGE_STATS_BUCKETS - 1; index >= 0; index--) {
      const start = currentHourStart - (index * MESSAGE_STATS_HOUR_MS);
      const bucket = this.buckets[String(start)] || { total: 0, bySource: {} };
      hourly.push({ start, total: bucket.total });
      last24h += bucket.total;

      for (const [source, count] of Object.entries(bucket.bySource)) {
        bySource[source] = (bySource[source] || 0) + count;
      }
    }

    return {
      version: MESSAGE_STATS_VERSION,
      currentHour: this.buckets[String(currentHourStart)]?.total || 0,
      previousHour: this.buckets[String(previousHourStart)]?.total || 0,
      last24h,
      averagePerHour: Math.round((last24h / MESSAGE_STATS_BUCKETS) * 10) / 10,
      total: this.total,
      lastMessageAt: this.lastMessageAt,
      bySource,
      hourly,
    };
  }

  serialize(timestamp = Date.now()) {
    this.prune(timestamp);
    return {
      version: MESSAGE_STATS_VERSION,
      total: this.total,
      lastMessageAt: this.lastMessageAt,
      buckets: this.buckets,
    };
  }

  reset() {
    this.total = 0;
    this.lastMessageAt = null;
    this.buckets = {};
  }

  prune(timestamp = Date.now()) {
    const oldest = this._hourStart(timestamp)
      - ((MESSAGE_STATS_BUCKETS - 1) * MESSAGE_STATS_HOUR_MS);
    for (const key of Object.keys(this.buckets)) {
      if (!Number.isFinite(Number(key)) || Number(key) < oldest) delete this.buckets[key];
    }
  }

  _normalizeBuckets(buckets) {
    if (!buckets || typeof buckets !== 'object' || Array.isArray(buckets)) return {};
    const normalized = {};

    for (const [key, bucket] of Object.entries(buckets)) {
      const timestamp = Number(key);
      if (!Number.isFinite(timestamp) || !bucket || typeof bucket !== 'object') continue;
      const total = Number.isFinite(bucket.total) && bucket.total >= 0
        ? Math.floor(bucket.total)
        : 0;
      const bySource = {};

      if (bucket.bySource && typeof bucket.bySource === 'object') {
        for (const [source, count] of Object.entries(bucket.bySource)) {
          if (Number.isFinite(count) && count > 0) {
            bySource[this._normalizeSource(source)] = Math.floor(count);
          }
        }
      }
      normalized[String(timestamp)] = { total, bySource };
    }
    return normalized;
  }

  _hourStart(timestamp) {
    return Math.floor(timestamp / MESSAGE_STATS_HOUR_MS) * MESSAGE_STATS_HOUR_MS;
  }

  _normalizeSource(source) {
    return String(source || 'unknown').slice(0, 64);
  }
}

module.exports = { HourlyMessageStats };
