// The track drawn as a loop of pieces in driving order, with a marker per car.
//
// This is a schematic, not the physical shape of the layout: a scan tells us
// the order of the pieces reliably, and that is all a race needs to show.

import { PIECE, PIECE_LABELS } from '../track.js';
import { h } from './dom.js';

const WIDTH = 520;
const HEIGHT = 280;
const STRAIGHT = 220; // length of the loop's two straight sides
const RADIUS = 96;
const ROAD = 34; // drawn road width
const GAP = 0.004; // fraction of the loop left open between two pieces
const LANE_PX = 6; // how far apart the four lanes are drawn

const PERIMETER = 2 * STRAIGHT + 2 * Math.PI * RADIUS;
const CX = WIDTH / 2;
const CY = HEIGHT / 2;

/**
 * A point on the loop, clockwise from the left end of the top side.
 * @param {number} u position round the loop, any real number; 1 is one full lap
 * @returns {{x: number, y: number, nx: number, ny: number}} the point and the outward normal
 */
function pointAt(u) {
  let d = (((u % 1) + 1) % 1) * PERIMETER;
  if (d < STRAIGHT) return { x: CX - STRAIGHT / 2 + d, y: CY - RADIUS, nx: 0, ny: -1 };
  d -= STRAIGHT;
  const arc = Math.PI * RADIUS;
  if (d < arc) {
    const angle = -Math.PI / 2 + d / RADIUS;
    return { x: CX + STRAIGHT / 2 + RADIUS * Math.cos(angle), y: CY + RADIUS * Math.sin(angle), nx: Math.cos(angle), ny: Math.sin(angle) };
  }
  d -= arc;
  if (d < STRAIGHT) return { x: CX + STRAIGHT / 2 - d, y: CY + RADIUS, nx: 0, ny: 1 };
  d -= STRAIGHT;
  const angle = Math.PI / 2 + d / RADIUS;
  return { x: CX - STRAIGHT / 2 + RADIUS * Math.cos(angle), y: CY + RADIUS * Math.sin(angle), nx: Math.cos(angle), ny: Math.sin(angle) };
}

function arcPath(from, to) {
  const steps = Math.max(2, Math.ceil((to - from) * 160));
  let d = '';
  for (let i = 0; i <= steps; i += 1) {
    const { x, y } = pointAt(from + ((to - from) * i) / steps);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

/**
 * @param {import('../track.js').TrackMap} map
 * @param {{labels?: boolean, onSelect?: (index: number) => void}} [options]
 *   labels: print each piece's id beside it. onSelect: makes pieces clickable.
 */
export function createTrackMap(map, { labels = false, onSelect = null } = {}) {
  const count = map.length;
  // Piece 0 holds the finish line: centre it on the top side.
  const origin = STRAIGHT / 2 / PERIMETER - 0.5 / count;
  const start = (index) => origin + index / count;
  const centre = (index) => origin + (index + 0.5) / count;

  const pieces = [];
  const road = h('g', { class: 'map-road' });
  for (let index = 0; index < count; index += 1) {
    const type = map.typeAt(index);
    const label = `Piece ${index + 1}: ${PIECE_LABELS[type]}, id ${map.idAt(index)}`;
    const path = h(
      'path',
      {
        class: `map-piece map-piece-${type}`,
        d: arcPath(start(index) + GAP, start(index + 1) - GAP),
        'stroke-width': ROAD,
        fill: 'none',
        ...(onSelect ? { tabindex: 0, role: 'button', 'aria-label': label } : {}),
      },
      h('title', {}, label),
    );
    if (onSelect) {
      path.addEventListener('click', () => onSelect(index));
      path.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect(index);
      });
    }
    pieces.push(path);
    road.append(path);
  }

  const marks = h('g', { class: 'map-marks', 'aria-hidden': 'true' });
  for (let index = 0; index < count; index += 1) {
    const type = map.typeAt(index);
    const at = pointAt(centre(index));
    if (type === PIECE.POWER_ZONE) {
      marks.append(
        h('path', {
          class: 'map-bolt',
          d: 'M1.5 -9 -5 1.5h4l-1 7.5 6.5-10.5h-4z',
          transform: `translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})`,
        }),
      );
    }
    if (labels) {
      const out = ROAD / 2 + 13;
      marks.append(
        h(
          'text',
          { class: 'map-label', x: (at.x + at.nx * out).toFixed(1), y: (at.y + at.ny * out + 4).toFixed(1), 'text-anchor': 'middle' },
          map.idAt(index),
        ),
      );
    }
  }
  // The finish line is where piece 0 begins. Drawn just inside it so it shows against the piece.
  const line = pointAt(start(0) + GAP + 3 / PERIMETER);
  marks.append(
    h('line', {
      class: 'map-line',
      x1: (line.x - (line.nx * ROAD) / 2).toFixed(1),
      y1: (line.y - (line.ny * ROAD) / 2).toFixed(1),
      x2: (line.x + (line.nx * ROAD) / 2).toFixed(1),
      y2: (line.y + (line.ny * ROAD) / 2).toFixed(1),
    }),
  );
  // An arrow inside the loop shows which way the cars go round.
  const arrowAt = pointAt(centre(0));
  marks.append(
    h('path', {
      class: 'map-arrow',
      d: 'M-14 0h22M2 -6l7 6-7 6',
      transform: `translate(${arrowAt.x.toFixed(1)} ${(arrowAt.y + ROAD / 2 + 16).toFixed(1)})`,
    }),
  );

  const carLayer = h('g', { class: 'map-cars' });
  const flashLayer = h('g', { class: 'map-flashes', 'aria-hidden': 'true' });
  const svg = h(
    'svg',
    { class: 'trackmap', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img', 'aria-label': `Track map, ${count} pieces` },
    road,
    marks,
    flashLayer,
    carLayer,
  );

  const markers = new Map(); // key -> circle element

  return {
    element: svg,

    /**
     * Moves the car markers.
     * @param {Array<{key: string, color: string, index: number|null, lane: number|null, dimmed?: boolean}>} cars
     */
    setCars(cars) {
      const seen = new Set();
      for (const car of cars) {
        seen.add(car.key);
        let marker = markers.get(car.key);
        if (!marker) {
          marker = h('circle', { class: 'map-car', r: 8 });
          markers.set(car.key, marker);
          carLayer.append(marker);
        }
        marker.style.fill = car.color;
        marker.classList.toggle('is-dimmed', Boolean(car.dimmed));
        marker.classList.toggle('is-hidden', car.index === null);
        if (car.index === null) continue;
        const at = pointAt(centre(car.index));
        // Lanes run left to right across the road. On a clockwise loop, left is the outside.
        const across = ((car.lane ?? 1.5) - 1.5) * -LANE_PX;
        marker.setAttribute('cx', (at.x + at.nx * across).toFixed(1));
        marker.setAttribute('cy', (at.y + at.ny * across).toFixed(1));
      }
      for (const [key, marker] of markers) {
        if (seen.has(key)) continue;
        marker.remove();
        markers.delete(key);
      }
    },

    setSelected(index) {
      pieces.forEach((piece, i) => piece.classList.toggle('is-selected', i === index));
    },

    /** A short burst on a piece, for hits and the Power Zone. */
    flash(index, color) {
      if (index === null || index === undefined) return;
      const at = pointAt(centre(index));
      const burst = h('circle', { class: 'map-flash', cx: at.x.toFixed(1), cy: at.y.toFixed(1), r: 10 });
      burst.style.stroke = color;
      flashLayer.append(burst);
      burst.addEventListener('animationend', () => burst.remove());
      setTimeout(() => burst.remove(), 1200); // if animations are disabled, still clean up
    },
  };
}
