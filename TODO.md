# TODO — NRGkick v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 11) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-20): one NRGkick Gen2 by IP address,
      optional Basic auth, one device per serial, status, connector,
      charging state, plugged, charge paused, power, current and voltage
      per phase, current set and signaled, session energy (plain sensor),
      energy index through the P1 Monitor guard with the two-click
      acceptance, temperatures, error / warning / RCD (read only), "Pause
      charging" always available and never held back, "Resume charging" and
      the current select behind `allow_commands` (off), one change a minute,
      late reads quarantined, 429/5xx pauses and credential blocks
      persisted, test button, docs en/fr, cover. Tested against made-up
      answers only.
- [ ] **Milestone 2 — real charger**: run against a real NRGkick Gen2 (see
      "To check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: several chargers, mDNS discovery
      (`_nrgkick._tcp`), the energy limit and the phase count (behind the
      option, never a switch), the domestic plug temperatures, GPS / cellular
      of the SIM model (opt-in, privacy).

## To check on a real charger

- That `/control?charge_pause=1` answers `{"charge_pause": 1}` (as
  nrgkick-api expects) and pauses at once; how long until `/values` shows
  it; whether `charge_pause` is read back as 0/1 or as a boolean.
- That `/control?current_set=10` answers `{"current_set": 10}` (a float?),
  and what the charger does above its attachment's max current (clamp, or a
  `Response` "406 …" as nrgkick-api's tests suggest).
- The HTTP status of a refused command with a `Response` message, and of the
  "API must be enabled" message (200 or 4xx).
- Whether `raw=1` and the section flags (`general=1`) are accepted as sent
  (the documentation writes `/info?raw&connector`).
- The value of `status` while the car is plugged and paused by the charger
  (`CONNECTED`?), and while the car itself stops (`CONNECTED` too: we show
  "EV connected", never "paused by the vehicle").
- `total_charged_energy` after a firmware update or a factory reset (a drop
  is held by the guard; the user accepts it).
- Whether a pause and a current written over the JSON API survive a restart
  of the charger, and how they interact with the NRGkick app and with OCPP
  (sescandell/gladys-ocpp-integration): two masters may contradict each
  other (said in the docs).
- The hierarchy of the energy settings of Gladys (the charger under the
  main meter, so that it is not counted twice): to confirm on a real core.
- Whether `device_name` (user-defined, may hold emojis) should become the
  device name (v1 uses "NRGkick" + the last 4 characters of the serial).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-nrgkick:0.1.0`);
  the first patch release gives 0.1.1. `test/manifest.test.js` checks the
  four agree.
- **Reference**: nrgkick-api 1.8.1 (MIT, Andreas Jakl, andijakl/nrgkick-api,
  tag v1.8.1, commit 8048242, 2026-10-14), the library of Home Assistant's
  NRGkick integration — license checked in its `LICENSE`: MIT, not GPL.
  Cloned read only in `_ref/nrgkick-api` (with the official "NRGkick Gen2
  Local API Documentation" it ships). Ported to JavaScript
  (`src/nrgkick/client.js`, `src/nrgkick/http.js` on `node:http`), no Python,
  no runtime dependency but the SDK; full MIT notice in
  `THIRD_PARTY_NOTICES.md`, shipped in the image with `LICENSE` (the
  standard Apache-2.0 text, no name). nrgkick-api's three tries with backoff
  are not kept (the app spaces its tries; a command is never retried).
- **Neighbour modules**: gladys-peblar (structure, transport, command rules,
  publisher, store) and gladys-v2c-trydan (read only, nothing modified).
  The index guard is `gladys-p1-monitor/src/guard.js` taken as it is, with
  the limits as a parameter (`{ maxKw, slackKwh }`, as gladys-imeon, whose
  copy and tests are reused unchanged), and the two-click acceptance of
  gladys-homee / gladys-hubitat.
- **Credentials**: none by default (the JSON API has no auth unless BasicAuth
  is turned on in the app); user name (string, never a ':') and password
  (secret field), both or neither, sent as nrgkick-api does (Basic, latin1)
  only when both are given. Memory only, never logged, never in `/data`,
  never in a status or an error; HTTP error bodies are never kept. The
  manifest says "kept by Gladys in its database, never shown again" (test).
  A 401/403 blocks the tries 15 min, 1 h, then every 6 h, persisted in
  `/data` (`mode` "basic" or "none" and a count only), bounded at a
  restart; saving other credentials lifts it at once. A reconnection to
  Gladys never clears a block, a pause, nor an index guard.
- **Reads**: `/info?raw=1&general=1&connector=1&versions=1` (no network,
  cellular nor GPS section: nothing personal is read), `/values?raw=1`,
  `/control`, one after the other, every interval (30 s default, 10 s –
  10 min). Raw mode for the numeric codes (names also understood). 429:
  pause bounded to 1 min – 6 h (Retry-After, 5 min without); 5xx: a pause of
  the failure delay (30 s, 1, 2, 5 min, never under the interval); both
  persisted in `/data`, bounded to 6 h at a restart, applied to every path
  but the pause command. The JSON API turned off: said in the status, read
  again every 5 min.
- **Identity**: one device per serial (`serial_number`, lower case,
  `[0-9a-z-]`, 4 to 40 characters), never per IP. Another serial at the
  address: the old device becomes "not read any more" (unreachable, status
  names it), its commands are refused. No serial: not added. One charger
  per integration in v1.
- **Features and units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`): power
  (total and per phase), current and voltage per phase on `energy-sensor`
  (W/A/V, instantaneous); the current set (`target-current`, read only) and
  the current signaled to the vehicle (`charge-current`) on
  `electrical-vehicle-charge` (A); the session energy
  (`last-charge-energy-added`, kWh) a **plain sensor** (it starts again at 0
  at each session: never an index); the total charged energy
  (`total_charged_energy`, Wh → kWh) **the only index**
  (`energy-sensor/index`, kWh), always through the guard; housing and
  attachment temperatures on `temperature-sensor/decimal` (°C); charge
  paused, error, warning, RCD on `unknown/binary`; error and warning codes
  as text ("NAME (code)"). Only the phases of the attachment are published
  (`connector.phase_count`; a single-phase attachment leaves L2/L3 empty).
  Every role always built, so a republished device never loses a feature.
  No `publishEnergyConsumption`, no daily consumption (the core derives them
  from the index).
- **Energy index guard** (lot 6 and P1 Monitor rules): `src/guard.js` taken
  as it is (never 0; a value equal to the last one keeps its date; a drop
  or a jump never confirmed by repetition nor by time; while a jump is held,
  every value at or above it stays held; a value back within the margin
  counted from the hold ends it). `maxKw` 25 (an NRGkick Gen2 delivers
  22 kW at most), `slackKwh` 0.5. Evaluated once per real read (never on a
  quarantined one), only once the device is created; the guard written to
  `/data` before Gladys gets the value; while held, the last accepted value
  is sent again. The hold is shown in the status, in the badge (degraded,
  "kWh from → to") and logged once. **"Accept the held index"** in two
  clicks: the first lists the hold (from → to, kWh counted), the second
  within 60 s takes exactly that if the hold is the same
  (direction:from:threshold) and its value is still the one listed plus the
  margin since; otherwise it lists again. A save or a reconnection accepts
  nothing; a device deleted drops its guard (added again: a fresh guard).
- **States** (`/values` general.status): STANDBY → AVAILABLE/IDLE, plugged 0;
  CONNECTED and WAKEUP → OCCUPIED, EV_CONNECTED (PAUSED_BY_CHARGER and
  "charge paused" when `charge_pause` is 1), plugged 1; CHARGING →
  OCCUPIED/CHARGING; ERROR → FAULTED/IDLE, plugged unknown; unknown codes →
  "Unknown state", no connector. Offline: status "Charger unreachable",
  connector UNAVAILABLE, other values kept.
- **Commands**: three features, never a switch nor a writable binary:
  `pause-charge` and `resume-charge` (`button/push`, value 1 only) and
  `set-current` (`text/select` of whole amperes from 6 A to the ceiling).
  They write `/control?charge_pause=1|0` and `/control?current_set=N` (a GET
  with a side effect, as the API defines it) and check the echo (a
  `Response` message is a refusal; the current within 0.1 A, else "sent,
  without confirmation"). Never the energy limit, the phase count, a reboot
  or an update in v1.
- **"Pause charging" is protective** (PIPELINE rule: "pause de charge"
  never blocked): **no option** — the user asked for resume and current
  only behind the option, and a pause only stops the charge. Never held
  back: not by a command in flight (it goes at once; a second pause shares
  the first one's outcome; sent once more, without a read, when a resume it
  overtook settles, unless that resume never left or a newer resume left
  after the pause), not by the minute, not by a 429 or 5xx pause or a block
  (one request), never a fresh read (it is always sent: sending it again is
  harmless). A resume or a current not sent yet gives way to it (refused
  unsent). Only refused when no address is configured or another charger
  answers at the address; it also goes when no read gave a serial yet (a
  pause or a block kept across a restart) if the device is a created one.
- **Late resume**: a resume left without confirmation opens a 90 s window; a
  pause sent in it keeps its guard the whole 90 s and, at each polling or
  follow-up read (never the fresh read of a command, never while a resume
  is in flight), if `charge_pause` reads 0 and no resume left since the
  pause, sends the pause again (twice at most, logged). Only a resume that
  really left after the pause ends it.
- **Resume and current** (`allow_commands`, off by default, only `true`
  allows): value validated strictly; the option checked on arrival and right
  before sending, with the start (generation) and the serial; refused during
  a 429/5xx pause or a credential block; a fresh read decides, never memory
  (`/control`, and `/values?raw=1&general=1` for a resume; 1.5 s at most); a
  missing value refuses; resume refused without a vehicle (STANDBY), on
  ERROR or an unknown state; current refused above the ceiling; nothing sent
  when already so (unless a guard holds); sent within 3.5 s or refused
  unsent, answered by 4.3 s. Setting the current while paused does not
  resume on the NRGkick (two separate fields): allowed. **One change a
  minute** (resume or current, counted from the send; not spent when nothing
  left).
- **Outcomes**: echo as asked → success (shown at once); unreachable, late or
  not sent → "not sent"; a `Response` message, 401/403 or another 4xx →
  "refused by the charger"; 429 → pause; silence, 5xx, unexpected echo →
  **"sent, without confirmation"** + guard. Reads 5 s and 20 s after, each a
  new read. The ack never waits for Gladys.
- **Ceiling**: the lowest of `max_current` (16 A by default, 6–32 A), the
  rated current (`general.rated_current`) and the attachment max current
  (`connector.max_current`), each trusted as 6–80 A.
- **Late answers**: an answer always belongs to its request; a poll read
  begun before a command left is quarantined (neither applied, nor
  published, nor used by a guard nor by the index guard); the fresh read of
  a command is applied only when no command left during it.
- **Hostile answers**: 64 KB at most; only own fields of plain objects, each
  with its exact type; serials and texts bounded, without control
  characters; codes 0–255 integers; the config takes only its known keys and
  printable ASCII secrets of 256 characters at most; feature ids matched by
  a strict pattern and a fixed role list; `/data` repaired and bounded (8
  index guards at most). Logs carry error kinds and HTTP statuses only (a
  refusal's `Response` text, bounded, is shown: it never holds a secret).
- **Gladys**: reconnection (`connected`): republishes status, devices,
  states and badge (caches cleared, the core keeps them in memory); a changed
  address or credentials restarts; the interval reschedules; the option, the
  ceiling and the language apply at once. No `publishSceneEvent` (no scene
  trigger in v1).
- **OCPP overlap**: sescandell/gladys-ocpp-integration may see the same
  charger when it is set up for OCPP; said in the docs (command only one).
- **gladys_version >= 5.1.0** (as the sibling local modules); **category
  `energy`**, transport `local`.
- **Demo files of the template** (`src/devices/*`, `scenes.js`, `widgets.js`,
  `weather.js` and their tests, the demo `test/config.test.js`) removed from
  the repository (moved aside, not deleted, by this session).
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved. No
  Docker on this PC: the image was not built locally. The store validator
  (`npx github:GladysAssistant/integration-store .`) cannot be run from this
  session: to run in the real terminal (`validate.ps1`).
