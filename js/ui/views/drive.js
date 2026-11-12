// Drive: connect cars and control each one directly. This is also the
// connection test: if a car drives and stops from here, the rest can work.

import { LOW_BATTERY_PERCENT, SPEED } from '../../car.js';
import { IDENTITIES, freeDriveControls } from '../cars.js';
import { clear, h, icon, setText } from '../dom.js';
import { KEY_LABELS } from '../input.js';
import { sfx } from '../sound.js';

const STATUS_TEXT = {
  connecting: 'Connecting',
  ready: 'Connected',
  reconnecting: 'Reconnecting',
  gone: 'Disconnected',
};

const BLUETOOTH_HELP = {
  unsupported: {
    title: 'This browser cannot talk to the cars',
    body: 'Web Bluetooth is missing here. On a Mac, open this page in Chrome. On an iPhone, open it in the free Bluefy browser.',
  },
  insecure: {
    title: 'Bluetooth needs a secure page',
    body: 'Open the app over https, or from http://localhost on this computer.',
  },
};

export function createDriveView(app) {
  const grid = h('div', { class: 'car-grid' });
  const notice = h('div', {});
  const element = h(
    'section',
    { class: 'view' },
    h(
      'header',
      { class: 'view-head' },
      h('h1', {}, 'Drive'),
      h('p', { class: 'lede' }, 'Connect your cars, check they respond, and take them for a spin.'),
    ),
    notice,
    grid,
  );

  /** Per-card references to the parts that change every frame. */
  let cards = [];

  function build() {
    clear(notice);
    const help = app.sim ? null : BLUETOOTH_HELP[app.bluetooth];
    if (app.sim) {
      notice.append(
        h(
          'div',
          { class: 'callout' },
          h('div', {}, h('strong', {}, 'Demo mode. '), 'These cars and this track are simulated. Remove ?sim from the address to use real cars.'),
        ),
      );
    } else if (help) {
      notice.append(h('div', { class: 'callout callout-warn' }, icon('warning', 20), h('div', {}, h('strong', {}, help.title), h('p', {}, help.body))));
    }

    cards = app.cars.map((entry, index) => buildCard(entry, index));
    clear(grid).append(...cards.map((card) => card.element));
    if (app.cars.length < app.maxCars) grid.append(buildAddCard(help !== null && help !== undefined));
  }

  function buildAddCard(disabled) {
    const first = app.cars.length === 0;
    return h(
      'button',
      { class: 'add-card', type: 'button', disabled, onClick: () => app.addCar() },
      h('span', { class: 'add-card-icon' }, icon(app.sim ? 'plus' : 'bluetooth', 28)),
      h('span', { class: 'add-card-title' }, first ? 'Connect a car' : 'Connect another car'),
      h(
        'span',
        { class: 'add-card-help' },
        app.sim
          ? 'Adds a simulated car.'
          : 'Switch the car on and lift it off the charger, then pick it from the list. It may show up as "Drive" or a string of odd characters.',
      ),
    );
  }

  function buildCard(entry, index) {
    const { car, steering } = entry;
    const controls = freeDriveControls(entry);
    const slot = index === 0 ? 'p1' : index === 1 ? 'p2' : null;

    const status = h('span', { class: 'pill' });
    const batteryFill = h('span', { class: 'battery-fill' });
    const batteryText = h('span', { class: 'battery-text' });
    const detail = h('span', { class: 'car-detail' });
    const speedValue = h('span', { class: 'speed-value' }, '0');
    const laneText = h('span', { class: 'speed-lane' });

    const slider = h('input', {
      class: 'speed-slider',
      type: 'range',
      min: 0,
      max: SPEED.MAX,
      step: 10,
      value: 0,
      'aria-label': `${car.name} speed`,
      onInput: () => car.setSpeed(Number(slider.value)),
    });
    let dragging = false;
    slider.addEventListener('pointerdown', () => {
      dragging = true;
    });
    const release = () => {
      dragging = false;
    };
    slider.addEventListener('pointerup', () => {
      release();
      slider.blur(); // a focused slider would swallow the driving keys
    });
    slider.addEventListener('pointercancel', release);
    slider.addEventListener('blur', release);

    const identity = h(
      'select',
      {
        class: 'car-name',
        'aria-label': 'Which car is this?',
        onChange: () => {
          identity.blur(); // a focused select would swallow the driving keys
          app.setIdentity(entry, identity.value);
        },
      },
      IDENTITIES.map((option) => h('option', { value: option.key, selected: option === entry.identity }, option.name)),
    );

    const lights = h(
      'button',
      {
        class: 'button',
        type: 'button',
        'aria-pressed': 'false',
        onClick: () => car.setLights(!car.state.lightsOn),
      },
      icon('bulb'),
      'Lights',
    );

    const body = h(
      'div',
      { class: 'car-body' },
      h(
        'div',
        { class: 'speed' },
        h('div', { class: 'speed-readout' }, speedValue, h('span', { class: 'speed-unit' }, 'mm/s'), laneText),
        slider,
      ),
      h(
        'div',
        { class: 'car-controls' },
        h('button', { class: 'button button-lane', type: 'button', 'aria-label': 'Lane left', onClick: () => controls.steer(-1) }, icon('left', 22)),
        h('button', { class: 'button button-stop', type: 'button', onClick: () => car.stop() }, icon('stop'), 'Stop'),
        h('button', { class: 'button button-lane', type: 'button', 'aria-label': 'Lane right', onClick: () => controls.steer(1) }, icon('right', 22)),
      ),
      h(
        'div',
        { class: 'car-extras' },
        lights,
        h(
          'button',
          {
            class: 'button',
            type: 'button',
            title: 'Flash this car so you can tell which one it is',
            onClick: () => {
              car.flashEngine([1, 1, 1], entry.identity.engine, 2000);
              sfx.click();
            },
          },
          icon('signal'),
          'Identify',
        ),
      ),
      slot
        ? h(
            'p',
            { class: 'keys' },
            'Keys: ',
            ['faster', 'slower', 'left', 'right'].map((action) => h('kbd', {}, KEY_LABELS[slot][action])),
            ' speed and lane',
          )
        : null,
    );

    const element = h(
      'article',
      { class: 'car-card', style: { '--car': entry.identity.color } },
      h(
        'header',
        { class: 'car-head' },
        h('span', { class: 'car-dot', 'aria-hidden': 'true' }),
        identity,
        h('button', { class: 'icon-button', type: 'button', 'aria-label': `Disconnect ${car.name}`, title: 'Disconnect', onClick: () => car.disconnect() }, icon('close')),
      ),
      h('div', { class: 'car-stats' }, h('span', { class: 'battery', 'aria-hidden': 'true' }, batteryFill), batteryText, detail, status),
      body,
    );

    return {
      element,
      update() {
        const { state } = car;
        setText(status, STATUS_TEXT[state.connection]);
        status.dataset.state = state.connection;
        body.inert = state.connection !== 'ready';

        const percent = car.batteryPercent;
        batteryFill.style.width = `${percent ?? 0}%`;
        batteryFill.classList.toggle('is-low', percent !== null && percent <= LOW_BATTERY_PERCENT);
        setText(batteryText, percent === null ? 'Battery --' : `${percent}%`);
        const facts = [];
        if (state.millivolts !== null) facts.push(`${(state.millivolts / 1000).toFixed(2)} V`);
        if (state.onCharger) facts.push('on charger');
        if (state.delocalized) facts.push('off track');
        setText(detail, facts.join(' · '));

        setText(speedValue, Math.round(state.commandedSpeed > 0 ? car.speed || state.commandedSpeed : 0));
        setText(laneText, steering.lane === null ? '' : `lane ${steering.lane + 1} of 4`);
        if (!dragging && Number(slider.value) !== state.commandedSpeed) slider.value = state.commandedSpeed;
        slider.style.setProperty('--fill', `${(state.commandedSpeed / SPEED.MAX) * 100}%`);
        lights.setAttribute('aria-pressed', String(state.lightsOn));
      },
    };
  }

  app.on('cars', build);
  build();

  return {
    element,
    show: build,
    frame() {
      for (const card of cards) card.update();
    },
  };
}
