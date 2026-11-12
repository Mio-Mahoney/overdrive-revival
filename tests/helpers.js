// Shared test rig: simulated cars on a simulated track, driven by a fake clock.

import { Car } from '../js/car.js';
import { SimWorld } from '../js/sim.js';
import { Steering, TrackMap } from '../js/track.js';

const STEP_MS = 20;

/** Lets queued car commands (which are sent asynchronously) reach the simulated cars. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {{cars?: number, layout?: object[]}} [options]
 * @returns a rig whose `run(ms)` advances the track, the clock and any session together
 */
export async function createRig({ cars: carCount = 2, layout } = {}) {
  let now = 0;
  const clock = () => now;
  const world = new SimWorld({ layout, realtime: false });
  const cars = [];
  for (let i = 0; i < carCount; i += 1) {
    const car = new Car(world.addCar(), { name: `Car ${i + 1}`, color: '#fff', clock });
    await car.connect();
    cars.push(car);
  }
  await flush();

  const rig = {
    world,
    cars,
    clock,
    session: null,
    steerings: cars.map((car) => new Steering(car, { clock })),
    /** The simulated car behind a Car, for reading its true position or knocking it off the track. */
    sim: (car) => world.cars.find((simCar) => simCar.link.id === car.id),
    /** Advances simulated time, ticking the current session every step. */
    async run(ms, until = () => false) {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        world.advance(STEP_MS);
        now += STEP_MS;
        rig.session?.tick();
        await flush();
        if (until()) return true;
      }
      return until();
    },
    async dispose() {
      rig.session?.dispose();
      for (const steering of rig.steerings) steering.detach();
      for (const car of cars) await car.disconnect();
    },
  };
  return rig;
}

/** The map a scan of the simulator's default layout produces. */
export const defaultMap = () => new TrackMap([33, 39, 17, 18, 57, 20, 40, 36, 23, 24, 27, 34]);
