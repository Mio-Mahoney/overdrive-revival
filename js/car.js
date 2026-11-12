// One car: its live state and the commands the rest of the app may give it.
//
// A Car sits on top of a link (ble.js on real hardware, sim.js in demo mode)
// and speaks protocol.js. It knows nothing about tracks, races or the screen.
//
// Events:
//   'state'       ()                    something in car.state changed
//   'tx'          (bytes)               a message was sent
//   'rx'          (bytes, message)      a message arrived, already decoded
//   'position'    (message)             the car read a location code
//   'transition'  (message)             the car crossed onto the next track piece
//   'delocalized' ()                    the car lost the track
//   'special'     ()                    the car drove over a Fast & Furious special piece
//   'note'        (text, level)         lifecycle and errors, for the debug log
//   'gone'        ({ intentional })     disconnected for good

import { Emitter } from './emitter.js';
import * as protocol from './protocol.js';

/**
 * Speeds in mm/s. Below the minimum the cars read the track unreliably and
 * will not change lanes; above the maximum they tend to leave it on curves.
 */
export const SPEED = Object.freeze({ MIN: 300, MAX: 1000, STEP: 50 });

const DRIVE_ACCEL = 1000; // mm/s^2
const STOP_ACCEL = 2500; // mm/s^2: brake harder than we accelerate
const LANE_CHANGE_SPEED = 300; // mm/s sideways
const LANE_CHANGE_ACCEL = 2500; // mm/s^2 sideways

// A single lithium cell: about 4.2 V full, and the car browns out a little above 3.3 V.
const BATTERY_EMPTY_MV = 3300;
const BATTERY_FULL_MV = 4200;
export const LOW_BATTERY_PERCENT = 15;

const BATTERY_POLL_MS = 20000;
// A car can ignore SDK mode in the first moments after it connects, so it is sent more than once.
const SDK_MODE_REPEAT_MS = [150, 300];
const REPORT_FRESH_MS = 1500; // a reported speed older than this is stale, the car has stopped

export function batteryPercent(millivolts) {
  if (!Number.isFinite(millivolts)) return null;
  const fraction = (millivolts - BATTERY_EMPTY_MV) / (BATTERY_FULL_MV - BATTERY_EMPTY_MV);
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class Car extends Emitter {
  #link;
  #clock;
  #outbox = [];
  #sending = false;
  #batteryTimer = null;
  #identifyTimer = null;
  #handshakeTimers = [];
  #unsubscribe = [];

  /**
   * @param {object} link see the link contract at the top of ble.js
   * @param {{name: string, color: string, clock?: () => number}} options
   */
  constructor(link, { name, color, clock = () => performance.now() }) {
    super();
    this.#link = link;
    this.#clock = clock;
    this.id = link.id;
    this.name = name;
    this.color = color;
    this.state = {
      /** @type {'connecting' | 'ready' | 'reconnecting' | 'gone'} */
      connection: 'connecting',
      millivolts: null,
      version: null,
      commandedSpeed: 0,
      reportedSpeed: 0,
      reportedAt: -Infinity,
      offset: null,
      pieceId: null,
      locationId: null,
      delocalized: false,
      onCharger: false,
      lightsOn: false,
    };
    this.#unsubscribe.push(
      link.on('message', (bytes) => this.#receive(bytes)),
      link.on('drop', () => this.#onDrop()),
      link.on('restore', () => this.#onRestore()),
      link.on('disconnect', (info) => this.#onGone(info)),
    );
  }

  get isReady() {
    return this.state.connection === 'ready';
  }

  get batteryPercent() {
    return batteryPercent(this.state.millivolts);
  }

  /** Speed the car last reported, or 0 once those reports stop coming (a parked car sends none). */
  get speed() {
    return this.#clock() - this.state.reportedAt <= REPORT_FRESH_MS ? this.state.reportedSpeed : 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect() {
    this.#note('Connecting');
    try {
      await this.#link.open();
    } catch (error) {
      this.#note(`Connection failed: ${error.message}`, 'error');
      this.#onGone({ intentional: false });
      throw error;
    }
    this.#note('Connected, notifications on');
    this.#handshake();
  }

  /** SDK mode has to be the first command: without it the car ignores driving commands. */
  #handshake() {
    this.#patch({ connection: 'ready', commandedSpeed: 0, delocalized: false });
    this.#send(protocol.sdkMode(true));
    this.#clearHandshakeTimers();
    this.#handshakeTimers = SDK_MODE_REPEAT_MS.map((wait) =>
      setTimeout(() => {
        if (this.isReady) this.#send(protocol.sdkMode(true));
      }, wait),
    );
    this.#send(protocol.versionRequest());
    this.#send(protocol.batteryRequest());
    clearInterval(this.#batteryTimer);
    this.#batteryTimer = setInterval(() => this.requestBattery(), BATTERY_POLL_MS);
  }

  #clearHandshakeTimers() {
    for (const timer of this.#handshakeTimers) clearTimeout(timer);
    this.#handshakeTimers = [];
  }

  async disconnect() {
    if (this.state.connection === 'gone') return;
    this.#note('Disconnecting');
    if (this.isReady) {
      // Park the car and say goodbye before the radio link goes away.
      this.#outbox.length = 0;
      this.#send(this.#speedMessage(0));
      this.#send(protocol.disconnect());
      await this.#drained();
    }
    await this.#link.close();
  }

  #onDrop() {
    this.#outbox.length = 0;
    clearInterval(this.#batteryTimer);
    this.#clearHandshakeTimers();
    this.#patch({ connection: 'reconnecting', commandedSpeed: 0 });
    this.#note('Connection lost, trying to reconnect', 'warn');
  }

  #onRestore() {
    this.#note('Reconnected');
    this.#handshake();
  }

  #onGone({ intentional }) {
    if (this.state.connection === 'gone') return;
    clearInterval(this.#batteryTimer);
    clearTimeout(this.#identifyTimer);
    this.#clearHandshakeTimers();
    this.#outbox.length = 0;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#patch({ connection: 'gone', commandedSpeed: 0 });
    this.#note(intentional ? 'Disconnected' : 'Connection lost', intentional ? 'info' : 'error');
    this.emit('gone', { intentional });
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * @param {number} speed mm/s. 0 stops; anything else is held inside the range the cars handle.
   */
  setSpeed(speed) {
    if (!this.isReady) return;
    const target = speed > 0 ? clamp(Math.round(speed), SPEED.MIN, SPEED.MAX) : 0;
    if (target === this.state.commandedSpeed) return;
    this.#patch({ commandedSpeed: target });
    // Dragging a slider asks for dozens of speeds a second. Only the newest matters.
    this.#send(this.#speedMessage(target), 'speed');
  }

  #speedMessage(speed) {
    const extended = (this.state.version ?? 0) >= protocol.EXTENDED_SET_SPEED_FROM_VERSION;
    return protocol.setSpeed(speed, speed === 0 ? STOP_ACCEL : DRIVE_ACCEL, { extended });
  }

  /** Stops now, ahead of anything else waiting to be sent. */
  stop() {
    if (!this.isReady) return;
    this.#outbox = this.#outbox.filter((entry) => entry.key !== 'speed' && entry.key !== 'lane');
    this.#patch({ commandedSpeed: 0 });
    this.#outbox.unshift({ key: 'speed', bytes: this.#speedMessage(0) });
    this.#pump();
  }

  /** Tells the car where it is across the road, in mm from the centre line. */
  setOffset(offsetMm) {
    if (!this.isReady) return;
    this.#send(protocol.setOffset(offsetMm), 'offset');
  }

  /** Moves the car sideways to a position in mm from the centre line, in the car's own frame. */
  changeLane(offsetMm) {
    if (!this.isReady) return;
    this.#send(protocol.changeLane(offsetMm, LANE_CHANGE_SPEED, LANE_CHANGE_ACCEL), 'lane');
  }

  setLights(on) {
    if (!this.isReady) return;
    this.#patch({ lightsOn: Boolean(on) });
    this.#send(protocol.setLights(protocol.lightMask({ HEADLIGHTS: on, FRONTLIGHTS: on, BRAKELIGHTS: on })), 'lights');
  }

  /** Steady engine-light colour, each component 0-1. */
  setEngineColor(red, green, blue) {
    if (!this.isReady) return;
    this.#send(protocol.engineColor(red, green, blue), 'engine');
  }

  /** Flashes the engine light in one colour for a moment, then returns to `restore`. */
  flashEngine([red, green, blue], restore = [0, 0, 0], durationMs = 900) {
    if (!this.isReady) return;
    const level = (value) => Math.round(value * protocol.MAX_LIGHT_INTENSITY);
    const channel = (id, value) => ({
      channel: id,
      effect: protocol.LIGHT_EFFECT.THROB,
      start: 0,
      end: level(value),
      cyclesPer10s: 40,
    });
    this.#send(
      protocol.lightsPattern([
        channel(protocol.LIGHT_CHANNEL.RED, red),
        channel(protocol.LIGHT_CHANNEL.GREEN, green),
        channel(protocol.LIGHT_CHANNEL.BLUE, blue),
      ]),
      'engine',
    );
    clearTimeout(this.#identifyTimer);
    this.#identifyTimer = setTimeout(() => this.setEngineColor(...restore), durationMs);
  }

  requestBattery() {
    if (this.isReady) this.#send(protocol.batteryRequest(), 'battery');
  }

  ping() {
    if (this.isReady) this.#send(protocol.ping());
  }

  requestVersion() {
    if (this.isReady) this.#send(protocol.versionRequest());
  }

  /** Sends bytes exactly as given. For the debug panel. */
  sendRaw(bytes) {
    if (this.isReady) this.#send(bytes);
  }

  // -------------------------------------------------------------------------
  // Sending: one write at a time, in order
  // -------------------------------------------------------------------------

  /**
   * @param {Uint8Array} bytes
   * @param {string} [key] commands with the same key replace each other while they wait,
   *   so a burst of speed changes costs one radio write, not thirty.
   */
  #send(bytes, key) {
    const waiting = key ? this.#outbox.find((entry) => entry.key === key) : null;
    if (waiting) {
      waiting.bytes = bytes;
    } else {
      this.#outbox.push({ key, bytes });
    }
    this.#pump();
  }

  async #pump() {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (this.#outbox.length > 0 && this.isReady) {
        const { bytes } = this.#outbox.shift();
        // Logged before the write so a reply can never appear ahead of its request.
        this.emit('tx', bytes);
        try {
          await this.#link.write(bytes);
        } catch (error) {
          this.#note(`Send failed (${protocol.describe(bytes)}): ${error.message}`, 'error');
        }
      }
    } finally {
      this.#sending = false;
    }
  }

  /** Resolves once everything queued so far has been written. */
  async #drained() {
    while (this.#sending || (this.#outbox.length > 0 && this.isReady)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  #receive(bytes) {
    const message = protocol.decode(bytes);
    this.emit('rx', bytes, message);
    switch (message.id) {
      case protocol.MSG.BATTERY_RESPONSE:
        if (message.millivolts !== undefined) this.#patch({ millivolts: message.millivolts });
        break;
      case protocol.MSG.VERSION_RESPONSE:
        if (message.version !== undefined) this.#patch({ version: message.version });
        break;
      case protocol.MSG.POSITION_UPDATE:
        this.#patch({
          pieceId: message.pieceId ?? null,
          locationId: message.locationId ?? null,
          offset: message.offset ?? this.state.offset,
          reportedSpeed: message.speed ?? 0,
          reportedAt: this.#clock(),
          delocalized: false,
        });
        this.emit('position', message);
        break;
      case protocol.MSG.TRANSITION_UPDATE:
        this.#patch({ offset: message.offset ?? this.state.offset, delocalized: false });
        this.emit('transition', message);
        break;
      case protocol.MSG.OFFSET_UPDATE:
        if (message.offset !== undefined) this.#patch({ offset: message.offset });
        break;
      case protocol.MSG.DELOCALIZED:
        // The car stops itself when it loses the track, so the next speed command must be sent afresh.
        this.#patch({ delocalized: true, reportedSpeed: 0, commandedSpeed: 0 });
        this.emit('delocalized');
        break;
      case protocol.MSG.STATUS:
        if (message.onCharger !== undefined) this.#patch({ onCharger: message.onCharger });
        break;
      case protocol.MSG.SPECIAL_PIECE:
        this.emit('special');
        break;
      default:
        break;
    }
  }

  #patch(changes) {
    let changed = false;
    for (const [key, value] of Object.entries(changes)) {
      if (this.state[key] !== value) {
        this.state[key] = value;
        changed = true;
      }
    }
    if (changed) this.emit('state');
  }

  #note(text, level = 'info') {
    this.emit('note', text, level);
  }
}
