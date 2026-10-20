import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialsKey, normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4, host names, ports, pasted URLs', () => {
  assert.deepEqual(parseAddress('192.168.1.70'), { host: '192.168.1.70', port: 80 });
  assert.deepEqual(parseAddress('http://NRGkick.local:8080/info'), {
    host: 'nrgkick.local',
    port: 8080,
  });
  for (const bad of ['', '999.1.1.1', 'a b', 'host:0', 'host:70000', '-bad.local']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('the defaults: no command allowed, 16 A, 30 s, French', () => {
  const c = normalizeConfig({ host: '10.0.0.2' });
  assert.equal(c.allowCommands, false);
  assert.equal(c.maxCurrent, 16);
  assert.equal(c.pollInterval, 30);
  assert.equal(c.language, 'fr');
  assert.equal(c.auth, undefined);
  assert.equal(c.badSecret, false);
});

test('only true allows; bounds are applied', () => {
  for (const value of ['yes', 1, 'TRUE', null, undefined]) {
    assert.equal(normalizeConfig({ allow_commands: value }).allowCommands, false, String(value));
  }
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
  assert.equal(normalizeConfig({ max_current: 99 }).maxCurrent, 32);
  assert.equal(normalizeConfig({ max_current: 2 }).maxCurrent, 6);
  assert.equal(normalizeConfig({ max_current: '' }).maxCurrent, 16);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, 30);
});

test('Basic auth: both or neither; never a colon in the user name; never in the key', () => {
  const both = normalizeConfig({ username: 'admin', password: 'pw' });
  assert.deepEqual(both.auth, { username: 'admin', password: 'pw' });
  assert.equal(normalizeConfig({ username: 'admin' }).badSecret, true);
  assert.equal(normalizeConfig({ password: 'pw' }).badSecret, true);
  assert.equal(normalizeConfig({ username: 'a:b', password: 'pw' }).badSecret, true);
  assert.equal(normalizeConfig({ username: 'admin', password: 'pé' }).badSecret, true);
  assert.equal(normalizeConfig({ username: '', password: '' }).badSecret, false);
  assert.notEqual(credentialsKey(both), credentialsKey(normalizeConfig({})));
  assert.equal(normalizeConfig({ __proto__: { allow_commands: true } }).allowCommands, false);
});
