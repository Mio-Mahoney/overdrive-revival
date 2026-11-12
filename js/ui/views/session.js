// Race and Battle: one screen for both, since they share the grid, the
// countdown, the driver controls and the map. It moves through three stages:
// setup, the live heads-up display, and results.

import { AI_LEVELS, Battle, DRIVER, FULL_HEALTH, Race, WEAPONS } from '../../game.js';
import { PIECE } from '../../track.js';
import { clear, formatTime, h, icon, ordinal, setText } from '../dom.js';
import { KEY_LABELS } from '../input.js';
import { sfx } from '../sound.js';
import { createTrackMap } from '../trackmap.js';

const COPY = {
  race: {
    title: 'Race',
    lede: 'First car to finish the laps wins.',
    start: 'Start race',
    again: 'Race again',
    end: 'End race',
    minCars: 1,
  },
  battle: {
    title: 'Battle',
    lede: 'Shoot the car ahead of you. Last car standing wins.',
    start: 'Start battle',
    again: 'Battle again',
    end: 'End battle',
    minCars: 2,
  },
};

const DRIVER_OPTIONS = [
  { value: DRIVER.P1, label: 'Player 1' },
  { value: DRIVER.P2, label: 'Player 2' },
  { value: DRIVER.AI, label: 'AI' },
  { value: 'none', label: 'Sit out' },
];

const DEFAULT_DRIVERS = {
  race: [DRIVER.P1, DRIVER.P2, DRIVER.AI, DRIVER.AI],
  battle: [DRIVER.P1, DRIVER.AI, DRIVER.AI, DRIVER.AI],
};

const HOLD_REPEAT_MS = 90;
const FEED_LENGTH = 5;

/** Makes a button act once on press and keep acting while it is held, like a held key. */
function holdable(button, action) {
  let timer = null;
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    action();
    stop();
    timer = setInterval(action, HOLD_REPEAT_MS);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) button.addEventListener(type, stop);
  // Keyboard and assistive tech activate with a click that no pointer press preceded.
  button.addEventListener('click', (event) => {
    if (event.detail === 0) action();
  });
  return button;
}

export function createSessionView(app, kind) {
  const copy = COPY[kind];
  const body = h('div', { class: 'stack' });
  const element = h(
    'section',
    { class: 'view' },
    h('header', { class: 'view-head' }, h('h1', {}, copy.title), h('p', { class: 'lede' }, copy.lede)),
    body,
  );

  /** What frame() refreshes while a session is live, or null. */
  let hud = null;
  let feed = [];

  const setup = () => app.setup[kind];
  const mine = () => (app.session?.kind === kind ? app.session : null);

  function build() {
    hud = null;
    clear(body);
    const session = mine();
    if (session) body.append(session.state === 'finished' ? buildResults(session) : buildHud(session));
    else if (app.sessionIsLive) body.append(buildBusy());
    else body.append(...buildSetup());
  }

  // -- Setup -----------------------------------------------------------------

  function driverOf(entry, index) {
    return setup().drivers[entry.identity.key] ?? DEFAULT_DRIVERS[kind][index] ?? 'none';
  }

  function levelOf(entry) {
    return setup().levels[entry.identity.key] ?? 'normal';
  }

  /** The cars taking part, as the session wants them. */
  function chosenEntries() {
    return app.cars
      .map((entry, index) => ({ ...entry, driver: driverOf(entry, index), level: levelOf(entry) }))
      .filter((entry) => entry.driver !== 'none' && entry.car.isReady);
  }

  /** @returns {string|null} why the session cannot start yet, or null when it can */
  function problem() {
    if (!app.map) return 'Scan the track first.';
    const entries = chosenEntries();
    if (entries.length < copy.minCars) {
      return copy.minCars === 1 ? 'Connect a car and give it a driver.' : 'A battle needs at least two cars with drivers.';
    }
    for (const slot of [DRIVER.P1, DRIVER.P2]) {
      if (entries.filter((entry) => entry.driver === slot).length > 1) {
        return `Only one car can be ${slot === DRIVER.P1 ? 'Player 1' : 'Player 2'}.`;
      }
    }
    return null;
  }

  function buildSetup() {
    const blocked = problem();
    const panels = [buildChecklist()];
    if (app.cars.length > 0) panels.push(buildDrivers());
    if (kind === 'race') panels.push(buildLaps());
    panels.push(
      h(
        'div',
        { class: 'start-row' },
        h(
          'button',
          { class: 'button button-primary button-large', type: 'button', disabled: blocked !== null, onClick: start },
          icon(kind === 'race' ? 'flag' : 'target', 22),
          copy.start,
        ),
        h('p', { class: 'hint' }, blocked ?? 'Put the cars on the start piece, behind the line, pointing the way the arrow points.'),
      ),
      buildKeys(),
    );
    return panels;
  }

  function buildChecklist() {
    const ready = app.cars.filter((entry) => entry.car.isReady).length;
    const item = (done, text, action) =>
      h(
        'li',
        { class: done ? 'check is-done' : 'check' },
        h('span', { class: 'check-mark', 'aria-hidden': 'true' }, done ? icon('check', 14) : null),
        h('span', {}, text),
        done ? null : action,
      );
    const go = (view, label) => h('button', { class: 'button button-small', type: 'button', onClick: () => app.navigate(view) }, label);
    const items = [
      item(
        ready >= copy.minCars,
        ready === 0 ? 'No cars connected' : `${ready} ${ready === 1 ? 'car' : 'cars'} connected`,
        go('drive', 'Connect cars'),
      ),
      item(app.map !== null, app.map ? `Track scanned, ${app.map.length} pieces` : 'Track not scanned', go('track', 'Scan track')),
    ];
    if (kind === 'battle' && app.map) {
      const hasZone = app.map.hasType(PIECE.POWER_ZONE);
      items.push(
        item(
          hasZone,
          hasZone ? 'Power Zone is on the track' : 'No Power Zone on this track (optional)',
          go('track', 'Mark it'),
        ),
      );
    }
    return h('div', { class: 'panel' }, h('h2', {}, 'Before you start'), h('ul', { class: 'checklist' }, items));
  }

  function buildDrivers() {
    const rows = app.cars.map((entry, index) => {
      const driver = driverOf(entry, index);
      const choose = (value) => {
        setup().drivers[entry.identity.key] = value;
        app.saveSetup();
        build();
      };
      const level = h(
        'select',
        {
          'aria-label': `${entry.car.name} AI level`,
          onChange: () => {
            setup().levels[entry.identity.key] = level.value;
            app.saveSetup();
          },
        },
        Object.entries(AI_LEVELS).map(([key, value]) => h('option', { value: key, selected: key === levelOf(entry) }, value.label)),
      );
      return h(
        'li',
        { class: 'driver-row', style: { '--car': entry.identity.color } },
        h('span', { class: 'driver-name' }, h('span', { class: 'car-dot', 'aria-hidden': 'true' }), entry.car.name),
        h(
          'div',
          { class: 'segmented', role: 'group', 'aria-label': `${entry.car.name} driver` },
          DRIVER_OPTIONS.map((option) =>
            h('button', { type: 'button', class: 'segment', 'aria-pressed': String(option.value === driver), onClick: () => choose(option.value) }, option.label),
          ),
        ),
        driver === DRIVER.AI ? level : null,
      );
    });
    return h('div', { class: 'panel' }, h('h2', {}, 'Drivers'), h('ul', { class: 'driver-list' }, rows));
  }

  function buildLaps() {
    const value = h('output', { class: 'stepper-value', 'aria-live': 'polite' }, app.setup.laps);
    const change = (delta) => {
      app.setup.laps = Math.min(30, Math.max(1, app.setup.laps + delta));
      app.saveSetup();
      value.textContent = app.setup.laps;
    };
    return h(
      'div',
      { class: 'panel panel-inline' },
      h('h2', {}, 'Laps'),
      h(
        'div',
        { class: 'stepper' },
        h('button', { class: 'button', type: 'button', 'aria-label': 'Fewer laps', onClick: () => change(-1) }, icon('down')),
        value,
        h('button', { class: 'button', type: 'button', 'aria-label': 'More laps', onClick: () => change(1) }, icon('up')),
      ),
    );
  }

  function buildKeys() {
    const actions = [
      ['faster', 'Faster'],
      ['slower', 'Slower'],
      ['left', 'Lane left'],
      ['right', 'Lane right'],
      ...(kind === 'battle'
        ? [
            ['fire', WEAPONS.blaster.label],
            ['heavy', WEAPONS.heavy.label],
          ]
        : []),
    ];
    return h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Controls'),
      h(
        'table',
        { class: 'keys-table' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Player 1'), h('th', {}, 'Player 2'))),
        h(
          'tbody',
          {},
          actions.map(([action, label]) =>
            h('tr', {}, h('th', { scope: 'row' }, label), h('td', {}, h('kbd', {}, KEY_LABELS.p1[action])), h('td', {}, h('kbd', {}, KEY_LABELS.p2[action]))),
          ),
        ),
      ),
      h(
        'p',
        { class: 'hint' },
        kind === 'battle'
          ? 'The Blaster reaches two pieces ahead, in your lane or the next. The Heavy shot reaches four pieces but only in your own lane. Esc stops everything.'
          : 'Each car also gets on-screen buttons, for touch screens. Esc stops everything.',
      ),
    );
  }

  function buildBusy() {
    const other = COPY[app.session.kind].title.toLowerCase();
    return h(
      'div',
      { class: 'panel empty' },
      h('p', {}, `A ${other} is in progress.`),
      h('button', { class: 'button button-primary', type: 'button', onClick: () => app.navigate(app.session.kind) }, `Go to the ${other}`),
    );
  }

  // -- Starting --------------------------------------------------------------

  function start() {
    if (problem() !== null) return;
    const entries = chosenEntries().map(({ car, steering, driver, level }) => ({ car, steering, driver, level }));
    const session =
      kind === 'race' ? new Race({ entries, map: app.map, laps: app.setup.laps }) : new Battle({ entries, map: app.map });
    feed = [];
    wire(session);
    app.setSession(session); // builds the HUD through the 'session' event
    session.begin();
    document.activeElement?.blur(); // so Space and Enter cannot press Start again mid-race
  }

  const engineOf = (racer) => app.cars.find((entry) => entry.car === racer.car)?.identity.engine ?? [0, 0, 0];

  /** Sounds, the event feed and the map flashes. These follow the session, not the screen. */
  function wire(session) {
    const say = (text, color) => {
      feed = [{ text, color }, ...feed].slice(0, FEED_LENGTH);
      if (hud?.session === session) hud.paintFeed();
    };
    const flash = (racer, color) => {
      if (hud?.session === session) hud.map.flash(racer.tracker.index, color);
    };

    session.on('countdown', () => sfx.countdown());
    session.on('go', () => sfx.go());
    session.on('lap', ({ racer, lap, time }) => {
      if (lap === session.totalLaps - 1) sfx.finalLap();
      else if (lap < session.totalLaps) sfx.lap();
      say(`${racer.car.name} lap ${lap}: ${formatTime(time)}`, racer.car.color);
    });
    session.on('done', ({ racer, place }) => {
      sfx.finish();
      say(`${racer.car.name} finishes ${ordinal(place)}`, racer.car.color);
    });
    session.on('shot', ({ weapon, hit }) => {
      if (weapon === 'heavy') sfx.heavy();
      else sfx.fire();
      if (!hit) sfx.miss();
    });
    session.on('hit', ({ by, target, weapon, damage }) => {
      sfx.hit();
      flash(target, by.car.color);
      target.car.flashEngine([1, 0, 0], engineOf(target));
      const name = weapon === 'powerZone' ? 'Power Zone' : WEAPONS[weapon].label;
      say(`${by.car.name} hits ${target.car.name} with ${name}: -${damage}`, by.car.color);
    });
    session.on('powerzone', ({ racer }) => {
      sfx.powerZone();
      flash(racer, '#ffd23f');
    });
    session.on('knockout', ({ racer }) => {
      sfx.knockout();
      say(`${racer.car.name} is knocked out`, racer.car.color);
    });
    session.on('offtrack', ({ racer }) => {
      sfx.offTrack();
      say(`${racer.car.name} left the track`, racer.car.color);
    });
    session.on('finish', (results) => {
      if (!results.aborted) {
        const humanWon = results.standings[0]?.driver !== DRIVER.AI;
        if (session.kind === 'battle' && !humanWon) sfx.lose();
        else sfx.finish();
      }
      if (mine() === session) build();
    });
  }

  // -- Heads-up display -------------------------------------------------------

  const driverLabel = (racer) =>
    racer.driver === DRIVER.AI ? `AI ${AI_LEVELS[racer.level]?.label ?? ''}`.trim() : racer.driver === DRIVER.P1 ? 'Player 1' : 'Player 2';

  function buildHud(session) {
    const clock = h('div', { class: 'hud-clock', role: 'timer' }, '0.000');
    const overlay = h('div', { class: 'countdown', 'aria-live': 'assertive' });
    const feedList = h('ul', { class: 'feed', 'aria-live': 'polite' });
    const map = createTrackMap(app.map);
    const cards = session.racers.map((racer) => buildRacerCard(session, racer));
    let goShownUntil = 0;
    session.on('go', () => {
      goShownUntil = performance.now() + 900;
    });

    hud = {
      session,
      map,
      paintFeed() {
        clear(feedList).append(...feed.map((entry) => h('li', { style: { '--car': entry.color } }, entry.text)));
      },
      update() {
        setText(clock, formatTime(session.elapsed));
        const counting = session.state === 'countdown' || session.state === 'grid';
        const text = counting ? (overlay.dataset.count ?? '') : performance.now() < goShownUntil ? 'GO' : '';
        setText(overlay, text);
        overlay.classList.toggle('is-visible', text !== '');
        const order = session.standings();
        for (const card of cards) card.update(order.indexOf(card.racer) + 1);
        map.setCars(
          session.racers.map((racer) => ({
            key: racer.car.id,
            color: racer.car.color,
            index: racer.tracker.index,
            lane: racer.steering.lane,
            dimmed: racer.knockedOut || racer.out || racer.offTrack,
          })),
        );
      },
    };
    session.on('countdown', (left) => {
      overlay.dataset.count = String(left);
    });
    hud.paintFeed();

    return h(
      'div',
      { class: 'hud' },
      h(
        'div',
        { class: 'hud-top' },
        clock,
        h('p', { class: 'hud-sub' }, kind === 'race' ? `${session.totalLaps} ${session.totalLaps === 1 ? 'lap' : 'laps'}` : 'Last car standing'),
        h('button', { class: 'button', type: 'button', onClick: () => session.end() }, icon('stop'), copy.end),
      ),
      h('div', { class: 'hud-main' }, h('div', { class: 'racers' }, cards.map((card) => card.element)), h('div', { class: 'hud-side' }, h('div', { class: 'map-frame' }, map.element), feedList)),
      overlay,
    );
  }

  function buildRacerCard(session, racer) {
    const human = racer.driver !== DRIVER.AI;
    const slot = human ? racer.driver : null;
    const place = h('span', { class: 'racer-place' });
    const main = h('div', { class: 'racer-main' });
    const stats = h('dl', { class: 'racer-stats' });
    const status = h('div', { class: 'racer-status' });
    const resume = h('button', { class: 'button button-small', type: 'button', onClick: () => racer.resume() }, 'Back on track');
    const statusText = h('span', {});
    status.append(statusText, resume);

    // Race: lap counter and times. Battle: health and weapons.
    const stat = (label) => {
      const value = h('dd', {});
      stats.append(h('div', {}, h('dt', {}, label), value));
      return value;
    };
    let lapText;
    let lastLap;
    let bestLap;
    let healthFill;
    let healthText;
    const weaponButtons = [];
    if (kind === 'race') {
      lapText = h('span', { class: 'racer-lap' });
      main.append(lapText);
      lastLap = stat('Last lap');
      bestLap = stat('Best lap');
    } else {
      healthFill = h('span', { class: 'health-fill' });
      healthText = h('span', { class: 'health-text' });
      main.append(h('div', { class: 'health', role: 'img' }, healthFill), healthText);
      for (const [key, action] of [
        ['blaster', 'fire'],
        ['heavy', 'heavy'],
      ]) {
        const button = h(
          'button',
          { class: 'button weapon', type: 'button', disabled: !human, onClick: () => racer[action]() },
          h('span', { class: 'weapon-cool', 'aria-hidden': 'true' }),
          icon(key === 'blaster' ? 'target' : 'bolt'),
          h('span', {}, WEAPONS[key].label),
          slot ? h('kbd', {}, KEY_LABELS[slot][action]) : null,
        );
        weaponButtons.push({ key, button });
      }
    }
    const speed = stat('Speed');

    const pad = human
      ? h(
          'div',
          { class: 'pad' },
          h('button', { class: 'button button-lane', type: 'button', 'aria-label': 'Lane left', onClick: () => racer.steer(-1) }, icon('left', 22)),
          holdable(h('button', { class: 'button', type: 'button', 'aria-label': 'Slower' }, icon('down', 22)), () => racer.slower()),
          holdable(h('button', { class: 'button', type: 'button', 'aria-label': 'Faster' }, icon('up', 22)), () => racer.faster()),
          h('button', { class: 'button button-lane', type: 'button', 'aria-label': 'Lane right', onClick: () => racer.steer(1) }, icon('right', 22)),
        )
      : null;

    const element = h(
      'article',
      { class: 'racer', style: { '--car': racer.car.color } },
      h('header', { class: 'racer-head' }, place, h('h3', {}, racer.car.name), h('span', { class: 'pill' }, driverLabel(racer))),
      main,
      weaponButtons.length > 0 ? h('div', { class: 'weapons' }, weaponButtons.map((weapon) => weapon.button)) : null,
      stats,
      status,
      pad,
    );

    return {
      racer,
      element,
      update(position) {
        setText(place, kind === 'race' ? ordinal(racer.place ?? position) : '');
        setText(speed, `${Math.round(racer.car.speed)} mm/s`);

        if (kind === 'race') {
          const lap = Math.min(session.totalLaps, racer.laps + 1);
          setText(lapText, racer.finishTime !== null ? formatTime(racer.finishTime) : `Lap ${lap} / ${session.totalLaps}`);
          setText(lastLap, racer.lapTimes.length > 0 ? formatTime(racer.lapTimes.at(-1)) : '--');
          setText(bestLap, racer.bestLap !== null ? formatTime(racer.bestLap) : '--');
        } else {
          healthFill.style.width = `${(racer.health / FULL_HEALTH) * 100}%`;
          healthFill.classList.toggle('is-low', racer.health <= FULL_HEALTH * 0.3);
          setText(healthText, racer.health);
          healthFill.parentElement.setAttribute('aria-label', `Health ${racer.health} of ${FULL_HEALTH}`);
          for (const { key, button } of weaponButtons) {
            const left = session.cooldown(racer, key) / WEAPONS[key].cooldownMs;
            button.style.setProperty('--cool', left.toFixed(3));
            button.classList.toggle('is-ready', left === 0 && session.state === 'running' && !racer.knockedOut);
          }
        }

        let text = '';
        if (racer.out) text = 'Disconnected';
        else if (racer.knockedOut) text = 'Knocked out';
        else if (racer.finishTime !== null) text = `Finished ${ordinal(racer.place)}`;
        else if (racer.offTrack) text = 'Off the track. Put it back, then:';
        else if (racer.slow !== 1) text = 'Slowed';
        setText(statusText, text);
        resume.hidden = !(racer.offTrack && !racer.out);
        element.classList.toggle('is-down', racer.out || racer.knockedOut);
        element.classList.toggle('is-hit', racer.slow !== 1);
        if (pad) pad.inert = racer.locked || racer.out;
      },
    };
  }

  // -- Results ---------------------------------------------------------------

  function buildResults(session) {
    const { results } = session;
    const first = results.standings[0];
    let headline;
    if (results.aborted) headline = `${copy.title} stopped`;
    else if (kind === 'battle') headline = results.winner ? `${results.winner.car.name} wins` : 'Nobody left standing';
    else headline = first?.finishTime !== null && first ? `${first.car.name} wins` : `${copy.title} over`;

    const name = (racer) =>
      h('th', { scope: 'row', style: { '--car': racer.car.color } }, h('span', { class: 'car-dot', 'aria-hidden': 'true' }), racer.car.name);
    const columns =
      kind === 'race'
        ? [
            ['Place', (racer, index) => (racer.finishTime !== null ? ordinal(racer.place) : racer.out ? 'Out' : ordinal(index + 1))],
            ['Time', (racer) => (racer.finishTime !== null ? formatTime(racer.finishTime) : '--')],
            ['Best lap', (racer) => (racer.bestLap !== null ? formatTime(racer.bestLap) : '--')],
            ['Laps', (racer) => `${racer.laps} / ${session.totalLaps}`],
          ]
        : [
            ['Health', (racer) => (racer.out ? 'Out' : racer.health)],
            ['Shots', (racer) => racer.shots],
            ['Hits', (racer) => racer.hits],
          ];

    return h(
      'div',
      { class: 'panel results', style: { '--car': results.aborted ? 'var(--muted)' : (first?.car.color ?? 'var(--accent)') } },
      h('p', { class: 'results-kicker' }, results.aborted ? 'Stopped early' : formatTime(session.elapsed)),
      h('h2', { class: 'results-headline' }, headline),
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'results-table' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Car'), columns.map(([label]) => h('th', { scope: 'col' }, label)))),
          h(
            'tbody',
            {},
            results.standings.map((racer, index) => h('tr', {}, name(racer), columns.map(([, value]) => h('td', {}, value(racer, index))))),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'button button-primary', type: 'button', disabled: problem() !== null, onClick: start }, icon('refresh'), copy.again),
        h('button', { class: 'button', type: 'button', onClick: () => app.setSession(null) }, 'Change setup'),
      ),
    );
  }

  app.on('session', build);
  app.on('cars', () => {
    if (!app.sessionIsLive) build();
  });
  app.on('map', () => {
    if (!app.sessionIsLive) build();
  });
  build();

  return {
    element,
    show: build,
    frame() {
      hud?.update();
    },
  };
}
