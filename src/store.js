// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the end of a pause (429, or a 5xx), the block after refused
// credentials, so a restart never asks the charger again before its time and
// never loops on a refused login, and the guard of the energy index (its
// reference and a value held back, src/guard.js). Bounded when read back: a
// pause never more than 6 h away, a block never more than the longest new-try
// delay. NO SECRET: neither the user name, nor the password, nor anything
// derived from them; the block only keeps whether credentials were given.
// The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/nrgkick-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const longestBlock = TIMINGS.authBackoff.at(-1);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const FEATURE_ID = /^[a-z0-9:_-]{1,200}$/;

const pointOf = (p) =>
  plain(p) && Number.isFinite(p.value) && p.value > 0 && Number.isFinite(p.at)
    ? { value: p.value, at: p.at }
    : null;

const heldOf = (h) =>
  plain(h) &&
  (h.direction === 'up' || h.direction === 'down') &&
  [h.from, h.to, h.threshold, h.at].every(Number.isFinite)
    ? { direction: h.direction, from: h.from, to: h.to, threshold: h.threshold, at: h.at }
    : null;

/** The guards of the index features: `{ [featureId]: { last, held } }`, bounded. */
function indexesOf(raw) {
  const indexes = {};
  if (!plain(raw)) {
    return indexes;
  }
  for (const [id, state] of Object.entries(raw).slice(0, LIMITS.indexStates)) {
    if (FEATURE_ID.test(id) && plain(state)) {
      indexes[id] = { last: pointOf(state.last), held: heldOf(state.held) };
    }
  }
  return indexes;
}

/**
 * The persisted state, repaired and bounded:
 * `{ pause: { until, reason } | null, block: { until, mode, failures } | null,
 *    indexes: { [featureId]: { last, held } } }`.
 */
export function normalizeMemory(raw, now) {
  const data = plain(raw) ? raw : {};
  const pause = plain(data.pause) ? data.pause : {};
  const block = plain(data.block) ? data.block : {};
  const failures = Number.isInteger(block.failures) && block.failures > 0 ? block.failures : 1;
  return {
    pause:
      Number.isFinite(pause.until) && pause.until > now
        ? {
            until: Math.min(pause.until, now + TIMINGS.rateLimitMax),
            reason: pause.reason === '5xx' ? '5xx' : '429',
          }
        : null,
    block:
      Number.isFinite(block.until) && (block.mode === 'basic' || block.mode === 'none')
        ? {
            // An expired block is kept (its count spaces the next tries) but no longer waits.
            until: Math.min(block.until, now + longestBlock),
            mode: block.mode,
            failures: Math.min(failures, 100),
          }
        : null,
    indexes: indexesOf(data.indexes),
  };
}
