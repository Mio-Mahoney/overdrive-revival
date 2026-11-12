// The track: a map of its pieces built by a scan lap, each car's position on
// that map, and where each car sits across the road.
//
// No Bluetooth and no DOM here. Everything is driven by the events a Car emits.

import { Emitter } from './emitter.js';
import { SPEED } from './car.js';

// ---------------------------------------------------------------------------
// Track pieces
// ---------------------------------------------------------------------------

export const PIECE = Object.freeze({
  START: 'start',
  STRAIGHT: 'straight',
  CURVE: 'curve',
  POWER_ZONE: 'powerzone',
  INTERSECTION: 'intersection',
  UNKNOWN: 'unknown',
});

export const PIECE_LABELS = Object.freeze({
  [PIECE.START]: 'Start / finish',
  [PIECE.STRAIGHT]: 'Straight',
  [PIECE.CURVE]: 'Curve',
  [PIECE.POWER_ZONE]: 'Power Zone',
  [PIECE.INTERSECTION]: 'Intersection',
  [PIECE.UNKNOWN]: 'Unknown',
});

/** Types a player may assign to a piece the app does not recognise. */
export const TAGGABLE_TYPES = Object.freeze([PIECE.STRAIGHT, PIECE.CURVE, PIECE.START, PIECE.POWER_ZONE]);

// Piece ids as reported in position updates. They come from community projects
// (MasterAirscrachDev/Anki-Partydrive, adessoSE/anki-drive-java), not from the
// SDK. A piece missing here shows as Unknown and the player tags it once, and a
// wrong guess can be corrected the same way (see TrackMap.tag).
const KNOWN_PIECES = new Map([
  // One physical start piece reads as two: the grid (34), then the finish line (33).
  [34, PIECE.START],
  [33, PIECE.START],
  ...[36, 39, 40, 48, 51].map((id) => [id, PIECE.STRAIGHT]),
  ...[17, 18, 20, 23, 24, 27].map((id) => [id, PIECE.CURVE]),
  [10, PIECE.INTERSECTION],
  // Fast & Furious special pieces. Which of the three is the Power Zone is not
  // documented anywhere, so all three count until a scan of the real kit says otherwise.
  ...[53, 54, 57].map((id) => [id, PIECE.POWER_ZONE]),
]);

/** @param {number} id @param {Record<number, string>} [tags] player-assigned types, which win */
export function pieceType(id, tags = {}) {
  return tags[id] ?? KNOWN_PIECES.get(id) ?? PIECE.UNKNOWN;
}

const MIN_LOOP_PIECES = 4; // the smallest closed layout is longer than this, so shorter repeats are noise

export class TrackMap extends Emitter {
  #ids;
  #tags;

  /**
   * @param {number[]} pieceIds one lap of piece ids in driving order
   * @param {Record<number, string>} [tags] player-assigned piece types by piece id
   */
  constructor(pieceIds, tags = {}) {
    super();
    this.#ids = [...pieceIds];
    this.#tags = { ...tags };
    this.#rotateToStart();
  }

  get length() {
    return this.#ids.length;
  }

  get tags() {
    return { ...this.#tags };
  }

  idAt(index) {
    return this.#ids[index];
  }

  typeAt(index) {
    return pieceType(this.#ids[index], this.#tags);
  }

  /** Every index where a piece with this id sits. A layout may use the same id twice. */
  indicesOf(id) {
    const indices = [];
    this.#ids.forEach((pieceId, index) => {
      if (pieceId === id) indices.push(index);
    });
    return indices;
  }

  hasType(type) {
    return this.#ids.some((_, index) => this.typeAt(index) === type);
  }

  /** Ids on this track the app could not classify and the player has not tagged yet. */
  get unknownIds() {
    return [...new Set(this.#ids.filter((id) => pieceType(id, this.#tags) === PIECE.UNKNOWN))];
  }

  /** Assigns a type to every piece with this id. Pass null to go back to the built-in type. */
  tag(id, type) {
    if (type === null) delete this.#tags[id];
    else this.#tags[id] = type;
    this.#rotateToStart();
    this.emit('change');
  }

  /**
   * Lap counting treats entering index 0 as crossing the line, so index 0 must be
   * the finish-line end of the start piece: the last id of the start run. Cars
   * waiting on the grid then sit on the final index, just behind the line.
   */
  #rotateToStart() {
    const count = this.#ids.length;
    const isStart = (index) => this.typeAt((index + count) % count) === PIECE.START;
    const line = this.#ids.findIndex((_, index) => isStart(index) && !isStart(index + 1));
    if (line > 0) this.#ids = [...this.#ids.slice(line), ...this.#ids.slice(0, line)];
  }

  toJSON() {
    return { version: 1, pieces: [...this.#ids], tags: { ...this.#tags } };
  }

  /** @returns {TrackMap|null} null when the stored data is not a usable map */
  static fromJSON(json) {
    const pieces = json?.pieces;
    if (!Array.isArray(pieces) || pieces.length < MIN_LOOP_PIECES) return null;
    if (!pieces.every((id) => Number.isInteger(id) && id >= 0 && id <= 255)) return null;
    const tags = {};
    for (const [id, type] of Object.entries(json.tags ?? {})) {
      if (TAGGABLE_TYPES.includes(type)) tags[Number(id)] = type;
    }
    return new TrackMap(pieces, tags);
  }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const sameRun = (sequence, a, b, length) => {
  for (let i = 0; i < length; i += 1) {
    if (sequence[a + i] === null || sequence[a + i] !== sequence[b + i]) return false;
  }
  return true;
};

/**
 * Finds one full lap in the pieces a scanning car has driven over so far.
 *
 * @param {(number|null)[]} sequence piece ids in the order driven; null is a piece whose id was not read
 * @param {Record<number, string>} [tags]
 * @returns {number[]|null} one lap of piece ids, or null if no lap is certain yet
 */
export function findLoop(sequence, tags = {}) {
  // Every layout has exactly one start piece, so two sightings of it bracket one lap.
  for (let i = 0; i < sequence.length; i += 1) {
    if (sequence[i] === null || pieceType(sequence[i], tags) !== PIECE.START) continue;
    for (let j = i + MIN_LOOP_PIECES; j < sequence.length; j += 1) {
      if (sequence[j] !== sequence[i]) continue;
      const lap = sequence.slice(i, j);
      if (lap.includes(null)) break; // a piece went unread: wait for the next lap
      return lap;
    }
  }
  if (sequence.some((id) => id !== null && pieceType(id, tags) === PIECE.START)) return null;

  // No start piece we recognise. Accept a lap only once a second lap has repeated it
  // piece for piece, because a layout can contain the same pair of pieces twice.
  for (let length = MIN_LOOP_PIECES; length * 2 <= sequence.length; length += 1) {
    for (let i = 0; i + length * 2 <= sequence.length; i += 1) {
      if (sameRun(sequence, i, i + length, length)) return sequence.slice(i, i + length);
    }
  }
  return null;
}

const SCAN_SPEED = 350; // mm/s: slow enough to read every piece
const SCAN_SILENCE_MS = 6000;
const SCAN_MAX_PIECES = 120;

/**
 * Drives one car slowly until it has seen a full lap, then reports the map.
 *
 * Events: 'progress' (pieceIds so far), 'done' (TrackMap), 'failed' (reason text)
 */
export class TrackScanner extends Emitter {
  #car;
  #clock;
  #tags;
  #sequence = [];
  #current = null; // the piece being driven over: { id: number|null }
  #lastHeardAt = 0;
  #watchdog = null;
  #unsubscribe = [];
  #running = false;

  /** @param {import('./car.js').Car} car @param {{tags?: Record<number,string>, clock?: () => number}} [options] */
  constructor(car, { tags = {}, clock = () => performance.now() } = {}) {
    super();
    this.#car = car;
    this.#tags = tags;
    this.#clock = clock;
  }

  get running() {
    return this.#running;
  }

  /** Piece ids seen so far, including the piece the car is on. */
  get pieces() {
    return this.#current ? [...this.#sequence, this.#current.id] : [...this.#sequence];
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#sequence = [];
    this.#current = null;
    this.#lastHeardAt = this.#clock();
    this.#unsubscribe = [
      this.#car.on('position', (message) => this.#onPosition(message)),
      this.#car.on('transition', () => this.#onTransition()),
      this.#car.on('delocalized', () => this.#fail('The car left the track. Put it back and scan again.')),
      this.#car.on('gone', () => this.#fail('The car disconnected during the scan.')),
    ];
    this.#watchdog = setInterval(() => this.#checkSilence(), 1000);
    this.#car.setSpeed(SCAN_SPEED);
  }

  cancel() {
    if (!this.#running) return;
    this.#finish();
  }

  #onPosition(message) {
    this.#lastHeardAt = this.#clock();
    const id = message.pieceId;
    if (id === undefined) return;
    if (!this.#current) {
      this.#current = { id };
    } else if (this.#current.id === null) {
      this.#current.id = id;
    } else if (this.#current.id !== id) {
      // A new id without a transition in between: the transition was missed.
      this.#sequence.push(this.#current.id);
      this.#current = { id };
    } else {
      return; // another location code on the same piece
    }
    this.#evaluate();
  }

  #onTransition() {
    this.#lastHeardAt = this.#clock();
    if (!this.#current) return; // the piece the car started on, partly driven: not counted
    this.#sequence.push(this.#current.id);
    this.#current = { id: null };
    this.#evaluate();
  }

  #evaluate() {
    this.emit('progress', this.pieces);
    const lap = findLoop(this.pieces, this.#tags);
    if (lap) {
      this.#finish();
      this.emit('done', new TrackMap(lap, this.#tags));
    } else if (this.#sequence.length > SCAN_MAX_PIECES) {
      this.#fail('Could not find a repeating lap. Check that the track is a closed loop with one start piece.');
    }
  }

  #checkSilence() {
    if (this.#clock() - this.#lastHeardAt > SCAN_SILENCE_MS) {
      this.#fail('The car is not reporting its position. Check that it is on the track and facing the right way.');
    }
  }

  #fail(reason) {
    if (!this.#running) return;
    this.#finish();
    this.emit('failed', reason);
  }

  #finish() {
    this.#running = false;
    clearInterval(this.#watchdog);
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#car.stop();
  }
}

// ---------------------------------------------------------------------------
// Position along the track
// ---------------------------------------------------------------------------

/**
 * Follows one car around a TrackMap.
 *
 * Events:
 *   'piece' ({ index, type })  the car entered a piece
 *   'line'  ()                 the car crossed the start line going forward
 */
export class Tracker extends Emitter {
  #car;
  #map;
  #clock;
  #unsubscribe = [];
  #linesCrossed = 0;

  /** Index of the piece the car is on, or null until it has read its first piece. */
  index = null;
  /** When the car entered that piece. Two cars on one piece: the earlier one is ahead. */
  enteredAt = 0;
  /** Pieces travelled since the first fix, counted from the start line, so it grows by map.length per lap. */
  distance = 0;

  /** @param {import('./car.js').Car} car @param {TrackMap} map @param {{clock?: () => number}} [options] */
  constructor(car, map, { clock = () => performance.now() } = {}) {
    super();
    this.#car = car;
    this.#map = map;
    this.#clock = clock;
    this.#unsubscribe = [
      car.on('position', (message) => this.#onPosition(message)),
      car.on('transition', () => this.#onTransition()),
    ];
  }

  detach() {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
  }

  get pieceType() {
    return this.index === null ? null : this.#map.typeAt(this.index);
  }

  /** How far round the current lap the car is, 0 to just under 1. */
  get lapFraction() {
    return this.index === null ? 0 : this.index / this.#map.length;
  }

  #onTransition() {
    if (this.index === null) return;
    this.#moveTo((this.index + 1) % this.#map.length);
  }

  #onPosition(message) {
    const candidates = this.#map.indicesOf(message.pieceId);
    if (candidates.length === 0) return; // a piece that is not on the scanned map: ignore it
    if (this.index === null) {
      this.index = candidates[0];
      this.distance = this.index;
      this.#linesCrossed = 0;
      this.enteredAt = this.#clock();
      this.emit('piece', { index: this.index, type: this.pieceType });
      return;
    }
    // If the layout uses this id more than once, the car is on the nearest one ahead.
    const count = this.#map.length;
    const ahead = (index) => (index - this.index + count) % count;
    const next = candidates.reduce((best, index) => (ahead(index) < ahead(best) ? index : best));
    if (next !== this.index) this.#moveTo(next);
  }

  #moveTo(next) {
    const count = this.#map.length;
    let step = (next - this.index + count) % count;
    // More than half a lap "ahead" really means the car was put back down behind where it was.
    if (step > count / 2) step -= count;
    this.index = next;
    this.distance += step;
    this.enteredAt = this.#clock();
    this.emit('piece', { index: next, type: this.pieceType });

    const lines = Math.floor(this.distance / count);
    if (lines > this.#linesCrossed) {
      this.#linesCrossed = lines;
      this.emit('line');
    }
  }
}

// ---------------------------------------------------------------------------
// Position across the road
// ---------------------------------------------------------------------------

/** Centres of the four driving lanes, in mm from the road centre line. */
export const LANES = Object.freeze([-67.5, -22.5, 22.5, 67.5]);

// How a straight piece encodes where a car is across the road: sixteen code
// lanes 9 mm apart, three location codes along each, numbered lane by lane.
const CODE_LANES = 16;
const CODES_PER_LANE = 3;
const CODE_LANE_SPACING_MM = 9;

const STABLE_READS = 4; // straight-piece reads that must agree before we trust the encoding above
const AGREE_MM = 12; // car and track agree about the car's offset within this
const SETTLE_MS = 400; // after telling the car its offset, give its reports time to catch up
const LANE_CHANGE_TIMEOUT_MS = 2500;
const ARRIVED_MM = 8;

const nearestLane = (offset) =>
  LANES.reduce((best, lane, index) => (Math.abs(lane - offset) < Math.abs(LANES[best] - offset) ? index : best), 0);

/**
 * Knows where one car is across the road, and moves it between lanes.
 *
 * A car only dead-reckons its sideways position from wherever it was switched
 * on, so on its own it cannot know how close it is to the edge. Straight
 * pieces can tell it: their location codes identify the lane. Steering reads
 * those, checks they behave as expected, and then keeps the car's own offset
 * in step with the track ("calibrated"). Until that check passes it falls
 * back to plain relative moves and never claims to know the lane.
 *
 * Events: 'calibrated' (), 'sign' (sign) when the track's left/right numbering
 * turned out to run the other way from the stored assumption.
 */
export class Steering extends Emitter {
  #car;
  #clock;
  #tags;
  #sign;
  #unsubscribe = [];
  #recent = []; // recent straight-piece reads: { codeLane, reported }
  #anchor = null; // the offset we last told the car it was at
  #settleUntil = 0;
  #target = null; // { offset, until } while a lane change is in flight

  /** True once the car's own offset is tied to the track's lane codes. */
  calibrated = false;

  /**
   * @param {import('./car.js').Car} car
   * @param {{tags?: () => Record<number,string>, sign?: 1|-1, clock?: () => number}} [options]
   *   `sign` is +1 if code lane numbers grow in the direction of positive offsets, -1 if not.
   */
  constructor(car, { tags = () => ({}), sign = 1, clock = () => performance.now() } = {}) {
    super();
    this.#car = car;
    this.#tags = tags;
    this.#sign = sign;
    this.#clock = clock;
    this.#unsubscribe = [
      car.on('position', (message) => this.#onPosition(message)),
      car.on('state', () => this.#onState()),
    ];
  }

  detach() {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
  }

  /** The car's offset from the road centre in mm, or null if it has not reported one yet. */
  get offset() {
    return this.#car.state.offset;
  }

  /** Index into LANES of the lane the car is in or heading for, or null when not calibrated. */
  get lane() {
    if (!this.calibrated) return null;
    const offset = this.#target?.offset ?? this.offset;
    return offset === null ? null : nearestLane(offset);
  }

  /** @param {-1|1} direction -1 is left, +1 is right: the cars count offsets as positive to the right */
  steer(direction) {
    const now = this.#clock();
    const from = this.#target?.offset ?? this.offset ?? 0;
    let to;
    if (this.calibrated) {
      const lane = Math.min(LANES.length - 1, Math.max(0, nearestLane(from) + direction));
      to = LANES[lane];
      if (Math.abs(to - from) < ARRIVED_MM && !this.#target) return; // already in the outermost lane
    } else {
      to = from + direction * (LANES[1] - LANES[0]);
    }
    this.#target = { offset: to, until: now + LANE_CHANGE_TIMEOUT_MS };
    this.#car.changeLane(to);
  }

  #onState() {
    // A dropped connection resets the car, so what we told it about its offset is gone.
    if (this.#car.state.connection !== 'ready' && this.calibrated) this.#reset();
  }

  #reset() {
    this.calibrated = false;
    this.#recent = [];
    this.#anchor = null;
    this.#target = null;
  }

  #laneChangeInFlight(now, reported) {
    if (!this.#target) return false;
    if (now > this.#target.until || Math.abs(reported - this.#target.offset) < ARRIVED_MM) {
      this.#target = null;
      return false;
    }
    return true;
  }

  #onPosition(message) {
    const { pieceId, locationId, offset: reported, reverseParsing } = message;
    if (reported === undefined || locationId === undefined) return;
    const now = this.#clock();
    const changingLane = this.#laneChangeInFlight(now, reported);

    // Only plain straights are known to use the sixteen-by-three layout.
    if (pieceType(pieceId, this.#tags()) !== PIECE.STRAIGHT) return;
    if (locationId >= CODE_LANES * CODES_PER_LANE) return;
    const printed = Math.floor(locationId / CODES_PER_LANE);
    // Driving a piece against its printed direction mirrors which side lane 0 is on.
    const codeLane = reverseParsing ? CODE_LANES - 1 - printed : printed;

    if (!this.calibrated) {
      this.#validate(codeLane, reported, changingLane);
      return;
    }
    if (changingLane || now < this.#settleUntil) return;

    const measured = this.#offsetOf(codeLane);
    const moved = measured - this.#anchor;
    const reportedMoved = reported - this.#anchor;
    // After a real sideways move, the car and the track must agree on which way it went.
    if (Math.abs(moved) > AGREE_MM * 2 && Math.abs(reportedMoved) > AGREE_MM * 2 && moved * reportedMoved < 0) {
      this.#sign = -this.#sign;
      this.emit('sign', this.#sign);
      this.#tellCar(this.#offsetOf(codeLane), now);
      return;
    }
    if (Math.abs(measured - reported) > AGREE_MM) this.#tellCar(measured, now);
  }

  /** Before trusting the lane codes, require a car holding its lane to read a steady lane. */
  #validate(codeLane, reported, changingLane) {
    if (changingLane) {
      this.#recent = [];
      return;
    }
    this.#recent.push({ codeLane, reported });
    if (this.#recent.length > STABLE_READS) this.#recent.shift();
    if (this.#recent.length < STABLE_READS) return;
    const lanes = this.#recent.map((read) => read.codeLane);
    const offsets = this.#recent.map((read) => read.reported);
    const steadyCar = Math.max(...offsets) - Math.min(...offsets) < AGREE_MM;
    const steadyLane = Math.max(...lanes) - Math.min(...lanes) <= 1;
    if (!steadyCar) return; // the car is drifting or being moved: keep watching
    if (!steadyLane) {
      this.#recent = []; // codes do not behave like lanes on this piece: stay uncalibrated
      return;
    }
    this.calibrated = true;
    this.#tellCar(this.#offsetOf(codeLane), this.#clock());
    this.emit('calibrated');
  }

  #offsetOf(codeLane) {
    return this.#sign * (codeLane - (CODE_LANES - 1) / 2) * CODE_LANE_SPACING_MM;
  }

  #tellCar(offset, now) {
    this.#anchor = offset;
    this.#settleUntil = now + SETTLE_MS;
    this.#car.setOffset(offset);
  }
}
