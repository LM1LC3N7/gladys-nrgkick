// -----------------------------------------------------------------------------
// The integration: the NRGkick typed in the configuration (one IP address,
// an optional Basic auth), one read of it every poll interval, its Gladys
// device and states, the guard of its energy index, the transport badge, the
// "Test the connection" and "Accept the held index" buttons, and the three
// commands (pause, resume, charging current). index.js only wires the SDK
// handlers to it.
//
// Commands follow the rules learnt on the previous modules (and the approved
// Peblar, KEBA and TechnoVE modules):
//   - "Pause charging" is protective: it needs no option and is never held
//     back: not by a command in flight (it goes at once, and once more when a
//     resume it overtook settles), not by the minute between two changes, not
//     by a 429 pause or refused credentials (one request), not by a failed
//     read (it needs none). A pause sent while a resume is not confirmed is
//     sent again if a read shows the charge resumed (a late resume landing
//     after it), twice at most;
//   - "Resume charging" and the charging current stay behind an option (off
//     by default), checked on arrival and again right before sending; they
//     are decided on a fresh read only, never on the state kept in memory,
//     and refused when a value they need is missing; one of them a minute;
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//   - a command that may have reached the charger (silence, a 5xx, an
//     unexpected answer) is never answered "not sent": "sent, without
//     confirmation", then spaced reads;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time (a pause aside), never retried;
//   - a read that began before the last command was sent may show the state
//     before it: quarantined, never applied nor published.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, authMode, credentialsKey, normalizeConfig } from './config.js';
import {
  CURRENT,
  FEATURES,
  GUARD_LIMITS,
  LIMITS,
  PLUGGED_STATES,
  PRESSED,
  SECOND,
  STATE,
  TIMINGS,
} from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  chargerIds,
  deviceName,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  statusText,
} from './devices.js';
import { IndexGuard } from './guard.js';
import { ERRORS, STATE_NAMES, T, age, summaryOf, word } from './i18n.js';
import {
  NrgkickClient,
  errorReason,
  parseControl,
  parseInfo,
  parseStatus,
  parseValues,
} from './nrgkick/client.js';
import { ERROR_KINDS } from './nrgkick/http.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

const both = (en, fr) => ({ en, fr });
const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);
const round3 = (value) => Math.round(value * 1000) / 1000;

/** A pause began in this cycle: it stops at once. */
const PAUSED = 'paused';

/** The key of a value held back: what it is, not where it is now (`to` moves). */
export const holdKey = (held) =>
  held.direction === 'down' ? `down:${held.from}` : `up:${held.from}:${held.threshold}`;

/** The last value Gladys holds for a feature (`{ value, at }`), from its devices. */
function lastValueOf(devices, featureId) {
  for (const device of devices ?? []) {
    const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
    if (feature) {
      const value = Number(feature.last_value);
      const at = Date.parse(feature.last_value_changed ?? '');
      return feature.last_value !== null &&
        feature.last_value !== undefined &&
        Number.isFinite(value) &&
        Number.isFinite(at)
        ? { value, at }
        : undefined;
    }
  }
  return undefined;
}

const freshCharger = () => ({
  serial: undefined,
  model: undefined,
  firmware: undefined,
  ratedCurrent: undefined,
  attachmentMax: undefined,
  phases: undefined,
  values: undefined,
  control: undefined,
  /** The energy index the guard lets through (undefined: none to publish). */
  index: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
  /** When the last request that writes left, resends included (a read begun before it is quarantined). */
  lastSentAt: -Infinity,
  /** When the last command of a user left (resends of a pause excluded). */
  lastCommandAt: -Infinity,
  /** When the last resume left: only a resume undoes a pause. */
  lastResumeAt: -Infinity,
  /** Until then, a resume not confirmed may still land (a pause sent meanwhile is reaffirmed). */
  unconfirmedResumeUntil: -Infinity,
  /** When the last resume or current change left: one a minute. */
  lastChangeAt: -Infinity,
});

export class NrgkickApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'nrgkick' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new NrgkickClient({ transport, now });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    this.charger = freshCharger();
    this.generation = 0;
    this.started = false;
    this.pausedUntil = 0;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    /** The command in flight: { role, sentAt, overtaken, again, promise } (a pause aside). */
    this.inFlight = undefined;
    /** `${serial}:pause` / `${serial}:current` -> a command sent, not seen yet. */
    this.guards = new Map();
    /** featureId -> IndexGuard (the energy index of a created device). */
    this.indexGuards = new Map();
    /** The first click of "Accept the held index": { fingerprint, at, listed }. */
    this.pendingAccept = undefined;
    /** The hold last logged (a hold is logged once). */
    this.loggedHold = undefined;
    this.savedMemory = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await this.charger.running;
    this.config = normalizeConfig(raw);
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    this.savedMemory = JSON.stringify(this.memory);
    // A pause survives a restart and a new configuration.
    if (this.memory.pause) {
      this.pausedUntil = Math.max(this.pausedUntil, this.memory.pause.until);
    }
    this.charger = freshCharger();
    this.indexGuards.clear();
    this.pendingAccept = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.config.address || this.config.badSecret) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1]);
    await this.tick();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.charger.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.charger.followUps.clear();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.charger.timer) {
      this.timers.clearTimeout(this.charger.timer);
      this.charger.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge) and the last states. Pauses, blocks and guards stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.liftBlockOnNewCredentials(raw);
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address or new credentials restart (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalidHost !== this.config.invalidHost ||
      next.badSecret !== this.config.badSecret ||
      credentialsKey(next) !== credentialsKey(this.config)
    );
  }

  /** New credentials saved (or given at a reconnection) lift a block at once. */
  async liftBlockOnNewCredentials(raw) {
    if (credentialsKey(normalizeConfig(raw)) !== credentialsKey(this.config) && this.memory.block) {
      this.memory.block = null;
      await this.saveMemory();
    }
  }

  /** A new interval: the next read follows it, without a restart. */
  rescheduleOnNewInterval(previous) {
    const c = this.charger;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !this.config.badSecret &&
      !c.running &&
      c.online !== false
    ) {
      this.schedule();
    }
  }

  /**
   * New address or credentials restart (new credentials lift a block at
   * once); the interval, the option, the ceiling and the language apply at
   * once.
   */
  async configUpdated(raw = {}) {
    await this.liftBlockOnNewCredentials(raw);
    if (this.needsRestart(raw)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(
        `NRGkick resume and current ${this.config.allowCommands ? 'allowed' : 'disabled'}`,
      );
    }
    if (
      this.config.language !== previous.language ||
      this.config.maxCurrent !== previous.maxCurrent ||
      this.config.allowCommands !== previous.allowCommands
    ) {
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** Writes /data when something changed (a pause, a block, an index guard). */
  async saveMemory() {
    const json = JSON.stringify(this.memory);
    if (json === this.savedMemory) {
      return;
    }
    try {
      await this.store.save(this.memory);
      this.savedMemory = json;
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err?.code ?? 'error'}`);
    }
  }

  // --- Credentials -----------------------------------------------------------

  get blocked() {
    return Boolean(this.memory.block) && this.now() < this.memory.block.until;
  }

  /** Credentials refused or asked for: the tries are spaced (15 min, 1 h, 6 h), kept in /data. */
  async authFailed() {
    const failures = (this.memory.block?.failures ?? 0) + 1;
    const wait = TIMINGS.authBackoff[Math.min(failures - 1, TIMINGS.authBackoff.length - 1)];
    const mode = authMode(this.config);
    this.memory.block = { until: this.now() + wait, mode, failures };
    await this.saveMemory();
    this.logger.warn(
      `NRGkick: ${mode === 'basic' ? 'credentials refused' : 'credentials asked for'}; next try in ${Math.round(wait / 60000)} min`,
    );
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  get paused() {
    return this.now() < this.pausedUntil;
  }

  /**
   * The next read: after a pause or a block (never sooner than the interval),
   * after its backoff, else the interval.
   */
  schedule(delay) {
    const c = this.charger;
    this.clearTimer();
    let wait;
    if (this.paused) {
      wait = Math.max(this.pausedUntil - this.now(), this.interval);
    } else if (this.blocked) {
      wait = Math.max(this.memory.block.until - this.now(), this.interval);
    } else {
      wait = delay ?? (c.online === false ? c.wait : this.interval);
    }
    const generation = this.generation;
    c.timer = this.timers.setTimeout(
      () => {
        c.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('NRGkick refresh failed'));
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const c = this.charger;
    if (!c.running) {
      c.running = this.run().finally(() => {
        c.running = undefined;
      });
    }
    return c.running;
  }

  async run() {
    const generation = this.generation;
    const c = this.charger;
    if (this.paused || this.blocked) {
      await this.updateStatus();
      this.schedule();
      return;
    }
    let delay;
    try {
      const startedAt = this.now();
      const read = await this.readAll();
      if (generation !== this.generation) {
        return;
      }
      if (startedAt <= c.lastSentAt) {
        // Begun before a command left: it may show the state before it.
        this.logger.debug('NRGkick: read begun before a command, not applied');
      } else {
        this.applyRead(read);
        if (this.memory.block) {
          this.memory.block = null;
          await this.saveMemory();
        }
        await this.evaluateIndex();
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      delay = await this.failed(err);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** Info (identity), values and control, one after the other. */
  async readAll() {
    const address = this.config.address;
    const auth = this.config.auth;
    const options = { timeoutMs: TIMINGS.readTimeout };
    const info = parseInfo(await this.client.info(address, auth, options));
    const values = parseValues(await this.client.values(address, auth, options));
    const control = parseControl(await this.client.control(address, auth, options));
    return { info, values, control };
  }

  /** A read answered: the charger as read, and the guards it may lift. */
  applyRead({ info, values, control }) {
    const c = this.charger;
    c.online = true;
    c.failures = 0;
    c.wait = undefined;
    if (!info.serial) {
      c.error = 'no_id';
      return;
    }
    c.error = undefined;
    if (c.serial && c.serial !== info.serial) {
      // Another charger answers at this address: the old device is no longer read.
      this.logger.warn('NRGkick: another charger answers at this address');
      c.index = undefined;
    }
    c.serial = info.serial;
    c.model = info.model ?? c.model;
    c.firmware = info.firmware ?? c.firmware;
    c.ratedCurrent = info.ratedCurrent;
    c.attachmentMax = info.attachmentMax;
    c.phases = info.phases ?? c.phases;
    c.values = values;
    this.applyControl(control);
  }

  /** fromCommand: the fresh read of a command (never reaffirms a pause: it would race it). */
  applyControl(control, { fromCommand = false } = {}) {
    const c = this.charger;
    c.control = control;
    if (c.serial) {
      this.observe(c.serial, control, { fromCommand });
    }
  }

  /** A failed read: the delay before the next one. */
  async failed(err) {
    const c = this.charger;
    const reason = errorReason(err);
    if (err.kind === PAUSED) {
      return undefined;
    }
    if (err.kind === ERROR_KINDS.AUTH) {
      // Not read until new credentials or the end of the block: offline.
      c.online = false;
      c.error = ERROR_KINDS.AUTH;
      await this.authFailed();
      return undefined;
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      // The charger answers: it stays online, the status shows the 429 pause.
      await this.pause(err);
      this.logger.warn(`NRGkick: ${reason}, pause`);
      return undefined;
    }
    if (err.kind === ERROR_KINDS.API_DISABLED) {
      c.online = false;
      c.error = ERROR_KINDS.API_DISABLED;
      c.wait = Math.max(this.interval, TIMINGS.apiDisabledWait);
      this.logger.warn('NRGkick: the JSON API is turned off in the app');
      return c.wait;
    }
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(c.failures, TIMINGS.backoff.length - 1)],
    );
    c.failures += 1;
    c.online = false;
    c.wait = wait;
    c.error = reason;
    if (err.kind === ERROR_KINDS.HTTP && err.status >= 500) {
      // A 5xx: a pause of the same length, kept in /data.
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.memory.pause = { until: this.pausedUntil, reason: '5xx' };
      await this.saveMemory();
    }
    this.logger.warn(`NRGkick: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** A 429: every path waits but a pause (polling, button, commands), kept in /data. */
  async pause(err) {
    const wait = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
    );
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.memory.pause = { until: this.pausedUntil, reason: '429' };
    await this.saveMemory();
  }

  pauseMessage() {
    if (!this.paused) {
      return undefined;
    }
    const wait = age(this.pausedUntil - this.now());
    return this.memory.pause?.reason === '5xx' ? T.serverError(wait) : T.rateLimited(wait);
  }

  /** The highest current the commands accept now. */
  get ceiling() {
    const c = this.charger;
    return Math.max(
      CURRENT.min,
      Math.min(this.config.maxCurrent, c.ratedCurrent ?? Infinity, c.attachmentMax ?? Infinity),
    );
  }

  summary() {
    const c = this.charger;
    return summaryOf(
      {
        name: deviceName(c),
        power: c.values?.power === undefined ? undefined : Math.round(c.values.power),
        current:
          c.control?.currentSet === undefined
            ? undefined
            : Math.round(c.control.currentSet * 10) / 10,
      },
      statusText(c.values?.state, c.control?.paused),
    );
  }

  /** `[connected, message, plain]`; `plain`: the summary without "Connected". */
  status() {
    const c = this.charger;
    if (!this.config.address) {
      return [false, this.config.invalidHost ? T.invalidHost(this.config.invalidHost) : T.noHost];
    }
    if (this.config.badSecret) {
      return [false, T.badSecret];
    }
    const pause = this.pauseMessage();
    if (pause) {
      return [false, pause];
    }
    if (this.blocked) {
      const wait = age(this.memory.block.until - this.now());
      return [false, this.memory.block.mode === 'basic' ? T.authRefused(wait) : T.authAsked(wait)];
    }
    if (c.online === false) {
      const wait = age(c.wait ?? this.interval);
      if (c.error === ERROR_KINDS.API_DISABLED) {
        return [false, T.apiDisabled(wait)];
      }
      return [
        false,
        c.error === ERROR_KINDS.UNREACHABLE || c.error === ERROR_KINDS.TIMEOUT
          ? T.unreachable(addressKey(this.config.address), wait)
          : T.failing(c.error ?? 'error', wait),
      ];
    }
    if (c.online === undefined) {
      return [false, T.connecting];
    }
    if (c.error === 'no_id' || !c.serial) {
      return [false, T.noId];
    }
    let summary = this.summary();
    const held = this.currentHold();
    if (held) {
      summary = join(summary, T.held(held));
    }
    return [true, T.connected(summary), summary];
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    const [connected, message, plain] = this.status();
    const orphans = this.orphans();
    if (orphans.length === 0) {
      await this.setStatus(connected, message);
      return;
    }
    const names = orphans
      .map((serial) => {
        const device = (this.gladys.devices ?? []).find(
          (d) => d.external_id === chargerIds(this.gladys, serial).device,
        );
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${serial})`
          : serial;
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.otherCharger(names)));
  }

  // --- Energy index ----------------------------------------------------------

  indexFeatureId(serial = this.charger.serial) {
    return chargerIds(this.gladys, serial).feature(FEATURES.ENERGY_INDEX);
  }

  /** The guard of an index feature of a created device, from Gladys and /data. */
  guardOf(featureId) {
    if (!this.indexGuards.has(featureId)) {
      this.indexGuards.set(
        featureId,
        new IndexGuard(
          lastValueOf(this.gladys.devices, featureId),
          this.memory.indexes[featureId],
          this.now(),
          GUARD_LIMITS,
        ),
      );
    }
    return this.indexGuards.get(featureId);
  }

  /** The value held back on the index of the charger read, else undefined. */
  currentHold() {
    const c = this.known();
    return c ? this.indexGuards.get(this.indexFeatureId(c.serial))?.held : undefined;
  }

  /**
   * The total charged energy through the guard, once per read: what may be
   * published (`c.index`), the guard written to /data BEFORE Gladys gets the
   * value (a crash in between never sends an index /data does not know).
   * Only once the device is created (its feature exists).
   */
  async evaluateIndex() {
    const c = this.known();
    if (!c) {
      return;
    }
    const featureId = this.indexFeatureId(c.serial);
    if (!this.createdFeatures().has(featureId)) {
      c.index = undefined;
      return;
    }
    const guard = this.guardOf(featureId);
    const total = c.values?.totalEnergy === undefined ? undefined : round3(c.values.totalEnergy);
    if (total === undefined) {
      // Not in this answer: the last accepted value keeps its date in Gladys.
      c.index = guard.held ? guard.last?.value : undefined;
    } else {
      const plausible = guard.accept(total, this.now());
      c.index = plausible ? total : guard.held ? guard.last?.value : undefined;
    }
    const held = guard.held;
    const key = held ? `${featureId}:${holdKey(held)}` : undefined;
    if (key && key !== this.loggedHold) {
      this.logger.warn(
        `NRGkick energy index ${held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held index" button takes it`,
      );
    }
    this.loggedHold = key;
    const kept = Object.entries(this.memory.indexes).filter(([id]) => id !== featureId);
    this.memory.indexes = Object.fromEntries(
      [[featureId, guard.state()], ...kept].slice(0, LIMITS.indexStates),
    );
    await this.saveMemory();
  }

  // --- Gladys ----------------------------------------------------------------

  /** The charger read with a valid serial, else undefined. */
  known() {
    const c = this.charger;
    return c.serial && c.values ? c : undefined;
  }

  /**
   * The serials of the devices created in Gladys that the charger read is not
   * (another charger at this address, an address changed, or no answer since
   * the start). Empty while a first read is still under way.
   */
  orphans() {
    const c = this.charger;
    if (c.online === undefined && !this.blocked && this.config.address && !this.config.badSecret) {
      return [];
    }
    const serials = [];
    for (const device of this.gladys.devices ?? []) {
      const serial = parseDeviceId(device?.external_id);
      if (
        serial &&
        serial !== c.serial &&
        chargerIds(this.gladys, serial).device === device.external_id
      ) {
        serials.push(serial);
      }
    }
    return serials;
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const c = this.known();
    if (!c) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, c, { ceiling: this.ceiling, language: this.config.language }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    const push = (serial, charger, online) => {
      const states = deviceStates(chargerIds(this.gladys, serial), charger, {
        online,
        language: this.config.language,
        ceiling: this.ceiling,
        index: charger.index,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    };
    const c = this.known();
    if (c) {
      push(c.serial, c, c.online !== false);
    }
    // A created device the charger read is not: unreachable, never left "charging".
    for (const serial of this.orphans()) {
      push(serial, {}, false);
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    const c = this.known();
    if (c && created.has(chargerIds(this.gladys, c.serial).device)) {
      const held = this.currentHold();
      entries.push({
        external_id: chargerIds(this.gladys, c.serial).device,
        transport: c.online === false ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.LOCAL,
        ...(held ? { degraded: true, message: T.badge.held(held) } : {}),
      });
    }
    for (const serial of this.orphans()) {
      entries.push({
        external_id: chargerIds(this.gladys, serial).device,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its index guard, then its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    await this.evaluateIndex();
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  /** A device deleted: its pending states and its index guard go (added again, a fresh guard). */
  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id !== 'string') {
      return;
    }
    this.publisher.forget(device.external_id);
    const prefix = `${device.external_id}:`;
    for (const id of [...this.indexGuards.keys()]) {
      if (id.startsWith(prefix)) {
        this.indexGuards.delete(id);
      }
    }
    this.memory.indexes = Object.fromEntries(
      Object.entries(this.memory.indexes).filter(([id]) => !id.startsWith(prefix)),
    );
    if (parseDeviceId(device.external_id) === this.charger.serial) {
      this.charger.index = undefined;
      this.pendingAccept = undefined;
    }
    await this.saveMemory();
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration buttons -------------------------------------------------------

  async testConnection() {
    if (!this.config.address || this.config.badSecret || this.paused || this.blocked) {
      return this.status()[1];
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      const last = JSON.parse(this.lastStatus ?? '[false,null]')[1];
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    this.lastTestAt = this.now();
    // A read now (a read in progress is joined).
    await this.tick();
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  /**
   * "Accept the held index", in two clicks (like gladys-homee and
   * gladys-hubitat). The first one takes nothing: it lists the value held
   * (drop or jump, from → to, kWh). A second click within
   * TIMINGS.acceptConfirm takes exactly that, if the hold is still the same
   * (direction, from, threshold) and its value is still the one listed plus
   * what the charger may have delivered since (a jump not below it, a drop
   * not above it plus that margin); otherwise it is a first click again. A
   * save of the configuration or a reconnection never accepts anything.
   */
  async acceptHeldIndex() {
    const c = this.known();
    const featureId = c ? this.indexFeatureId(c.serial) : undefined;
    const guard = featureId ? this.indexGuards.get(featureId) : undefined;
    const held = guard?.held;
    if (!held) {
      this.pendingAccept = undefined;
      return T.accept.nothing;
    }
    const now = this.now();
    const fingerprint = `${featureId}:${holdKey(held)}`;
    const pending = this.pendingAccept;
    const asListed = () => {
      const top = pending.listed.to + guard.margin(pending.listed.at, now);
      return held.direction === 'up'
        ? held.to >= pending.listed.to && held.to <= top
        : held.to <= top;
    };
    if (
      !pending ||
      pending.fingerprint !== fingerprint ||
      now - pending.at > TIMINGS.acceptConfirm ||
      now < pending.at ||
      !asListed()
    ) {
      this.pendingAccept = { fingerprint, at: now, listed: { to: held.to, at: now } };
      return T.accept.confirm(held);
    }
    this.pendingAccept = undefined;
    const taken = guard.acceptHeld();
    this.logger.info(
      `NRGkick energy index ${taken.direction === 'down' ? 'drop' : 'jump'} from ${taken.from} to ${taken.to} kWh accepted by the user`,
    );
    // The value held is the one of the last read: taken now.
    await this.evaluateIndex();
    this.badge = undefined;
    await this.publishAll();
    return T.accept.done(taken);
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, strictly: null, '', ' ', true or 1.5 are never
   * read as a number. Throws a refusal when it is not valid.
   */
  commandValue(role, value) {
    if (role === FEATURES.PAUSE || role === FEATURES.RESUME) {
      if (value === PRESSED || value === String(PRESSED)) {
        return PRESSED;
      }
      throw this.refusal(ERRORS.badButton);
    }
    const amps =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)
          ? Number(value.trim())
          : NaN;
    if (!Number.isInteger(amps)) {
      throw this.refusal(ERRORS.badCurrent);
    }
    if (amps < CURRENT.min || amps > CURRENT.max) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, CURRENT.max));
    }
    return amps;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.commandValue(target.role, value);
    const { role } = target;
    const isPause = role === FEATURES.PAUSE;
    if (!isPause && !this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (!this.config.address) {
      throw this.refusal(ERRORS.noAddress);
    }
    if (!this.isTarget(target.serial, role)) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    const previous = this.inFlight;
    if (previous && isPause && previous.role === FEATURES.PAUSE) {
      // A pause already under way: this one shares its outcome.
      return previous.promise;
    }
    // One command at a time: a busy charger refuses at once, but a pause is
    // never held back: it goes now, and once more when a resume it overtook settles.
    if (previous && !isPause) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = {
      role,
      sentAt: undefined,
      overtaken: previous,
      again: undefined,
      promise: undefined,
    };
    this.inFlight = entry;
    entry.promise = this.command(target, wanted, received, entry);
    const release = () => {
      if (this.inFlight === entry) {
        this.inFlight = undefined;
      }
    };
    try {
      return await entry.promise;
    } finally {
      // A pause to send again keeps the charger busy until it is done (the
      // ack does not wait for it): a newer resume is refused meanwhile.
      if (entry.again) {
        entry.again.finally(release);
      } else {
        release();
      }
    }
  }

  /**
   * Whether a command of the device `serial` goes to the charger at the
   * address. A pause also goes when no read gave a serial yet (a pause or a
   * block kept in /data across a restart, a first read under way) and the
   * device is one created in Gladys: pausing is never held back. Never when
   * another charger answers at the address.
   */
  isTarget(serial, role) {
    if (this.charger.serial !== undefined) {
      return this.charger.serial === serial;
    }
    return (
      role === FEATURES.PAUSE &&
      (this.gladys.devices ?? []).some(
        (d) => d.external_id === chargerIds(this.gladys, serial).device,
      )
    );
  }

  /** The checks before sending, on the latest configuration. A pause only needs its charger. */
  checkBeforeSend(generation, serial, role) {
    if (generation !== this.generation || !this.isTarget(serial, role)) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    if (role === FEATURES.PAUSE) {
      return;
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.paused) {
      throw this.refusal(ERRORS.paused(age(this.pausedUntil - this.now())));
    }
    if (this.blocked) {
      throw this.refusal(ERRORS.blocked);
    }
    const since = this.now() - this.charger.lastChangeAt;
    if (since < TIMINGS.changeMinInterval) {
      throw this.refusal(ERRORS.tooOften(age(TIMINGS.changeMinInterval - since)));
    }
  }

  /** A pause arrived after `entry` started: anything but a pause gives way. */
  pauseArrived(entry) {
    return entry.role !== FEATURES.PAUSE && this.inFlight !== entry;
  }

  /**
   * What to send (`{ key, value, guardKey, expected, from }`), from the state
   * just read; undefined when already so. A pause is always sent (it needs no
   * read, and sending it again is harmless).
   */
  plan(role, wanted, fresh, serial) {
    if (role === FEATURES.PAUSE) {
      return {
        key: 'charge_pause',
        value: 1,
        guardKey: 'pause',
        expected: true,
        from: this.charger.control?.paused,
      };
    }
    const control = fresh.control;
    if (role === FEATURES.RESUME) {
      const state = fresh.status.state;
      if (state === STATE.STANDBY) {
        throw this.refusal(ERRORS.noVehicle);
      }
      if (!PLUGGED_STATES.has(state)) {
        throw this.refusal(ERRORS.fault(STATE_NAMES[state] ?? STATE_NAMES[STATE.UNKNOWN]));
      }
      if (control.paused === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      if (control.paused === false && !this.guardActive(serial, 'pause')) {
        return undefined;
      }
      return {
        key: 'charge_pause',
        value: 0,
        guardKey: 'pause',
        expected: false,
        from: control.paused,
      };
    }
    if (control.currentSet === undefined) {
      throw this.refusal(ERRORS.missing);
    }
    const ceiling = this.ceiling;
    if (wanted > ceiling) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, ceiling));
    }
    if (
      Math.abs(control.currentSet - wanted) <= CURRENT.tolerance &&
      !this.guardActive(serial, 'current')
    ) {
      return undefined;
    }
    return {
      key: 'current_set',
      value: wanted,
      guardKey: 'current',
      expected: wanted,
      from: control.currentSet,
    };
  }

  /** The fresh read of a resume or a current change: control (and the status for a resume). */
  async freshRead(role, budget) {
    const address = this.config.address;
    const auth = this.config.auth;
    const deadline = this.now() + budget;
    const control = parseControl(await this.client.control(address, auth, { timeoutMs: budget }));
    let status;
    if (role === FEATURES.RESUME) {
      const left = deadline - this.now();
      if (left < TIMINGS.commandMinRead) {
        throw Object.assign(new Error('No time left'), { kind: ERROR_KINDS.TIMEOUT, late: true });
      }
      status = parseStatus(
        await this.client.values(address, auth, { timeoutMs: left, generalOnly: true }),
      );
    }
    return { control, status };
  }

  async command({ serial, role }, wanted, received, entry) {
    const generation = this.generation;
    const isPause = role === FEATURES.PAUSE;
    const sendBy = received + TIMINGS.commandSendBy;
    const c = this.charger;
    this.checkBeforeSend(generation, serial, role);
    const address = this.config.address;

    // A resume or a current: the state just before acting, never the one in memory.
    let fresh;
    if (!isPause) {
      const readBudget = Math.min(
        TIMINGS.commandReadMax,
        sendBy - TIMINGS.commandMinSend - this.now(),
      );
      if (readBudget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      const readStart = this.now();
      try {
        fresh = await this.freshRead(role, readBudget);
      } catch (err) {
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
          this.updateStatus().catch(() => {});
        }
        throw this.refusal(err.late ? ERRORS.tooSlow : ERRORS.unknownState(errorReason(err)));
      }
      if (generation !== this.generation) {
        throw this.refusal(ERRORS.unknownCharger);
      }
      // Applied only when no command left during the read.
      if (readStart > c.lastSentAt) {
        this.applyControl(fresh.control, { fromCommand: true });
        // Shown in the background: the ack never waits for Gladys.
        this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
      }
    }

    const plan = this.plan(role, wanted, fresh, serial);
    if (!plan) {
      return;
    }
    // The option may have been turned off during the read: checked again.
    this.checkBeforeSend(generation, serial, role);
    if (this.pauseArrived(entry)) {
      throw this.refusal(ERRORS.pauseMeanwhile);
    }
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const timeoutMs = Math.max(200, received + TIMINGS.commandAnswerBy - this.now());
    const previousChangeAt = c.lastChangeAt;
    const previousResumeAt = c.lastResumeAt;
    c.lastSentAt = this.now();
    c.lastCommandAt = this.now();
    entry.sentAt = this.now();
    if (!isPause) {
      c.lastChangeAt = this.now();
    }
    if (role === FEATURES.RESUME) {
      c.lastResumeAt = this.now();
    }
    this.logger.info(`NRGkick: ${role} (${plan.key}=${plan.value})`);
    const reassertFrom = isPause && this.unconfirmedResume ? entry.sentAt : undefined;
    try {
      const echoed = await this.client.command(address, this.config.auth, plan.key, plan.value, {
        startBy: sendBy,
        timeoutMs,
      });
      this.applyEcho(plan, echoed);
    } catch (err) {
      const reason = errorReason(err);
      this.logger.warn(`NRGkick: ${role} failed (${reason})`);
      if (err.kind === ERROR_KINDS.LATE || err.kind === ERROR_KINDS.UNREACHABLE || err.notSent) {
        // Nothing left: the minute between two changes is not spent.
        c.lastChangeAt = previousChangeAt;
        c.lastResumeAt = previousResumeAt;
        throw this.refusal(err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        await this.pause(err);
        this.updateStatus().catch(() => {});
        throw this.refusal(ERRORS.refused(reason));
      }
      if (
        err.kind === ERROR_KINDS.AUTH ||
        err.kind === ERROR_KINDS.REJECTED ||
        err.kind === ERROR_KINDS.API_DISABLED ||
        (err.kind === ERROR_KINDS.HTTP && err.status < 500)
      ) {
        this.followUp();
        throw this.refusal(ERRORS.refused(reason));
      }
      // A 5xx, a silence, an unexpected answer or any other error after the
      // transport started: it may have reached the charger.
      if (role === FEATURES.RESUME) {
        // It may still land later, even after a pause: a pause sent within
        // the next 90 s is reaffirmed if a read shows the charge resumed.
        c.unconfirmedResumeUntil = this.now() + TIMINGS.guard;
      }
      this.guard(serial, plan, reassertFrom);
      this.followUp();
      this.pauseAgain(serial, entry, plan);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    this.guard(serial, plan, reassertFrom);
    this.followUp();
    this.pauseAgain(serial, entry, plan);
  }

  /** The charger echoed the value it took: shown at once (in the background). */
  applyEcho(plan, echoed) {
    const c = this.charger;
    if (!c.control) {
      return;
    }
    c.control = {
      ...c.control,
      ...(plan.key === 'charge_pause' ? { paused: echoed === 1 } : { currentSet: echoed }),
    };
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
  }

  /**
   * A pause that overtook a resume still in flight (it may land after it):
   * sent once more when that resume settles. No state read: it repeats a
   * pause already decided.
   */
  pauseAgain(serial, entry, plan) {
    if (
      entry.overtaken?.role !== FEATURES.RESUME ||
      plan.key !== 'charge_pause' ||
      plan.value !== 1
    ) {
      return;
    }
    // Kept in entry.again: the pause holds the charger (inFlight) until it ends.
    entry.again = entry.overtaken.promise
      .catch(() => {})
      .then(async () => {
        // Only the charger is checked: the pause was accepted.
        if (entry.overtaken.sentAt === undefined) {
          // The resume gave way (refused unsent): nothing can land after the pause.
          return;
        }
        if (this.charger.lastResumeAt > entry.sentAt) {
          // A newer resume really left since this pause: its intent wins.
          this.logger.info('NRGkick: pause not sent again (newer resume sent)');
          return;
        }
        if (!this.isTarget(serial, FEATURES.PAUSE) || !this.config.address) {
          return;
        }
        this.logger.warn('NRGkick: pause sent again after the resume in flight');
        this.charger.lastSentAt = this.now();
        await this.client.command(this.config.address, this.config.auth, 'charge_pause', 1, {
          startBy: Infinity,
          timeoutMs: TIMINGS.readTimeout,
        });
        this.guard(serial, plan, this.unconfirmedResume ? entry.sentAt : undefined);
      })
      .catch(async (err) => {
        this.logger.warn(`NRGkick: pause again failed (${errorReason(err)})`);
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
          await this.updateStatus();
        }
      })
      .catch(() => {});
  }

  /** Spaced reads after a command: its effect, then a check (each a new read). */
  followUp() {
    const generation = this.generation;
    const c = this.charger;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        c.followUps.delete(handle);
        if (generation === this.generation) {
          // A read under way began before the command: wait for it, then read again.
          Promise.resolve(c.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('NRGkick refresh failed'));
        }
      }, delay);
      c.followUps.add(handle);
    }
  }

  // --- Guards ----------------------------------------------------------------------

  /** A resume not confirmed may still land on the charger. */
  get unconfirmedResume() {
    return this.now() < this.charger.unconfirmedResumeUntil;
  }

  /**
   * After a command, until the charger shows it: a new command is always
   * sent, never answered "already so" on a state that may not show the
   * previous one yet. The start state is kept: a read equal to it lifts
   * nothing until a move was seen. `reassertFrom`: a pause sent while a
   * resume was not confirmed (the time it left): its guard holds the whole
   * 90 s and reaffirms the pause (see observe).
   */
  guard(serial, plan, reassertFrom) {
    const key = `${serial}:${plan.guardKey}`;
    const held = this.guards.get(key);
    // A pause sent again keeps the reaffirmation of the pause it repeats.
    const keep =
      held?.reassertFrom !== undefined &&
      plan.expected === true &&
      this.guardActive(serial, plan.guardKey);
    this.guards.set(key, {
      from: plan.from,
      expected: plan.expected,
      moved: false,
      until: keep ? held.until : this.now() + TIMINGS.guard,
      // A second pause click renews the reaffirmation from its own time.
      reassertFrom: keep ? (reassertFrom ?? held.reassertFrom) : reassertFrom,
      reasserts: keep ? held.reasserts : 0,
    });
  }

  guardActive(serial, guardKey) {
    const key = `${serial}:${guardKey}`;
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read of the control, through the guards: never lifted on an unknown value. */
  observe(serial, control, { fromCommand = false } = {}) {
    const same = (a, b) =>
      typeof a === 'number' && typeof b === 'number'
        ? Math.abs(a - b) <= CURRENT.tolerance
        : a === b;
    for (const [guardKey, value] of [
      ['pause', control.paused],
      ['current', control.currentSet],
    ]) {
      if (!this.guardActive(serial, guardKey) || value === undefined) {
        continue;
      }
      const key = `${serial}:${guardKey}`;
      const guard = this.guards.get(key);
      if (!same(value, guard.from)) {
        guard.moved = true;
      }
      if (guard.reassertFrom !== undefined) {
        // A pause to reaffirm: the guard holds its 90 s. The charge read
        // resumed while no resume left since the pause is a late resume
        // landing after it: the pause is sent again, twice at most.
        if (
          value === false &&
          !fromCommand &&
          !(this.inFlight && this.inFlight.role === FEATURES.RESUME) &&
          this.charger.lastResumeAt <= guard.reassertFrom &&
          guard.reasserts < TIMINGS.pauseReasserts
        ) {
          guard.reasserts += 1;
          this.reassertPause(serial);
        }
        continue;
      }
      if (guard.moved && same(value, guard.expected)) {
        this.guards.delete(key);
      }
    }
  }

  /** Sends the pause again (a late resume landed after it). No read, no option check. */
  reassertPause(serial) {
    if (this.charger.serial !== serial || !this.config.address) {
      return;
    }
    this.logger.warn('NRGkick: the charge resumed after a pause, pause sent again');
    this.charger.lastSentAt = this.now();
    this.client
      .command(this.config.address, this.config.auth, 'charge_pause', 1, {
        startBy: Infinity,
        timeoutMs: TIMINGS.readTimeout,
      })
      .then(() => this.followUp())
      .catch(async (err) => {
        this.logger.warn(`NRGkick: pause reaffirmed failed (${errorReason(err)})`);
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.pause(err);
        }
      })
      .catch(() => {});
  }
}
