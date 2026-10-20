// -----------------------------------------------------------------------------
// Review 1 (I1, M1-M8): the reviewer's hostile scenarios H4, H4b and the
// minor points, against the real wiring, the SDK's fake Gladys and the fake
// charger. Timers and Date are mocked.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NrgkickApp } from '../src/app.js';
import { normalizeConfig } from '../src/config.js';
import { HOUR, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { ChargerError, ERROR_KINDS } from '../src/nrgkick/http.js';
import { memoryStore } from '../src/store.js';
import { HOST, NOW, SERIAL, fakeCharger, info, settle } from './fixtures/fakeNrgkick.js';

const CONFIG = { host: HOST };
const ALLOWED = { ...CONFIG, allow_commands: true };
const DEVICE = `ext:test-integration:nrgkick:${SERIAL}`;
const feature = (role) => `${DEVICE}:${role}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (body) => ({ status: 200, headers: {}, body: JSON.stringify(body) });

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map(String).join(' ')),
    ]),
  );

async function setup(
  t,
  { config = CONFIG, server = fakeCharger(), store = memoryStore(), logs = [], transport } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const make = () =>
    new NrgkickApp({
      gladys,
      logger: recorder(logs),
      transport: transport ?? server.transport,
      now: () => Date.now(),
      store,
    });
  const app = make();
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
  if (gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  const target = (role) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
    return [device, device.features.find((f) => f.external_id === feature(role))];
  };
  const send = (role, value = 1) => gladys.fake.setValue(...target(role), value);
  return { gladys, app, server, store, advance, logs, send, make, target };
}

/**
 * A transport whose commands follow `plan(index, request)` (index of the
 * command), the reads going to the fake charger.
 */
const planned = (server, plan) => {
  let index = -1;
  return async (request) => {
    const url = new URL(request.path, 'http://x');
    if (url.pathname === '/control' && url.search !== '') {
      index += 1;
      server.requests.push(request);
      return plan(index, request);
    }
    return server.transport(request);
  };
};

const paused = (server) => {
  server.charger.control.charge_pause = 1;
  return ok({ charge_pause: 1 });
};

test('H4 (I1): the pause sent again fails after a resume landing late: reaffirmed', async (t) => {
  const server = fakeCharger();
  const logs = [];
  const transport = planned(server, async (i, request) => {
    if (i === 0) {
      // The resume: lands 6 s later, never answered.
      setTimeout(() => (server.charger.control.charge_pause = 0), 6_000);
      await wait(request.timeoutMs);
      throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
    }
    if (i === 2) {
      return { status: 503, headers: {}, body: 'busy' };
    }
    return paused(server);
  });
  const ctx = await setup(t, { config: ALLOWED, server, logs, transport });
  server.charger.control.charge_pause = 1;
  const resume = ctx.send('resume-charge');
  await ctx.advance(1_000, 100);
  const pause = ctx.send('pause-charge');
  await ctx.advance(5 * SECOND, 100);
  assert.equal((await pause).success, true);
  await resume;
  await ctx.advance(2 * MINUTE, 500);
  assert.ok(logs.some((l) => /pause again failed/.test(l)));
  assert.ok(logs.some((l) => /the charge resumed after a pause, pause sent again/.test(l)));
  assert.equal(server.charger.control.charge_pause, 1, 'the charge stays paused');
});

test('H4b (I1): a resume processed after the pause, the pause sent again gets a 503', async (t) => {
  const server = fakeCharger();
  const transport = planned(server, async (i) => {
    if (i === 0) {
      await wait(2_500);
      server.charger.control.charge_pause = 0;
      return ok({ charge_pause: 0 });
    }
    if (i === 2) {
      return { status: 503, headers: {}, body: 'busy' };
    }
    return paused(server);
  });
  const ctx = await setup(t, { config: ALLOWED, server, transport });
  server.charger.control.charge_pause = 1;
  const resume = ctx.send('resume-charge');
  await ctx.advance(1_000, 100);
  const pause = ctx.send('pause-charge');
  await ctx.advance(5 * SECOND, 100);
  assert.equal((await pause).success, true);
  assert.equal((await resume).success, true);
  await ctx.advance(2 * MINUTE, 500);
  assert.equal(server.charger.control.charge_pause, 1, 'the charge stays paused');
});

test('M1: a bound missing from one /info answer never raises the ceiling', async (t) => {
  const server = fakeCharger({
    info: info({ general: { rated_current: 16 }, connector: { max_current: 10 } }),
  });
  const ctx = await setup(t, { config: { ...ALLOWED, max_current: 32 }, server });
  assert.equal(ctx.app.ceiling, 10);
  delete server.charger.info.general.rated_current;
  delete server.charger.info.connector.max_current;
  await ctx.advance(30 * SECOND);
  assert.equal(ctx.app.ceiling, 10);
  const ack = ctx.send('set-current', '20');
  await ctx.advance(5 * SECOND, 100);
  assert.match((await ack).error, /entre 6 et 10 A/);
});

test('M2: a restart never resets the minute between two changes', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  let ack = ctx.send('set-current', '10');
  await ctx.advance(2 * SECOND, 100);
  assert.equal((await ack).success, true);
  await ctx.app.configUpdated({ ...ALLOWED, username: 'admin', password: 'pw' });
  await ctx.advance(5 * SECOND, 100);
  ack = ctx.send('set-current', '12');
  await ctx.advance(2 * SECOND, 100);
  assert.match((await ack).error, /moins d'une minute/);
  assert.deepEqual(ctx.server.commands(), [{ current_set: '10' }]);
});

test('M3: before the first read, a pause goes only to the last charger read here', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  assert.equal(store.data.serial, SERIAL);
  ctx.app.stop();
  store.data.pause = { until: Date.now() + HOUR, reason: '429' };
  store.data.serial = 'x9999999999999999z9z9';
  const app = ctx.make();
  t.after(() => app.stop());
  await app.connected({ ...CONFIG });
  await settle();
  await assert.rejects(app.setValue(...ctx.target('pause-charge'), 1), /pas lue/);
  assert.deepEqual(ctx.server.commands(), []);
});

test('M4: after a restart during a block, the device is offline, never "not read any more"', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  ctx.app.stop();
  store.data.block = { until: Date.now() + HOUR, mode: 'none', failures: 1 };
  const app = ctx.make();
  t.after(() => app.stop());
  await app.connected({ ...CONFIG });
  await settle();
  const status = ctx.gladys.fake.connectionStatus;
  assert.equal(status.connected, false);
  assert.doesNotMatch(status.message.fr, /Plus lue/);
  assert.equal(ctx.gladys.fake.lastState(feature('status')), 'Borne injoignable');
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
});

test('M4: after a restart during a 429 pause, the device is offline too', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  assert.equal(ctx.gladys.fake.lastState(feature('status')), 'En charge');
  ctx.app.stop();
  store.data.pause = { until: Date.now() + HOUR, reason: '429' };
  const app = ctx.make();
  t.after(() => app.stop());
  await app.connected({ ...CONFIG });
  await settle();
  assert.equal(ctx.gladys.fake.lastState(feature('status')), 'Borne injoignable');
});

test('M5: a pause pressed while the first one waits to be sent again goes itself', async (t) => {
  const server = fakeCharger();
  const transport = planned(server, async (i) => {
    if (i === 0) {
      await wait(3_000);
      server.charger.control.charge_pause = 0;
      return ok({ charge_pause: 0 });
    }
    return paused(server);
  });
  const ctx = await setup(t, { config: ALLOWED, server, transport });
  server.charger.control.charge_pause = 1;
  const resume = ctx.send('resume-charge');
  await ctx.advance(500, 100);
  const first = ctx.send('pause-charge');
  await ctx.advance(1_000, 100);
  assert.equal((await first).success, true);
  const second = ctx.send('pause-charge');
  await ctx.advance(5 * SECOND, 100);
  assert.equal((await second).success, true);
  await resume;
  const pauses = server.commands().filter((c) => c.charge_pause === '1').length;
  assert.ok(pauses >= 3, `the second pause was sent (${pauses} pauses)`);
});

test('M6: during a 5xx pause, the refusal says "server error", not "slow down"', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  ctx.server.charger.statuses['/values'] = 503;
  await ctx.advance(30 * SECOND);
  const ack = ctx.send('set-current', '10');
  await ctx.advance(2 * SECOND, 100);
  assert.match((await ack).error, /erreur serveur/);
  assert.doesNotMatch((await ack).error, /ralentir/);
});

test('M8: credentials pasted in the address are ignored and never shown back', () => {
  const c = normalizeConfig({ host: 'http://admin:correct horse@192.168.1.70' });
  assert.deepEqual(c.address, { host: '192.168.1.70', port: 80 });
  const bad = normalizeConfig({ host: 'http://admin:s3cr/et@not an address' });
  assert.equal(bad.address, undefined);
  assert.ok(!bad.invalidHost.includes('s3cr'), bad.invalidHost);
});
