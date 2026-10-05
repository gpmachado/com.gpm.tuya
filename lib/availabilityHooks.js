'use strict';

/**
 * @file availabilityHooks.js
 * @description The inbound and outbound hooks of AvailabilityManagerPassive, kept apart from
 * the availability policy (timeouts, poll-before-offline, sibling cascade), which stays in
 * AvailabilityManager.js. Applied to the Passive manager's prototype, so the methods run
 * with `this` as the manager and use its _messageStats, _markAlive and _onSendFailure.
 *
 * - inbound: wraps node.handleFrame and treats every frame as a sign of life;
 * - outbound: wraps zclNode.sendFrame and hands "Could not reach device" to _onSendFailure.
 */

const { ZCL_DEBUG } = require('./constants');
const { FrameMiddleware, FRAME_PRIORITY } = require('./FrameMiddleware');

class AvailabilityHooks {

  // Moes/Tuya addition (ZCL_DEBUG only): one line per inbound frame, used to measure each device's
  // heartbeat and to find its boot-only frames (see RejoinManager.watchBootSignals).
  _logFrame(endpointId, clusterId, frame) {
    if (!ZCL_DEBUG) return;
    const hex = Buffer.isBuffer(frame) ? frame.toString('hex') : '';
    this.device.log(`[Availability] frame ep${endpointId} cl:0x${clusterId.toString(16)} ${hex}`);
  }

  _logBasicFrameNeedingResponse(endpointId, clusterId, frame) {
    if (!ZCL_DEBUG) return;
    if (clusterId !== 0 || !Buffer.isBuffer(frame) || frame.length < 3) return;

    const frameControl = frame[0];
    const directionToClient = (frameControl & 0x08) !== 0;
    const disableDefaultResponse = (frameControl & 0x10) !== 0;
    const sequenceNumber = frame[1];
    const commandId = frame[2];

    if (directionToClient && !disableDefaultResponse && commandId === 0x0a) {
      this.device.log(
        `[Availability] Basic report expects default response: ep${endpointId} seq=${sequenceNumber} cmd=0x${commandId.toString(16)}`,
      );
    }
  }

  async _installHandleFrameHook() {
    const node = await this.device.homey.zigbee.getNode(this.device);
    if (!node) throw new Error('[Availability] Failed to get ZigBee node');

    if (node._availabilityHookInstalled) {
      // AvailabilityManagerPassive must be installed on exactly one device per
      // Zigbee node (the main/EP1 device). A second instance here would run
      // its own watchdog against a node it never receives frames from,
      // silently going stale while the physical device stays online.
      throw new Error(
        '[Availability] node.handleFrame already hooked - install AvailabilityManagerPassive '
        + 'on exactly one device per Zigbee node.',
      );
    }

    this._zigbeeNode = node;
    // Runs at FRAME_PRIORITY.AVAILABILITY, the lowest number (dispatched first): this is what
    // guarantees it sees every single frame, before any later layer gets a chance to swallow one
    // (see the priority table in FrameMiddleware.js). It never returns false itself.
    FrameMiddleware.for(node).register('availability', FRAME_PRIORITY.AVAILABILITY,
      (endpointId, clusterId, frame) => {
        this._logBasicFrameNeedingResponse(endpointId, clusterId, frame);
        this._logFrame(endpointId, clusterId, frame);
        this._messageStats.record(`ep${endpointId}:0x${clusterId.toString(16)}`);
        // Fire-and-forget: availability bookkeeping (Store I/O, sibling cascade)
        // must not serialize the frame path.
        this._markAlive(`ep${endpointId} cl:0x${clusterId.toString(16)}`)
          .catch(e => this.device.error('[Availability] handleFrame hook error:', e.message));
      });

    node._availabilityHookInstalled = true;
    this._frameHookInstalled = true;
    this.device.log('[Availability] handleFrame hook installed');
  }

  /**
   * Outbound evidence, the counterpart of the passive inbound hook: when Homey
   * cannot deliver a command or read ("Could not reach device"), that is a much
   * faster signal than waiting out the idle timeout. Wraps zclNode.sendFrame - the
   * function every cluster call goes through - and hands such failures to
   * _onSendFailure(), which confirms with a poll before marking unavailable.
   */
  _installSendFailureHook() {
    const zclNode = this.device.zclNode;
    if (!zclNode || typeof zclNode.sendFrame !== 'function') return;

    const original = zclNode.sendFrame;
    const wrapped = async (...args) => {
      if (!this._sendObserved) {
        // Proof that the hook really sees outbound traffic (a zigbee-clusters change
        // that binds sendFrame earlier would silently disable it - no line, no hook).
        this._sendObserved = true;
        if (this.options.logIdle) this.device.log('[Availability] Send-failure hook observed its first outbound frame');
      }
      try {
        return await original(...args);
      } catch (err) {
        this._onSendFailure(err);
        throw err;
      }
    };
    this._zclNodeForSend = zclNode;
    this._originalZclSendFrame = original;
    this._wrappedZclSendFrame = wrapped;
    zclNode.sendFrame = wrapped;
  }

  /**
   * Restore what the install methods replaced. The frame hook is only restored (or removed)
   * by the layer that installed it, and the send hook only when it is still the current
   * sendFrame, so a wrapper added by someone else after us is never overwritten.
   */
  _removeHooks() {
    if (this._zclNodeForSend) {
      if (this._zclNodeForSend.sendFrame === this._wrappedZclSendFrame) {
        this._zclNodeForSend.sendFrame = this._originalZclSendFrame;
      }
      this._zclNodeForSend = null;
      this._originalZclSendFrame = null;
      this._wrappedZclSendFrame = null;
    }
    if (this._zigbeeNode) {
      FrameMiddleware.unregister(this._zigbeeNode, 'availability');
      this._zigbeeNode._availabilityHookInstalled = false;
      this._zigbeeNode = null;
    }
    this._frameHookInstalled = false;
    this._sendObserved = false;
  }
}

/**
 * @param {Function} target class whose prototype receives the hook methods
 */
function applyAvailabilityHooks(target) {
  for (const name of Object.getOwnPropertyNames(AvailabilityHooks.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(
      target.prototype,
      name,
      Object.getOwnPropertyDescriptor(AvailabilityHooks.prototype, name),
    );
  }
}

module.exports = { applyAvailabilityHooks };
