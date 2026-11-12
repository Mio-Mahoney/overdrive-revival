// Keyboard input for two players sharing one Mac keyboard.
//
// Each player slot drives whatever "controls" object is currently bound to it:
//   { faster(), slower(), steer(direction), fire(), heavy() }
// The views decide what that is: a parked car in free drive, a racer in a race.

export const KEYMAPS = Object.freeze({
  p1: Object.freeze({ faster: 'KeyW', slower: 'KeyS', left: 'KeyA', right: 'KeyD', fire: 'KeyF', heavy: 'KeyG' }),
  p2: Object.freeze({
    faster: 'ArrowUp',
    slower: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    fire: 'Slash',
    heavy: 'Period',
  }),
});

/** Key labels as printed on the keyboard, for on-screen hints. */
export const KEY_LABELS = Object.freeze({
  p1: Object.freeze({ faster: 'W', slower: 'S', left: 'A', right: 'D', fire: 'F', heavy: 'G' }),
  p2: Object.freeze({ faster: '↑', slower: '↓', left: '←', right: '→', fire: '/', heavy: '.' }),
});

const REPEAT_MS = 90; // how often a held throttle key steps the speed

export class Keyboard {
  #targets = { p1: null, p2: null };
  #repeats = new Map(); // key code -> interval id
  #onStopAll;

  /** @param {{onStopAll: () => void}} options Escape stops every car, whatever has focus. */
  constructor({ onStopAll }) {
    this.#onStopAll = onStopAll;
    window.addEventListener('keydown', (event) => this.#keydown(event));
    window.addEventListener('keyup', (event) => this.#release(event.code));
    // A key held while the window loses focus never gets its keyup.
    window.addEventListener('blur', () => this.#releaseAll());
  }

  /** @param {'p1'|'p2'} slot @param {object|null} controls null unbinds the slot */
  bind(slot, controls) {
    // A held throttle key keeps stepping the controls it started on, so drop it on any rebind.
    if (this.#targets[slot] !== controls) this.#releaseAll();
    this.#targets[slot] = controls;
  }

  unbindAll() {
    this.bind('p1', null);
    this.bind('p2', null);
  }

  #keydown(event) {
    if (event.code === 'Escape') {
      this.#onStopAll();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Typing a car name or a hex message must not drive the cars.
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;

    for (const slot of ['p1', 'p2']) {
      const controls = this.#targets[slot];
      if (!controls) continue;
      const map = KEYMAPS[slot];
      const action = Object.keys(map).find((name) => map[name] === event.code);
      if (!action) continue;
      event.preventDefault(); // arrows and slash would otherwise scroll or open find
      if (event.repeat) return; // we run our own repeat so both players get the same rate
      this.#press(event.code, action, controls);
      return;
    }
  }

  #press(code, action, controls) {
    switch (action) {
      case 'faster':
      case 'slower': {
        const step = () => controls[action]();
        step();
        this.#release(code);
        this.#repeats.set(code, setInterval(step, REPEAT_MS));
        break;
      }
      case 'left':
        controls.steer(-1);
        break;
      case 'right':
        controls.steer(1);
        break;
      default:
        controls[action]?.();
    }
  }

  #release(code) {
    const timer = this.#repeats.get(code);
    if (timer === undefined) return;
    clearInterval(timer);
    this.#repeats.delete(code);
  }

  #releaseAll() {
    for (const code of [...this.#repeats.keys()]) this.#release(code);
  }
}
