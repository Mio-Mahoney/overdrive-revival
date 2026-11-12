// Bluetooth transport: find cars, connect, write commands, receive messages.
//
// This is the only module that touches Web Bluetooth. Everything above it
// talks to a "link" with this shape, so a native app (or the simulator in
// sim.js) can replace this file without touching the game:
//
//   link.id                       stable identifier for the device
//   link.name                     advertised name, may be empty
//   await link.open()             connect and start receiving
//   await link.write(Uint8Array)  send one message
//   await link.close()            disconnect on purpose
//   link.on('message', (Uint8Array) => {})
//   link.on('drop', () => {})        connection lost, reconnect in progress
//   link.on('restore', () => {})     reconnected after a drop
//   link.on('disconnect', ({ intentional }) => {})  gone for good

import { Emitter } from './emitter.js';

const SERVICE_UUID = 'be15beef-6186-407e-8381-0bd89c4d8df4';
const READ_UUID = 'be15bee0-6186-407e-8381-0bd89c4d8df4'; // car to app, notify
const WRITE_UUID = 'be15bee1-6186-407e-8381-0bd89c4d8df4'; // app to car

const CONNECT_TIMEOUT_MS = 12000;
const CONNECT_ATTEMPTS = 3; // the first connect to a just-woken car often fails
const WRITE_GAP_MS = 20; // back-to-back writes without response can be dropped by the car
const RECONNECT_DELAYS_MS = [400, 1200, 2500, 5000];

/** One link per physical car, so picking the same car twice returns the same link. */
const linksByDeviceId = new Map();

/**
 * @returns {'ok' | 'insecure' | 'unsupported'}
 *   'insecure': the page is not served over HTTPS or localhost, which Web Bluetooth requires.
 *   'unsupported': this browser has no Web Bluetooth (Safari, Firefox, iOS browsers other than Bluefy).
 */
export function bluetoothStatus() {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
  if (typeof navigator === 'undefined' || !navigator.bluetooth) return 'unsupported';
  return 'ok';
}

/**
 * Opens the browser's device chooser. Must be called from a click or key press.
 * @returns {Promise<BleLink|null>} null when the user closes the chooser without picking a car.
 */
export async function requestCar() {
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] });
  } catch (error) {
    if (error?.name === 'NotFoundError') return null; // chooser dismissed
    throw error;
  }
  let link = linksByDeviceId.get(device.id);
  if (!link) {
    link = new BleLink(device);
    linksByDeviceId.set(device.id, link);
  }
  return link;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BleLink extends Emitter {
  #device;
  #readCharacteristic = null;
  #writeCharacteristic = null;
  #writeWithoutResponse = false;
  /** @type {'closed' | 'open' | 'reconnecting'} */
  #state = 'closed';

  constructor(device) {
    super();
    this.#device = device;
    device.addEventListener('gattserverdisconnected', this.#onGattDisconnected);
  }

  get id() {
    return this.#device.id;
  }

  /** The advertised name carries state bytes on these cars, so it is often not readable text. */
  get name() {
    return this.#device.name ?? '';
  }

  get isOpen() {
    return this.#state === 'open';
  }

  async open() {
    if (this.#state !== 'closed') return;
    await this.#connect();
    this.#state = 'open';
  }

  /** Connects, retrying a couple of times, since a first attempt often fails on a car that just woke up. */
  async #connect() {
    let lastError;
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
      try {
        await this.#connectOnce();
        return;
      } catch (error) {
        lastError = error;
        if (this.#device.gatt?.connected) this.#device.gatt.disconnect();
        if (attempt < CONNECT_ATTEMPTS) await delay(300 * attempt);
      }
    }
    throw lastError;
  }

  async #connectOnce() {
    const server = await withTimeout(
      this.#device.gatt.connect(),
      CONNECT_TIMEOUT_MS,
      'Timed out connecting. Is the car switched on and off the charger?',
    );
    const service = await server.getPrimaryService(SERVICE_UUID);
    const [read, write] = await Promise.all([
      service.getCharacteristic(READ_UUID),
      service.getCharacteristic(WRITE_UUID),
    ]);
    // A reconnect hands out new characteristic objects, so listen on the new one.
    read.addEventListener('characteristicvaluechanged', this.#onValue);
    await read.startNotifications();
    this.#readCharacteristic = read;
    this.#writeCharacteristic = write;
    this.#writeWithoutResponse =
      Boolean(write.properties?.writeWithoutResponse) && typeof write.writeValueWithoutResponse === 'function';
  }

  #onValue = (event) => {
    const view = event.target.value;
    if (!view) return;
    // Copy: the browser may reuse the underlying buffer for the next notification.
    this.emit('message', new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)));
  };

  async write(bytes) {
    const characteristic = this.#writeCharacteristic;
    if (this.#state !== 'open' || !characteristic) throw new Error('Car is not connected');
    if (this.#writeWithoutResponse) {
      await characteristic.writeValueWithoutResponse(bytes);
    } else if (typeof characteristic.writeValueWithResponse === 'function') {
      await characteristic.writeValueWithResponse(bytes);
    } else {
      await characteristic.writeValue(bytes); // older Web Bluetooth implementations
    }
    await delay(WRITE_GAP_MS);
  }

  /** Disconnects on purpose. Safe to call in any state, including mid-reconnect. */
  async close() {
    if (this.#state === 'closed') return;
    this.#finish(true);
    if (this.#device.gatt?.connected) this.#device.gatt.disconnect();
  }

  /** Ends the link for good and tells listeners exactly once. */
  #finish(intentional) {
    this.#state = 'closed';
    this.#detachCharacteristics();
    this.#device.removeEventListener('gattserverdisconnected', this.#onGattDisconnected);
    if (linksByDeviceId.get(this.#device.id) === this) linksByDeviceId.delete(this.#device.id);
    this.emit('disconnect', { intentional });
  }

  #detachCharacteristics() {
    this.#readCharacteristic?.removeEventListener('characteristicvaluechanged', this.#onValue);
    this.#readCharacteristic = null;
    this.#writeCharacteristic = null;
  }

  #onGattDisconnected = async () => {
    if (this.#state !== 'open') return; // closed on purpose, or already reconnecting
    this.#state = 'reconnecting';
    this.#detachCharacteristics();
    this.emit('drop');
    for (const wait of RECONNECT_DELAYS_MS) {
      await delay(wait);
      if (this.#state !== 'reconnecting') return; // closed while we waited
      try {
        await this.#connect();
      } catch {
        continue; // out of range or still rebooting: try again after the next delay
      }
      if (this.#state !== 'reconnecting') {
        // Closed while the connect was in flight: do not leave the radio link up.
        if (this.#device.gatt?.connected) this.#device.gatt.disconnect();
        return;
      }
      this.#state = 'open';
      this.emit('restore');
      return;
    }
    if (this.#state !== 'reconnecting') return;
    this.#finish(false);
    // A connect that got as far as the radio link but not the service can leave it up.
    if (this.#device.gatt?.connected) this.#device.gatt.disconnect();
  };
}
