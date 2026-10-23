# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-21

### Added

- NRGkick Gen2 chargers read over their local REST JSON API (no cloud), with
  an optional Basic auth: one device, keyed by its serial number.
- State, connector and charging state (charging-station category), vehicle
  plugged in, charge paused, power (total and per phase), current and
  voltage per phase, charging current set and signaled to the vehicle,
  energy of the session (plain sensor), temperatures, error and warning
  codes, residual current device triggered (read only).
- The total charged energy as an energy index, through the guard of the P1
  Monitor integration: never 0, drops and jumps held (kept in `/data`), never
  confirmed by time, accepted only by the "Accept the held index" action, in
  two clicks bounded to what the first one listed.
- "Pause charging" button, always available and never held back (not by a
  command in flight, the minute between changes, a 429 pause or a failed
  read), sent again when a resume it overtook or left unconfirmed lands
  after it.
- "Resume charging" button and a charging current list (6 A to a ceiling of
  16 A by default, lowered by the rated current and the attachment), refused
  unless "Allow resuming and the charging current" is on (off by default);
  resume refused without a vehicle plugged in; one change a minute.
- Reads every 30 s (configurable); failures retried after 30 s to 5 minutes;
  429 and 5xx pause, kept in `/data`; refused credentials are tried again
  after 15 min, 1 h, then every 6 h, kept in `/data` (no secret in it); the
  JSON API turned off in the app is said in the status.
- "Test the connection" button; documentation in English and French;
  `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.
- A pause sent again after an overtaken resume that fails is reaffirmed by
  the next reads; the docs say that a pause stays on the charger until a
  resume, that a resume from the app within the 90 s watch is cancelled,
  and that the charger may refuse a pause.
- A restart keeps the minute between two changes; a pause before the first
  read goes only to the last charger read at the address; after a restart
  during a pause or a block, the devices are shown offline; credentials
  pasted in the address are ignored and never shown back.

[Unreleased]: https://github.com/LM1LC3N7/gladys-nrgkick/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-nrgkick/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-nrgkick/releases/tag/v0.1.1
