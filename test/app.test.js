// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake charger behind the transport. Timers and Date are mocked:
// the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NrgkickApp } from '../src/app.js';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { CHARGING_STATE, CONNECTOR_STATUS } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  HOST,
  NOW,
  PASSWORD,
  SERIAL,
  USER,
  basic,
  control,
  fakeCharger,
  info,
  settle,
  values,
} from './fixtures/fakeNrgkick.js';

const CONFIG = { host: HOST };
const ALLOWED = { ...CONFIG, allow_commands: true };
const WITH_AUTH = { host: HOST, username: USER, password: PASSWORD };
const DEVICE = `ext:test-integration:nrgkick:${SERIAL}`;
const feature = (role) => `${DEVICE}:${role}`;

async function setup(
  t,
  {
    config = CONFIG,
    server = fakeCharger(),
    store = memoryStore(),
    create = true,
    logs = [],
    transport,
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new NrgkickApp({
    gladys,
    logger: recorder(logs),
    transport: transport ?? server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  const target = (role) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
    return [device, device.features.find((f) => f.external_id === feature(role))];
  };
  const send = (role, value = 1) => gladys.fake.setValue(...target(role), value);
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = send(role, value);
    await settle();
    await advance(wait, 100);
    return ack;
  };
  return { gladys, app, server, store, advance, logs, press, send, charger: server.charger };
}

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, role) => gladys.fake.lastState(feature(role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);

/** No secret anywhere a user or a log reader may see. */
function assertNoSecret({ gladys, logs, store }) {
  const seen = JSON.stringify([logs, gladys.fake.connectionStatuses, store.data]);
  assert.ok(!seen.includes(PASSWORD), 'the password leaked');
  assert.ok(!seen.includes(basic(USER, PASSWORD)), 'the auth header leaked');
}

test('without an address, the status asks for it and nothing is requested', async (t) => {
  const server = fakeCharger();
  const { gladys } = await setup(t, { config: {}, server });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(server.requests.length, 0);
});

test('a user name without a password: refused before any request', async (t) => {
  const server = fakeCharger();
  const { gladys } = await setup(t, { config: { host: HOST, username: USER }, server });
  assert.equal(server.requests.length, 0);
  assert.match(message(gladys).en, /go together/);
});

test('one read: the device, its features, then its states', async (t) => {
  const ctx = await setup(t);
  const { gladys, server } = ctx;
  assert.deepEqual(server.paths().slice(0, 3), [
    '/info?raw=1&general=1&connector=1&versions=1',
    '/values?raw=1',
    '/control',
  ]);
  assert.ok(server.requests.every((r) => r.port === 80 && r.method === 'GET'));
  assert.ok(server.requests.every((r) => r.headers.Authorization === undefined));
  const device = deviceOf(gladys);
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'NRGkick S1D2');
  assert.equal(device.model, 'NRGkick Gen2 SIM');
  assert.deepEqual(device.params, [
    { name: 'serial_number', value: SERIAL },
    { name: 'firmware', value: '4.1.2.0' },
    { name: 'rated_current', value: '32' },
  ]);
  const roles = device.features.map((f) => [
    f.external_id.slice(DEVICE.length + 1),
    f.category,
    f.type,
    f.unit,
    f.read_only,
  ]);
  assert.deepEqual(roles.slice(0, 4), [
    ['status', 'text', 'text', undefined, true],
    ['connector-status', 'charging-station', 'connector-status', undefined, true],
    ['charging-state', 'charging-station', 'charging-state', undefined, true],
    ['plugged', 'electrical-vehicle-charge', 'plugged', undefined, true],
  ]);
  assert.deepEqual(roles.slice(-3), [
    ['pause-charge', 'button', 'push', undefined, false],
    ['resume-charge', 'button', 'push', undefined, false],
    ['set-current', 'text', 'select', undefined, false],
  ]);
  assert.ok(
    device.features.every((f) => f.type !== 'binary' || f.read_only),
    'never a writable binary',
  );
  assert.ok(
    device.features.every((f) => f.category !== 'switch'),
    'never a switch',
  );
  const index = device.features.find((f) => f.external_id === feature('energy-index'));
  assert.deepEqual(
    [index.category, index.type, index.unit],
    ['energy-sensor', 'index', 'kilowatt-hour'],
  );
  const select = device.features.at(-1);
  assert.deepEqual(
    [select.supported_options[0].value, select.supported_options.at(-1).value],
    ['6', '16'],
    'the default ceiling is 16 A',
  );

  assert.equal(last(gladys, 'status'), 'En charge');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.CHARGING);
  assert.equal(last(gladys, 'plugged'), 1);
  assert.equal(last(gladys, 'charge-paused'), 0);
  assert.equal(last(gladys, 'power'), 11_040);
  assert.equal(last(gladys, 'power-l2'), 3_675);
  assert.equal(last(gladys, 'current-l1'), 16.01);
  assert.equal(last(gladys, 'voltage-l3'), 231);
  assert.equal(last(gladys, 'current-set'), 16);
  assert.equal(last(gladys, 'current-signaled'), 16);
  assert.equal(last(gladys, 'session-energy'), 5.23);
  assert.equal(last(gladys, 'energy-index'), 14_187);
  assert.equal(last(gladys, 'temperature-housing'), 37.8);
  assert.equal(last(gladys, 'temperature-connector-l2'), 25.4);
  assert.equal(last(gladys, 'error'), 0);
  assert.equal(last(gladys, 'error-code'), 'NO_ERROR (0)');
  assert.equal(last(gladys, 'warning'), 0);
  assert.equal(last(gladys, 'rcd-triggered'), 0);
  assert.equal(last(gladys, 'set-current'), '16');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /NRGkick S1D2 : En charge, 11040 W, 16 A réglés/);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
  assert.deepEqual(gladys.fake.publishedEnergyConsumption, [], 'the core computes it');
  assertNoSecret(ctx);
});

test('Basic auth: the header is sent; refused, the tries are spaced and kept in /data', async (t) => {
  const store = memoryStore();
  const server = fakeCharger({ auth: basic(USER, 'other') });
  const logs = [];
  const ctx = await setup(t, { server, store, logs, config: WITH_AUTH });
  const { gladys, advance } = ctx;
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].headers.Authorization, basic(USER, PASSWORD));
  assert.match(message(gladys).fr, /refusé le nom d'utilisateur ou le mot de passe/);
  assert.equal(store.data.block.mode, 'basic');
  await advance(14 * MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, 1, 'no try during the block');
  await advance(MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, 2);
  await advance(59 * MINUTE, MINUTE);
  assert.equal(server.requests.length, 2);
  await advance(2 * MINUTE, MINUTE);
  assert.equal(server.requests.length, 3);
  assertNoSecret(ctx);
});

test('Basic auth asked for and not given: said; new credentials lift the block at once', async (t) => {
  const store = memoryStore();
  const server = fakeCharger({ auth: basic(USER, PASSWORD) });
  const { gladys, app } = await setup(t, { server, store });
  assert.match(message(gladys).en, /asks for a user name and a password/);
  assert.equal(store.data.block.mode, 'none');
  await app.configUpdated(WITH_AUTH);
  await settle();
  assert.equal(store.data.block, null);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a block survives a restart', async (t) => {
  const store = memoryStore({ block: { until: NOW + HOUR, mode: 'basic', failures: 2 } });
  const server = fakeCharger();
  const { gladys } = await setup(t, { server, store, config: WITH_AUTH });
  assert.equal(server.requests.length, 0, 'never a try before the end of the block');
  assert.match(message(gladys).fr, /refusé/);
});

test('the JSON API turned off: said, read again every 5 minutes', async (t) => {
  const server = fakeCharger({ apiDisabled: true });
  const { gladys, advance } = await setup(t, { server });
  assert.match(message(gladys).fr, /API JSON de la borne est désactivée/);
  assert.equal(server.requests.length, 1);
  await advance(4 * MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, 1);
  await advance(MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, 2);
});

test('the energy index: never 0, a jump held, two clicks to accept it', async (t) => {
  const store = memoryStore();
  const logs = [];
  const { gladys, advance, charger, app } = await setup(t, { store, logs });
  assert.equal(last(gladys, 'energy-index'), 14_187);
  assert.equal(store.data.indexes[feature('energy-index')].last.value, 14_187);
  // A normal rise (2.75 kWh in 30 s would be 330 kW: too much; 0.05 kWh is fine).
  charger.values.energy.total_charged_energy = 14_187_050;
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'energy-index'), 14_187.05);
  // A glitch at 0: never published, the session energy is a plain sensor.
  charger.values.energy = { total_charged_energy: 0, charged_energy: 0 };
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'energy-index'), 14_187.05);
  assert.equal(last(gladys, 'session-energy'), 0);
  // A jump: held, the last accepted value sent again.
  charger.values.energy = { total_charged_energy: 20_000_000, charged_energy: 10 };
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'energy-index'), 14_187.05);
  assert.match(message(gladys).fr, /Index d'énergie retenu : un saut de 14187\.05 à 20000 kWh/);
  assert.equal(gladys.fake.transports.at(-1).degraded, true);
  assert.equal(store.data.indexes[feature('energy-index')].held.to, 20_000);
  assert.ok(logs.some((l) => /index jump held back/.test(l)));
  // Never confirmed by time nor repetition.
  await advance(10 * MINUTE, 30 * SECOND);
  assert.equal(last(gladys, 'energy-index'), 14_187.05);
  // A reconnection or a save never accepts it.
  await app.connected({ ...CONFIG });
  await app.configUpdated({ ...CONFIG, poll_interval: 60 });
  await advance(2 * MINUTE, 30 * SECOND);
  assert.equal(last(gladys, 'energy-index'), 14_187.05);
  // First click: listed, nothing taken.
  let ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(ack.data.message.en, /Click again within 60 s/);
  assert.match(ack.data.message.en, /5812\.95 kWh would be counted/);
  assert.equal(last(gladys, 'energy-index'), 14_187.05);
  // Second click: taken.
  ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await settle();
  assert.match(ack.data.message.fr, /Accepté : le saut de 14187\.05 à 20000 kWh/);
  assert.equal(last(gladys, 'energy-index'), 20_000);
  assert.equal(store.data.indexes[feature('energy-index')].held, null);
  ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(ack.data.message.en, /No energy index is held back/);
});

test('the acceptance: a second click too late, or on another value, lists again', async (t) => {
  const { gladys, advance, charger } = await setup(t);
  charger.values.energy.total_charged_energy = 1_000;
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'energy-index'), 14_187, 'a drop is held');
  let ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(ack.data.message.fr, /une baisse de 14187 à 1 kWh/);
  await advance(61 * SECOND, 30 * SECOND);
  ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(ack.data.message.en, /Click again/, 'too late: a first click again');
  // The value held changes far beyond what was listed: listed again.
  charger.values.energy.total_charged_energy = 9_000_000;
  await advance(30 * SECOND);
  ack = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(ack.data.message.en, /Click again/);
  assert.equal(last(gladys, 'energy-index'), 14_187);
});

test('the index guard survives a restart (kept in /data)', async (t) => {
  const store = memoryStore({
    indexes: {
      [feature('energy-index')]: {
        last: { value: 14_000, at: NOW - MINUTE },
        held: { direction: 'up', from: 14_000, to: 14_187, threshold: 14_187, at: NOW - MINUTE },
      },
    },
  });
  const { gladys } = await setup(t, { store });
  assert.equal(last(gladys, 'energy-index'), 14_000, 'still held after the restart');
});

test('a single-phase attachment: L2 and L3 kept as features, never published', async (t) => {
  const server = fakeCharger({ info: info({ connector: { phase_count: 1, max_current: 16 } }) });
  const { gladys } = await setup(t, { server });
  assert.ok(deviceOf(gladys).features.some((f) => f.external_id === feature('current-l3')));
  assert.equal(last(gladys, 'current-l1'), 16.01);
  assert.equal(last(gladys, 'current-l3'), undefined);
  assert.equal(last(gladys, 'temperature-connector-l2'), undefined);
  assert.equal(
    deviceOf(gladys).features.at(-1).supported_options.at(-1).value,
    '16',
    'the attachment caps the ceiling',
  );
});

test('statuses: no vehicle, paused, error, unknown', async (t) => {
  const { gladys, advance, charger } = await setup(t);
  const cases = [
    [1, 0, 'Aucun véhicule', CONNECTOR_STATUS.AVAILABLE, CHARGING_STATE.IDLE, 0],
    [2, 0, 'Véhicule branché, sans charge', 1, CHARGING_STATE.EV_CONNECTED, 1],
    [2, 1, 'Véhicule branché, charge en pause', 1, CHARGING_STATE.PAUSED_BY_CHARGER, 1],
    [6, 0, 'Erreur de la borne', CONNECTOR_STATUS.FAULTED, CHARGING_STATE.IDLE, 1],
  ];
  for (const [status, paused, text, connector, charging, plugged] of cases) {
    charger.values = values({ general: { status, error_code: status === 6 ? 16 : 0 } });
    charger.control = control({ charge_pause: paused });
    await advance(30 * SECOND);
    assert.equal(last(gladys, 'status'), text);
    assert.equal(last(gladys, 'connector-status'), connector, text);
    assert.equal(last(gladys, 'charging-state'), charging, text);
    assert.equal(last(gladys, 'plugged'), plugged, text);
  }
  assert.equal(last(gladys, 'error'), 1);
  assert.equal(last(gladys, 'error-code'), 'RESIDUAL_CURRENT_DETECTED (16)');
  charger.values = values({ general: { status: 99 } });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'État inconnu');
});

test('unreachable: offline states, badge, spaced new tries', async (t) => {
  const { gladys, server, advance, charger } = await setup(t);
  charger.down = true;
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Borne injoignable');
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.UNAVAILABLE);
  assert.equal(last(gladys, 'power'), 11_040, 'the last power is kept');
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.match(message(gladys).en, /No answer from 192\.168\.1\.70/);
  const before = server.requests.length;
  await advance(29 * SECOND);
  assert.equal(server.requests.length, before, 'never sooner than the interval');
  await advance(SECOND);
  assert.equal(server.requests.length, before + 1);
});

test('429: a pause on every path but the pause command, kept in /data', async (t) => {
  const server = fakeCharger();
  const store = memoryStore();
  const { gladys, app, advance, charger, press } = await setup(t, {
    server,
    store,
    config: ALLOWED,
  });
  charger.statuses['/info'] = 429;
  charger.headers = { 'retry-after': '600' };
  await advance(30 * SECOND);
  assert.equal(store.data.pause.reason, '429');
  delete charger.statuses['/info'];
  const before = server.requests.length;
  await app.connected({ ...ALLOWED });
  await advance(5 * MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, before, 'no read during the pause');
  let ack = await press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /ralentir/);
  ack = await press('resume-charge');
  assert.equal(ack.success, false);
  ack = await press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.equal(server.requests.length, before + 1, 'one request: the pause');
  assert.deepEqual(server.commands(), [{ charge_pause: '1' }]);
  assert.match(message(gladys).fr, /HTTP 429/);
});

test('a pause after a restart during a 429 pause: sent, the serial not read yet', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  first.app.stop();
  store.data.pause = { until: Date.now() + HOUR, reason: '429' };
  const server = fakeCharger();
  const gladys = first.gladys;
  const app = new NrgkickApp({
    gladys,
    transport: server.transport,
    now: () => Date.now(),
    store,
    logger: recorder([]),
  });
  t.after(() => app.stop());
  await app.connected({ ...CONFIG });
  await settle();
  assert.equal(server.requests.length, 0);
  const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
  const target = (role) => device.features.find((f) => f.external_id === feature(role));
  const pause = app.setValue(device, target('pause-charge'), 1);
  await settle();
  await pause;
  assert.deepEqual(server.commands(), [{ charge_pause: '1' }]);
  await assert.rejects(app.setValue(device, target('resume-charge'), 1), /désactivé|lue/);
});

test('5xx: a pause kept in /data, never shorter than the interval', async (t) => {
  const server = fakeCharger();
  const store = memoryStore();
  const { advance, charger } = await setup(t, { server, store });
  charger.statuses['/values'] = 503;
  await advance(30 * SECOND);
  assert.equal(store.data.pause.reason, '5xx');
  assert.ok(store.data.pause.until >= NOW + 60 * SECOND);
});

test('resume and current refused while not allowed; the pause always goes', async (t) => {
  const { server, press } = await setup(t);
  for (const [role, value] of [
    ['resume-charge', 1],
    ['set-current', '10'],
  ]) {
    const ack = await press(role, value);
    assert.equal(ack.success, false, role);
    assert.match(ack.error, /Autoriser la reprise et le courant de charge/);
  }
  assert.deepEqual(server.commands(), []);
  const ack = await press('pause-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.commands(), [{ charge_pause: '1' }]);
});

test('pause: sent without a read, never limited to one a minute, shown at once', async (t) => {
  const { server, press, gladys } = await setup(t, { config: ALLOWED });
  const before = server.requests.length;
  let ack = await press('pause-charge', 1, 500);
  assert.equal(ack.success, true, ack.error);
  assert.equal(server.requests[before].path, '/control?charge_pause=1', 'no read first');
  assert.equal(last(gladys, 'charge-paused'), 1);
  ack = await press('pause-charge', 1, 500);
  assert.equal(ack.success, true);
  assert.equal(server.commands().length, 2);
  for (const value of [0, 2, '', null, true]) {
    ack = await press('pause-charge', value, 200);
    assert.equal(ack.success, false, JSON.stringify(value));
  }
});

test('resume: refused without a vehicle or on an error; sent with one; already: nothing', async (t) => {
  const { server, press, charger, advance } = await setup(t, { config: ALLOWED });
  charger.control.charge_pause = 1;
  charger.values = values({ general: { status: 1 } });
  let ack = await press('resume-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Aucun véhicule/);
  charger.values = values({ general: { status: 6 } });
  ack = await press('resume-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Erreur de la borne/);
  charger.values = values({ general: { status: 2 } });
  ack = await press('resume-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.commands(), [{ charge_pause: '0' }]);
  assert.ok(server.paths().includes('/values?raw=1&general=1'), 'the status read just before');
  await advance(MINUTE, 10 * SECOND);
  ack = await press('resume-charge');
  assert.equal(ack.success, true);
  assert.equal(server.commands().length, 1, 'already resumed: nothing sent');
});

test('current: strict value, ceiling, one change a minute, a pause never held', async (t) => {
  const { server, press } = await setup(t, { config: ALLOWED });
  for (const value of [null, '', ' ', true, 12.5, '1e1', '33', '5']) {
    const ack = await press('set-current', value, 200);
    assert.equal(ack.success, false, JSON.stringify(value));
  }
  let ack = await press('set-current', '20');
  assert.match(ack.error, /entre 6 et 16 A/);
  ack = await press('set-current', '10');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(server.commands(), [{ current_set: '10' }]);
  ack = await press('set-current', '12');
  assert.equal(ack.success, false);
  assert.match(ack.error, /moins d'une minute/);
  ack = await press('pause-charge');
  assert.equal(ack.success, true, 'a pause is never held back by the minute');
  assert.deepEqual(server.commands(), [{ current_set: '10' }, { charge_pause: '1' }]);
});

test('a current the charger clamps: "sent, without confirmation"', async (t) => {
  const server = fakeCharger({ clamp: 8 });
  const { press } = await setup(t, { server, config: { ...ALLOWED, max_current: 32 } });
  const ack = await press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
});

test('a command refused by the charger with a Response message', async (t) => {
  const server = fakeCharger({ reject: '406 Invalid current' });
  const { press } = await setup(t, { server, config: ALLOWED });
  const ack = await press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /refusé la commande \("406 Invalid current"\)/);
});

test('a pause is never held back by a resume in flight: sent at once, then again', async (t) => {
  const { server, send, advance, charger } = await setup(t, { config: ALLOWED });
  charger.control.charge_pause = 1;
  charger.delays.command = 2_500;
  const resume = send('resume-charge');
  await advance(1_000, 100);
  charger.delays.command = 0;
  const pause = send('pause-charge');
  await advance(5 * SECOND, 100);
  assert.equal((await pause).success, true, (await pause).error);
  assert.equal((await resume).success, true);
  assert.deepEqual(server.commands(), [
    { charge_pause: '0' },
    { charge_pause: '1' },
    { charge_pause: '1' },
  ]);
  assert.equal(charger.control.charge_pause, 1, 'the pause wins');
});

test('a pause cancels a resume not sent yet', async (t) => {
  const { server, send, advance, charger } = await setup(t, { config: ALLOWED });
  charger.control.charge_pause = 1;
  charger.delays['/control'] = 800;
  const resume = send('resume-charge');
  await advance(300, 100);
  const pause = send('pause-charge');
  await advance(5 * SECOND, 100);
  assert.equal((await pause).success, true);
  assert.equal((await resume).success, false);
  assert.match((await resume).error, /pause de cette borne est arrivée/);
  assert.deepEqual(server.commands(), [{ charge_pause: '1' }]);
});

test('a resume landing late after a pause: the pause is sent again', async (t) => {
  const logs = [];
  const { server, send, advance, charger } = await setup(t, { config: ALLOWED, logs });
  charger.control.charge_pause = 1;
  // The resume: no answer (sent, without confirmation), it lands 8 s later.
  charger.commandPlan = (i) => (i === 0 ? { applyAfter: 8_000, answerAfter: 10_000 } : {});
  const resume = send('resume-charge');
  await advance(5 * SECOND, 100);
  assert.match((await resume).error, /envoyée, sans confirmation/);
  const pause = send('pause-charge');
  await advance(2 * SECOND, 100);
  assert.equal((await pause).success, true);
  // The late resume lands; the follow-up read sees the charge resumed.
  await advance(30 * SECOND, 500);
  assert.ok(logs.some((l) => /pause sent again/.test(l)));
  assert.equal(charger.control.charge_pause, 1);
  assert.ok(server.commands().filter((c) => c.charge_pause === '1').length >= 2);
});

test('a command not answered: "sent, without confirmation", then reads', async (t) => {
  const { server, press, charger } = await setup(t, { config: ALLOWED });
  charger.delays.command = 10 * SECOND;
  const before = server.requests.length;
  const ack = await press('pause-charge', 1, 30 * SECOND);
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
  const reads = server
    .paths()
    .slice(before)
    .filter((p) => p === '/control').length;
  assert.ok(reads >= 2, 'the follow-up reads');
});

test('the option turned off during the fresh read: refused, not sent', async (t) => {
  const { server, send, app, advance, charger } = await setup(t, { config: ALLOWED });
  charger.control.charge_pause = 1;
  charger.delays['/control'] = 800;
  const ack = send('resume-charge');
  await advance(300, 100);
  await app.configUpdated({ ...CONFIG, allow_commands: false });
  await advance(3 * SECOND, 100);
  assert.equal((await ack).success, false);
  assert.match((await ack).error, /Autoriser la reprise/);
  assert.deepEqual(server.commands(), []);
});

test('a read begun before a command left is quarantined', async (t) => {
  const logs = [];
  const { send, advance, charger } = await setup(t, { config: ALLOWED, logs });
  charger.delays['/values'] = 2_000;
  await advance(30 * SECOND, 100);
  // The poll is in its values read; a pause leaves meanwhile.
  const ack = send('pause-charge');
  await advance(3 * SECOND, 100);
  assert.equal((await ack).success, true);
  assert.ok(logs.some((l) => /begun before a command, not applied/.test(l)));
});

test('the reconnection to Gladys republishes the status and the devices', async (t) => {
  const { gladys, app } = await setup(t);
  const count = gladys.fake.discoveredDevices.length;
  const statuses = gladys.fake.connectionStatuses.length;
  await app.connected({ ...CONFIG });
  await settle();
  assert.ok(gladys.fake.discoveredDevices.length >= count);
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'the status sent again');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('another charger at the address: the old device is shown unreachable', async (t) => {
  const { gladys, advance, charger, press } = await setup(t, { config: ALLOWED });
  charger.info = info({ general: { serial_number: 'X9999999999999999Z9Z9' } });
  await advance(30 * SECOND);
  assert.equal(last(gladys, 'status'), 'Borne injoignable');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /Plus lue/);
  const ack = await press('pause-charge');
  assert.equal(ack.success, false);
});
