/**
 * PowerShell scripts must be pure ASCII.
 *
 * Windows PowerShell 5.1 — still the default `powershell.exe` on Windows 11 —
 * reads a `.ps1` file as ANSI (Windows-1252) unless it carries a UTF-8 BOM. A
 * UTF-8 file without a BOM therefore has every multi-byte character mangled:
 * an em dash becomes three garbage characters, and if one of those lands inside
 * a quoted string the parser loses the closing quote and the whole script fails
 * to parse.
 *
 * That is not a hypothetical. `build-all.ps1` used box-drawing characters for
 * its section rules and failed on its first real run with
 * `Unexpected token '€â"€ {0}. {1} "'` — before executing a single step.
 * `test-installed.ps1` and `test-update.ps1` carried the same characters and
 * would have failed identically.
 *
 * Adding a BOM would also work, but BOMs are easy to lose to an editor, a
 * `git` filter or a copy-paste. Requiring ASCII is a property that can be
 * checked mechanically and cannot be silently undone, so that is what is
 * enforced here.
 *
 * The same reasoning does not apply to `.mjs` or `.ts`: Node reads those as
 * UTF-8 unconditionally.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const scriptsDir = join(import.meta.dirname, '..', '..', 'scripts');

/** Every `.ps1` under scripts/, recursively. */
function powershellFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...powershellFiles(path));
    else if (entry.name.endsWith('.ps1')) found.push(path);
  }
  return found;
}

describe('PowerShell scripts survive Windows PowerShell 5.1', () => {
  const files = powershellFiles(scriptsDir);

  it('there are PowerShell scripts to check', () => {
    // Guards against this spec passing vacuously if the directory moves.
    assert.ok(files.length > 0, `no .ps1 files found under ${scriptsDir}`);
  });

  for (const file of files) {
    const name = file.slice(scriptsDir.length + 1).replace(/\\/g, '/');

    it(`${name} contains no non-ASCII bytes`, () => {
      const bytes = readFileSync(file);
      const offenders: string[] = [];

      for (let index = 0; index < bytes.length && offenders.length < 5; index += 1) {
        const byte = bytes[index] as number;
        if (byte > 127) {
          // Report the line and the character, so the fix is obvious rather
          // than a byte offset someone has to go hunting for.
          const line = bytes.subarray(0, index).toString('utf8').split('\n').length;
          const text = bytes.toString('utf8');
          const character = [...text].find((c) => c.codePointAt(0)! > 127) ?? '?';
          offenders.push(
            `line ${line}: U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} "${character}"`,
          );
          // Skip the rest of this character's bytes.
          while (index + 1 < bytes.length && ((bytes[index + 1] as number) & 0xc0) === 0x80)
            index += 1;
        }
      }

      assert.equal(
        offenders.length,
        0,
        `${name} has non-ASCII characters, which Windows PowerShell 5.1 will mangle:\n  ` +
          `${offenders.join('\n  ')}\n` +
          '  Use ASCII equivalents: "-" for an em dash, "->" for an arrow, "..." for an ellipsis.',
      );
    });

    it(`${name} has no UTF-8 BOM`, () => {
      // A BOM would make non-ASCII safe, but it also makes the ASCII rule
      // above unenforceable by inspection. Keep exactly one convention.
      const bytes = readFileSync(file);
      const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      assert.equal(
        hasBom,
        false,
        `${name} starts with a UTF-8 BOM; keep these files plain ASCII instead`,
      );
    });
  }
});
