# Update verification keys

This directory holds **public** Ed25519 verification keys only, embedded in the
application so an installed copy can check that an update really came from this
project before it can be installed.

`keys.json` is currently **empty**, which is deliberate rather than an
oversight. No key pair has been generated, because generating one is a
maintainer action that must happen on a machine where the private key can be
stored safely — and because no release exists to sign yet.

## Consequences of the empty keyring

- The application logs a warning at startup and **does not offer updates at
  all**. It does not fall back to installing an unverified binary.
- `npm run verify:package` **fails**, so a package cannot be released in this
  state.

Both are the intended behaviour. An update path that cannot verify its input is
worse than no update path.

## Creating the key pair (once, ever)

```powershell
npm run keys:bootstrap -- --key-id cw-2026-09
```

That writes the private key to `%USERPROFILE%\.chargewatch-release-keys\`,
outside this repository, and installs only the public key here. Commit the
resulting `keys.json`.

**Never** commit a private key, paste one into a terminal or a chat, or
generate a new pair per release: installed copies verify against the key they
shipped with, so a fresh key per release would make every update unverifiable.

Rotation has an ordering requirement — the new public key must ship in a
release signed by the _current_ key before the new key is used to sign
anything. `docs/UPDATES_AND_RECOVERY.md` has the procedure.
