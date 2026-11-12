// Log: every raw message to and from each car, with tools to poke a car by hand.

import * as protocol from '../../protocol.js';
import { clear, h, icon } from '../dom.js';
import { formatEntries } from '../log.js';

const MAX_ROWS = 600; // rows kept in the page; the store itself keeps more, and Copy copies all of it
const ARROW = { tx: '→', rx: '←', note: '·' };
const DIRECTION_LABEL = { tx: 'sent', rx: 'received', note: 'note' };

export function createLogView(app) {
  let showChatty = true;
  let paused = false;
  let carFilter = 'all';
  let pending = [];
  let visible = false;

  const list = h('ol', { class: 'log-list', tabindex: 0, 'aria-label': 'Message log' });
  const empty = h('p', { class: 'hint log-empty' }, 'Nothing yet. Connect a car and its messages appear here.');
  const filter = h('select', { 'aria-label': 'Show messages from', onChange: () => { carFilter = filter.value; repaint(); } });
  const target = h('select', { 'aria-label': 'Send to' });
  const hex = h('input', {
    type: 'text',
    class: 'hex-input',
    placeholder: '03 90 01 01',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Raw message in hex',
  });
  const pauseButton = h('button', { class: 'button', type: 'button', 'aria-pressed': 'false', onClick: togglePause }, icon('pause'), 'Pause');

  const matches = (entry) =>
    (showChatty || !entry.chatty) && (carFilter === 'all' || entry.carId === carFilter || entry.carId === null);

  function row(entry) {
    return h(
      'li',
      { class: `log-row log-${entry.direction} log-level-${entry.level}`, style: entry.carColor ? { '--car': entry.carColor } : null },
      h('span', { class: 'log-time' }, entry.time),
      h('span', { class: 'log-car' }, entry.carName),
      h('span', { class: 'log-arrow', title: DIRECTION_LABEL[entry.direction] }, ARROW[entry.direction]),
      h('span', { class: 'log-text' }, entry.text),
      entry.hex ? h('span', { class: 'log-hex' }, entry.hex) : null,
    );
  }

  function repaint() {
    pending = [];
    const rows = app.log.entries.filter(matches).slice(-MAX_ROWS).map(row);
    clear(list).append(...rows);
    empty.hidden = rows.length > 0;
    list.scrollTop = list.scrollHeight;
  }

  /** Appends what arrived since the last frame, keeping the view pinned to the bottom if it was there. */
  function flush() {
    if (pending.length === 0) return;
    const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.append(...pending.map(row));
    pending = [];
    while (list.children.length > MAX_ROWS) list.firstChild.remove();
    empty.hidden = true;
    if (pinned) list.scrollTop = list.scrollHeight;
  }

  app.log.subscribe((entry) => {
    if (!visible) return;
    if (entry === null) repaint(); // cleared: empty the list even while paused
    else if (!paused && matches(entry)) pending.push(entry);
  });

  function togglePause() {
    paused = !paused;
    pauseButton.setAttribute('aria-pressed', String(paused));
    clear(pauseButton).append(icon(paused ? 'play' : 'pause'), paused ? 'Resume' : 'Pause');
    if (!paused) repaint();
  }

  async function copy() {
    const text = formatEntries(app.log.entries.filter(matches));
    try {
      await navigator.clipboard.writeText(text);
      app.toast('Log copied. Paste it into the chat with Claude.', 'good');
    } catch {
      // Clipboard access can be refused: fall back to a box the user can copy from by hand.
      const box = h('textarea', { class: 'copy-box', readonly: true, 'aria-label': 'Log text' }, text);
      list.before(box);
      box.select();
      app.toast('Could not reach the clipboard. The log is selected below: copy it by hand.', 'error');
    }
  }

  function paintCars() {
    const options = (extra) => [...extra, ...app.cars.map(({ car }) => h('option', { value: car.id }, car.name))];
    const keep = (select, fallback) => {
      const previous = select.value;
      return [...select.options].some((option) => option.value === previous) ? previous : fallback;
    };
    clear(filter).append(...options([h('option', { value: 'all' }, 'All cars')]));
    filter.value = keep(filter, 'all');
    carFilter = filter.value;
    clear(target).append(...options([]));
    if (app.cars.length === 0) target.append(h('option', { value: '' }, 'No car connected'));
    else target.value = keep(target, app.cars[0].car.id);
    for (const control of tools.querySelectorAll('button, input')) control.disabled = app.cars.length === 0;
  }

  const targetCar = () => app.cars.find(({ car }) => car.id === target.value)?.car ?? null;
  const command = (label, action) =>
    h('button', { class: 'button button-small', type: 'button', onClick: () => { const car = targetCar(); if (car) action(car); } }, label);

  function sendHex(event) {
    event.preventDefault();
    const car = targetCar();
    const bytes = protocol.fromHex(hex.value);
    if (!car) return;
    if (!bytes || bytes.length > protocol.MAX_MESSAGE_BYTES) {
      app.toast(`That is not a valid message: 1 to ${protocol.MAX_MESSAGE_BYTES} bytes of hex, for example 03 90 01 01.`, 'error');
      return;
    }
    car.sendRaw(bytes);
  }

  const tools = h(
    'form',
    { class: 'log-tools', onSubmit: sendHex },
    h('label', { class: 'field' }, 'Send to', target),
    command('Ping', (car) => car.ping()),
    command('Version', (car) => car.requestVersion()),
    command('Battery', (car) => car.requestBattery()),
    command('SDK mode on', (car) => car.sendRaw(protocol.sdkMode(true))),
    hex,
    h('button', { class: 'button button-small', type: 'submit' }, 'Send hex'),
  );

  const element = h(
    'section',
    { class: 'view view-log' },
    h(
      'header',
      { class: 'view-head' },
      h('h1', {}, 'Log'),
      h('p', { class: 'lede' }, 'Every message to and from the cars. When something goes wrong on the track, copy this and paste it to Claude.'),
    ),
    h(
      'div',
      { class: 'panel log-panel' },
      h(
        'div',
        { class: 'log-bar' },
        filter,
        h(
          'label',
          { class: 'toggle' },
          h('input', {
            type: 'checkbox',
            checked: true,
            onChange: (event) => {
              showChatty = event.target.checked;
              repaint();
            },
          }),
          'Position updates',
        ),
        h('span', { class: 'spacer' }),
        pauseButton,
        h('button', { class: 'button', type: 'button', onClick: copy }, icon('copy'), 'Copy log'),
        h('button', { class: 'button button-quiet', type: 'button', onClick: () => app.log.clear() }, icon('trash'), 'Clear'),
      ),
      empty,
      list,
      tools,
    ),
  );

  app.on('cars', paintCars);
  paintCars();

  return {
    element,
    show() {
      visible = true;
      paintCars();
      repaint();
    },
    hide() {
      visible = false;
      pending = [];
    },
    frame: flush,
  };
}
