/**
 * How the collector identifies itself to the sites it reads.
 *
 * The first live run on 2026-09-21 collected nothing: every read timed out and
 * the circuit breaker opened. The cause was the way we introduced ourselves.
 * `X-Requested-With: ChargeWatch/<version>` was set on the browser CONTEXT, so
 * Chromium attached it to every cross-origin request the page itself made, not
 * only to ours. `X-Requested-With` is not a CORS-safelisted request header, so
 * each of those requests needed a preflight the provider does not answer --
 * including the one for the file defining the status pills. The page rendered
 * "Unable to load page" and there was no status to read. With the header
 * removed the same headless browser renders port rows.
 *
 * The identifier now rides on the User-Agent, which is safelisted and which
 * the page sends anyway. These specs hold two things: that the suffix is added
 * without erasing what the browser says about itself, and that no request
 * header is set context-wide again.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { identifyingUserAgent } from '../../src/collector/browser.ts';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36';

describe('the collector says who it is without hiding what it is', () => {
  it('appends the identifier to the browser own user agent', () => {
    const ua = identifyingUserAgent(CHROME_UA, 'ChargeWatch/0.3.0');
    assert.equal(ua, `${CHROME_UA} ChargeWatch/0.3.0`);
  });

  it('leaves the browser own identity intact, HeadlessChrome included', () => {
    const ua = identifyingUserAgent(CHROME_UA, 'ChargeWatch/0.3.0');
    assert.ok(ua !== null);
    assert.ok(
      ua.startsWith(CHROME_UA),
      'the browser statement about itself is added to, never rewritten',
    );
    assert.ok(
      ua.includes('HeadlessChrome'),
      'an automated client is not disguised as an ordinary one',
    );
  });

  it('is idempotent, so a restart does not stack identifiers', () => {
    const once = identifyingUserAgent(CHROME_UA, 'ChargeWatch/0.3.0');
    const twice = identifyingUserAgent(once, 'ChargeWatch/0.3.0');
    assert.equal(twice, once);
  });

  it('returns null rather than a half-formed user agent', () => {
    // Nothing to append to: the context then uses the browser default, which
    // is correct behaviour minus the identifier.
    assert.equal(identifyingUserAgent(null, 'ChargeWatch/0.3.0'), null);
    assert.equal(identifyingUserAgent(undefined, 'ChargeWatch/0.3.0'), null);
    assert.equal(identifyingUserAgent('   ', 'ChargeWatch/0.3.0'), null);
    // Nothing to say: a bare browser user agent is not worth overriding.
    assert.equal(identifyingUserAgent(CHROME_UA, ''), null);
    assert.equal(identifyingUserAgent(CHROME_UA, '  '), null);
  });

  it('trims so the suffix joins with exactly one space', () => {
    assert.equal(
      identifyingUserAgent(`${CHROME_UA}  `, '  ChargeWatch/0.3.0 '),
      `${CHROME_UA} ChargeWatch/0.3.0`,
    );
  });
});

describe('no request header is set on the browser context', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/collector/browser.ts', import.meta.url)),
    'utf8',
  );

  it('does not call extraHTTPHeaders', () => {
    // A header set here applies to the page own cross-origin requests too.
    // That is what broke collection on 2026-09-21; the comment in the source
    // explains it, and this keeps it from being reintroduced.
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*'))
      .join('\n');
    assert.ok(
      !code.includes('extraHTTPHeaders'),
      'context-wide request headers force preflights on requests that are not ours',
    );
  });

  it('passes the resolved user agent when creating a context', () => {
    assert.match(source, /userAgent: this\.userAgent \?\? undefined/);
  });
});
