// -----------------------------------------------------------------------------
// NRGkick constants, limits and timings.
//
// An NRGkick Gen2 (portable charger, DiniTech) has a local REST JSON API on
// port 80, as nrgkick-api (MIT, andijakl/nrgkick-api 1.8.1, the library of
// Home Assistant's NRGkick integration) reads it. Three endpoints, all GET:
//   - `/info`: identity (serial number, model, rated current), attachment
//     (connector type, phases, max current), firmware versions;
//   - `/values`: energy (total and session), power flow per phase, status,
//     warning and error codes, temperatures;
//   - `/control`: the charging current set, the charge pause, the energy
//     limit and the phase count. The same endpoint WRITES them through its
//     query string (`/control?charge_pause=1`): a GET with a side effect.
// HTTP Basic auth is optional (turned on in the NRGkick app). The JSON API
// itself must be turned on in the app (it then answers with a `Response`
// message saying so).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 80;

export const PATHS = {
  info: '/info',
  values: '/values',
  control: '/control',
};

/** `raw=1` gives the numeric codes (status, warning, error) instead of texts. */
export const QUERIES = {
  info: { raw: '1', general: '1', connector: '1', versions: '1' },
  values: { raw: '1' },
  /** The fresh read of a resume: the status only. */
  valuesGeneral: { raw: '1', general: '1' },
};

/** The text the charger answers with while its JSON API is off (nrgkick-api). */
export const API_DISABLED_TEXT = 'API must be enabled within the NRGkick App';

/**
 * The charging current, in whole amperes: never below 6 A (IEC 61851, the
 * lowest current a vehicle accepts, and the lowest the charger takes), never
 * above the ceiling of the configuration (16 A by default, 32 A at most), the
 * rated current of the charger nor the max current of its attachment.
 */
export const CURRENT = {
  min: 6,
  max: 32,
  defaultCeiling: 16,
  /** nrgkick-api accepts the answer of a current set within this tolerance. */
  tolerance: 0.1,
};

/** The charging status of `/values` general.status (raw), as nrgkick-api's ChargingStatus. */
export const STATUS_CODES = {
  0: 'unknown',
  1: 'standby',
  2: 'connected',
  3: 'charging',
  6: 'error',
  7: 'wakeup',
};

/** Our states: the charging statuses, plus `offline` (no answer). */
export const STATE = {
  UNKNOWN: 'unknown',
  STANDBY: 'standby',
  CONNECTED: 'connected',
  CHARGING: 'charging',
  ERROR: 'error',
  WAKEUP: 'wakeup',
  OFFLINE: 'offline',
};

/** A vehicle is plugged in: the only states where a resume is sent. */
export const PLUGGED_STATES = new Set([STATE.CONNECTED, STATE.CHARGING, STATE.WAKEUP]);

/** Warning codes (nrgkick-api's WarningCode). */
export const WARNING_CODES = {
  0: 'NO_WARNING',
  1: 'NO_PE',
  2: 'BLACKOUT_PROTECTION',
  3: 'ENERGY_LIMIT_REACHED',
  4: 'EV_DOES_NOT_COMPLY_STANDARD',
  5: 'UNSUPPORTED_CHARGING_MODE',
  6: 'NO_ATTACHMENT_DETECTED',
  7: 'NO_COMM_WITH_TYPE2_ATTACHMENT',
  16: 'INCREASED_TEMPERATURE',
  17: 'INCREASED_HOUSING_TEMPERATURE',
  18: 'INCREASED_ATTACHMENT_TEMPERATURE',
  19: 'INCREASED_DOMESTIC_PLUG_TEMPERATURE',
};

/** Error codes (nrgkick-api's ErrorCode). */
export const ERROR_CODES = {
  0: 'NO_ERROR',
  1: 'GENERAL_ERROR',
  2: '32A_ATTACHMENT_ON_16A_UNIT',
  3: 'VOLTAGE_DROP_DETECTED',
  4: 'UNPLUG_DETECTION_TRIGGERED',
  5: 'TYPE2_NOT_AUTHORIZED',
  16: 'RESIDUAL_CURRENT_DETECTED',
  32: 'CP_SIGNAL_VOLTAGE_ERROR',
  33: 'CP_SIGNAL_IMPERMISSIBLE',
  34: 'EV_DIODE_FAULT',
  48: 'PE_SELF_TEST_FAILED',
  49: 'RCD_SELF_TEST_FAILED',
  50: 'RELAY_SELF_TEST_FAILED',
  51: 'PE_AND_RCD_SELF_TEST_FAILED',
  52: 'PE_AND_RELAY_SELF_TEST_FAILED',
  53: 'RCD_AND_RELAY_SELF_TEST_FAILED',
  54: 'PE_AND_RCD_AND_RELAY_SELF_TEST_FAILED',
  64: 'SUPPLY_VOLTAGE_ERROR',
  65: 'PHASE_SHIFT_ERROR',
  66: 'OVERVOLTAGE_DETECTED',
  67: 'UNDERVOLTAGE_DETECTED',
  68: 'OVERVOLTAGE_WITHOUT_PE_DETECTED',
  69: 'UNDERVOLTAGE_WITHOUT_PE_DETECTED',
  70: 'UNDERFREQUENCY_DETECTED',
  71: 'OVERFREQUENCY_DETECTED',
  72: 'UNKNOWN_FREQUENCY_TYPE',
  73: 'UNKNOWN_GRID_TYPE',
  80: 'GENERAL_OVERTEMPERATURE',
  81: 'HOUSING_OVERTEMPERATURE',
  82: 'ATTACHMENT_OVERTEMPERATURE',
  83: 'DOMESTIC_PLUG_OVERTEMPERATURE',
};

/** Connector (attachment) types (nrgkick-api's ConnectorType). */
export const CONNECTOR_TYPES = {
  0: 'UNKNOWN',
  1: 'CEE',
  2: 'DOMESTIC',
  3: 'TYPE2',
  4: 'WALL',
  5: 'AUS',
};

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  CONNECTOR: 'connector-status',
  CHARGING_STATE: 'charging-state',
  PLUGGED: 'plugged',
  PAUSED: 'charge-paused',
  POWER: 'power',
  POWER_L1: 'power-l1',
  POWER_L2: 'power-l2',
  POWER_L3: 'power-l3',
  CURRENT_L1: 'current-l1',
  CURRENT_L2: 'current-l2',
  CURRENT_L3: 'current-l3',
  VOLTAGE_L1: 'voltage-l1',
  VOLTAGE_L2: 'voltage-l2',
  VOLTAGE_L3: 'voltage-l3',
  CURRENT_SET: 'current-set',
  CURRENT_SIGNALED: 'current-signaled',
  SESSION_ENERGY: 'session-energy',
  ENERGY_INDEX: 'energy-index',
  TEMP_HOUSING: 'temperature-housing',
  TEMP_L1: 'temperature-connector-l1',
  TEMP_L2: 'temperature-connector-l2',
  TEMP_L3: 'temperature-connector-l3',
  ERROR: 'error',
  ERROR_TEXT: 'error-code',
  WARNING: 'warning',
  WARNING_TEXT: 'warning-code',
  RCD: 'rcd-triggered',
  PAUSE: 'pause-charge',
  RESUME: 'resume-charge',
  SET_CURRENT: 'set-current',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  ACCEPT_HELD: 'accept_held_index',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 30,
};

/**
 * The guard of the energy index (src/guard.js): an NRGkick Gen2 delivers 22 kW
 * at most (32 A on three phases); 25 kW on average since the last value is
 * already implausible. 0.5 kWh always allowed on top (rounding, a late read).
 */
export const GUARD_LIMITS = { maxKw: 25, slackKwh: 0.5 };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** The answers are a few KB (`/values` about 1.5 KB). */
  responseBytes: 64 * 1024,
  /** Longest text kept from an answer (model, firmware, a refusal). */
  textLength: 60,
  /** User name and password: printable ASCII, bounded. */
  secretMin: 1,
  secretMax: 256,
  /** Index guards kept in /data at most (one per index feature). */
  indexStates: 8,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling (nrgkick-api waits 10 s; a LAN charger answers in well under 1 s). */
  readTimeout: 5 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The JSON API turned off in the app: read again every 5 minutes at most. */
  apiDisabledWait: 5 * MINUTE,
  /** 429: Retry-After bounded to 1 min .. 6 h, 5 min without. A 5xx pauses as a failed read. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** Credentials refused (or asked for): new tries 15 min, 1 h, then every 6 h (kept in /data). */
  authBackoff: [15 * MINUTE, HOUR, 6 * HOUR],
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads the charger at most this often. */
  testCooldown: 10 * SECOND,
  /** "Accept the held index": the second click within this time takes what the first listed. */
  acceptConfirm: MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the command
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command: 1.5 s at most, and 0.3 s left to send after it. */
  commandReadMax: 1_500,
  commandMinRead: 300,
  commandMinSend: 300,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until the charger shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** A pause reaffirmed at most this often while its guard holds (a late resume landing after it). */
  pauseReasserts: 2,
  /** One resume or current change a minute; a pause is never limited. */
  changeMinInterval: MINUTE,
};
