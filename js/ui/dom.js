// Small DOM helpers. The app has no framework and no build step.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'g', 'line', 'text', 'polygon', 'polyline', 'title']);

/**
 * Creates an element. Props: `class`, `dataset`, `style` (object), `on<event>` handlers,
 * and anything else becomes an attribute (false, null and undefined are skipped).
 * Children may be nodes, strings, numbers, arrays, or null/false to skip.
 */
export function h(tag, props = {}, ...children) {
  const node = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.setAttribute('class', value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [name, v] of Object.entries(value)) node.style.setProperty(name, v);
    } else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Sets text only when it changed, so per-frame updates do not thrash layout or selection. */
export function setText(node, text) {
  const value = String(text);
  if (node.textContent !== value) node.textContent = value;
}

/** 83456 ms becomes "1:23.456"; under a minute it is "23.456". */
export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--.---';
  const total = Math.floor(ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  const tail = `${String(seconds).padStart(minutes > 0 ? 2 : 1, '0')}.${String(millis).padStart(3, '0')}`;
  return minutes > 0 ? `${minutes}:${tail}` : tail;
}

export function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

const ICON_PATHS = {
  bluetooth: 'M7 7l10 10-5 5V2l5 5L7 17',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  up: 'M5 15l7-7 7 7',
  down: 'M5 9l7 7 7-7',
  stop: 'M7 7h10v10H7z',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.4 1 2.5h6c0-1.1.3-1.8 1-2.5A6 6 0 0 0 12 3z',
  flag: 'M5 21V4M5 4h13l-2.5 4.5L18 13H5',
  target: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 12h.01M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  map: 'M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  wheel: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM3.5 10.5L10 12M20.5 10.5L14 12M12 14v7',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  soundOn: 'M4 9v6h4l5 4V5L8 9H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  soundOff: 'M4 9v6h4l5 4V5L8 9H4zM16 9l5 6M21 9l-5 6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4l13 8-13 8V4z',
  refresh: 'M20 11a8 8 0 1 0-2.3 6.7M20 4v7h-7',
  signal: 'M5 19v-4M10 19V11M15 19V7M20 19V3',
  warning: 'M12 3l10 18H2L12 3zM12 10v5M12 18h.01',
};

/** An inline stroke icon. Decorative by default: give the button its own label. */
export function icon(name, size = 18) {
  return h(
    'svg',
    {
      class: 'icon',
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    },
    h('path', { d: ICON_PATHS[name] ?? '' }),
  );
}
