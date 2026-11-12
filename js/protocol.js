// Anki Drive wire protocol: commands to bytes, incoming bytes to events.
//
// Source of truth: include/ankidrive/protocol.h and src/protocol.c in
// https://github.com/anki/drive-sdk (Apache 2.0). Every message is
//   byte 0: size (number of bytes that follow, so message id + payload)
//   byte 1: message id
//   bytes 2..: payload, little-endian, 18 bytes max
// This module is pure: no Bluetooth, no DOM, no timers.
//
// The SDK predates Overdrive, so the cars also send messages it does not
// document. Those marked "community" below come from open-source projects
// that reverse-engineered them (mainly MasterAirscrachDev/Anki-Partydrive)
// and are still to be confirmed on a real Fast & Furious car.

export const MAX_MESSAGE_BYTES = 20;

export const MSG = Object.freeze({
  // App to car
  DISCONNECT: 0x0d,
  PING_REQUEST: 0x16,
  VERSION_REQUEST: 0x18,
  BATTERY_REQUEST: 0x1a,
  SET_LIGHTS: 0x1d,
  SET_SPEED: 0x24,
  CHANGE_LANE: 0x25,
  CANCEL_LANE_CHANGE: 0x26,
  SET_OFFSET: 0x2c,
  TURN: 0x32,
  LIGHTS_PATTERN: 0x33,
  SET_CONFIG_PARAMS: 0x45,
  SDK_MODE: 0x90,
  // Car to app
  PING_RESPONSE: 0x17,
  VERSION_RESPONSE: 0x19,
  BATTERY_RESPONSE: 0x1b,
  POSITION_UPDATE: 0x27,
  TRANSITION_UPDATE: 0x29,
  INTERSECTION_UPDATE: 0x2a,
  DELOCALIZED: 0x2b,
  OFFSET_UPDATE: 0x2d,
  // Car to app, community
  SPEED_UPDATE: 0x36,
  STATUS: 0x3f,
  LANE_CHANGE_UPDATE: 0x41,
  DELOC_RECOVERY_STARTED: 0x43,
  DELOC_RECOVERY_DONE: 0x44,
  COLLISION: 0x4d,
  SPECIAL_PIECE: 0x53,
  CYCLE_OVERTIME: 0x86,
});

const NAMES = Object.freeze({
  [MSG.DISCONNECT]: 'disconnect',
  [MSG.PING_REQUEST]: 'ping',
  [MSG.VERSION_REQUEST]: 'version?',
  [MSG.BATTERY_REQUEST]: 'battery?',
  [MSG.SET_LIGHTS]: 'set lights',
  [MSG.SET_SPEED]: 'set speed',
  [MSG.CHANGE_LANE]: 'change lane',
  [MSG.CANCEL_LANE_CHANGE]: 'cancel lane change',
  [MSG.SET_OFFSET]: 'set offset',
  [MSG.TURN]: 'turn',
  [MSG.LIGHTS_PATTERN]: 'lights pattern',
  [MSG.SET_CONFIG_PARAMS]: 'set config',
  [MSG.SDK_MODE]: 'sdk mode',
  [MSG.PING_RESPONSE]: 'pong',
  [MSG.VERSION_RESPONSE]: 'version',
  [MSG.BATTERY_RESPONSE]: 'battery',
  [MSG.POSITION_UPDATE]: 'position',
  [MSG.TRANSITION_UPDATE]: 'transition',
  [MSG.INTERSECTION_UPDATE]: 'intersection',
  [MSG.DELOCALIZED]: 'delocalized',
  [MSG.OFFSET_UPDATE]: 'offset',
  [MSG.SPEED_UPDATE]: 'speed update',
  [MSG.STATUS]: 'status',
  [MSG.LANE_CHANGE_UPDATE]: 'lane change update',
  [MSG.DELOC_RECOVERY_STARTED]: 'recovering from off-track',
  [MSG.DELOC_RECOVERY_DONE]: 'recovered from off-track',
  [MSG.COLLISION]: 'collision',
  [MSG.SPECIAL_PIECE]: 'special piece',
  [MSG.CYCLE_OVERTIME]: 'cycle overtime',
});

/** SDK mode flag: let the app, not the car's built-in game logic, own localization. */
export const SDK_OPTION_OVERRIDE_LOCALIZATION = 0x01;

/** Bit masks for the parsing_flags byte of a position update. */
export const PARSE_FLAGS = Object.freeze({
  NUM_BITS: 0x0f,
  REVERSE_DRIVING: 0x20,
  REVERSE_PARSING: 0x40,
  INVERTED_COLOR: 0x80,
});

/** Lights addressed by the simple set-lights message. */
export const LIGHT = Object.freeze({ HEADLIGHTS: 0, BRAKELIGHTS: 1, FRONTLIGHTS: 2, ENGINE: 3 });

/** LED channels addressed by the lights-pattern message. */
export const LIGHT_CHANNEL = Object.freeze({ RED: 0, TAIL: 1, BLUE: 2, GREEN: 3, FRONT_LEFT: 4, FRONT_RIGHT: 5 });

export const LIGHT_EFFECT = Object.freeze({ STEADY: 0, FADE: 1, THROB: 2, FLASH: 3, RANDOM: 4 });

export const MAX_LIGHT_INTENSITY = 14;
const MAX_PATTERN_CHANNELS = 3;

// ---------------------------------------------------------------------------
// Encoding (app to car)
// ---------------------------------------------------------------------------

/** Allocates a message with `size` bytes after the size byte and fills in the header. */
function frame(id, size) {
  const bytes = new Uint8Array(size + 1);
  bytes[0] = size;
  bytes[1] = id;
  return { bytes, view: new DataView(bytes.buffer) };
}

const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value) || 0)));

export function sdkMode(on = true, flags = SDK_OPTION_OVERRIDE_LOCALIZATION) {
  const { bytes } = frame(MSG.SDK_MODE, 3);
  bytes[2] = on ? 1 : 0;
  bytes[3] = flags & 0xff;
  return bytes;
}

/**
 * Firmware from this version on expects one more byte on set speed (community:
 * "drive without localization"). Older firmware gets the 7-byte SDK form.
 */
export const EXTENDED_SET_SPEED_FROM_VERSION = 12385;

/**
 * @param {number} speed mm/s
 * @param {number} accel mm/s^2
 * @param {{respectSpeedLimit?: boolean, extended?: boolean}} [options]
 *   respectSpeedLimit: let the car cap its speed on pieces that carry a limit.
 *   extended: send the longer form newer firmware needs, see EXTENDED_SET_SPEED_FROM_VERSION.
 */
export function setSpeed(speed, accel = 1000, { respectSpeedLimit = false, extended = false } = {}) {
  const { bytes, view } = frame(MSG.SET_SPEED, extended ? 7 : 6);
  view.setInt16(2, clampInt(speed, -32768, 32767), true);
  view.setInt16(4, clampInt(accel, 0, 32767), true);
  bytes[6] = respectSpeedLimit ? 1 : 0;
  if (extended) bytes[7] = 1;
  return bytes;
}

/** Tells the car where it currently is, in mm from the road centre line. */
export function setOffset(offsetMm) {
  const { bytes, view } = frame(MSG.SET_OFFSET, 5);
  view.setFloat32(2, Number(offsetMm) || 0, true);
  return bytes;
}

/**
 * @param {number} offsetMm target position in mm from the road centre line
 * @param {number} horizontalSpeed mm/s
 * @param {number} horizontalAccel mm/s^2
 * @param {number} tag echoed back by the car as the last received / executed lane change id
 */
export function changeLane(offsetMm, horizontalSpeed = 300, horizontalAccel = 2500, tag = 0) {
  const { bytes, view } = frame(MSG.CHANGE_LANE, 11);
  view.setUint16(2, clampInt(horizontalSpeed, 0, 65535), true);
  view.setUint16(4, clampInt(horizontalAccel, 0, 65535), true);
  view.setFloat32(6, Number(offsetMm) || 0, true);
  bytes[10] = 0; // hop intent
  bytes[11] = tag & 0xff;
  return bytes;
}

export const cancelLaneChange = () => frame(MSG.CANCEL_LANE_CHANGE, 1).bytes;
export const ping = () => frame(MSG.PING_REQUEST, 1).bytes;
export const versionRequest = () => frame(MSG.VERSION_REQUEST, 1).bytes;
export const batteryRequest = () => frame(MSG.BATTERY_REQUEST, 1).bytes;
export const disconnect = () => frame(MSG.DISCONNECT, 1).bytes;

/**
 * Builds the mask for the simple set-lights message. The low nibble marks
 * which lights the message addresses, the high nibble carries their on/off value.
 * @param {Partial<Record<keyof typeof LIGHT, boolean>>} lights e.g. { HEADLIGHTS: true, BRAKELIGHTS: false }
 */
export function lightMask(lights) {
  let mask = 0;
  for (const [name, on] of Object.entries(lights)) {
    const bit = LIGHT[name];
    if (bit === undefined) throw new RangeError(`Unknown light: ${name}`);
    mask |= 1 << bit;
    if (on) mask |= 1 << (bit + 4);
  }
  return mask;
}

export function setLights(mask) {
  const { bytes } = frame(MSG.SET_LIGHTS, 2);
  bytes[2] = mask & 0xff;
  return bytes;
}

/**
 * @param {Array<{channel: number, effect?: number, start?: number, end?: number, cyclesPer10s?: number}>} channels
 *   up to three LED channels. `start` and `end` are intensities (0-14), or times for the flash effect.
 */
export function lightsPattern(channels) {
  if (!Array.isArray(channels) || channels.length === 0 || channels.length > MAX_PATTERN_CHANNELS) {
    throw new RangeError(`A lights pattern takes 1 to ${MAX_PATTERN_CHANNELS} channels`);
  }
  const { bytes } = frame(MSG.LIGHTS_PATTERN, 17);
  bytes[2] = channels.length;
  channels.forEach((config, index) => {
    const at = 3 + index * 5;
    bytes[at] = config.channel & 0xff;
    bytes[at + 1] = (config.effect ?? LIGHT_EFFECT.STEADY) & 0xff;
    bytes[at + 2] = clampInt(config.start ?? 0, 0, MAX_LIGHT_INTENSITY);
    bytes[at + 3] = clampInt(config.end ?? config.start ?? 0, 0, MAX_LIGHT_INTENSITY);
    bytes[at + 4] = clampInt(config.cyclesPer10s ?? 0, 0, 255);
  });
  return bytes;
}

/** Steady engine-light colour. Each component is 0-1. */
export function engineColor(red, green, blue) {
  const level = (value) => clampInt((Number(value) || 0) * MAX_LIGHT_INTENSITY, 0, MAX_LIGHT_INTENSITY);
  return lightsPattern([
    { channel: LIGHT_CHANNEL.RED, start: level(red) },
    { channel: LIGHT_CHANNEL.GREEN, start: level(green) },
    { channel: LIGHT_CHANNEL.BLUE, start: level(blue) },
  ]);
}

// ---------------------------------------------------------------------------
// Decoding (car to app, and app to car for the debug log)
// ---------------------------------------------------------------------------

/** Accepts a Uint8Array, ArrayBuffer or DataView and returns a Uint8Array over the same bytes. */
export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Expected a Uint8Array, ArrayBuffer or DataView');
}

/**
 * Reads fields only as far as the message actually goes, so a firmware that
 * sends a shorter or longer variant never throws: missing fields are undefined.
 */
function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (at, length) => at + length <= bytes.byteLength;
  return {
    length: bytes.byteLength,
    u8: (at) => (has(at, 1) ? view.getUint8(at) : undefined),
    i8: (at) => (has(at, 1) ? view.getInt8(at) : undefined),
    u16: (at) => (has(at, 2) ? view.getUint16(at, true) : undefined),
    i16: (at) => (has(at, 2) ? view.getInt16(at, true) : undefined),
    f32: (at) => (has(at, 4) ? view.getFloat32(at, true) : undefined),
  };
}

const DECODERS = {
  [MSG.VERSION_RESPONSE]: (r) => ({ version: r.u16(2) }),
  [MSG.BATTERY_RESPONSE]: (r) => ({ millivolts: r.u16(2) }),
  [MSG.POSITION_UPDATE]: (r) => {
    const flags = r.u8(10);
    return {
      locationId: r.u8(2),
      pieceId: r.u8(3),
      offset: r.f32(4),
      speed: r.u16(8),
      parsingFlags: flags,
      reverseParsing: flags === undefined ? undefined : (flags & PARSE_FLAGS.REVERSE_PARSING) !== 0,
      reverseDriving: flags === undefined ? undefined : (flags & PARSE_FLAGS.REVERSE_DRIVING) !== 0,
      lastReceivedLaneChangeId: r.u8(11),
      lastExecutedLaneChangeId: r.u8(12),
      lastDesiredLaneChangeSpeed: r.u16(13),
      lastDesiredSpeed: r.u16(15),
    };
  },
  [MSG.TRANSITION_UPDATE]: (r) => {
    // Older firmware sends 19 bytes: a driving-direction byte sits right after
    // the offset and pushes every later field along by one. The SDK dropped it.
    const legacy = r.length >= 19;
    const at = (index) => index + (legacy ? 1 : 0);
    return {
      pieceIndex: r.i8(2),
      previousPieceIndex: r.i8(3),
      offset: r.f32(4),
      drivingDirection: legacy ? r.u8(8) : undefined,
      lastReceivedLaneChangeId: r.u8(at(8)),
      lastExecutedLaneChangeId: r.u8(at(9)),
      lastDesiredLaneChangeSpeed: r.u16(at(10)),
      driftPixels: r.i8(at(12)),
      hadLaneChangeActivity: r.u8(at(13)),
      uphillCounter: r.u8(at(14)),
      downhillCounter: r.u8(at(15)),
      leftWheelCm: r.u8(at(16)),
      rightWheelCm: r.u8(at(17)),
    };
  },
  [MSG.INTERSECTION_UPDATE]: (r) => ({
    pieceIndex: r.i8(2),
    offset: r.f32(3),
    intersectionCode: r.u8(7),
    isExiting: r.u8(8),
    mmSinceTransitionBar: r.u16(9),
    mmSinceIntersectionCode: r.u16(11),
  }),
  [MSG.OFFSET_UPDATE]: (r) => ({ offset: r.f32(2), laneChangeId: r.u8(6) }),
  // Community layouts.
  [MSG.STATUS]: (r) => ({
    onTrack: r.u8(2) === undefined ? undefined : r.u8(2) !== 0,
    onCharger: r.u8(3) === undefined ? undefined : r.u8(3) !== 0,
    lowBattery: r.u8(4) === undefined ? undefined : r.u8(4) !== 0,
    fullBattery: r.u8(5) === undefined ? undefined : r.u8(5) !== 0,
  }),
  [MSG.COLLISION]: (r) => ({ side: r.u8(2), frontOrBack: r.u8(3) }),
  // App to car messages, decoded so the debug log can explain what was sent.
  [MSG.SDK_MODE]: (r) => ({ on: r.u8(2) === 1, flags: r.u8(3) }),
  [MSG.SET_SPEED]: (r) => ({
    speed: r.i16(2),
    accel: r.i16(4),
    respectSpeedLimit: r.u8(6) === 1,
    extended: r.length >= 8,
  }),
  [MSG.SET_OFFSET]: (r) => ({ offset: r.f32(2) }),
  [MSG.CHANGE_LANE]: (r) => ({
    horizontalSpeed: r.u16(2),
    horizontalAccel: r.u16(4),
    offset: r.f32(6),
    hopIntent: r.u8(10),
    tag: r.u8(11),
  }),
  [MSG.SET_LIGHTS]: (r) => ({ mask: r.u8(2) }),
  [MSG.LIGHTS_PATTERN]: (r) => ({ channelCount: r.u8(2) }),
};

/**
 * @returns {{id: number|undefined, name: string, known: boolean, size: number|undefined, [field: string]: any}}
 *   `name` is 'unknown' for message ids this app does not know and 'empty' for a
 *   message too short to carry an id. Never throws on malformed input.
 */
export function decode(data) {
  const bytes = toBytes(data);
  if (bytes.byteLength < 2) return { id: undefined, name: 'empty', known: false, size: bytes[0] };
  const id = bytes[1];
  const name = NAMES[id];
  const base = { id, name: name ?? 'unknown', known: name !== undefined, size: bytes[0] };
  const decoder = DECODERS[id];
  return decoder ? { ...base, ...decoder(reader(bytes)) } : base;
}

export function toHex(data) {
  return Array.from(toBytes(data), (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/** Parses "03 90 01 01", "0x03,0x90" or "03900101" into bytes. Returns null if it is not valid hex. */
export function fromHex(text) {
  const cleaned = String(text).replace(/0x/gi, '').replace(/[\s,;:]+/g, '');
  if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned)) return null;
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const round1 = (value) => (value === undefined ? '?' : Math.round(value * 10) / 10);
const show = (value) => (value === undefined ? '?' : value);

/** One-line, human-readable summary of a message for the debug log. */
export function describe(data) {
  const m = decode(data);
  switch (m.id) {
    case undefined:
      return 'empty message';
    case MSG.VERSION_RESPONSE:
      return `version 0x${show(m.version?.toString(16).padStart(4, '0'))}`;
    case MSG.BATTERY_RESPONSE:
      return `battery ${show(m.millivolts)} mV`;
    case MSG.POSITION_UPDATE:
      return (
        `position piece ${show(m.pieceId)} loc ${show(m.locationId)} offset ${round1(m.offset)} mm ` +
        `speed ${show(m.speed)} mm/s flags 0x${show(m.parsingFlags?.toString(16).padStart(2, '0'))}`
      );
    case MSG.TRANSITION_UPDATE:
      return (
        `transition offset ${round1(m.offset)} mm wheels L${show(m.leftWheelCm)}/R${show(m.rightWheelCm)} cm ` +
        `up ${show(m.uphillCounter)} down ${show(m.downhillCounter)}`
      );
    case MSG.INTERSECTION_UPDATE:
      return `intersection code ${show(m.intersectionCode)} exiting ${show(m.isExiting)}`;
    case MSG.OFFSET_UPDATE:
      return `offset ${round1(m.offset)} mm (lane change ${show(m.laneChangeId)})`;
    case MSG.STATUS: {
      const flags = [
        m.onTrack && 'on track',
        m.onCharger && 'on charger',
        m.lowBattery && 'low battery',
        m.fullBattery && 'full battery',
      ].filter(Boolean);
      return `status: ${flags.length > 0 ? flags.join(', ') : 'off track'}`;
    }
    case MSG.COLLISION:
      return `collision side ${show(m.side)} front/back ${show(m.frontOrBack)}`;
    case MSG.SDK_MODE:
      return `sdk mode ${m.on ? 'on' : 'off'} flags 0x${show(m.flags?.toString(16).padStart(2, '0'))}`;
    case MSG.SET_SPEED:
      return `set speed ${show(m.speed)} mm/s accel ${show(m.accel)} mm/s2${m.extended ? ' (extended)' : ''}`;
    case MSG.SET_OFFSET:
      return `set offset ${round1(m.offset)} mm`;
    case MSG.CHANGE_LANE:
      return `change lane to ${round1(m.offset)} mm at ${show(m.horizontalSpeed)} mm/s (tag ${show(m.tag)})`;
    case MSG.SET_LIGHTS:
      return `set lights mask 0x${show(m.mask?.toString(16).padStart(2, '0'))}`;
    case MSG.LIGHTS_PATTERN:
      return `lights pattern, ${show(m.channelCount)} channel(s)`;
    default:
      return m.known ? m.name : `unknown message 0x${m.id.toString(16).padStart(2, '0')}`;
  }
}
