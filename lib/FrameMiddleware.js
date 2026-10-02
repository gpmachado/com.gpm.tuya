'use strict';

/**
 * @file FrameMiddleware.js
 * @description A single `node.handleFrame` per Zigbee node, with named handlers run in priority
 * order instead of each layer wrapping the previous one. Ported from com.gpm.sonoff; in use by
 * AvailabilityManagerPassive, RejoinManager (watchAnnounceFrame / watchBootSignals) and the
 * moes_remote_4_gang button interceptor.
 *
 * Fixes, versus an earlier sketch of this idea:
 * - The original handler is stored as-is (no `.bind()`), so restoring it puts back the exact
 *   same function reference the node had before, not a new bound copy.
 * - `unregister()` restores `node.handleFrame` itself once the handler list is empty; there is
 *   no separate `dispose()` step to remember to call.
 * - A teardown path uses the static `unregister(node, id)`, which never installs a middleware
 *   on a node that does not already have one - removing something that was never added is a
 *   no-op, not a fresh wrap-then-immediately-restore.
 *
 * What a handler must be: a synchronous function `(endpointId, clusterId, frame, meta) => result`.
 * Async work (a Zigbee read/write, a store write) must be fire-and-forget with its own `.catch()`,
 * the same convention every hook in this app already follows - this middleware's `try/catch`
 * only guards against a handler throwing synchronously, not against a later promise rejection.
 * Return `false` to swallow the frame (stop the chain and skip the original handler and any
 * lower-priority ones); return anything else (including nothing) to let it continue.
 *
 * Handler id and scope: pass a node-level id (the same string regardless of which device
 * instance is installing it) for anything that must exist once per node no matter how many
 * devices share it - a multi-gang node (MINI-ZB2GS) runs `onNodeInit` once per gang. Pass a
 * device-specific id (e.g. including `device.getData().id`) only when the handler's own logic
 * is genuinely per-device. Registering the same node-level concept under different per-device
 * ids installs one duplicate handler per device sharing the node - this module cannot detect
 * that misuse, so the convention has to be followed by the caller.
 *
 * @example
 * const { FrameMiddleware, FRAME_PRIORITY } = require('../lib/FrameMiddleware');
 * const mw = FrameMiddleware.for(this.node);
 * mw.register('rejoin', FRAME_PRIORITY.REJOIN, (endpointId, clusterId, frame) => { ... });
 * // later, in _teardown():
 * FrameMiddleware.unregister(this.node, 'rejoin');
 */

const FRAME_PRIORITY = {
  // The rule: a handler that never returns `false` (an "observer") must have a lower number than
  // any handler that can swallow a frame it needs to see - the dispatch loop stops at the first
  // `false`, so a swallower running earlier hides that frame from every observer after it
  // (AVAILABILITY would stop counting it as activity/traffic, REJOIN would miss a boot signal).
  // Both observers sit below 10 so that can't happen as long as every swallower (CLUSTER_REPORT
  // and anything added later) stays at 10 or above.
  AVAILABILITY: 0,
  REJOIN: 5,
  CLUSTER_REPORT: 20,
};

class FrameMiddleware {

  constructor(node) {
    if (node._frameMiddleware) return node._frameMiddleware;

    this.node = node;
    this._handlers = [];
    this._original = node.handleFrame || null;
    node.handleFrame = (...args) => this._dispatch(args);
    node._frameMiddleware = this;
  }

  /** Get (or create) the middleware for this node. */
  static for(node) {
    if (!node) throw new Error('FrameMiddleware.for: node required');
    return node._frameMiddleware || new FrameMiddleware(node);
  }

  /** Read-only lookup: never installs a middleware. Safe to call from a teardown path. */
  static get(node) {
    return node ? (node._frameMiddleware || null) : null;
  }

  /**
   * Remove a handler by id. A no-op if this node has no middleware installed (nothing was ever
   * registered on it, or the last handler already removed itself) - never creates one just to
   * find it empty.
   */
  static unregister(node, id) {
    FrameMiddleware.get(node)?._unregister(id);
  }

  /**
   * @param {string} id unique id for this handler; registering again with the same id replaces it
   * @param {number} priority lower runs first
   * @param {(endpointId: number, clusterId: number, frame: Buffer, meta: object) => (false|void)} fn
   */
  register(id, priority, fn) {
    // A same-id replace must never trip the "list went empty" restore below: filter directly,
    // without going through unregister()/_unregister(), which is for an actual removal.
    this._handlers = this._handlers.filter(h => h.id !== id);
    this._handlers.push({ id, priority, fn });
    this._handlers.sort((a, b) => a.priority - b.priority);
  }

  unregister(id) {
    this._unregister(id);
  }

  _unregister(id) {
    const before = this._handlers.length;
    this._handlers = this._handlers.filter(h => h.id !== id);
    if (this._handlers.length === 0 && before > 0) this._restore();
  }

  _restore() {
    if (this._original) this.node.handleFrame = this._original;
    else delete this.node.handleFrame;
    delete this.node._frameMiddleware;
  }

  /** Diagnostic: handler ids in the order they run. */
  listHandlers() {
    return this._handlers.map(h => ({ id: h.id, priority: h.priority }));
  }

  _dispatch(args) {
    const [endpointId, clusterId, frame, meta] = args;
    for (const { id, fn } of this._handlers) {
      try {
        if (fn(endpointId, clusterId, frame, meta) === false) return Promise.resolve();
      } catch (err) {
        // A bug in one handler must never block the frame path or the handlers after it.
        console.error(`[FrameMiddleware] handler '${id}' error:`, err.message);
      }
    }
    if (this._original) return this._original.apply(this.node, args);
    return false;
  }
}

module.exports = { FrameMiddleware, FRAME_PRIORITY };
