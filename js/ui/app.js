// App shell: the connected cars, the saved track, the running session, and
// switching between screens. The screens themselves live in ./views.

import { bluetoothStatus, requestCar } from '../ble.js';
import { Car, LOW_BATTERY_PERCENT } from '../car.js';
import { Emitter } from '../emitter.js';
import { Steering, TrackMap } from '../track.js';
import { IDENTITIES, freeDriveControls } from './cars.js';
import { clear, h, icon } from './dom.js';
import { Keyboard } from './input.js';
import { LogStore } from './log.js';
import { isMuted, setMuted, sfx, unlockAudio } from './sound.js';
import { createDriveView } from './views/drive.js';
import { createLogView } from './views/log.js';
import { createSessionView } from './views/session.js';
import { createTrackView } from './views/track.js';

const STORAGE = Object.freeze({
  map: 'overdrive.map',
  identities: 'overdrive.identities',
  laneSign: 'overdrive.laneSign',
  setup: 'overdrive.setup',
});

const TICK_MS = 50;

const TABS = [
  { id: 'drive', label: 'Drive', icon: 'wheel' },
  { id: 'track', label: 'Track', icon: 'map' },
  { id: 'race', label: 'Race', icon: 'flag' },
  { id: 'battle', label: 'Battle', icon: 'target' },
  { id: 'log', label: 'Log', icon: 'terminal' },
];

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback; // storage blocked or corrupt: start fresh
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is a convenience. The app works without it.
  }
}

/**
 * Events: 'cars' the list of connected cars changed, 'map' the track map changed,
 * 'session' a race or battle started or was closed.
 */
class App extends Emitter {
  /** @type {Array<{car: Car, steering: Steering, identity: typeof IDENTITIES[number], everConnected: boolean}>} */
  cars = [];
  /** @type {TrackMap|null} */
  map = null;
  /** @type {import('../game.js').Race | import('../game.js').Battle | null} */
  session = null;
  log = new LogStore();
  /** The simulated world in demo mode, otherwise null. */
  sim = null;
  bluetooth = bluetoothStatus();

  #laneSign = load(STORAGE.laneSign, 1) === -1 ? -1 : 1;
  #identityByDevice = load(STORAGE.identities, {});
  #lowBatteryWarned = new Set();
  #views = {};
  #current = null;
  #viewRoot = document.getElementById('view');
  #tabsRoot = document.getElementById('tabs');
  #toasts = document.getElementById('toasts');
  #wakeLock = null;

  constructor() {
    super();
    this.keyboard = new Keyboard({ onStopAll: () => this.stopAll() });
    // Race and battle settings, remembered between visits. Drivers and AI levels are kept per car identity.
    const stored = load(STORAGE.setup, {});
    const choices = (saved) => ({ drivers: { ...saved?.drivers }, levels: { ...saved?.levels } });
    this.setup = {
      laps: Number.isInteger(stored.laps) ? Math.min(30, Math.max(1, stored.laps)) : 5,
      race: choices(stored.race),
      battle: choices(stored.battle),
    };
  }

  async start() {
    const stored = TrackMap.fromJSON(load(STORAGE.map, null));
    if (stored) this.#adoptMap(stored);

    if (new URLSearchParams(location.search).has('sim')) {
      const { SimWorld } = await import('../sim.js');
      this.sim = new SimWorld();
      this.log.note('Demo mode: cars and track are simulated');
    }

    this.#views = {
      drive: createDriveView(this),
      track: createTrackView(this),
      race: createSessionView(this, 'race'),
      battle: createSessionView(this, 'battle'),
      log: createLogView(this),
    };
    this.#buildChrome();
    window.addEventListener('hashchange', () => this.#route());
    this.#route();

    setInterval(() => this.session?.tick(), TICK_MS);
    const frame = () => {
      this.#views[this.#current]?.frame?.();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    // The browser drops a wake lock when the tab is hidden, so take it again on return.
    document.addEventListener('visibilitychange', () => this.#holdScreenAwake());
    // Park the cars rather than leave them circling when the tab closes.
    window.addEventListener('pagehide', () => this.stopAll());
  }

  // -------------------------------------------------------------------------
  // Chrome: tabs, mute, stop all, toasts
  // -------------------------------------------------------------------------

  #buildChrome() {
    for (const tab of TABS) {
      this.#tabsRoot.append(
        h('a', { class: 'tab', href: `#${tab.id}`, dataset: { tab: tab.id } }, icon(tab.icon), h('span', {}, tab.label)),
      );
    }
    const mute = document.getElementById('mute');
    const paintMute = () => {
      clear(mute).append(icon(isMuted() ? 'soundOff' : 'soundOn', 20));
      mute.setAttribute('aria-pressed', String(isMuted()));
      mute.setAttribute('aria-label', isMuted() ? 'Unmute sound' : 'Mute sound');
    };
    mute.addEventListener('click', () => {
      setMuted(!isMuted());
      paintMute();
      sfx.click();
    });
    paintMute();
    document.getElementById('stop-all').addEventListener('click', () => this.stopAll());
    // Browsers hold audio back until the first gesture.
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    this.on('session', () => this.#paintTabs());
  }

  #route() {
    const id = location.hash.slice(1);
    this.#show(TABS.some((tab) => tab.id === id) ? id : 'drive');
  }

  navigate(id) {
    if (location.hash === `#${id}`) this.#show(id);
    else location.hash = id;
  }

  #show(id) {
    if (this.#current === id) return;
    this.#views[this.#current]?.hide?.();
    this.#current = id;
    clear(this.#viewRoot).append(this.#views[id].element);
    this.#views[id].show?.();
    this.#paintTabs();
    this.refreshInput();
    this.#viewRoot.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  get currentView() {
    return this.#current;
  }

  #paintTabs() {
    for (const tab of this.#tabsRoot.children) {
      const id = tab.dataset.tab;
      const selected = id === this.#current;
      tab.classList.toggle('is-current', selected);
      if (selected) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
      tab.classList.toggle('is-live', this.sessionIsLive && this.session.kind === id);
    }
  }

  /** @param {string} text @param {'info'|'error'|'good'} [kind] */
  toast(text, kind = 'info') {
    const node = h('div', { class: `toast toast-${kind}` }, text);
    this.#toasts.append(node);
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 300);
    }, kind === 'error' ? 6000 : 3500);
  }

  // -------------------------------------------------------------------------
  // Cars
  // -------------------------------------------------------------------------

  async addCar() {
    unlockAudio();
    let link;
    if (this.sim) {
      link = this.sim.addCar();
    } else {
      try {
        link = await requestCar();
      } catch (error) {
        this.log.note(`Could not open the Bluetooth chooser: ${error.message}`, 'error');
        this.toast(`Bluetooth: ${error.message}`, 'error');
        return;
      }
      if (!link) return; // chooser closed without a pick
    }
    if (this.cars.some((entry) => entry.car.id === link.id)) {
      this.toast('That car is already connected.');
      return;
    }

    const identity = this.#pickIdentity(link.id);
    const car = new Car(link, { name: identity.name, color: identity.color });
    const steering = new Steering(car, { tags: () => this.map?.tags ?? {}, sign: this.#laneSign });
    const entry = { car, steering, identity, everConnected: false };
    this.log.attach(car);
    this.#watch(entry);
    this.cars.push(entry);
    this.emit('cars');
    this.refreshInput();

    try {
      await car.connect();
    } catch (error) {
      this.toast(`Could not connect: ${error.message}`, 'error');
      return;
    }
    entry.everConnected = true;
    sfx.connect();
    car.setEngineColor(...entry.identity.engine);
  }

  #watch(entry) {
    const { car, steering } = entry;
    car.on('gone', ({ intentional }) => {
      steering.detach();
      this.cars = this.cars.filter((other) => other !== entry);
      this.#lowBatteryWarned.delete(car.id);
      this.emit('cars');
      this.refreshInput();
      // A car that never connected has already been reported as a failed connection.
      if (!intentional && entry.everConnected) {
        sfx.disconnect();
        this.toast(`${car.name} disconnected.`, 'error');
      }
    });
    car.on('state', () => {
      const percent = car.batteryPercent;
      if (percent === null || percent > LOW_BATTERY_PERCENT || this.#lowBatteryWarned.has(car.id)) return;
      this.#lowBatteryWarned.add(car.id);
      sfx.lowBattery();
      this.toast(`${car.name} battery is low (${percent}%). Put it on the charger soon.`, 'error');
    });
    steering.on('calibrated', () => this.log.note('Lane position calibrated from the track', 'info', car));
    steering.on('sign', (sign) => {
      this.#laneSign = sign;
      save(STORAGE.laneSign, sign);
      this.log.note(`Track lane numbering runs the other way: lane sign is now ${sign}`, 'warn', car);
    });
  }

  /** A car keeps the identity it had last time; a new car takes the first one not in use. */
  #pickIdentity(deviceId) {
    const taken = new Set(this.cars.map((entry) => entry.identity.key));
    const remembered = IDENTITIES.find((identity) => identity.key === this.#identityByDevice[deviceId]);
    if (remembered && !taken.has(remembered.key)) return remembered;
    return IDENTITIES.find((identity) => !taken.has(identity.key)) ?? IDENTITIES[IDENTITIES.length - 1];
  }

  /** Says which physical car this is. If another car had that identity, the two swap. */
  setIdentity(entry, key) {
    const identity = IDENTITIES.find((candidate) => candidate.key === key);
    if (!identity || identity === entry.identity) return;
    const other = this.cars.find((candidate) => candidate.identity === identity);
    if (other) this.#applyIdentity(other, entry.identity);
    this.#applyIdentity(entry, identity);
    this.emit('cars');
  }

  #applyIdentity(entry, identity) {
    entry.identity = identity;
    entry.car.name = identity.name;
    entry.car.color = identity.color;
    entry.car.setEngineColor(...identity.engine);
    if (!this.sim) {
      this.#identityByDevice[entry.car.id] = identity.key;
      save(STORAGE.identities, this.#identityByDevice);
    }
  }

  get maxCars() {
    return IDENTITIES.length;
  }

  /** Stops every car at once and ends any race or battle. Bound to the red button and to Escape. */
  stopAll() {
    if (this.sessionIsLive) this.session.end();
    for (const { car } of this.cars) car.stop();
  }

  // -------------------------------------------------------------------------
  // Track map
  // -------------------------------------------------------------------------

  setMap(map) {
    if (map) this.#adoptMap(map);
    else this.map = null;
    this.saveMap();
    this.emit('map');
  }

  #adoptMap(map) {
    this.map = map;
    map.on('change', () => {
      if (this.map !== map) return;
      this.saveMap();
      this.emit('map');
    });
  }

  saveMap() {
    if (this.sim) return; // a simulated track must not replace the real one
    if (this.map) save(STORAGE.map, this.map.toJSON());
    else save(STORAGE.map, null);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  get sessionIsLive() {
    return this.session !== null && this.session.state !== 'finished';
  }

  setSession(session) {
    this.session?.dispose();
    this.session = session;
    session?.on('state', () => {
      this.#paintTabs();
      this.refreshInput();
      this.#holdScreenAwake();
    });
    this.emit('session');
    this.refreshInput();
    this.#holdScreenAwake();
  }

  /**
   * Keeps the screen on during a race or battle. A phone that dims and locks
   * mid-race drops its Bluetooth connections. Not every browser offers this.
   */
  async #holdScreenAwake() {
    if (!this.sessionIsLive) {
      this.#wakeLock?.release().catch(() => {});
      this.#wakeLock = null;
      return;
    }
    if (this.#wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => {
        if (this.#wakeLock === lock) this.#wakeLock = null;
      });
      // The session may have ended, or another request may have won, while this one was pending.
      if (this.sessionIsLive && !this.#wakeLock) this.#wakeLock = lock;
      else lock.release().catch(() => {});
    } catch {
      // Refused (low battery, no permission): the race still works, the screen may dim.
    }
  }

  saveSetup() {
    save(STORAGE.setup, this.setup);
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  /** Points the two keyboard slots at whatever they should drive right now. */
  refreshInput() {
    this.keyboard.unbindAll();
    if (this.sessionIsLive) {
      for (const racer of this.session.racers) {
        if (racer.driver === 'p1' || racer.driver === 'p2') this.keyboard.bind(racer.driver, racer);
      }
      return;
    }
    if (this.#current !== 'drive') return;
    ['p1', 'p2'].forEach((slot, index) => {
      const entry = this.cars[index];
      if (entry) this.keyboard.bind(slot, freeDriveControls(entry));
    });
  }
}

const app = new App();
app.start();
