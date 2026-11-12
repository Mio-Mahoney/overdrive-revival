// Simulated cars on a simulated track, for demo mode (open the app with ?sim)
// and for the tests. A SimLink has the same shape as the Bluetooth link in
// ble.js and speaks the same bytes, so everything above it runs unchanged.
//
// This is a stand-in for the screens and the game rules, not evidence about
// real cars: it encodes the same assumptions the app makes about them.

import { Emitter } from './emitter.js';
import { MSG, PARSE_FLAGS, decode } from './protocol.js';

const STEP_MS = 20;
const ROAD_HALF_WIDTH_MM = 80; // past this a car has driven off the side
const CODE_LANES = 16;
const CODE_LANE_SPACING_MM = 9;

// Location codes per code lane, by piece shape: [count for lanes below `split`, count from `split` on].
const SHAPES = Object.freeze({
  straight: { length: 560, split: 0, codes: [3, 3], wheels: [36, 36] },
  curve: { length: 440, split: 10, codes: [2, 3], wheels: [33, 41] },
  grid: { length: 340, split: 0, codes: [2, 2], wheels: [34, 34] },
  line: { length: 220, split: 0, codes: [1, 1], wheels: [22, 22] },
  special: { length: 560, split: 9, codes: [2, 3], wheels: [36, 36] },
});

const piece = (id, shape, reversed = false) => ({ id, shape, reversed, ...SHAPES[shape] });

/** A loop made from the Fast & Furious kit: start piece, straights, a special piece and six curves. */
export const DEFAULT_LAYOUT = Object.freeze([
  piece(34, 'grid'),
  piece(33, 'line'),
  piece(39, 'straight'),
  piece(17, 'curve'),
  piece(18, 'curve'),
  piece(57, 'special'),
  piece(20, 'curve'),
  piece(40, 'straight', true),
  piece(36, 'straight'),
  piece(23, 'curve'),
  piece(24, 'curve'),
  piece(27, 'curve'),
]);

const moveToward = (value, target, maxStep) =>
  Math.abs(target - value) <= maxStep ? target : value + Math.sign(target - value) * maxStep;

function locationId(layoutPiece, codeLane, along) {
  const { split, codes } = layoutPiece;
  const before = Math.min(codeLane, split) * codes[0] + Math.max(0, codeLane - split) * codes[1];
  return before + along;
}

class SimCar {
  constructor(world, index) {
    this.world = world;
    this.link = new SimLink(this, `sim-${index + 1}`);
    this.sdkMode = false;
    this.speed = 0;
    this.targetSpeed = 0;
    this.accel = 1000;
    // Cars start side by side on the grid, in the two middle lanes.
    this.lateral = index % 2 === 0 ? -22.5 : 22.5;
    this.frameShift = this.lateral; // the car believes it starts at offset 0
    this.laneTarget = null;
    this.laneSpeed = 0;
    this.pieceIndex = 0;
    this.along = 120 + 40 * Math.floor(index / 2); // mm into the current piece
    this.codesRead = 0;
    this.millivolts = 4080 - index * 140;
    this.delocalized = false;
  }

  get reportedOffset() {
    return this.lateral - this.frameShift;
  }

  get piece() {
    return this.world.layout[this.pieceIndex];
  }

  receive(bytes) {
    const message = decode(bytes);
    switch (message.id) {
      case MSG.SDK_MODE:
        this.sdkMode = message.on;
        break;
      case MSG.PING_REQUEST:
        this.send([1, MSG.PING_RESPONSE]);
        break;
      case MSG.VERSION_REQUEST:
        this.send([3, MSG.VERSION_RESPONSE, 0x66, 0x26]);
        break;
      case MSG.BATTERY_REQUEST:
        this.send([3, MSG.BATTERY_RESPONSE, this.millivolts & 0xff, this.millivolts >> 8]);
        break;
      case MSG.SET_SPEED:
        if (!this.sdkMode) break; // a real car ignores driving commands outside SDK mode
        this.targetSpeed = Math.max(0, message.speed);
        this.accel = Math.max(1, message.accel);
        if (this.targetSpeed > 0) this.delocalized = false; // put back on the track and driven again
        break;
      case MSG.SET_OFFSET:
        this.frameShift = this.lateral - message.offset;
        break;
      case MSG.CHANGE_LANE:
        if (!this.sdkMode) break;
        this.laneTarget = message.offset;
        this.laneSpeed = message.horizontalSpeed;
        break;
      case MSG.CANCEL_LANE_CHANGE:
        this.laneTarget = null;
        break;
      default:
        break;
    }
  }

  send(values) {
    this.link.emit('message', Uint8Array.from(values));
  }

  /** Test hook: what happens when a car is knocked off the track. */
  delocalize() {
    this.delocalized = true;
    this.speed = 0;
    this.targetSpeed = 0;
    this.laneTarget = null;
    this.send([1, MSG.DELOCALIZED]);
  }

  step(dtMs) {
    if (!this.link.isOpen || this.delocalized) return;
    const dt = dtMs / 1000;
    this.speed = moveToward(this.speed, this.targetSpeed, this.accel * dt);
    if (this.speed <= 0) return;

    if (this.laneTarget !== null) {
      const next = moveToward(this.reportedOffset, this.laneTarget, this.laneSpeed * dt);
      this.lateral = next + this.frameShift;
      if (next === this.laneTarget) this.laneTarget = null;
      if (Math.abs(this.lateral) > ROAD_HALF_WIDTH_MM) {
        this.delocalize();
        return;
      }
    }

    this.millivolts = Math.max(3300, this.millivolts - this.speed * dt * 0.00002);
    this.along += this.speed * dt;
    this.#readCodes();
    while (this.along >= this.piece.length) {
      this.along -= this.piece.length;
      this.pieceIndex = (this.pieceIndex + 1) % this.world.layout.length;
      this.codesRead = 0;
      this.#sendTransition();
      if (this.piece.shape === 'special') this.send([1, MSG.SPECIAL_PIECE]);
      this.#readCodes();
    }
  }

  get #codeLane() {
    const lane = Math.round(this.lateral / CODE_LANE_SPACING_MM + (CODE_LANES - 1) / 2);
    return Math.min(CODE_LANES - 1, Math.max(0, lane));
  }

  /** Emits a position update for each location code the car has passed on this piece. */
  #readCodes() {
    const current = this.piece;
    const lane = this.#codeLane;
    const printedLane = current.reversed ? CODE_LANES - 1 - lane : lane;
    const count = current.codes[printedLane < current.split ? 0 : 1];
    while (this.codesRead < count && this.along >= ((this.codesRead + 0.5) / count) * current.length) {
      const along = current.reversed ? count - 1 - this.codesRead : this.codesRead;
      this.#sendPosition(locationId(current, printedLane, along), current);
      this.codesRead += 1;
    }
  }

  #sendPosition(location, current) {
    const bytes = new Uint8Array(17);
    const view = new DataView(bytes.buffer);
    bytes[0] = 16;
    bytes[1] = MSG.POSITION_UPDATE;
    bytes[2] = location;
    bytes[3] = current.id;
    view.setFloat32(4, this.reportedOffset, true);
    view.setUint16(8, Math.round(this.speed), true);
    bytes[10] = 0x07 | (current.reversed ? PARSE_FLAGS.REVERSE_PARSING : 0);
    view.setUint16(15, Math.round(this.targetSpeed), true);
    this.link.emit('message', bytes);
  }

  #sendTransition() {
    const bytes = new Uint8Array(18);
    const view = new DataView(bytes.buffer);
    bytes[0] = 17;
    bytes[1] = MSG.TRANSITION_UPDATE;
    view.setFloat32(4, this.reportedOffset, true);
    const previous = this.world.layout[(this.pieceIndex - 1 + this.world.layout.length) % this.world.layout.length];
    [bytes[16], bytes[17]] = previous.wheels;
    this.link.emit('message', bytes);
  }
}

class SimLink extends Emitter {
  #car;
  #open = false;

  constructor(car, id) {
    super();
    this.#car = car;
    this.id = id;
    this.name = 'Drive (simulated)';
  }

  get isOpen() {
    return this.#open;
  }

  async open() {
    this.#open = true;
    this.#car.world.wake();
  }

  async write(bytes) {
    if (!this.#open) throw new Error('Car is not connected');
    this.#car.receive(bytes);
  }

  async close() {
    if (!this.#open) return;
    this.#open = false;
    this.#car.world.remove(this.#car);
    this.emit('disconnect', { intentional: true });
  }
}

export class SimWorld {
  #cars = [];
  #timer = null;
  #lastStepAt = 0;
  #created = 0;

  /**
   * @param {{layout?: typeof DEFAULT_LAYOUT, realtime?: boolean}} [options]
   *   realtime false: nothing moves until advance() is called. For tests.
   */
  constructor({ layout = DEFAULT_LAYOUT, realtime = true } = {}) {
    this.layout = layout;
    this.realtime = realtime;
  }

  get cars() {
    return [...this.#cars];
  }

  /** @returns a link to hand to `new Car(link, ...)` */
  addCar() {
    const car = new SimCar(this, this.#created);
    this.#created += 1;
    this.#cars.push(car);
    return car.link;
  }

  /** The simulated car behind a link, for test hooks such as delocalize(). */
  carFor(link) {
    return this.#cars.find((car) => car.link === link) ?? null;
  }

  remove(car) {
    this.#cars = this.#cars.filter((other) => other !== car);
    if (this.#cars.length === 0 && this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  wake() {
    if (!this.realtime || this.#timer !== null) return;
    this.#lastStepAt = performance.now();
    this.#timer = setInterval(() => {
      const now = performance.now();
      // A background tab throttles timers: catch up, but never by more than a second.
      this.advance(Math.min(1000, now - this.#lastStepAt));
      this.#lastStepAt = now;
    }, STEP_MS);
  }

  /** Moves every car forward by `ms` of simulated time. */
  advance(ms, onStep = () => {}) {
    for (let remaining = ms; remaining > 0; remaining -= STEP_MS) {
      const dt = Math.min(STEP_MS, remaining);
      for (const car of this.#cars) car.step(dt);
      onStep(dt);
    }
  }
}
