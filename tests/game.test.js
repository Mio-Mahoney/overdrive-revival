import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Battle, DRIVER, FULL_HEALTH, POWER_ZONE, Race, SHIELD_MS, WEAPONS } from '../js/game.js';
import { createRig, defaultMap } from './helpers.js';

/** Builds a session of the given kind over the rig's cars. Drivers default to AI. */
function startSession(rig, Kind, { drivers = [], levels = [], random = () => 0, ...options } = {}) {
  const entries = rig.cars.map((car, i) => ({
    car,
    steering: rig.steerings[i],
    driver: drivers[i] ?? DRIVER.AI,
    level: levels[i] ?? 'normal',
  }));
  rig.session = new Kind({ entries, map: defaultMap(), clock: rig.clock, random, ...options });
  return rig.session;
}

/** Records every event of the given names, in order. */
function record(session, names) {
  const events = [];
  for (const name of names) session.on(name, (payload) => events.push({ name, payload }));
  return events;
}

/** Places a simulated car at the start of a layout piece, in the lane it already occupies. */
function place(rig, car, layoutIndex, along = 0) {
  const simCar = rig.sim(car);
  simCar.pieceIndex = layoutIndex;
  simCar.along = along;
  simCar.codesRead = 0;
}

test('cars stay parked through the countdown and are released on GO', async (t) => {
  const rig = await createRig();
  t.after(() => rig.dispose());
  const race = startSession(rig, Race, { drivers: [DRIVER.P1, DRIVER.P2], laps: 1 });
  const events = record(race, ['countdown', 'go']);
  const [one] = race.racers;

  race.begin();
  one.faster(); // jumping the start does nothing
  await rig.run(2900);
  assert.equal(race.state, 'countdown');
  assert.deepEqual(events.map((event) => event.payload), [3, 2, 1]);
  assert.equal(rig.sim(one.car).speed, 0);
  assert.equal(one.throttle, 0);

  await rig.run(200);
  assert.equal(race.state, 'running');
  assert.equal(events.at(-1).name, 'go');
  one.faster();
  await rig.run(1000);
  assert.ok(rig.sim(one.car).speed > 0);
});

test('a race counts exactly the laps driven and the faster car wins', async (t) => {
  const rig = await createRig();
  t.after(() => rig.dispose());
  const race = startSession(rig, Race, { levels: ['hard', 'easy'], laps: 3 });
  const laps = record(race, ['lap']);
  const [fast, slow] = race.racers;

  race.begin();
  const finished = await rig.run(240000, () => race.state === 'finished');
  assert.equal(finished, true, 'the race finishes');

  assert.equal(fast.laps, 3);
  assert.equal(slow.laps, 3);
  assert.equal(laps.length, 6, 'rolling off the grid over the line is not a lap');
  assert.equal(fast.place, 1);
  assert.equal(slow.place, 2);
  assert.ok(fast.finishTime < slow.finishTime);
  assert.deepEqual(race.results.standings, [fast, slow]);
  assert.equal(race.results.aborted, false);

  // Lap times add up to the finish time: the clock runs from GO, laps from line to line.
  const total = fast.lapTimes.reduce((sum, time) => sum + time, 0);
  assert.ok(Math.abs(total - fast.finishTime) < 1, `${total} vs ${fast.finishTime}`);
  assert.equal(fast.bestLap, Math.min(...fast.lapTimes));

  await rig.run(3000);
  assert.equal(rig.sim(fast.car).speed, 0, 'finishers are parked');
  assert.equal(rig.sim(slow.car).speed, 0);
});

test('standings during a race follow distance covered', async (t) => {
  const rig = await createRig();
  t.after(() => rig.dispose());
  const race = startSession(rig, Race, { levels: ['easy', 'hard'], laps: 5 });
  race.begin();
  await rig.run(30000);
  const [easy, hard] = race.racers;
  assert.deepEqual(race.standings(), [hard, easy]);
});

test('ending a race early reports it as aborted and parks the cars', async (t) => {
  const rig = await createRig();
  t.after(() => rig.dispose());
  const race = startSession(rig, Race, { laps: 5 });
  race.begin();
  await rig.run(8000);
  race.end();
  assert.equal(race.state, 'finished');
  assert.equal(race.results.aborted, true);
  const frozen = race.elapsed;
  await rig.run(3000);
  assert.equal(race.elapsed, frozen, 'the clock stops with the race');
  for (const car of rig.cars) assert.equal(rig.sim(car).speed, 0);
});

test('a car that leaves the track waits to be put back, then carries on', async (t) => {
  const rig = await createRig();
  t.after(() => rig.dispose());
  const race = startSession(rig, Race, { laps: 5 });
  const events = record(race, ['offtrack']);
  race.begin();
  await rig.run(8000);
  const [racer] = race.racers;

  rig.sim(racer.car).delocalize();
  assert.equal(events.length, 1);
  assert.equal(racer.offTrack, true);
  await rig.run(3000);
  assert.equal(rig.sim(racer.car).speed, 0, 'the AI does not drive a car that is off the track');

  racer.resume();
  await rig.run(2000);
  assert.ok(rig.sim(racer.car).speed > 0);
});

test('a race ends when the only car still running disconnects', async (t) => {
  const rig = await createRig();
  t.after(() => rig.dispose());
  const race = startSession(rig, Race, { laps: 5 });
  race.begin();
  await rig.run(5000);
  await rig.cars[0].disconnect();
  assert.equal(race.state, 'running');
  await rig.cars[1].disconnect();
  assert.equal(race.state, 'finished');
  assert.equal(race.racers.every((racer) => racer.out), true);
});

// Layout indices in the simulator: 0 grid, 1 line, 2 straight, 3 curve, 4 curve, 5 special, ...
async function battleWithCarsApart(t, piecesApart, options = {}) {
  const rig = await createRig();
  t.after(() => rig.dispose());
  const battle = startSession(rig, Battle, { drivers: [DRIVER.P1, DRIVER.P2], ...options });
  battle.begin();
  await rig.run(3100);
  const [shooter, target] = battle.racers;
  place(rig, shooter.car, 6);
  place(rig, target.car, 6 + piecesApart);
  for (const racer of battle.racers) racer.setThrottle(300);
  // Both cars need to be seen on the track before a shot can be judged.
  await rig.run(1500, () => shooter.tracker.index !== null && target.tracker.index !== null);
  return { rig, battle, shooter, target };
}

test('a blaster shot hits a car two pieces ahead, drains health and slows it', async (t) => {
  const { rig, battle, shooter, target } = await battleWithCarsApart(t, 2);
  const events = record(battle, ['shot', 'hit']);
  assert.equal(battle.gapAhead(shooter, target), 2);

  shooter.fire();
  assert.deepEqual(events.map((event) => event.name), ['shot', 'hit']);
  assert.equal(events[0].payload.hit, true);
  assert.equal(target.health, FULL_HEALTH - WEAPONS.blaster.damage);
  assert.equal(shooter.shots, 1);
  assert.equal(shooter.hits, 1);
  assert.equal(target.slow, WEAPONS.blaster.slow);

  await rig.run(WEAPONS.blaster.slowMs + 100);
  assert.equal(target.slow, 1, 'the slow-down wears off');
});

test('a weapon cannot fire again until its cooldown has passed', async (t) => {
  const { rig, battle, shooter, target } = await battleWithCarsApart(t, 1);
  shooter.fire();
  shooter.fire();
  assert.equal(shooter.shots, 1);
  assert.ok(battle.cooldown(shooter, 'blaster') > 0);
  await rig.run(WEAPONS.blaster.cooldownMs + 50);
  assert.equal(battle.cooldown(shooter, 'blaster'), 0);
  shooter.fire();
  assert.equal(shooter.shots, 2);
});

test('a car that was just hit is shielded from the next shot', async (t) => {
  const { rig, battle, shooter, target } = await battleWithCarsApart(t, 1);
  const events = record(battle, ['shot']);
  shooter.fire();
  assert.equal(target.health, FULL_HEALTH - WEAPONS.blaster.damage);

  // The second weapon is ready, but the target is still shielded.
  assert.equal(battle.targetFor(shooter, 'heavy'), null);
  shooter.heavy();
  assert.equal(events.at(-1).payload.hit, false);
  assert.equal(target.health, FULL_HEALTH - WEAPONS.blaster.damage);

  // Keep the pair together while the shield runs out, then the next shot lands.
  await rig.run(SHIELD_MS + 50);
  place(rig, shooter.car, 6);
  place(rig, target.car, 7);
  await rig.run(1500, () => battle.gapAhead(shooter, target) === 1);
  shooter.fire();
  assert.equal(target.health, FULL_HEALTH - 2 * WEAPONS.blaster.damage);
});

test('a shot at a car out of reach, or behind, misses but still costs the cooldown', async (t) => {
  const { battle, shooter, target } = await battleWithCarsApart(t, 3);
  const events = record(battle, ['shot', 'hit']);
  shooter.fire();
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.hit, false);
  assert.equal(target.health, FULL_HEALTH);
  assert.ok(battle.cooldown(shooter, 'blaster') > 0);

  // The target is behind the shooter from the target's point of view.
  target.fire();
  assert.equal(shooter.health, FULL_HEALTH);
});

test('on the same piece, only the car that entered first can be hit', async (t) => {
  const rig = await createRig();
  t.after(() => rig.dispose());
  const battle = startSession(rig, Battle, { drivers: [DRIVER.P1, DRIVER.P2] });
  battle.begin();
  await rig.run(3100);
  const [behind, ahead] = battle.racers;
  place(rig, ahead.car, 8, 250);
  place(rig, behind.car, 7, 300);
  for (const racer of battle.racers) racer.setThrottle(300);
  await rig.run(4000, () => behind.tracker.index !== null && behind.tracker.index === ahead.tracker.index);
  assert.equal(behind.tracker.index, ahead.tracker.index);

  ahead.fire();
  assert.equal(behind.health, FULL_HEALTH, 'the car in front cannot shoot backwards');
  behind.fire();
  assert.equal(ahead.health, FULL_HEALTH - WEAPONS.blaster.damage);
});

test('the heavy shot needs the same lane; the blaster reaches the next lane over', async (t) => {
  const { rig, battle, shooter, target } = await battleWithCarsApart(t, 1);
  // Let both cars calibrate their lanes: they sit in neighbouring lanes, 45 mm apart.
  await rig.run(40000, () => shooter.steering.calibrated && target.steering.calibrated);
  await rig.run(1000);
  assert.equal(shooter.steering.calibrated && target.steering.calibrated, true);
  place(rig, shooter.car, 6);
  place(rig, target.car, 7);
  await rig.run(1500, () => battle.gapAhead(shooter, target) === 1);
  assert.equal(battle.gapAhead(shooter, target), 1);

  assert.equal(battle.targetFor(shooter, 'heavy'), null);
  assert.equal(battle.targetFor(shooter, 'blaster'), target);

  // Move in behind the target and the heavy shot lines up.
  shooter.steer(1);
  await rig.run(2500);
  place(rig, shooter.car, 6);
  place(rig, target.car, 7);
  await rig.run(1500, () => battle.gapAhead(shooter, target) === 1);
  assert.equal(battle.targetFor(shooter, 'heavy'), target);
  shooter.heavy();
  assert.equal(target.health, FULL_HEALTH - WEAPONS.heavy.damage);
});

test('driving over the Power Zone blasts the opponent once per crossing', async (t) => {
  const rig = await createRig();
  t.after(() => rig.dispose());
  const battle = startSession(rig, Battle, { drivers: [DRIVER.P1, DRIVER.P2] });
  const events = record(battle, ['powerzone', 'hit']);
  battle.begin();
  await rig.run(3100);
  const [driver, victim] = battle.racers;
  place(rig, driver.car, 3); // two curves before the special piece
  place(rig, victim.car, 9);
  driver.setThrottle(400);
  await rig.run(8000, () => events.length > 0);
  await rig.run(1000);

  // The piece type and the car's own special-piece message both report the crossing.
  assert.deepEqual(events.map((event) => event.name), ['powerzone', 'hit']);
  assert.equal(events[0].payload.racer, driver);
  assert.equal(events[0].payload.target, victim);
  assert.equal(victim.health, FULL_HEALTH - POWER_ZONE.damage);
  assert.equal(driver.health, FULL_HEALTH);
});

test('health reaching zero knocks a car out, parks it and ends the battle', async (t) => {
  const { rig, battle, shooter, target } = await battleWithCarsApart(t, 1);
  const events = record(battle, ['knockout', 'finish']);
  target.health = WEAPONS.blaster.damage; // one hit from out
  shooter.fire();

  assert.deepEqual(events.map((event) => event.name), ['knockout', 'finish']);
  assert.equal(target.knockedOut, true);
  assert.equal(battle.state, 'finished');
  assert.equal(battle.winner, shooter);
  assert.equal(battle.results.winner, shooter);
  assert.deepEqual(battle.results.standings, [shooter, target]);
  await rig.run(2000);
  for (const car of rig.cars) assert.equal(rig.sim(car).speed, 0);

  shooter.fire();
  assert.equal(shooter.shots, 1, 'no firing after the battle is over');
});

test('an AI battle plays out to a winner', async (t) => {
  const rig = await createRig();
  t.after(() => rig.dispose());
  // A fixed sequence stands in for chance so the run is repeatable.
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const battle = startSession(rig, Battle, { levels: ['hard', 'easy'], random });
  const offTrack = record(battle, ['offtrack']);
  battle.begin();
  const finished = await rig.run(1200000, () => battle.state === 'finished');

  assert.equal(finished, true, 'someone wins within twenty minutes of play');
  assert.ok(battle.winner, 'there is a winner');
  assert.equal(battle.winner.knockedOut, false);
  assert.ok(battle.winner.hits > 0);
  assert.equal(offTrack.length, 0, 'the AI never steers a car off the road');
});
