// -----------------------------------------------------------------------------
// A fake NRGkick Gen2 behind the transport the integration is given: the
// answers shaped like the local API documentation shipped with nrgkick-api
// (values made up, never captured from a real charger), the optional Basic
// auth checked, and the commands of `/control?<key>=<value>`, which change the
// charger like it is expected to and echo the value. Records every request.
// No network. Delays use setTimeout, so the mocked clock drives them.
// -----------------------------------------------------------------------------

import { ChargerError, ERROR_KINDS } from '../../src/nrgkick/http.js';

export const HOST = '192.168.1.70';
export const USER = 'admin';
export const PASSWORD = 'correct horse';
export const SERIAL = 't2332500000000000s1d2';
export const NOW = Date.UTC(2026, 9, 20, 18, 0, 0);

export const basic = (user, password) =>
  `Basic ${Buffer.from(`${user}:${password}`, 'latin1').toString('base64')}`;

/** Raw mode: the codes as numbers. */
export const info = (over = {}) => ({
  general: {
    serial_number: 'T2332500000000000S1D2',
    model_type: 'NRGkick Gen2 SIM',
    device_name: 'NRGkick',
    rated_current: 32,
    ...over.general,
  },
  connector: { phase_count: 3, max_current: 32, type: 3, serial: 'A1234567', ...over.connector },
  versions: { sw_sm: '4.1.2.0', hw_sm: '1.0', ...over.versions },
});

/** Charging on three phases at 16 A, 11 kW, 14 187 Wh in total, 5 230 Wh this session. */
export const values = (over = {}) => ({
  energy: { total_charged_energy: 14_187_000, charged_energy: 5_230, ...over.energy },
  powerflow: {
    charging_voltage: 230.1,
    charging_current: 16,
    grid_frequency: 50.01,
    peak_power: 11_100,
    total_active_power: 11_040,
    total_reactive_power: 0,
    total_apparent_power: 11_050,
    total_power_factor: 0.99,
    l1: { voltage: 229.6, current: 16.01, active_power: 3_680 },
    l2: { voltage: 230.4, current: 15.98, active_power: 3_675 },
    l3: { voltage: 231.2, current: 16.03, active_power: 3_685 },
    n: { current: 0.1 },
    ...over.powerflow,
  },
  general: {
    charging_rate: 60,
    vehicle_connect_time: 3600,
    vehicle_charging_time: 1700,
    status: 3,
    charge_permitted: 1,
    relay_state: 15,
    charge_count: 61,
    rcd_trigger: 0,
    warning_code: 0,
    error_code: 0,
    ...over.general,
  },
  temperatures: {
    housing: 37.76,
    connector_l1: 36.71,
    connector_l2: 25.39,
    connector_l3: 27.91,
    domestic_plug_1: 0,
    domestic_plug_2: 0,
    ...over.temperatures,
  },
});

export const control = (over = {}) => ({
  current_set: 16,
  charge_pause: 0,
  energy_limit: 0,
  phase_count: 3,
  ...over,
});

const answer = (status, body = '', headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The charger. The test may set: `down` (nothing answers), `silent`
 * (connected, no answer), `delays` (by path, or `command`), `statuses` (by
 * path, or `command`), `auth` (the header it asks for), `apiDisabled`,
 * `reject` (a `Response` message to commands), `clamp` (the highest current
 * it takes), `commandPlan(index)` -> { applyAfter, answerAfter } (ms).
 */
export function fakeCharger(over = {}) {
  const charger = {
    info: info(),
    values: values(),
    control: control(),
    delays: {},
    statuses: {},
    headers: {},
    auth: undefined,
    ...over,
  };
  const server = {
    charger,
    /** { host, port, method, path, headers, timeoutMs } */
    requests: [],
    paths: () => server.requests.map((r) => r.path),
    commands: () =>
      server.requests
        .map((r) => new URL(r.path, 'http://x'))
        .filter((u) => u.pathname === '/control' && u.search !== '')
        .map((u) => Object.fromEntries(u.searchParams)),
    async transport(request) {
      const { path, headers = {}, timeoutMs } = request;
      server.requests.push(request);
      if (charger.down) {
        throw new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      const url = new URL(path, 'http://x');
      const query = Object.fromEntries(url.searchParams);
      const isCommand =
        url.pathname === '/control' && ('charge_pause' in query || 'current_set' in query);
      const key = isCommand ? 'command' : url.pathname;
      if (charger.auth && headers.Authorization !== charger.auth) {
        return answer(401, 'Unauthorized');
      }
      if (isCommand && charger.commandPlan) {
        const index = server.commands().length - 1;
        const { applyAfter = 0, answerAfter = 0 } = charger.commandPlan(index) ?? {};
        const apply = () => applyCommand(charger, query);
        if (applyAfter > 0) {
          setTimeout(apply, applyAfter);
        } else {
          apply();
        }
        if (answerAfter >= timeoutMs) {
          await wait(timeoutMs);
          throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
        }
        if (answerAfter) {
          await wait(answerAfter);
        }
        return answer(200, echo(charger, query));
      }
      const delay = charger.delays[key] ?? 0;
      if (charger.silent || delay >= timeoutMs) {
        await wait(timeoutMs);
        throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
      }
      if (delay) {
        await wait(delay);
      }
      if (charger.apiDisabled) {
        return answer(200, { Response: 'API must be enabled within the NRGkick App' });
      }
      const status = charger.statuses[key];
      if (status) {
        return answer(status, 'error', charger.headers);
      }
      if (isCommand) {
        if (charger.reject) {
          return answer(400, { Response: charger.reject });
        }
        applyCommand(charger, query);
        return answer(200, echo(charger, query));
      }
      const table = {
        '/info': charger.info,
        '/values': charger.values,
        '/control': charger.control,
      };
      return Object.hasOwn(table, url.pathname)
        ? answer(200, table[url.pathname])
        : answer(404, { Response: 'Error 404 - Not found' });
    },
  };
  return server;
}

function applyCommand(charger, query) {
  if ('charge_pause' in query) {
    charger.control.charge_pause = Number(query.charge_pause);
  }
  if ('current_set' in query) {
    charger.control.current_set = Math.min(Number(query.current_set), charger.clamp ?? Infinity);
  }
}

const echo = (charger, query) =>
  'charge_pause' in query
    ? { charge_pause: charger.control.charge_pause }
    : { current_set: charger.control.current_set };

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
