import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as protocol from '../js/protocol.js';

const bytes = (...values) => Uint8Array.from(values);

test('every encoded message fits one BLE write and declares its own size', () => {
  const messages = [
    protocol.sdkMode(true),
    protocol.setSpeed(500),
    protocol.setOffset(23),
    protocol.changeLane(-68),
    protocol.cancelLaneChange(),
    protocol.ping(),
    protocol.versionRequest(),
    protocol.batteryRequest(),
    protocol.disconnect(),
    protocol.setLights(0x11),
    protocol.engineColor(1, 0, 0),
  ];
  for (const message of messages) {
    assert.ok(message.length <= protocol.MAX_MESSAGE_BYTES, `too long: ${protocol.toHex(message)}`);
    assert.equal(message[0], message.length - 1, `size byte wrong: ${protocol.toHex(message)}`);
  }
});

test('sdk mode matches the SDK: size 3, id 0x90, on, override-localization flag', () => {
  assert.deepEqual(protocol.sdkMode(true), bytes(0x03, 0x90, 0x01, 0x01));
  assert.deepEqual(protocol.sdkMode(false), bytes(0x03, 0x90, 0x00, 0x01));
});

test('set speed is little-endian speed then accel then the speed-limit flag', () => {
  // 500 = 0x01f4, 1000 = 0x03e8
  assert.deepEqual(protocol.setSpeed(500, 1000), bytes(0x06, 0x24, 0xf4, 0x01, 0xe8, 0x03, 0x00));
  assert.deepEqual(
    protocol.setSpeed(0, 2500, { respectSpeedLimit: true }),
    bytes(0x06, 0x24, 0x00, 0x00, 0xc4, 0x09, 0x01),
  );
});

test('extended set speed adds one trailing byte for newer firmware', () => {
  const message = protocol.setSpeed(500, 1000, { extended: true });
  assert.deepEqual(message, bytes(0x07, 0x24, 0xf4, 0x01, 0xe8, 0x03, 0x00, 0x01));
  assert.equal(protocol.decode(message).extended, true);
  assert.equal(protocol.decode(protocol.setSpeed(500)).extended, false);
});

test('set speed clamps instead of wrapping around', () => {
  const view = new DataView(protocol.setSpeed(999999, -5).buffer);
  assert.equal(view.getInt16(2, true), 32767);
  assert.equal(view.getInt16(4, true), 0);
});

test('set offset carries a little-endian float', () => {
  // 23.0 as float32 is 0x41b80000
  assert.deepEqual(protocol.setOffset(23), bytes(0x05, 0x2c, 0x00, 0x00, 0xb8, 0x41));
});

test('change lane is 12 bytes: speeds, float offset, hop intent, tag', () => {
  const message = protocol.changeLane(-68, 300, 2500, 7);
  // 300 = 0x012c, 2500 = 0x09c4, -68.0 = 0xc2880000
  assert.deepEqual(message, bytes(0x0b, 0x25, 0x2c, 0x01, 0xc4, 0x09, 0x00, 0x00, 0x88, 0xc2, 0x00, 0x07));
});

test('simple requests are a size byte and an id', () => {
  assert.deepEqual(protocol.ping(), bytes(0x01, 0x16));
  assert.deepEqual(protocol.versionRequest(), bytes(0x01, 0x18));
  assert.deepEqual(protocol.batteryRequest(), bytes(0x01, 0x1a));
  assert.deepEqual(protocol.cancelLaneChange(), bytes(0x01, 0x26));
  assert.deepEqual(protocol.disconnect(), bytes(0x01, 0x0d));
});

test('light mask puts "addressed" bits low and "on" bits high', () => {
  assert.equal(protocol.lightMask({ HEADLIGHTS: true }), 0x11);
  assert.equal(protocol.lightMask({ HEADLIGHTS: false }), 0x01);
  assert.equal(protocol.lightMask({ FRONTLIGHTS: true, BRAKELIGHTS: false }), 0x46);
  assert.equal(protocol.lightMask({ ENGINE: true }), 0x88);
  assert.throws(() => protocol.lightMask({ FOGLIGHTS: true }), RangeError);
  assert.deepEqual(protocol.setLights(0x44), bytes(0x02, 0x1d, 0x44));
});

test('lights pattern is always 18 bytes with unused channels zeroed', () => {
  const message = protocol.lightsPattern([
    { channel: protocol.LIGHT_CHANNEL.RED, effect: protocol.LIGHT_EFFECT.THROB, start: 0, end: 99, cyclesPer10s: 20 },
  ]);
  assert.equal(message.length, 18);
  assert.deepEqual(Array.from(message.slice(0, 8)), [0x11, 0x33, 0x01, 0x00, 0x02, 0x00, 14, 20]);
  assert.ok(message.slice(8).every((byte) => byte === 0));
  assert.throws(() => protocol.lightsPattern([]), RangeError);
  assert.throws(() => protocol.lightsPattern([{}, {}, {}, {}]), RangeError);
});

test('engine colour sets red, green and blue channels steady', () => {
  const message = protocol.engineColor(1, 0.5, 0);
  assert.deepEqual(
    Array.from(message.slice(2)),
    [3, /* red */ 0, 0, 14, 14, 0, /* green */ 3, 0, 7, 7, 0, /* blue */ 2, 0, 0, 0, 0],
  );
});

test('decodes a battery response', () => {
  const message = protocol.decode(bytes(0x03, 0x1b, 0x68, 0x10)); // 0x1068 = 4200
  assert.equal(message.name, 'battery');
  assert.equal(message.millivolts, 4200);
});

test('decodes a version response', () => {
  assert.equal(protocol.decode(bytes(0x03, 0x19, 0x34, 0x12)).version, 0x1234);
});

test('decodes a position update field by field', () => {
  const data = new Uint8Array(17);
  const view = new DataView(data.buffer);
  data[0] = 16;
  data[1] = 0x27;
  data[2] = 21; // location
  data[3] = 33; // piece
  view.setFloat32(4, -22.5, true);
  view.setUint16(8, 512, true);
  data[10] = 0x47; // reverse parsing + 7 bits
  data[11] = 3;
  data[12] = 2;
  view.setUint16(13, 300, true);
  view.setUint16(15, 500, true);

  const message = protocol.decode(data);
  assert.equal(message.name, 'position');
  assert.equal(message.locationId, 21);
  assert.equal(message.pieceId, 33);
  assert.equal(message.offset, -22.5);
  assert.equal(message.speed, 512);
  assert.equal(message.reverseParsing, true);
  assert.equal(message.reverseDriving, false);
  assert.equal(message.lastReceivedLaneChangeId, 3);
  assert.equal(message.lastExecutedLaneChangeId, 2);
  assert.equal(message.lastDesiredLaneChangeSpeed, 300);
  assert.equal(message.lastDesiredSpeed, 500);
});

test('decodes a transition update using the SDK field order', () => {
  const data = new Uint8Array(18);
  const view = new DataView(data.buffer);
  data[0] = 17;
  data[1] = 0x29;
  view.setInt8(2, -1);
  view.setInt8(3, 4);
  view.setFloat32(4, 67.5, true);
  data[12] = 0xfe; // drift -2
  data[13] = 1;
  data[14] = 5;
  data[15] = 6;
  data[16] = 37;
  data[17] = 42;

  const message = protocol.decode(data);
  assert.equal(message.name, 'transition');
  assert.equal(message.pieceIndex, -1);
  assert.equal(message.previousPieceIndex, 4);
  assert.equal(message.offset, 67.5);
  assert.equal(message.driftPixels, -2);
  assert.equal(message.hadLaneChangeActivity, 1);
  assert.equal(message.uphillCounter, 5);
  assert.equal(message.downhillCounter, 6);
  assert.equal(message.leftWheelCm, 37);
  assert.equal(message.rightWheelCm, 42);
});

test('decodes the 19-byte transition update of older firmware, shifted by its direction byte', () => {
  const data = new Uint8Array(19);
  const view = new DataView(data.buffer);
  data[0] = 18;
  data[1] = 0x29;
  view.setFloat32(4, -22.5, true);
  data[8] = 1; // driving direction
  data[15] = 5; // uphill
  data[16] = 6; // downhill
  data[17] = 37;
  data[18] = 50;

  const message = protocol.decode(data);
  assert.equal(message.offset, -22.5);
  assert.equal(message.drivingDirection, 1);
  assert.equal(message.uphillCounter, 5);
  assert.equal(message.downhillCounter, 6);
  assert.equal(message.leftWheelCm, 37);
  assert.equal(message.rightWheelCm, 50);
});

test('decodes the community status message', () => {
  const message = protocol.decode(bytes(0x05, 0x3f, 0x01, 0x00, 0x00, 0x01));
  assert.equal(message.name, 'status');
  assert.deepEqual(
    [message.onTrack, message.onCharger, message.lowBattery, message.fullBattery],
    [true, false, false, true],
  );
  assert.equal(protocol.describe(bytes(0x05, 0x3f, 0x01, 0x00, 0x00, 0x01)), 'status: on track, full battery');
  assert.equal(protocol.describe(bytes(0x05, 0x3f, 0x00, 0x00, 0x00, 0x00)), 'status: off track');
});

test('names the Fast & Furious special-piece message', () => {
  assert.equal(protocol.decode(bytes(0x01, 0x53)).name, 'special piece');
});

test('a short message leaves missing fields undefined instead of throwing', () => {
  const message = protocol.decode(bytes(0x03, 0x27, 12, 40));
  assert.equal(message.pieceId, 40);
  assert.equal(message.offset, undefined);
  assert.equal(message.reverseParsing, undefined);
  assert.doesNotThrow(() => protocol.describe(bytes(0x03, 0x27, 12, 40)));
});

test('unknown and empty messages are reported, not thrown', () => {
  const unknown = protocol.decode(bytes(0x02, 0x7a, 0x01));
  assert.equal(unknown.known, false);
  assert.equal(unknown.name, 'unknown');
  assert.equal(protocol.describe(bytes(0x02, 0x7a, 0x01)), 'unknown message 0x7a');
  assert.equal(protocol.decode(bytes()).name, 'empty');
  assert.equal(protocol.describe(bytes(0x00)), 'empty message');
});

test('decode accepts the DataView that Web Bluetooth hands over, at any offset', () => {
  const backing = bytes(0xff, 0xff, 0x03, 0x1b, 0xa0, 0x0f, 0xff);
  const view = new DataView(backing.buffer, 2, 4);
  assert.equal(protocol.decode(view).millivolts, 4000);
});

test('describe explains outgoing commands too', () => {
  assert.equal(protocol.describe(protocol.setSpeed(500, 1000)), 'set speed 500 mm/s accel 1000 mm/s2');
  assert.equal(protocol.describe(protocol.sdkMode(true)), 'sdk mode on flags 0x01');
  assert.equal(protocol.describe(protocol.ping()), 'ping');
});

test('hex round trip and rejection of bad input', () => {
  assert.equal(protocol.toHex(bytes(0x03, 0x90, 0x01, 0x01)), '03 90 01 01');
  assert.deepEqual(protocol.fromHex('03 90 01 01'), bytes(0x03, 0x90, 0x01, 0x01));
  assert.deepEqual(protocol.fromHex('0x03,0x90'), bytes(0x03, 0x90));
  assert.deepEqual(protocol.fromHex('0390'), bytes(0x03, 0x90));
  assert.equal(protocol.fromHex('039'), null);
  assert.equal(protocol.fromHex('zz'), null);
  assert.equal(protocol.fromHex(''), null);
});
