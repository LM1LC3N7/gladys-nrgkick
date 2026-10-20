// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The user name
// and the password of the optional Basic auth are kept here in memory only:
// never logged, never written to /data, never put in a status or an error.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { CURRENT, DEFAULT_PORT, LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  username: '',
  password: '',
  allow_commands: false,
  max_current: CURRENT.defaultCeiling,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of the charger typed by the user: an IPv4 address or a host
 * name, with an optional port (a pasted URL is reduced to its host and port).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A user name or a password typed in the form: printable ASCII, else ''. */
function secret(value, { colon = true } = {}) {
  if (typeof value !== 'string') {
    return '';
  }
  const text = value.trim();
  if (text.length < LIMITS.secretMin || text.length > LIMITS.secretMax) {
    return '';
  }
  if (!colon && text.includes(':')) {
    // Basic auth joins them with ':': a user name never holds one.
    return '';
  }
  return /^[\x20-\x7e]+$/.test(text) ? text : '';
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = String(c.host ?? '').trim();
  const address = parseAddress(typed);
  const username = secret(c.username, { colon: false });
  const password = secret(c.password);
  const typedUser = typeof c.username === 'string' && c.username.trim() !== '';
  const typedPassword = typeof c.password === 'string' && c.password.trim() !== '';
  const interval = Number(c.poll_interval);
  const ceiling = Number(c.max_current);
  return {
    address,
    /** The text typed when it is not an address (shown in the status, cut). */
    invalidHost: typed !== '' && !address ? typed.slice(0, 100) : undefined,
    /** Basic auth: only with both (nrgkick-api sends it only then). */
    auth: username && password ? { username, password } : undefined,
    /** A user name or a password typed but refused, or one of the two missing. */
    badSecret:
      (typedUser && !username) ||
      (typedPassword && !password) ||
      (Boolean(username) !== Boolean(password) && (typedUser || typedPassword)),
    allowCommands: strictTrue(c.allow_commands),
    maxCurrent:
      Number.isFinite(ceiling) && String(c.max_current).trim() !== ''
        ? Math.min(CURRENT.max, Math.max(CURRENT.min, Math.floor(ceiling)))
        : CURRENT.defaultCeiling,
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What identifies the credentials, to tell a change (never stored, never logged). */
export const credentialsKey = (config) =>
  config.auth ? `basic:${config.auth.username}:${config.auth.password}` : 'none';

/** The kind of credentials, for the block kept in /data (never the secret). */
export const authMode = (config) => (config.auth ? 'basic' : 'none');
