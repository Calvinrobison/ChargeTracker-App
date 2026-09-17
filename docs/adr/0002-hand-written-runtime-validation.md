# ADR-0002: Hand-written runtime validation instead of Zod

- Status: accepted
- Date: 2026-09-17

## Context

The handoff requires "Zod **or equivalent** runtime validation for IPC, imports,
and collector output".

Two constraints shaped the choice:

1. The npm registry was unreachable in the build environment (see ADR-0001), so
   Zod could not be installed, and therefore no schema written against it could
   be executed or tested here. Validation code that has never run is exactly the
   wrong thing to trust at a security boundary.
2. The correctness-critical parts of this codebase are deliberately runnable
   without a package install (`npm run test:nodeps`, using Node's built-in test
   runner, type stripping and `node:sqlite`). A dependency in the validation
   layer would pull IPC, import and collector validation out of that suite.

## Decision

Write `src/shared/validate.ts`: a ~400-line dependency-free validator with a
Zod-shaped API (`parse`, `safeParse`, `Infer`, `nullable`, `optional`,
`refine`, `withDefault`, strict-key objects).

It is exercised by 24 specs in `tests/nodeps/validate.test.ts` covering the
properties this product actually depends on:

- `null` and `undefined` stay distinct, and a missing number never becomes zero
  — the same honesty rule the metric engine enforces, applied at the boundary.
- Unknown keys are stripped by default, so a compromised renderer cannot
  smuggle fields into a worker call; `strictKeys()` rejects them outright where
  that is preferable.
- Integer schemas reject `1.5` rather than rounding.
- `instant()` range-checks UTC milliseconds, so a seconds value cannot enter
  the database and silently move history by decades.
- Prototype-pollution payloads (`__proto__`, `constructor`) are stripped.
- Errors carry the full path to the offending value.

## Consequences

- One fewer runtime dependency in a product whose whole point is local
  operation, and one less thing to keep patched.
- Validation is covered by the no-install suite, so it stays verifiable on a
  machine with no network.
- We own the maintenance. The module is intentionally small and has no
  ambitions beyond what the contracts need: no transforms, no coercion, no
  async refinement. If a future need genuinely exceeds it, swapping in Zod is a
  contained change because the call sites only use `parse`/`safeParse`.
- Reviewers should read `validate.ts` as security-relevant code.

## Alternatives considered

**Declare Zod and write untested schemas.** Rejected: unexecuted validation at
a trust boundary, and it would have broken the no-install suite.

**Skip runtime validation and rely on TypeScript.** Rejected outright. Types
are erased at runtime; IPC payloads, CSV rows and source output are untrusted
data.
