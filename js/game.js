// Race and battle rules, health, weapons and the AI opponent.
//
// No Bluetooth and no DOM. A session is advanced by calling tick(), and it
// reads time from an injected clock, so the rules run the same in tests.
//
// Session events:
//   'state'      (state)                   grid, countdown, running, finished
//   'countdown'  (secondsLeft)             3, 2, 1
//   'go'         ()
//   'lap'        ({ racer, lap, time })    race only
//   'done'       ({ racer, place })        race only: a racer completed the distance
//   'shot'       ({ racer, weapon, hit })  battle only
//   'hit'        ({ by, target, weapon, damage })
//   'powerzone'  ({ racer, target })
//   'knockout'   ({ racer, by })
//   'offtrack'   ({ racer })
//   'finish'     (results)

import { Emitter } from './emitter.js';
import { SPEED } from './car.js';
import { PIECE, Tracker } from './track.js';

export const DRIVER = Object.freeze({ P1: 'p1', P2: 'p2', AI: 'ai' });

export const AI_LEVELS = Object.freeze({
  easy: Object.freeze({ label: 'Easy', speed: 420, reactionMs: 1100, aim: 0.55, laneEveryMs: 4000, dodges: false }),
  normal: Object.freeze({ label: 'Normal', speed: 520, reactionMs: 600, aim: 0.8, laneEveryMs: 2500, dodges: true }),
  hard: Object.freeze({ label: 'Hard', speed: 620, reactionMs: 300, aim: 0.95, laneEveryMs: 1500, dodges: true }),
});

/**
 * Weapons. A shot lands when the target is at most `reach` track pieces ahead
 * and at most `laneReachMm` to the side. Hits are judged by piece and lane,
 * not by exact distance, because that is as fine as the cars report.
 */
export const WEAPONS = Object.freeze({
  blaster: Object.freeze({
    label: 'Blaster',
    cooldownMs: 1500,
    reach: 2,
    laneReachMm: 50, // same lane or the one next to it
    damage: 6,
    slow: 0.6,
    slowMs: 1000,
  }),
  heavy: Object.freeze({
    label: 'Heavy shot',
    cooldownMs: 7000,
    reach: 4,
    laneReachMm: 25, // same lane only
    damage: 15,
    slow: 0.4,
    slowMs: 1800,
  }),
});

export const POWER_ZONE = Object.freeze({ label: 'Power Zone', cooldownMs: 4000, damage: 12, slow: 0.4, slowMs: 1500 });

/**
 * After a hit the target cannot be hit again for this long. A hit slows the
 * target, which would otherwise hold it in the attacker's sights for hit after hit.
 */
export const SHIELD_MS = 2000;

export const FULL_HEALTH = 100;
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP_MS = 1000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** One car taking part in a session, and the controls its driver uses. */
export class Racer {
  #session;

  constructor(session, { car, steering, driver, level = 'normal' }, tracker) {
    this.#session = session;
    this.car = car;
    this.steering = steering;
    this.tracker = tracker;
    this.driver = driver;
    this.level = level;

    /** Speed the driver is asking for, mm/s. */
    this.throttle = 0;
    /** The session is holding the car still: countdown, finished, knocked out. */
    this.locked = true;
    /** The car left the track and waits for someone to put it back. */
    this.offTrack = false;
    /** The car disconnected for good. */
    this.out = false;
    this.slow = 1;
    this.slowUntil = 0;

    // Race
    this.laps = 0;
    this.lapTimes = [];
    this.lineDistance = null;
    this.lastLineAt = 0;
    this.finishTime = null;
    this.place = null;

    // Battle
    this.health = FULL_HEALTH;
    this.shieldUntil = 0;
    this.readyAt = { blaster: 0, heavy: 0, powerZone: 0 };
    this.shots = 0;
    this.hits = 0;
    this.knockedOut = false;
  }

  get bestLap() {
    return this.lapTimes.length > 0 ? Math.min(...this.lapTimes) : null;
  }

  /** Sends the car the speed that the throttle, slow-downs and locks add up to. */
  apply() {
    const moving = !this.locked && !this.offTrack && !this.out;
    this.car.setSpeed(moving ? this.throttle * this.slow : 0);
  }

  setThrottle(speed) {
    this.throttle = speed > 0 ? clamp(speed, SPEED.MIN, SPEED.MAX) : 0;
    this.apply();
  }

  // Driver controls. The keyboard, the on-screen buttons and the AI all go through these.

  faster() {
    if (this.locked) return; // no winding up the throttle before GO
    this.offTrack = false; // touching the throttle says the car is back on the track
    this.setThrottle(this.throttle === 0 ? SPEED.MIN : this.throttle + SPEED.STEP);
  }

  slower() {
    if (this.locked) return;
    this.setThrottle(this.throttle <= SPEED.MIN ? 0 : this.throttle - SPEED.STEP);
  }

  /** @param {-1|1} direction -1 left, +1 right */
  steer(direction) {
    if (this.locked || this.offTrack || this.out) return;
    this.steering.steer(direction);
  }

  fire() {
    this.#session.fire?.(this, 'blaster');
  }

  heavy() {
    this.#session.fire?.(this, 'heavy');
  }

  /** Puts an off-track car back in play. */
  resume() {
    this.offTrack = false;
    this.apply();
  }
}

/** What Race and Battle share: the grid, the countdown, the clock and the AI drivers. */
class Session extends Emitter {
  #countdownStartedAt = 0;
  #countdownShown = null;
  #unsubscribe = [];

  /**
   * @param {object} options
   * @param {Array<{car: object, steering: object, driver: string, level?: string}>} options.entries
   * @param {import('./track.js').TrackMap} options.map
   * @param {() => number} [options.clock]
   * @param {() => number} [options.random]
   */
  constructor({ entries, map, clock = () => performance.now(), random = Math.random }) {
    super();
    this.map = map;
    this.clock = clock;
    this.random = random;
    /** @type {'grid' | 'countdown' | 'running' | 'finished'} */
    this.state = 'grid';
    this.startedAt = 0;
    this.finishedAt = 0;
    this.results = null;
    this.racers = entries.map((entry) => new Racer(this, entry, new Tracker(entry.car, map, { clock })));
    this.ai = this.racers
      .filter((racer) => racer.driver === DRIVER.AI)
      .map((racer) => new AiDriver(racer, this, AI_LEVELS[racer.level] ?? AI_LEVELS.normal));

    for (const racer of this.racers) {
      this.#unsubscribe.push(
        racer.car.on('delocalized', () => this.#onOffTrack(racer)),
        racer.car.on('gone', () => this.#onGone(racer)),
        racer.tracker.on('piece', (piece) => this.onPiece(racer, piece)),
        racer.tracker.on('line', () => this.onLine(racer)),
        racer.car.on('special', () => this.onSpecial(racer)),
      );
    }
  }

  /** Milliseconds since GO, frozen once the session has finished. */
  get elapsed() {
    if (this.state === 'running') return this.clock() - this.startedAt;
    return this.state === 'finished' ? this.finishedAt - this.startedAt : 0;
  }

  /** Starts the countdown. Cars stay locked until GO. */
  begin() {
    if (this.state !== 'grid') return;
    this.#countdownStartedAt = this.clock();
    this.#countdownShown = null;
    this.#setState('countdown');
    this.tick();
  }

  tick() {
    const now = this.clock();
    if (this.state === 'countdown') this.#tickCountdown(now);
    if (this.state !== 'running') return;
    for (const racer of this.racers) {
      if (racer.slow !== 1 && now >= racer.slowUntil) {
        racer.slow = 1;
        racer.apply();
      }
    }
    for (const driver of this.ai) driver.tick(now);
    this.onTick(now);
  }

  #tickCountdown(now) {
    const stepsDone = Math.floor((now - this.#countdownStartedAt) / COUNTDOWN_STEP_MS);
    const left = COUNTDOWN_FROM - stepsDone;
    if (left > 0) {
      if (left !== this.#countdownShown) {
        this.#countdownShown = left;
        this.emit('countdown', left);
      }
      return;
    }
    this.startedAt = now;
    for (const racer of this.racers) {
      racer.locked = false;
      racer.lastLineAt = now;
    }
    this.#setState('running');
    this.emit('go');
    for (const driver of this.ai) driver.start(now);
    this.onGo(now);
  }

  /** Stops the session early. Results are whatever stands at this moment. */
  end() {
    if (this.state === 'finished') return;
    this.finish({ aborted: true });
  }

  finish(extra = {}) {
    if (this.state === 'finished') return;
    this.finishedAt = this.state === 'running' ? this.clock() : this.startedAt;
    for (const racer of this.racers) {
      racer.locked = true;
      racer.apply();
    }
    this.results = { aborted: false, standings: this.standings(), ...extra };
    this.#setState('finished');
    this.emit('finish', this.results);
  }

  /** Detaches from the cars. Call when leaving the session screen. */
  dispose() {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    for (const racer of this.racers) {
      racer.tracker.detach();
      racer.locked = true;
      racer.apply();
    }
  }

  #setState(state) {
    this.state = state;
    this.emit('state', state);
  }

  #onOffTrack(racer) {
    if (this.state !== 'running' || racer.offTrack) return;
    racer.offTrack = true;
    this.emit('offtrack', { racer });
  }

  #onGone(racer) {
    racer.out = true;
    if (this.state === 'running' || this.state === 'countdown') this.onRacerOut(racer);
  }

  /** Racers still able to take part. */
  get active() {
    return this.racers.filter((racer) => !racer.out);
  }

  /**
   * How many pieces `other` is ahead of `racer`, 0 to map.length - 1, or null
   * when either car has not been seen on the track yet.
   */
  gapAhead(racer, other) {
    const from = racer.tracker;
    const to = other.tracker;
    if (from.index === null || to.index === null) return null;
    const count = this.map.length;
    const pieces = (to.index - from.index + count) % count;
    // On the same piece, whoever entered it first is in front.
    if (pieces === 0 && to.enteredAt >= from.enteredAt) return count - 1;
    return pieces;
  }

  // Hooks for subclasses.
  onGo() {}
  onTick() {}
  onPiece() {}
  onLine() {}
  onSpecial() {}
  onRacerOut() {}
  standings() {
    return [...this.racers];
  }
}

// ---------------------------------------------------------------------------
// Race
// ---------------------------------------------------------------------------

export class Race extends Session {
  /** @param {object} options see Session, plus `laps` */
  constructor({ laps = 5, ...options }) {
    super(options);
    this.kind = 'race';
    this.totalLaps = clamp(Math.round(laps), 1, 99);
  }

  onPiece(racer) {
    // The first fix tells us where the car started relative to the line.
    if (racer.lineDistance === null) racer.lineDistance = racer.tracker.distance;
  }

  onLine(racer) {
    if (this.state !== 'running' || racer.finishTime !== null) return;
    const now = this.clock();
    const travelled = racer.tracker.distance - (racer.lineDistance ?? racer.tracker.distance);
    racer.lineDistance = racer.tracker.distance;
    // Cars wait on the grid just behind the line. Rolling over it at the start
    // begins lap one; it is not a lap. A real lap covers most of the track.
    if (travelled < this.map.length / 2) return;

    racer.laps += 1;
    const time = now - racer.lastLineAt;
    racer.lapTimes.push(time);
    racer.lastLineAt = now;
    this.emit('lap', { racer, lap: racer.laps, time });

    if (racer.laps >= this.totalLaps) {
      racer.finishTime = now - this.startedAt;
      racer.place = this.racers.filter((other) => other.finishTime !== null).length;
      racer.locked = true;
      racer.apply();
      this.emit('done', { racer, place: racer.place });
      this.#finishIfAllDone();
    }
  }

  onRacerOut() {
    this.#finishIfAllDone();
  }

  #finishIfAllDone() {
    if (this.active.every((racer) => racer.finishTime !== null)) this.finish();
  }

  /** Finishers in finishing order, then everyone else by distance covered. */
  standings() {
    const progress = (racer) =>
      racer.lineDistance === null ? 0 : racer.laps * this.map.length + (racer.tracker.distance - racer.lineDistance);
    return [...this.racers].sort((a, b) => {
      if (a.finishTime !== null || b.finishTime !== null) {
        if (a.finishTime === null) return 1;
        if (b.finishTime === null) return -1;
        return a.finishTime - b.finishTime;
      }
      if (a.out !== b.out) return a.out ? 1 : -1;
      return progress(b) - progress(a) || a.tracker.enteredAt - b.tracker.enteredAt;
    });
  }
}

// ---------------------------------------------------------------------------
// Battle
// ---------------------------------------------------------------------------

export class Battle extends Session {
  constructor(options) {
    super(options);
    this.kind = 'battle';
    this.winner = null;
  }

  /** Racers that can still fight. */
  get standing() {
    return this.racers.filter((racer) => !racer.knockedOut && !racer.out);
  }

  /** Milliseconds until this racer's weapon is ready, 0 when it is. */
  cooldown(racer, weaponKey) {
    return Math.max(0, racer.readyAt[weaponKey] - this.clock());
  }

  /** The opponent this weapon would hit right now, or null. */
  targetFor(racer, weaponKey) {
    const weapon = WEAPONS[weaponKey];
    let best = null;
    let bestGap = Infinity;
    const now = this.clock();
    for (const other of this.standing) {
      if (other === racer || now < other.shieldUntil) continue;
      const gap = this.gapAhead(racer, other);
      if (gap === null || gap > weapon.reach || gap >= bestGap) continue;
      if (!this.#inLaneReach(racer, other, weapon.laneReachMm)) continue;
      best = other;
      bestGap = gap;
    }
    return best;
  }

  /**
   * Until both cars have calibrated their sideways position we cannot compare
   * lanes, so the shot is judged on track distance alone rather than refused.
   */
  #inLaneReach(racer, other, reachMm) {
    if (!racer.steering.calibrated || !other.steering.calibrated) return true;
    const a = racer.steering.offset;
    const b = other.steering.offset;
    return a === null || b === null || Math.abs(a - b) <= reachMm;
  }

  fire(racer, weaponKey) {
    if (this.state !== 'running' || racer.knockedOut || racer.out || racer.offTrack) return;
    const now = this.clock();
    if (now < racer.readyAt[weaponKey]) return;
    const weapon = WEAPONS[weaponKey];
    racer.readyAt[weaponKey] = now + weapon.cooldownMs;
    racer.shots += 1;
    const target = this.targetFor(racer, weaponKey);
    this.emit('shot', { racer, weapon: weaponKey, hit: target !== null });
    if (target) this.#hit(racer, target, weapon, weaponKey);
  }

  onPiece(racer, piece) {
    if (piece.type === PIECE.POWER_ZONE) this.#powerZone(racer);
  }

  /** The car itself reports driving over a Fast & Furious special piece. */
  onSpecial(racer) {
    this.#powerZone(racer);
  }

  /** Driving over the Power Zone blasts the nearest opponent, wherever it is. */
  #powerZone(racer) {
    if (this.state !== 'running' || racer.knockedOut || racer.out) return;
    const now = this.clock();
    if (now < racer.readyAt.powerZone) return; // the piece and the car both report the same crossing
    racer.readyAt.powerZone = now + POWER_ZONE.cooldownMs;

    const count = this.map.length;
    const distanceTo = (other) => {
      const gap = this.gapAhead(racer, other);
      return gap === null ? count : Math.min(gap, count - gap);
    };
    const target = this.standing
      .filter((other) => other !== racer && now >= other.shieldUntil)
      .reduce((best, other) => (best === null || distanceTo(other) < distanceTo(best) ? other : best), null);
    this.emit('powerzone', { racer, target });
    if (target) this.#hit(racer, target, POWER_ZONE, 'powerZone');
  }

  #hit(by, target, weapon, weaponKey) {
    const now = this.clock();
    if (weaponKey !== 'powerZone') by.hits += 1; // hits are counted against shots fired
    target.health = Math.max(0, target.health - weapon.damage);
    target.shieldUntil = now + SHIELD_MS;
    target.slow = weapon.slow;
    target.slowUntil = now + weapon.slowMs;
    target.apply();
    this.emit('hit', { by, target, weapon: weaponKey, damage: weapon.damage });
    if (target.health === 0) {
      target.knockedOut = true;
      target.locked = true;
      target.apply();
      this.emit('knockout', { racer: target, by });
      this.#finishIfDecided();
    }
  }

  onRacerOut() {
    this.#finishIfDecided();
  }

  #finishIfDecided() {
    const standing = this.standing;
    if (standing.length > 1) return;
    this.winner = standing[0] ?? null;
    this.finish({ winner: this.winner });
  }

  /** Still standing first, by health; then the knocked out. */
  standings() {
    const rank = (racer) => (racer.out ? 2 : racer.knockedOut ? 1 : 0);
    return [...this.racers].sort((a, b) => rank(a) - rank(b) || b.health - a.health);
  }
}

// ---------------------------------------------------------------------------
// AI opponent
// ---------------------------------------------------------------------------

const AI_LOOK_AHEAD = 5; // pieces: how far ahead the AI notices an opponent
const AI_LOOK_BEHIND = 3;
const AI_WANDER_CHANCE = 0.3;

/**
 * Drives one car with the same controls a player has, and the same information:
 * where the cars are on the map and which lane they are in.
 */
class AiDriver {
  #racer;
  #session;
  #level;
  #nextLaneAt = 0;
  #aimingSince = { blaster: null, heavy: null };

  constructor(racer, session, level) {
    this.#racer = racer;
    this.#session = session;
    this.#level = level;
  }

  start(now) {
    this.#nextLaneAt = now + this.#level.laneEveryMs;
    this.#racer.setThrottle(this.#level.speed);
  }

  tick(now) {
    const racer = this.#racer;
    if (racer.locked || racer.offTrack || racer.out) return;
    if (racer.throttle !== this.#level.speed) racer.setThrottle(this.#level.speed);
    if (now >= this.#nextLaneAt) {
      this.#nextLaneAt = now + this.#level.laneEveryMs;
      this.#chooseLane();
    }
    if (this.#session.kind === 'battle') {
      this.#aim(now, 'heavy');
      this.#aim(now, 'blaster');
    }
  }

  #chooseLane() {
    const racer = this.#racer;
    const lane = racer.steering.lane;
    if (lane === null) return; // without a known lane a move could run the car off the road

    const session = this.#session;
    const count = session.map.length;
    let direction = 0;
    if (session.kind === 'battle') {
      for (const other of session.standing) {
        if (other === racer || other.steering.lane === null) continue;
        const gap = session.gapAhead(racer, other);
        if (gap === null) continue;
        const difference = other.steering.lane - lane;
        if (gap <= AI_LOOK_AHEAD && difference !== 0) {
          direction = Math.sign(difference); // line up behind the target
          break;
        }
        if (this.#level.dodges && count - gap <= AI_LOOK_BEHIND && Math.abs(difference) <= 1) {
          // Something is close behind in our lane or the next: move away from it, towards the roomier side.
          direction = difference !== 0 ? -Math.sign(difference) : lane < 2 ? 1 : -1;
          break;
        }
      }
    }
    if (direction === 0 && session.random() < AI_WANDER_CHANCE) direction = session.random() < 0.5 ? -1 : 1;
    if (direction !== 0) racer.steer(direction);
  }

  /** Fires a ready weapon once a target has been in its sights for the reaction time. */
  #aim(now, weaponKey) {
    const session = this.#session;
    const racer = this.#racer;
    if (session.cooldown(racer, weaponKey) > 0 || session.targetFor(racer, weaponKey) === null) {
      this.#aimingSince[weaponKey] = null;
      return;
    }
    if (this.#aimingSince[weaponKey] === null) {
      this.#aimingSince[weaponKey] = now;
      return;
    }
    if (now - this.#aimingSince[weaponKey] < this.#level.reactionMs) return;
    this.#aimingSince[weaponKey] = null;
    // A lower aim means the AI hesitates and has to line the shot up again.
    if (session.random() < this.#level.aim) session.fire(racer, weaponKey);
  }
}
