# Overdrive Revival

A free web app that drives Anki Overdrive Fast & Furious Edition cars from a browser, over Web Bluetooth. It covers version 1 of the project scope: connect and drive the cars, scan the track, race, and battle an AI opponent.

Plain HTML, CSS and JavaScript. No framework, no build step, no dependencies.

## Run it

Web Bluetooth only works on a secure page, so the files have to be served, not opened from disk.

```bash
npm start
```

Then open http://localhost:8137 in Chrome on the Mac.

To try the app without cars, open http://localhost:8137/?sim. Demo mode adds simulated cars on a simulated track.

On the iPhone, the app has to be hosted over HTTPS (GitHub Pages serves this folder as it is) and opened in the free Bluefy browser, because Safari has no Web Bluetooth.

## Status: not yet tested on real cars

Everything here was built and checked against the simulator in `js/sim.js` and the unit tests. No real car has been connected yet. The simulator encodes the same assumptions as the app, so it proves the screens and the rules, not the hardware.

Test on the track in this order. Each step ends with a check; move on only when it passes. When something fails, open the Log tab, press Copy log, and paste it to Claude.

### Phase 0: connection test

1. Switch one car on and lift it off the charger.
2. Drive tab, Connect a car, pick it in the chooser (it may be listed as "Drive" or as odd characters).
3. Move the speed slider, then press Stop.

Done when the car drives and stops on command. In the Log tab you should see `battery` and `version` replies, then `position` and `transition` lines while it moves.

If the car connects but does not move, note the `version` number from the log: firmware 12385 and later needs a longer speed command, which the app sends automatically, but that path is unconfirmed.

### Phase 1: controller

1. Connect both cars. Use the name menu on each card to say which is the Ice Charger and which is the MXT (Identify flashes a car).
2. Drive both with the keyboard: W S A D for the first car, the arrow keys for the second. Esc stops everything.
3. Try lane left and right on a straight.

Done when two people can drive both cars for a full charge without a dropped connection.

Watch for: lane buttons moving the car the wrong way, or a car steering off the edge. A few seconds after a car starts driving, its card shows "lane N of 4". That means lane calibration worked. If it never appears, lane changes still work but the app cannot stop a car at the edge of the road.

### Phase 2: racing

1. Track tab: put one car on the track and press Scan. It drives until it has passed the start piece twice.
2. Check the map. If a piece shows as Unknown, select it and say what it is.
3. Race tab: choose drivers and laps, put the cars on the start piece behind the line, and start.

Done when a 5-lap race runs start to finish with correct lap counts, on the Mac and on the iPhone.

### Phase 3: battle

1. Check the Power Zone is marked on the map (Track tab).
2. Battle tab: one player against the AI. F fires the Blaster, G the Heavy shot.

Done when one player can finish a full battle against the AI and it feels fair. Damage, cooldowns, reach and the AI levels are constants at the top of `js/game.js`.

## What is assumed about the cars

The message format and the documented message ids come from the open-source [Anki Drive SDK](https://github.com/anki/drive-sdk) and are covered by tests. The points below come from community projects that reverse-engineered Overdrive, and still need confirming on this kit:

| Assumption | Where | If it is wrong |
| --- | --- | --- |
| The start piece reports ids 34 then 33 | `js/track.js` | The scan takes two laps instead of one. Tag the start piece on the map |
| Pieces 53, 54 and 57 are Fast & Furious special pieces, so Power Zone | `js/track.js` | Retag the piece on the map |
| Straight pieces carry 16 lanes of 3 location codes | `js/track.js` | Lane calibration never completes; the app falls back to relative lane moves |
| Negative offsets are to the left | `js/track.js` | Lane buttons are mirrored |
| Battery is empty at 3300 mV and full at 4200 mV | `js/car.js` | The percentage is off |
| Firmware 12385 and later needs an 8-byte speed command | `js/protocol.js` | Cars on new firmware do not move |
| The car sends message 0x53 on a special piece | `js/protocol.js` | Nothing: the map triggers the Power Zone as well |

## Code layout

| File | Job |
| --- | --- |
| `js/ble.js` | Find cars, connect, write, receive. The only Bluetooth code |
| `js/protocol.js` | Commands to bytes, incoming bytes to events |
| `js/car.js` | One car: its state and the commands it accepts |
| `js/track.js` | Track map from the scan, each car's position along and across the road |
| `js/game.js` | Race and battle rules, health, weapons, AI opponent |
| `js/sim.js` | Simulated cars for demo mode and tests |
| `js/ui/` | Screens, controls, sounds |

`ble.js` hands the rest of the app a "link" (open, write, close, message events). A native app could replace that one file and keep everything else.

## Tests

```bash
npm test
```

Needs Node 20 or later. The tests drive simulated cars through real scans, races and battles on a fake clock.
