// The debug log: every raw message to and from each car, plus connection notes.
// When something breaks on the track, "Copy log" gives text to paste back to Claude.

import * as protocol from '../protocol.js';

const MAX_ENTRIES = 4000;

const two = (n) => String(n).padStart(2, '0');

function timestamp(date) {
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

/** Position and transition updates arrive several times a second per car; the view can hide them. */
const CHATTY = new Set([protocol.MSG.POSITION_UPDATE, protocol.MSG.TRANSITION_UPDATE, protocol.MSG.OFFSET_UPDATE]);

export class LogStore {
  #entries = [];
  #listeners = new Set();
  #nextId = 1;

  get entries() {
    return this.#entries;
  }

  /** Subscribes to appended entries and clears. Returns an unsubscribe function. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Records everything one car sends, receives and reports about its connection. */
  attach(car) {
    car.on('tx', (bytes) => this.#message(car, 'tx', bytes));
    car.on('rx', (bytes) => this.#message(car, 'rx', bytes));
    car.on('note', (text, level) => this.note(text, level, car));
  }

  note(text, level = 'info', car = null) {
    this.#push({ direction: 'note', level, text, hex: '', chatty: false, car });
  }

  clear() {
    this.#entries = [];
    for (const listener of this.#listeners) listener(null);
  }

  #message(car, direction, bytes) {
    this.#push({
      direction,
      level: 'info',
      text: protocol.describe(bytes),
      hex: protocol.toHex(bytes),
      chatty: CHATTY.has(bytes[1]),
      car,
    });
  }

  #push({ car, ...fields }) {
    const entry = {
      id: this.#nextId,
      time: timestamp(new Date()),
      carId: car?.id ?? null,
      carName: car?.name ?? 'App',
      carColor: car?.color ?? null,
      ...fields,
    };
    this.#nextId += 1;
    this.#entries.push(entry);
    if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES);
    for (const listener of this.#listeners) listener(entry);
  }
}

const ARROWS = { tx: '->', rx: '<-', note: '--' };

/** Plain-text form of the log, one line per entry, for copying. */
export function formatEntries(entries) {
  return entries
    .map((entry) => {
      const head = `${entry.time}  ${entry.carName.padEnd(12)} ${ARROWS[entry.direction]} `;
      return entry.direction === 'note'
        ? `${head}[${entry.level}] ${entry.text}`
        : `${head}${entry.hex.padEnd(54)} | ${entry.text}`;
    })
    .join('\n');
}
