import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANES, PIECE, Steering, TrackMap, TrackScanner, Tracker, findLoop, pieceType } from '../js/track.js';
import { createRig, defaultMap } from './helpers.js';

test('known piece ids are classified, and a player tag wins', () => {
  assert.equal(pieceType(33), PIECE.START);
  assert.equal(pieceType(34), PIECE.START);
  assert.equal(pieceType(39), PIECE.STRAIGHT);
  assert.equal(pieceType(23), PIECE.CURVE);
  assert.equal(pieceType(57), PIECE.POWER_ZONE);
  assert.equal(pieceType(99), PIECE.UNKNOWN);
  assert.equal(pieceType(99, { 99: PIECE.POWER_ZONE }), PIECE.POWER_ZONE);
  assert.equal(pieceType(57, { 57: PIECE.STRAIGHT }), PIECE.STRAIGHT);
});

test('findLoop brackets one lap between two sightings of the start piece', () => {
  // The car starts mid-track, passes the start piece twice.
  const driven = [18, 36, 34, 33, 39, 17, 18, 36, 34, 33];
  assert.deepEqual(findLoop(driven), [34, 33, 39, 17, 18, 36]);
});

test('findLoop waits for another lap when a piece went unread', () => {
  assert.equal(findLoop([34, 33, 39, null, 18, 36, 34]), null);
  assert.deepEqual(
    findLoop([34, 33, 39, null, 18, 36, 34, 33, 39, 17, 18, 36, 34]),
    [34, 33, 39, 17, 18, 36],
    'the second lap was read in full',
  );
});

test('findLoop is not fooled by a layout that is still shorter than one lap', () => {
  assert.equal(findLoop([34, 33, 39, 17]), null);
  assert.equal(findLoop([]), null);
});

test('without a recognisable start piece, findLoop needs the lap to repeat in full', () => {
  // 91 92 appears twice in this six-piece layout: a naive detector would stop at three pieces.
  const lap = [91, 92, 93, 91, 92, 94];
  assert.equal(findLoop([...lap, 91, 92]), null);
  assert.deepEqual(findLoop([...lap, ...lap]), lap);
});

test('a map puts the finish line at index 0 and the grid at the end', () => {
  const map = new TrackMap([39, 17, 34, 33, 18, 36]);
  assert.equal(map.idAt(0), 33);
  assert.equal(map.idAt(map.length - 1), 34);
  assert.equal(map.typeAt(0), PIECE.START);
  assert.deepEqual(map.indicesOf(36), [2]);
});

test('tagging an unknown piece as the start re-centres the map and survives a save', () => {
  const map = new TrackMap([91, 92, 93, 94, 95]);
  assert.deepEqual(map.unknownIds, [91, 92, 93, 94, 95]);
  let changes = 0;
  map.on('change', () => {
    changes += 1;
  });
  map.tag(93, PIECE.START);
  map.tag(95, PIECE.POWER_ZONE);
  assert.equal(changes, 2);
  assert.equal(map.idAt(0), 93);
  assert.equal(map.hasType(PIECE.POWER_ZONE), true);

  const restored = TrackMap.fromJSON(JSON.parse(JSON.stringify(map)));
  assert.equal(restored.idAt(0), 93);
  assert.equal(restored.typeAt(restored.indicesOf(95)[0]), PIECE.POWER_ZONE);

  map.tag(95, null);
  assert.equal(map.hasType(PIECE.POWER_ZONE), false);
});

test('fromJSON rejects data that is not a usable map', () => {
  assert.equal(TrackMap.fromJSON(null), null);
  assert.equal(TrackMap.fromJSON({ pieces: [33, 34] }), null);
  assert.equal(TrackMap.fromJSON({ pieces: [33, 'x', 17, 18, 20] }), null);
  assert.equal(TrackMap.fromJSON({ pieces: [33, 300, 17, 18, 20] }), null);
  // An unknown tag type is dropped, the map is kept.
  const map = TrackMap.fromJSON({ pieces: [33, 39, 17, 18, 20], tags: { 39: 'teleporter' } });
  assert.equal(map.typeAt(1), PIECE.STRAIGHT);
});

test('a scan lap produces the layout, starting at the finish line, then stops the car', async (t) => {
  const rig = await createRig({ cars: 1 });
  t.after(() => rig.dispose());
  const [car] = rig.cars;
  const scanner = new TrackScanner(car, { clock: rig.clock });
  let map = null;
  let failure = null;
  scanner.on('done', (result) => {
    map = result;
  });
  scanner.on('failed', (reason) => {
    failure = reason;
  });
  scanner.start();
  await rig.run(60000, () => map !== null || failure !== null);

  assert.equal(failure, null);
  assert.deepEqual(map.toJSON().pieces, defaultMap().toJSON().pieces);
  assert.equal(scanner.running, false);
  await rig.run(2000);
  assert.equal(rig.sim(car).speed, 0, 'the car is parked after the scan');
});

test('a scan fails with a reason when the car leaves the track', async (t) => {
  const rig = await createRig({ cars: 1 });
  t.after(() => rig.dispose());
  const [car] = rig.cars;
  const scanner = new TrackScanner(car, { clock: rig.clock });
  let failure = null;
  scanner.on('failed', (reason) => {
    failure = reason;
  });
  scanner.start();
  await rig.run(2000);
  rig.sim(car).delocalize();
  assert.match(failure, /left the track/);
  assert.equal(scanner.running, false);
});

test('a tracker follows the car and reports each crossing of the line once', async (t) => {
  const rig = await createRig({ cars: 1 });
  t.after(() => rig.dispose());
  const [car] = rig.cars;
  const map = defaultMap();
  const tracker = new Tracker(car, map, { clock: rig.clock });
  let lines = 0;
  tracker.on('line', () => {
    lines += 1;
  });
  car.setSpeed(600);

  // The car starts on the grid, so it rolls over the line almost at once.
  await rig.run(20000, () => lines === 1);
  assert.equal(lines, 1);
  assert.equal(tracker.index, 0);

  await rig.run(60000, () => lines === 3);
  assert.equal(lines, 3);
  assert.equal(tracker.distance, map.length * 3);
  tracker.detach();
});

test('a car put back down behind where it was does not gain a lap', async (t) => {
  const rig = await createRig({ cars: 1 });
  t.after(() => rig.dispose());
  const [car] = rig.cars;
  const map = defaultMap();
  const tracker = new Tracker(car, map, { clock: rig.clock });
  let lines = 0;
  tracker.on('line', () => {
    lines += 1;
  });
  car.setSpeed(600);
  await rig.run(30000, () => tracker.index === 2);
  assert.equal(lines, 1);

  // Lift the car and set it down on the grid again, two pieces back.
  const simCar = rig.sim(car);
  simCar.pieceIndex = 0;
  simCar.along = 0;
  simCar.codesRead = 0;
  await rig.run(5000, () => tracker.index === map.length - 1);
  assert.equal(tracker.index, map.length - 1);
  assert.equal(lines, 1);

  // Crossing the same line again is still the same lap boundary.
  await rig.run(5000, () => tracker.index === 0);
  assert.equal(lines, 1);
  await rig.run(60000, () => lines === 2);
  assert.equal(lines, 2);
  tracker.detach();
});

test('steering calibrates from straight pieces and then knows the lane', async (t) => {
  const rig = await createRig({ cars: 2 });
  t.after(() => rig.dispose());
  const [left, right] = rig.steerings;
  assert.equal(left.calibrated, false);
  assert.equal(left.lane, null);
  for (const car of rig.cars) car.setSpeed(500);
  await rig.run(30000, () => left.calibrated && right.calibrated);

  assert.equal(left.calibrated, true);
  assert.equal(right.calibrated, true);
  await rig.run(1000);
  // The simulated cars start in the two middle lanes, each believing it is at offset 0.
  assert.equal(left.lane, 1);
  assert.equal(right.lane, 2);
  assert.ok(Math.abs(left.offset - LANES[1]) < 5, `left car reports ${left.offset}`);
  assert.ok(Math.abs(right.offset - LANES[2]) < 5, `right car reports ${right.offset}`);
});

test('a calibrated car cannot be steered off the edge of the road', async (t) => {
  const rig = await createRig({ cars: 1 });
  t.after(() => rig.dispose());
  const [car] = rig.cars;
  const [steering] = rig.steerings;
  let offTrack = false;
  car.on('delocalized', () => {
    offTrack = true;
  });
  car.setSpeed(500);
  await rig.run(30000, () => steering.calibrated);

  for (let i = 0; i < 6; i += 1) {
    steering.steer(-1);
    await rig.run(1500);
  }
  assert.equal(offTrack, false);
  assert.equal(steering.lane, 0);
  assert.ok(Math.abs(rig.sim(car).lateral - LANES[0]) < 5, `car is at ${rig.sim(car).lateral}`);

  for (let i = 0; i < 6; i += 1) {
    steering.steer(1);
    await rig.run(1500);
  }
  assert.equal(offTrack, false);
  assert.equal(steering.lane, 3);
  assert.ok(Math.abs(rig.sim(car).lateral - LANES[3]) < 5, `car is at ${rig.sim(car).lateral}`);
});

test('steering notices when the track numbers its lanes the other way round', async (t) => {
  const rig = await createRig({ cars: 1 });
  t.after(() => rig.dispose());
  const [car] = rig.cars;
  rig.steerings[0].detach();
  const steering = new Steering(car, { sign: -1, clock: rig.clock });
  let learned = null;
  steering.on('sign', (sign) => {
    learned = sign;
  });
  car.setSpeed(500);
  await rig.run(30000, () => steering.calibrated);
  await rig.run(1000);
  // With the wrong sign the car, truly left of centre, believes it is right of centre.
  assert.ok(steering.offset > 0);

  steering.steer(-1); // one lane towards the centre as the car sees it
  await rig.run(20000, () => learned !== null);
  assert.equal(learned, 1);
  await rig.run(3000);
  assert.ok(
    Math.abs(steering.offset - rig.sim(car).lateral) < 5,
    `car reports ${steering.offset}, truly at ${rig.sim(car).lateral}`,
  );
  steering.detach();
});
