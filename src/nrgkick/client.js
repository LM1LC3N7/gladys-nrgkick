// -----------------------------------------------------------------------------
// The NRGkick Gen2 local REST JSON API, ported from nrgkick-api 1.8.1 (MIT,
// Andreas Jakl, andijakl/nrgkick-api): the three endpoints (`/info`,
// `/values`, `/control`), the raw mode, the optional HTTP Basic auth (user
// name and password joined by ':', latin1, as nrgkick-api does), the message
// of a JSON API turned off, and the commands written through the query string
// of `/control` with the check of their answer (the key echoed with the value
// asked, a `Response` message being a refusal; the current within 0.1 A).
//
// Reads are never retried here (the app spaces its new tries; nrgkick-api's
// three tries with backoff are not kept); a command is never retried at all
// (it may have reached the charger).
//
// The answers come from the network: only own fields of plain objects are
// read, each with its exact type (a missing or mistyped value is undefined,
// never a default, so that a command is refused rather than decided on a
// guess). JSON.parse keeps `__proto__` as a plain own key: it never reaches a
// prototype, and it is never read.
// -----------------------------------------------------------------------------

import {
  API_DISABLED_TEXT,
  CURRENT,
  LIMITS,
  PATHS,
  QUERIES,
  STATE,
  STATUS_CODES,
} from '../constants.js';
import { ChargerError, ERROR_KINDS, request as httpRequest } from './http.js';

const plain = (data) => data !== null && typeof data === 'object' && !Array.isArray(data);
const own = (object, key) =>
  plain(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const integer = (value) => (Number.isInteger(value) ? value : undefined);
const section = (data, key) => {
  const value = own(data, key);
  return plain(value) ? value : undefined;
};

/** A short text from the charger, without control characters. */
export function text(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.textLength);
}

/** The serial number ("T2332500000000000S1D2") in lower case, else undefined. */
export function serialOf(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const serial = value.trim().toLowerCase();
  return /^[0-9a-z](?:[0-9a-z-]{2,38}[0-9a-z])$/.test(serial) ? serial : undefined;
}

const notObject = () => new ChargerError(ERROR_KINDS.PROTOCOL, 'Not a JSON object');

/** A whole number of amperes usable as a bound (6 to 80 A), else undefined. */
const amperes = (value) => {
  const amps = number(value);
  return amps !== undefined && amps >= 6 && amps <= 80 ? Math.floor(amps) : undefined;
};

/** GET /info?raw&general&connector&versions -> identity, attachment, firmware. */
export function parseInfo(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const general = section(data, 'general');
  const connector = section(data, 'connector');
  const versions = section(data, 'versions');
  const phases = integer(own(connector, 'phase_count'));
  const type = integer(own(connector, 'type'));
  return {
    serial: serialOf(own(general, 'serial_number')),
    model: text(own(general, 'model_type')),
    name: text(own(general, 'device_name')),
    ratedCurrent: amperes(own(general, 'rated_current')),
    phases: phases !== undefined && phases >= 1 && phases <= 3 ? phases : undefined,
    attachmentMax: amperes(own(connector, 'max_current')),
    connectorType: type !== undefined && type >= 0 && type <= 255 ? type : undefined,
    firmware: text(own(versions, 'sw_sm')),
  };
}

const STATUS_NAMES = Object.fromEntries(
  Object.values(STATUS_CODES).map((name) => [name.toUpperCase(), name]),
);

/** The charging status, raw (a code) or not (its name), else unknown. */
export function stateOf(value) {
  if (Number.isInteger(value)) {
    return Object.hasOwn(STATUS_CODES, value) ? STATUS_CODES[value] : STATE.UNKNOWN;
  }
  if (typeof value === 'string' && Object.hasOwn(STATUS_NAMES, value)) {
    return STATUS_NAMES[value];
  }
  return STATE.UNKNOWN;
}

/** A code (warning, error, RCD): a small non-negative integer, else undefined. */
const code = (value) => {
  const v = integer(value);
  return v !== undefined && v >= 0 && v <= 255 ? v : undefined;
};

/** 0/1 (or a boolean) as a boolean, else undefined. */
const flag = (value) => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return undefined;
};

/** Wh -> kWh, a counter: a finite number at or above 0, else undefined. */
const kwh = (value) => {
  const wh = number(value);
  return wh !== undefined && wh >= 0 ? wh / 1000 : undefined;
};

/** The general section of /values: status, flags and codes. */
function generalOf(general) {
  return {
    state: stateOf(own(general, 'status')),
    chargePermitted: flag(own(general, 'charge_permitted')),
    warning: code(own(general, 'warning_code')),
    error: code(own(general, 'error_code')),
    rcd: code(own(general, 'rcd_trigger')),
  };
}

/** GET /values?raw -> energies (kWh), power flow (W, A, V), status, codes, temperatures (°C). */
export function parseValues(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const energy = section(data, 'energy');
  const flow = section(data, 'powerflow');
  const temperatures = section(data, 'temperatures');
  const phase = (name) => section(flow, name);
  const phases = ['l1', 'l2', 'l3'].map(phase);
  const temperature = (key) => number(own(temperatures, key));
  return {
    totalEnergy: kwh(own(energy, 'total_charged_energy')),
    sessionEnergy: kwh(own(energy, 'charged_energy')),
    power: number(own(flow, 'total_active_power')),
    signaled: number(own(flow, 'charging_current')),
    powers: phases.map((p) => number(own(p, 'active_power'))),
    currents: phases.map((p) => number(own(p, 'current'))),
    voltages: phases.map((p) => number(own(p, 'voltage'))),
    ...generalOf(section(data, 'general')),
    temperatures: {
      housing: temperature('housing'),
      connectors: [
        temperature('connector_l1'),
        temperature('connector_l2'),
        temperature('connector_l3'),
      ],
    },
  };
}

/** GET /values?raw&general (the fresh read of a resume) -> the status only. */
export function parseStatus(data) {
  if (!plain(data)) {
    throw notObject();
  }
  return generalOf(section(data, 'general'));
}

/** GET /control -> the current set (A), the pause, the energy limit (kWh), the phases. */
export function parseControl(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const current = number(own(data, 'current_set'));
  const limit = number(own(data, 'energy_limit'));
  const phases = integer(own(data, 'phase_count'));
  return {
    currentSet: current !== undefined && current >= 0 && current <= 80 ? current : undefined,
    paused: flag(own(data, 'charge_pause')),
    energyLimit: limit !== undefined && limit >= 0 ? limit / 1000 : undefined,
    phases: phases !== undefined && phases >= 1 && phases <= 3 ? phases : undefined,
  };
}

/** Retry-After (seconds or an HTTP date) in ms, else undefined. */
export function retryAfterOf(header, now = Date.now()) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  if (/^\s*\d+\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The error of a non-2xx answer (the body is never kept). */
function statusError(response, now) {
  if (response.status === 429) {
    return new ChargerError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', {
      status: 429,
      retryAfter: retryAfterOf(response.headers?.['retry-after'], now),
    });
  }
  if (response.status === 401 || response.status === 403) {
    return new ChargerError(ERROR_KINDS.AUTH, `HTTP ${response.status}`, {
      status: response.status,
    });
  }
  return new ChargerError(ERROR_KINDS.HTTP, `HTTP ${response.status}`, {
    status: response.status,
  });
}

/** The reason of an error for a log or a message: its kind and status, never the answer. */
export function errorReason(err) {
  if (
    err?.kind === ERROR_KINDS.HTTP ||
    err?.kind === ERROR_KINDS.RATE_LIMITED ||
    err?.kind === ERROR_KINDS.AUTH
  ) {
    return `HTTP ${err.status}`;
  }
  if (err?.kind === ERROR_KINDS.REJECTED) {
    return err.reason ? `"${err.reason}"` : 'rejected';
  }
  return err?.kind ?? 'error';
}

const ok = (response) => response.status >= 200 && response.status <= 299;

/** The JSON of an answer, or undefined when it is not JSON. */
function jsonOf(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    return undefined;
  }
}

/** The `Response` message of an answer (a refusal, the API turned off), bounded. */
const responseText = (data) => text(own(data, 'Response'));

/** The query string of a request: only the keys and values given (never user text). */
export function pathOf(path, query = {}) {
  const search = new URLSearchParams(query).toString();
  return search === '' ? path : `${path}?${search}`;
}

/** The Basic auth header, as nrgkick-api builds it (latin1). */
export const basicAuth = ({ username, password }) =>
  `Basic ${Buffer.from(`${username}:${password}`, 'latin1').toString('base64')}`;

export class NrgkickClient {
  constructor({ transport = httpRequest, now = Date.now } = {}) {
    this.transport = transport;
    this.now = now;
  }

  async exchange(address, auth, path, query, { timeoutMs, command = false }) {
    const response = await this.transport({
      ...address,
      method: 'GET',
      path: pathOf(path, query),
      headers: auth ? { Authorization: basicAuth(auth) } : {},
      timeoutMs,
    });
    const data = jsonOf(response);
    const message = plain(data) ? own(data, 'Response') : undefined;
    if (message === API_DISABLED_TEXT) {
      throw new ChargerError(ERROR_KINDS.API_DISABLED, 'JSON API turned off');
    }
    if (!ok(response)) {
      if (
        command &&
        typeof message === 'string' &&
        response.status !== 401 &&
        response.status !== 403 &&
        response.status !== 429
      ) {
        throw new ChargerError(ERROR_KINDS.REJECTED, 'Command refused', {
          status: response.status,
          reason: responseText(data),
        });
      }
      throw statusError(response, this.now());
    }
    if (data === undefined) {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Not JSON');
    }
    return data;
  }

  /** GET /info (identity, attachment, versions). */
  info(address, auth, { timeoutMs }) {
    return this.exchange(address, auth, PATHS.info, QUERIES.info, { timeoutMs });
  }

  /** GET /values (raw); `generalOnly` for the fresh read of a resume. */
  values(address, auth, { timeoutMs, generalOnly = false }) {
    return this.exchange(
      address,
      auth,
      PATHS.values,
      generalOnly ? QUERIES.valuesGeneral : QUERIES.values,
      { timeoutMs },
    );
  }

  /** GET /control (read). */
  control(address, auth, { timeoutMs }) {
    return this.exchange(address, auth, PATHS.control, {}, { timeoutMs });
  }

  /**
   * One command through `/control?<key>=<value>`, never retried. `startBy`:
   * refused unsent (LATE) after it. The answer must echo the key with the
   * value asked: a `Response` message is a refusal, another value a protocol
   * error (the charger did not take it as asked).
   */
  async command(address, auth, key, value, { startBy, timeoutMs }) {
    const valid =
      (key === 'charge_pause' && (value === 0 || value === 1)) ||
      (key === 'current_set' &&
        Number.isInteger(value) &&
        value >= CURRENT.min &&
        value <= CURRENT.max);
    if (!valid) {
      throw Object.assign(new Error('Bad command'), { notSent: true });
    }
    if (this.now() > startBy) {
      throw new ChargerError(ERROR_KINDS.LATE, 'Too late to send');
    }
    const data = await this.exchange(
      address,
      auth,
      PATHS.control,
      { [key]: String(value) },
      { timeoutMs, command: true },
    );
    if (!plain(data)) {
      throw notObject();
    }
    const refusal = responseText(data);
    if (refusal) {
      throw new ChargerError(ERROR_KINDS.REJECTED, 'Command refused', { reason: refusal });
    }
    const echoed = own(data, key);
    const read =
      typeof echoed === 'number'
        ? echoed
        : typeof echoed === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(echoed)
          ? Number(echoed)
          : undefined;
    const matches =
      read !== undefined &&
      (key === 'current_set' ? Math.abs(read - value) <= CURRENT.tolerance : read === value);
    if (!matches) {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Unexpected answer to the command', {
        echoed: read,
      });
    }
    return read;
  }
}
