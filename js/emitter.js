// Minimal event emitter shared by the non-UI modules.

export class Emitter {
  #listeners = new Map();

  /** Subscribes and returns a function that unsubscribes. */
  on(event, listener) {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  emit(event, ...args) {
    const set = this.#listeners.get(event);
    if (!set) return;
    // Copy so a listener can unsubscribe itself, or others, while we iterate.
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        // One broken listener must not stop a car command or a game tick.
        console.error(`Listener for "${event}" failed`, error);
      }
    }
  }
}
