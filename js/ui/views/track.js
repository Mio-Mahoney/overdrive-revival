// Track: scan the layout with one car, look at the map, and tell the app
// about any piece it does not recognise (the Power Zone, most likely).

import { PIECE, PIECE_LABELS, TAGGABLE_TYPES, TrackScanner } from '../../track.js';
import { clear, h, icon } from '../dom.js';
import { sfx } from '../sound.js';
import { createTrackMap } from '../trackmap.js';

export function createTrackView(app) {
  const body = h('div', { class: 'stack' });
  const element = h(
    'section',
    { class: 'view' },
    h(
      'header',
      { class: 'view-head' },
      h('h1', {}, 'Track'),
      h('p', { class: 'lede' }, 'One car drives a slow lap to learn the layout. Races and battles need this map.'),
    ),
    body,
  );

  let scanner = null;
  let scanCarId = null;
  let selected = null;
  let trackMap = null;
  let progressText = null;

  function build() {
    clear(body);
    trackMap = null;
    if (scanner) {
      body.append(buildScanning());
      return;
    }
    // Once there is a map it is the main thing on this screen; rescanning moves below it.
    if (app.map) body.append(buildMapPanel());
    body.append(buildScanPanel());
  }

  // -- Scan ------------------------------------------------------------------

  function buildScanPanel() {
    const ready = app.cars.filter((entry) => entry.car.isReady);
    if (ready.length === 0) {
      return h(
        'div',
        { class: 'panel empty' },
        h('p', {}, 'Connect a car first, then come back to scan the track.'),
        h('button', { class: 'button button-primary', type: 'button', onClick: () => app.navigate('drive') }, 'Go to Drive'),
      );
    }
    if (app.sessionIsLive) {
      return h('div', { class: 'panel empty' }, h('p', {}, `Finish the ${app.session.kind} before scanning again.`));
    }
    if (!ready.some((entry) => entry.car.id === scanCarId)) scanCarId = ready[0].car.id;
    const picker = h(
      'select',
      {
        id: 'scan-car',
        onChange: () => {
          scanCarId = picker.value;
        },
      },
      ready.map((entry) => h('option', { value: entry.car.id, selected: entry.car.id === scanCarId }, entry.car.name)),
    );
    return h(
      'div',
      { class: 'panel' },
      h('h2', {}, app.map ? 'Changed the layout?' : 'Scan the track'),
      app.map
        ? h('p', { class: 'hint' }, 'Scan again with one car on the track and the others off it.')
        : h(
            'ol',
            { class: 'steps' },
            h('li', {}, 'Build a closed loop with exactly one start piece.'),
            h('li', {}, 'Put one car on the track, pointing the way the start piece arrow points. Take the other cars off.'),
            h('li', {}, 'Press Scan. The car drives until it has seen the start piece twice, then parks.'),
          ),
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'field', for: 'scan-car' }, 'Scan with', picker),
        h('button', { class: 'button button-primary', type: 'button', onClick: startScan }, icon('refresh'), app.map ? 'Scan again' : 'Scan'),
      ),
    );
  }

  function buildScanning() {
    progressText = h('p', { class: 'scan-count', 'aria-live': 'polite' }, 'Waiting for the first piece');
    return h(
      'div',
      { class: 'panel scanning' },
      h('h2', {}, 'Scanning'),
      h('div', { class: 'scan-pulse', 'aria-hidden': 'true' }),
      progressText,
      h('button', { class: 'button', type: 'button', onClick: cancelScan }, 'Cancel'),
    );
  }

  function startScan() {
    const entry = app.cars.find((candidate) => candidate.car.id === scanCarId);
    if (!entry?.car.isReady) return;
    scanner = new TrackScanner(entry.car, { tags: app.map?.tags ?? {} });
    scanner.on('progress', (pieces) => {
      const seen = pieces.filter((id) => id !== null).length;
      if (progressText) progressText.textContent = `${seen} ${seen === 1 ? 'piece' : 'pieces'} driven`;
    });
    scanner.on('done', (map) => {
      scanner = null;
      selected = null;
      app.log.note(`Track scanned: ${map.toJSON().pieces.join(', ')}`, 'info', entry.car);
      sfx.finish();
      app.toast(`Track scanned: ${map.length} pieces.`, 'good');
      app.setMap(map); // rebuilds this view through the 'map' event
    });
    scanner.on('failed', (reason) => {
      app.log.note(`Scan failed: ${reason} Pieces seen: ${scanner.pieces.join(', ') || 'none'}`, 'error', entry.car);
      scanner = null;
      sfx.lose();
      app.toast(reason, 'error');
      build();
    });
    scanner.start();
    build();
  }

  function cancelScan() {
    scanner?.cancel();
    scanner = null;
    build();
  }

  // -- Map -------------------------------------------------------------------

  function buildMapPanel() {
    const map = app.map;
    trackMap = createTrackMap(map, { labels: true, onSelect: select });
    trackMap.setSelected(selected);

    const unknown = map.unknownIds;
    const panel = h(
      'div',
      { class: 'panel' },
      h(
        'div',
        { class: 'panel-head' },
        h('h2', {}, `Your track: ${map.length} pieces`),
        h('button', { class: 'button button-quiet', type: 'button', onClick: forget }, icon('trash'), 'Forget this map'),
      ),
    );

    if (unknown.length > 0) {
      panel.append(
        h(
          'div',
          { class: 'callout callout-warn' },
          icon('warning', 20),
          h(
            'div',
            {},
            h('strong', {}, unknown.length === 1 ? `Piece ${unknown[0]} is new to the app.` : `Pieces ${unknown.join(', ')} are new to the app.`),
            h('p', {}, 'Select each one on the map and say what it is. If one of them is the Power Zone, mark it so battles can use it.'),
          ),
        ),
      );
    } else if (!map.hasType(PIECE.START)) {
      panel.append(
        h(
          'div',
          { class: 'callout callout-warn' },
          icon('warning', 20),
          h('div', {}, h('strong', {}, 'No start piece found.'), h('p', {}, 'Select the start piece on the map and mark it, so laps are counted at the right place.')),
        ),
      );
    }

    panel.append(h('div', { class: 'map-frame' }, trackMap.element), buildLegend(), buildInspector());
    return panel;
  }

  function buildLegend() {
    const types = [PIECE.START, PIECE.STRAIGHT, PIECE.CURVE, PIECE.POWER_ZONE, PIECE.UNKNOWN];
    return h(
      'ul',
      { class: 'legend' },
      types.filter((type) => app.map.hasType(type)).map((type) => h('li', {}, h('span', { class: `swatch swatch-${type}` }), PIECE_LABELS[type])),
    );
  }

  function buildInspector() {
    if (selected === null || selected >= app.map.length) {
      return h('p', { class: 'hint' }, 'Select a piece on the map to see what it is or to change its type.');
    }
    const map = app.map;
    const id = map.idAt(selected);
    const current = map.typeAt(selected);
    return h(
      'div',
      { class: 'inspector' },
      h('p', {}, h('strong', {}, `Piece ${selected + 1}`), ` reports id ${id}. The app treats it as:`),
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Piece type' },
        TAGGABLE_TYPES.map((type) =>
          h(
            'button',
            {
              type: 'button',
              class: 'segment',
              'aria-pressed': String(type === current),
              onClick: () => {
                if (type === current) return;
                // Tagging the start piece re-centres the map, so the old selection would point elsewhere.
                selected = null;
                map.tag(id, type);
              },
            },
            PIECE_LABELS[type],
          ),
        ),
      ),
      Object.hasOwn(map.tags, id)
        ? h(
            'button',
            {
              class: 'button button-quiet',
              type: 'button',
              onClick: () => {
                selected = null;
                map.tag(id, null);
              },
            },
            'Reset to the built-in type',
          )
        : null,
    );
  }

  function select(index) {
    selected = selected === index ? null : index;
    build();
  }

  function forget() {
    selected = null;
    app.setMap(null);
    app.toast('Map forgotten. Scan again before the next race.');
  }

  app.on('map', build);
  app.on('cars', () => {
    if (!scanner) build();
  });
  app.on('session', build);
  build();

  return {
    element,
    show: build,
    hide() {
      // Leaving the screen mid-scan would leave a car circling unattended.
      if (scanner) cancelScan();
    },
    frame() {
      if (!trackMap) return;
      trackMap.setCars(
        app.cars.map(({ car, steering }) => {
          const indices = car.state.pieceId === null ? [] : app.map.indicesOf(car.state.pieceId);
          return { key: car.id, color: car.color, index: indices[0] ?? null, lane: steering.lane };
        }),
      );
    },
  };
}
