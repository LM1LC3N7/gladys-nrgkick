# gladys-nrgkick

[Gladys Assistant](https://gladysassistant.com) external integration for the
**NRGkick Gen2** portable EV charger through its local REST JSON API: state,
connector and charging state, vehicle plugged in, charge paused, power,
current and voltage per phase, current set and signaled, energy of the
session (plain sensor), energy index (guarded), temperatures, error and
warning codes; "Pause charging" always available, resume and the charging
current behind an off-by-default option. **Never tested with a real charger.
Not affiliated with DiniTech.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (NrgkickApp)
                                  ├─ src/nrgkick/client.js  /info, /values, /control, parsing (own fields, exact types)
                                  ├─ src/nrgkick/http.js    the only network access (node:http, bounded)
                                  ├─ src/devices.js         the device and its states (pure)
                                  ├─ src/guard.js           energy index guard (from gladys-p1-monitor)
                                  ├─ src/publisher.js       states within 300/min
                                  └─ src/store.js           /data/nrgkick-state.json (pauses, block, index guard; no secret)
```

- **Credentials**: none by default; optional HTTP Basic auth (user name and
  password, both or neither, latin1 as nrgkick-api). Plain HTTP: they travel
  in clear on the LAN. Refused (or asked for) credentials block the tries
  for 15 min, 1 h, then 6 h (kept in `/data`, no secret in it).
- **Reads**: `GET /info?raw&general&connector&versions`, `/values?raw`,
  `/control` every 30 s (configurable, 10 s – 10 min); failures retried
  after 30 s, 1, 2, 5 min, never under the interval; 429 and 5xx pause, kept
  in `/data`; the JSON API turned off in the app is said, read again every
  5 min.
- **Device**: `ext:<selector>:nrgkick:<serial>` (`serial_number`, lower
  case), never the IP address. Readings on `energy-sensor` (W, A, V), the
  total charged energy as `energy-sensor/index` (kWh) through the guard of
  gladys-p1-monitor (never 0, drops and jumps held, never confirmed by time,
  accepted in two clicks bounded to what was listed, 25 kW as its `maxKw`),
  the session energy as a plain `electrical-vehicle-charge` sensor,
  temperatures on `temperature-sensor`, connector and charging state on the
  core's `charging-station` category.
- **Commands**: `button/push` "Pause charging" (no option, never held back,
  sent again after a resume it overtook or that lands late), `button/push`
  "Resume charging" and a `text/select` (6 A to the ceiling) behind
  `allow_commands` (off by default); never a switch nor a writable binary.
  They write `/control?charge_pause=` and `/control?current_set=` and check
  the echo. Resume and current read the charger first and decide on that
  read only, check the option again right before sending, leave within 3.5 s
  of the click or are refused unsent, and are answered by 4.3 s; a silence,
  a 5xx or an unexpected echo is "sent, without confirmation", followed by
  reads 5 s and 20 s later. One change a minute. A poll read begun before a
  command left is quarantined.
- **Hostile answers**: 64 KB at most, only own fields read with their exact
  type (no prototype pollution; a missing value refuses a command), no
  answer text in the logs.

## Credits

The API, its fields, codes and command checks are ported from
[nrgkick-api](https://github.com/andijakl/nrgkick-api) (Andreas Jakl, MIT,
1.8.1). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on the
sibling integrations
[gladys-peblar](https://github.com/LM1LC3N7/gladys-peblar) (local HTTP
charger, command rules) and
[gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor) (energy
index guard).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: the charger is a fake behind the injected
transport, Gladys is the SDK's fake; `test/client.test.js` runs the real
transport against a loopback server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the
Docker image).
