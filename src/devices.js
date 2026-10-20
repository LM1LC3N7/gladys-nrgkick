// -----------------------------------------------------------------------------
// The charger -> one Gladys device and its states (pure).
//
// `ext:<selector>:nrgkick:<serial>`: one device per charger, keyed by its
// serial number (`serial_number` of `/info`, in lower case), never by its IP
// address (it may change). The feature roles (the last part of their external
// ids) are published forever: never rename them. Every role is always built,
// whatever the attachment (a single-phase one leaves its L2 and L3 features
// empty), so a republished device never loses a feature.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach a charge command. Pausing
// and resuming are two `button/push` features, the charging current a
// `text/select` of the whole amperes from 6 A to the ceiling.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): W, A and V on `energy-sensor`
// (instantaneous readings) and the energy index (kWh, `energy-sensor/index`,
// the only cumulative counter: it goes through the guard of src/guard.js);
// A and kWh on `electrical-vehicle-charge` (the current set, the current
// signaled to the vehicle, the energy of the session: a plain sensor, it
// starts again at 0 at each session, so never an index); °C on
// `temperature-sensor`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  CURRENT,
  ERROR_CODES,
  FEATURES,
  PLUGGED_STATES,
  STATE,
  WARNING_CODES,
} from './constants.js';
import { FEATURE_NAMES, PAUSED, STATE_NAMES, word } from './i18n.js';

/** CHARGING_STATION_CONNECTOR_STATUS of the core (server/utils/constants.js). */
export const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};

/** CHARGING_STATION_CHARGING_STATE of the core (OCPP 2.0.1 chargingState). */
export const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
  DISCHARGING: 5,
};

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const power = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.POWER,
  unit: U.WATT,
  min: 0,
  max: 30_000,
});
const current = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.CURRENT,
  unit: U.AMPERE,
  min: 0,
  max: 64,
});
const voltage = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.VOLTAGE,
  unit: U.VOLT,
  min: 0,
  max: 500,
});
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -40,
  max: 150,
});
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 });

/** The features, by role, in display order (set-current gets its options in buildDevice). */
export const DEFINITIONS = {
  [FEATURES.STATUS]: text,
  [FEATURES.CONNECTOR]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CONNECTOR_STATUS,
    min: 0,
    max: 4,
  }),
  [FEATURES.CHARGING_STATE]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CHARGING_STATE,
    min: 0,
    max: 5,
  }),
  [FEATURES.PLUGGED]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
    min: 0,
    max: 1,
  }),
  [FEATURES.PAUSED]: binary,
  [FEATURES.POWER]: power,
  [FEATURES.POWER_L1]: power,
  [FEATURES.POWER_L2]: power,
  [FEATURES.POWER_L3]: power,
  [FEATURES.CURRENT_L1]: current,
  [FEATURES.CURRENT_L2]: current,
  [FEATURES.CURRENT_L3]: current,
  [FEATURES.VOLTAGE_L1]: voltage,
  [FEATURES.VOLTAGE_L2]: voltage,
  [FEATURES.VOLTAGE_L3]: voltage,
  [FEATURES.CURRENT_SET]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CURRENT,
    unit: U.AMPERE,
    min: 0,
    max: 64,
  }),
  [FEATURES.CURRENT_SIGNALED]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_CURRENT,
    unit: U.AMPERE,
    min: 0,
    max: 64,
  }),
  [FEATURES.SESSION_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1000,
  }),
  [FEATURES.ENERGY_INDEX]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.INDEX,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 100_000_000,
  }),
  [FEATURES.TEMP_HOUSING]: temperature,
  [FEATURES.TEMP_L1]: temperature,
  [FEATURES.TEMP_L2]: temperature,
  [FEATURES.TEMP_L3]: temperature,
  [FEATURES.ERROR]: binary,
  [FEATURES.ERROR_TEXT]: text,
  [FEATURES.WARNING]: binary,
  [FEATURES.WARNING_TEXT]: text,
  [FEATURES.RCD]: binary,
  [FEATURES.PAUSE]: button,
  [FEATURES.RESUME]: button,
  [FEATURES.SET_CURRENT]: {
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  },
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [FEATURES.PAUSE, FEATURES.RESUME, FEATURES.SET_CURRENT];

export const chargerIds = (gladys, serial) => gladys.externalIds('nrgkick', serial);

const SERIAL = '[0-9a-z](?:[0-9a-z-]{2,38}[0-9a-z])';

/** The serial and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`:nrgkick:(${SERIAL}):([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.includes(match[2]) ? { serial: match[1], role: match[2] } : undefined;
}

/** The serial of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = new RegExp(`:nrgkick:(${SERIAL})$`).exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

export function currentOptions(ceiling) {
  const options = [];
  for (let amps = CURRENT.min; amps <= ceiling; amps += 1) {
    options.push({ value: String(amps), label: `${amps} A`, sort_order: amps - CURRENT.min });
  }
  return options;
}

export const deviceName = (charger) => `NRGkick ${charger.serial.slice(-4).toUpperCase()}`;

/**
 * The Gladys device of the charger. `ceiling`: the highest current the
 * commands accept now (the select is only an offer: the command checks the
 * ceiling again).
 */
export function buildDevice(gladys, charger, { ceiling, language }) {
  const ids = chargerIds(gladys, charger.serial);
  const params = [{ name: 'serial_number', value: charger.serial }];
  if (charger.firmware) {
    params.push({ name: 'firmware', value: charger.firmware });
  }
  if (charger.ratedCurrent) {
    params.push({ name: 'rated_current', value: String(charger.ratedCurrent) });
  }
  return {
    name: deviceName(charger),
    external_id: ids.device,
    model: charger.model ?? 'NRGkick Gen2',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.SET_CURRENT ? { supported_options: currentOptions(ceiling) } : {}),
    })),
    params,
  };
}

/** The connector, as the core's charging-station category reads it (undefined: unknown). */
export function connectorOf(state) {
  switch (state) {
    case STATE.OFFLINE:
      return CONNECTOR_STATUS.UNAVAILABLE;
    case STATE.STANDBY:
      return CONNECTOR_STATUS.AVAILABLE;
    case STATE.CONNECTED:
    case STATE.CHARGING:
    case STATE.WAKEUP:
      return CONNECTOR_STATUS.OCCUPIED;
    case STATE.ERROR:
      return CONNECTOR_STATUS.FAULTED;
    default:
      return undefined;
  }
}

/**
 * The charging state (OCPP's chargingState). No vehicle or an error: IDLE, so
 * a scene never keeps reading "charging" after the car left.
 */
export function chargingStateOf(state, paused) {
  switch (state) {
    case STATE.CHARGING:
      return CHARGING_STATE.CHARGING;
    case STATE.CONNECTED:
    case STATE.WAKEUP:
      return paused === true ? CHARGING_STATE.PAUSED_BY_CHARGER : CHARGING_STATE.EV_CONNECTED;
    case STATE.STANDBY:
    case STATE.ERROR:
      return CHARGING_STATE.IDLE;
    default:
      return undefined;
  }
}

/** The text of the status feature. */
export function statusText(state, paused) {
  if (state === STATE.CONNECTED && paused === true) {
    return PAUSED;
  }
  return STATE_NAMES[state] ?? STATE_NAMES[STATE.UNKNOWN];
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const flag = (value) => (value === undefined ? undefined : value ? 1 : 0);
const codeText = (table, code) =>
  Object.hasOwn(table, code) ? `${table[code]} (${code})` : `UNKNOWN (${code})`;

/**
 * The current values of the charger's device. Offline: only the status and
 * the connector (Gladys keeps the last value of the others). `index`: the
 * value of the energy index the guard lets through (undefined: none).
 */
export function deviceStates(ids, charger, { online, language, ceiling, index }) {
  if (!online) {
    return [
      { role: FEATURES.STATUS, text: word(STATE_NAMES[STATE.OFFLINE], language) },
      { role: FEATURES.CONNECTOR, state: CONNECTOR_STATUS.UNAVAILABLE },
    ].map(({ role, ...value }) => ({ device_feature_external_id: ids.feature(role), ...value }));
  }
  const states = [];
  // A value outside the bounds of its feature is dropped (Gladys keeps the last one).
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (value !== undefined && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ role, state: value });
    }
  };
  const v = charger.values;
  const ctl = charger.control;
  const paused = ctl?.paused;
  if (v) {
    states.push({ role: FEATURES.STATUS, text: word(statusText(v.state, paused), language) });
    add(FEATURES.CONNECTOR, connectorOf(v.state));
    add(FEATURES.CHARGING_STATE, chargingStateOf(v.state, paused));
    if (v.state !== STATE.UNKNOWN && v.state !== STATE.ERROR) {
      add(FEATURES.PLUGGED, PLUGGED_STATES.has(v.state) ? 1 : 0);
    }
    if (v.power !== undefined) add(FEATURES.POWER, Math.round(v.power));
    // Only the phases of the attachment (a single-phase one leaves L2/L3 empty).
    const count = charger.phases ?? 3;
    const phases = [
      [FEATURES.POWER_L1, FEATURES.CURRENT_L1, FEATURES.VOLTAGE_L1, FEATURES.TEMP_L1],
      [FEATURES.POWER_L2, FEATURES.CURRENT_L2, FEATURES.VOLTAGE_L2, FEATURES.TEMP_L2],
      [FEATURES.POWER_L3, FEATURES.CURRENT_L3, FEATURES.VOLTAGE_L3, FEATURES.TEMP_L3],
    ];
    for (const [i, [powerRole, currentRole, voltageRole, tempRole]] of phases.entries()) {
      if (i >= count) break;
      if (v.powers[i] !== undefined) add(powerRole, Math.round(v.powers[i]));
      if (v.currents[i] !== undefined) add(currentRole, round(v.currents[i], 2));
      if (v.voltages[i] !== undefined) add(voltageRole, Math.round(v.voltages[i]));
      if (v.temperatures.connectors[i] !== undefined) {
        add(tempRole, round(v.temperatures.connectors[i], 1));
      }
    }
    if (v.temperatures.housing !== undefined) {
      add(FEATURES.TEMP_HOUSING, round(v.temperatures.housing, 1));
    }
    if (v.signaled !== undefined) add(FEATURES.CURRENT_SIGNALED, round(v.signaled, 1));
    if (v.sessionEnergy !== undefined) add(FEATURES.SESSION_ENERGY, round(v.sessionEnergy, 3));
    if (v.error !== undefined) {
      add(FEATURES.ERROR, v.error === 0 ? 0 : 1);
      states.push({ role: FEATURES.ERROR_TEXT, text: codeText(ERROR_CODES, v.error) });
    }
    if (v.warning !== undefined) {
      add(FEATURES.WARNING, v.warning === 0 ? 0 : 1);
      states.push({ role: FEATURES.WARNING_TEXT, text: codeText(WARNING_CODES, v.warning) });
    }
    if (v.rcd !== undefined) add(FEATURES.RCD, v.rcd === 0 ? 0 : 1);
  }
  // Never 0, never a value the guard held back (src/app.js decides `index`).
  if (index !== undefined && index > 0) {
    add(FEATURES.ENERGY_INDEX, round(index, 3));
  }
  if (ctl) {
    add(FEATURES.PAUSED, flag(ctl.paused));
    if (ctl.currentSet !== undefined) {
      add(FEATURES.CURRENT_SET, round(ctl.currentSet, 1));
      // The select shows the current set when it is one of its options.
      if (
        Number.isInteger(ctl.currentSet) &&
        ctl.currentSet >= CURRENT.min &&
        ctl.currentSet <= ceiling
      ) {
        states.push({ role: FEATURES.SET_CURRENT, text: String(ctl.currentSet) });
      }
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
