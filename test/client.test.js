import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  NrgkickClient,
  basicAuth,
  parseControl,
  parseInfo,
  parseStatus,
  parseValues,
  pathOf,
  retryAfterOf,
  serialOf,
  stateOf,
} from '../src/nrgkick/client.js';
import { ERROR_KINDS, request } from '../src/nrgkick/http.js';
import { normalizeMemory } from '../src/store.js';
import { info, values } from './fixtures/fakeNrgkick.js';

const ADDRESS = { host: 'h', port: 80 };
const replying = (status, body, seen = []) => ({
  transport: async (req) => {
    seen.push(req);
    return { status, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) };
  },
});

test('values: Wh to kWh, per phase, codes, temperatures', () => {
  const v = parseValues(values());
  assert.equal(v.totalEnergy, 14_187);
  assert.equal(v.sessionEnergy, 5.23);
  assert.equal(v.power, 11_040);
  assert.deepEqual(v.currents, [16.01, 15.98, 16.03]);
  assert.equal(v.state, 'charging');
  assert.equal(v.temperatures.connectors[2], 27.91);
  const empty = parseValues({});
  assert.deepEqual(empty.voltages, [undefined, undefined, undefined]);
  assert.equal(empty.totalEnergy, undefined);
  assert.equal(empty.state, 'unknown');
});

test('statuses, raw or as names', () => {
  assert.equal(stateOf(2), 'connected');
  assert.equal(stateOf('CHARGING'), 'charging');
  assert.equal(stateOf(5), 'unknown');
  assert.equal(stateOf('toString'), 'unknown');
  assert.equal(parseStatus({ general: { status: 7 } }).state, 'wakeup');
});

test('info: serial, ratings, attachment', () => {
  const i = parseInfo(info());
  assert.equal(i.serial, 't2332500000000000s1d2');
  assert.equal(i.ratedCurrent, 32);
  assert.equal(i.attachmentMax, 32);
  assert.equal(i.phases, 3);
  assert.equal(i.firmware, '4.1.2.0');
  assert.equal(serialOf('../etc'), undefined);
  assert.equal(serialOf('a:b'), undefined);
  assert.equal(parseInfo({ general: { rated_current: 5 } }).ratedCurrent, undefined);
});

test('hostile answers: wrong types are undefined, never a default', () => {
  const c = parseControl({ current_set: '16', charge_pause: 'yes', energy_limit: -1 });
  assert.equal(c.currentSet, undefined);
  assert.equal(c.paused, undefined);
  assert.equal(c.energyLimit, undefined);
  assert.equal(parseControl({ charge_pause: true }).paused, true);
  const polluted = parseInfo(JSON.parse('{"__proto__": {"general": {"serial_number": "x1234"}}}'));
  assert.equal(polluted.serial, undefined);
  assert.equal({}.general, undefined, 'no prototype polluted');
  const v = parseValues({ energy: { total_charged_energy: -5 }, general: { warning_code: 1.5 } });
  assert.equal(v.totalEnergy, undefined);
  assert.equal(v.warning, undefined);
  for (const bad of [null, [], 'text', 12]) {
    assert.throws(
      () => parseValues(bad),
      (err) => err.kind === ERROR_KINDS.PROTOCOL,
    );
  }
});

test('query strings and the Basic auth header (latin1, as nrgkick-api)', () => {
  assert.equal(pathOf('/control', { charge_pause: '1' }), '/control?charge_pause=1');
  assert.equal(pathOf('/control'), '/control');
  assert.equal(basicAuth({ username: 'admin', password: 'pw' }), 'Basic YWRtaW46cHc=');
});

test('Retry-After in seconds or as a date', () => {
  assert.equal(retryAfterOf('120'), 120_000);
  assert.equal(retryAfterOf(new Date(10_000).toUTCString(), 0), 10_000);
  assert.equal(retryAfterOf('soon'), undefined);
});

test('statuses: 401/403 auth, 429 rate limited, others http; the body never kept', async () => {
  for (const [status, kind] of [
    [401, ERROR_KINDS.AUTH],
    [403, ERROR_KINDS.AUTH],
    [429, ERROR_KINDS.RATE_LIMITED],
    [500, ERROR_KINDS.HTTP],
  ]) {
    const client = new NrgkickClient(replying(status, 'secret-echo'));
    await assert.rejects(
      client.values(ADDRESS, undefined, { timeoutMs: 100 }),
      (err) => err.kind === kind && !err.message.includes('secret-echo'),
    );
  }
  const off = new NrgkickClient(
    replying(200, { Response: 'API must be enabled within the NRGkick App' }),
  );
  await assert.rejects(
    off.info(ADDRESS, undefined, { timeoutMs: 100 }),
    (err) => err.kind === ERROR_KINDS.API_DISABLED,
  );
});

test('commands: the echo checked, a Response is a refusal, a bad value never sent', async () => {
  const seen = [];
  let client = new NrgkickClient(replying(200, { current_set: 10.05 }, seen));
  assert.equal(
    await client.command(ADDRESS, undefined, 'current_set', 10, {
      startBy: Infinity,
      timeoutMs: 100,
    }),
    10.05,
  );
  assert.equal(seen[0].path, '/control?current_set=10');
  client = new NrgkickClient(replying(200, { current_set: 8 }));
  await assert.rejects(
    client.command(ADDRESS, undefined, 'current_set', 10, { startBy: Infinity, timeoutMs: 100 }),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  client = new NrgkickClient(replying(400, { Response: '406 Invalid current' }));
  await assert.rejects(
    client.command(ADDRESS, undefined, 'current_set', 10, { startBy: Infinity, timeoutMs: 100 }),
    (err) => err.kind === ERROR_KINDS.REJECTED && err.reason === '406 Invalid current',
  );
  client = new NrgkickClient(replying(200, { Response: 'Busy' }));
  await assert.rejects(
    client.command(ADDRESS, undefined, 'charge_pause', 1, { startBy: Infinity, timeoutMs: 100 }),
    (err) => err.kind === ERROR_KINDS.REJECTED,
  );
  const calls = [];
  client = new NrgkickClient({ ...replying(200, {}, calls), now: () => 1_000 });
  for (const [key, value] of [
    ['current_set', 5],
    ['current_set', 6.5],
    ['charge_pause', 2],
    ['energy_limit', 0],
  ]) {
    await assert.rejects(
      client.command(ADDRESS, undefined, key, value, { startBy: 2_000, timeoutMs: 100 }),
      (err) => err.notSent,
    );
  }
  await assert.rejects(
    client.command(ADDRESS, undefined, 'charge_pause', 1, { startBy: 999, timeoutMs: 100 }),
    (err) => err.kind === ERROR_KINDS.LATE,
  );
  assert.equal(calls.length, 0);
});

test('the real transport against a loopback server: headers, size bound', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/values?raw=1') {
      res.end('x'.repeat(70 * 1024));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ current_set: 6, charge_pause: 0 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = { host: '127.0.0.1', port: server.address().port };
  const client = new NrgkickClient({ transport: request });
  const auth = { username: 'u', password: 'p' };
  const data = await client.control(address, auth, { timeoutMs: 2000 });
  assert.equal(data.current_set, 6);
  assert.equal(seen[0].authorization, 'Basic dTpw');
  await assert.rejects(
    client.values(address, undefined, { timeoutMs: 2000 }),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  server.close();
  await assert.rejects(
    request({ ...address, path: '/', timeoutMs: 500 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
});

test('the memory in /data is repaired and bounded, and holds no secret', () => {
  const now = 1_000_000;
  const memory = normalizeMemory(
    {
      pause: { until: now + 999 * 3_600_000, reason: 'x' },
      block: { until: now + 999 * 3_600_000, mode: 'basic', failures: 3, password: 'leak' },
      indexes: {
        'ext:a:nrgkick:abcd:energy-index': {
          last: { value: 10, at: 5 },
          held: { direction: 'sideways' },
          extra: 'leak',
        },
        'bad id with spaces': { last: { value: 1, at: 1 } },
      },
    },
    now,
  );
  assert.equal(memory.pause.until, now + 6 * 3_600_000);
  assert.equal(memory.pause.reason, '429');
  assert.equal(memory.block.until, now + 6 * 3_600_000);
  assert.deepEqual(Object.keys(memory.indexes), ['ext:a:nrgkick:abcd:energy-index']);
  assert.equal(memory.indexes['ext:a:nrgkick:abcd:energy-index'].held, null);
  assert.ok(!JSON.stringify(memory).includes('leak'));
  assert.deepEqual(normalizeMemory('garbage', now), { pause: null, block: null, indexes: {} });
});
