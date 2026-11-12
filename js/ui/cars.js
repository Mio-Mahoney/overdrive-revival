// Who each car is on screen, and how a car is driven outside a race.

import { SPEED } from '../car.js';

/** Who a car is on screen. The first two are the cars in the Fast & Furious kit. */
export const IDENTITIES = Object.freeze([
  Object.freeze({ key: 'ice-charger', name: 'Ice Charger', color: '#5cc8ff', engine: [0, 0.45, 1] }),
  Object.freeze({ key: 'mxt', name: 'MXT', color: '#ff9d2e', engine: [1, 0.3, 0] }),
  Object.freeze({ key: 'car-3', name: 'Car 3', color: '#7ee787', engine: [0, 1, 0.2] }),
  Object.freeze({ key: 'car-4', name: 'Car 4', color: '#e879f9', engine: [1, 0, 1] }),
]);

/** The driver controls for a car that is not in a race: straight to the car. */
export function freeDriveControls({ car, steering }) {
  return {
    faster: () => car.setSpeed(car.state.commandedSpeed === 0 ? SPEED.MIN : car.state.commandedSpeed + SPEED.STEP),
    slower: () => car.setSpeed(car.state.commandedSpeed <= SPEED.MIN ? 0 : car.state.commandedSpeed - SPEED.STEP),
    steer: (direction) => {
      if (car.state.commandedSpeed > 0) steering.steer(direction);
    },
    fire: () => {},
    heavy: () => {},
  };
}
