/**
 * Lets the dependency-free specs run under Vitest as well as under Node.
 *
 * The specs in tests/nodeps import `describe`, `it`, `test` and `after` from
 * `node:test`, because they must run on a machine with nothing installed —
 * that is the whole point of `npm run test:nodeps`. Vitest cannot collect a
 * `node:test` suite: those registrations go to Node's runner, Vitest sees a
 * file that declared nothing, and reports "No test suite found".
 *
 * vitest.config.ts therefore aliases `node:test` to this module, so the same
 * spec files register against whichever runner is executing them. Nothing in
 * tests/nodeps changes, and neither runner learns about the other.
 *
 * Only the four names the specs actually import are re-exported. Anything else
 * from `node:test` — `mock`, the `TestContext` argument, `run` — is absent on
 * purpose: a spec that reaches for one would fail here loudly rather than
 * behave differently under the two runners, which is the failure this file
 * exists to prevent.
 *
 * `after` maps to `afterAll` rather than `afterEach`: Node's top-level `after`
 * runs once when the file is done, which is what `afterAll` means in Vitest.
 */

import { afterAll, describe, it, test } from 'vitest';

export { describe, it, test };
export { afterAll as after };
