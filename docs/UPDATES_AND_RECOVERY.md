# Updates and recovery

How ChargeWatch updates itself, what it checks before installing anything, and
what to do when something goes wrong with your history file.

---

## How an update is verified

ChargeWatch checks GitHub Releases for a newer version. Before anything is
installed, the release has to pass every one of these. A failure at any point
leaves your installation and your history exactly as they were.

**The manifest signature.** Each release carries `release-manifest.json` and a
detached Ed25519 signature over the **exact bytes of that file**. It is verified
against a public key embedded in your installed copy, _before the manifest is
parsed_. An attacker who can modify the release cannot produce a valid
signature without the private key, which never leaves the maintainer's machine.

**What the manifest claims.** The application id, platform, architecture and
release channel all have to match your installation. A manifest for a different
product, or for arm64 when you are on x64, is rejected rather than tried.

**The release sequence.** Your copy records the highest sequence it has
accepted. A release at or below that is refused as a downgrade, so an old
release cannot be replayed at you — which is how a signed-but-obsolete version
with a known fault would otherwise be pushed back onto your machine.

**The schema range.** A release states which history-file schema versions it can
read and which it writes. If your history file is newer than the incoming
version can read, the update is refused. Some upgrades also name a required
intermediate version, and skipping it is refused rather than attempted.

**The installer bytes.** Size, SHA-256 and SHA-512, all checked against the
manifest after download. A truncated or substituted installer fails here.

**Where it came from.** Downloads are restricted to the configured release
source. A manifest that points somewhere else is rejected.

The same code that performs these checks is what `npm run release:verify` runs
before a release is published, against the same public keys — so a release that
would be refused on your machine is caught before it exists.

## When updates install

Never while you are in the middle of something.

Installation waits for the window to have been hidden for a while, no
maintenance operation to be running (a backup, a restore, an export, an import),
and the OS not to be shutting down or signing you out. If any of those does not
hold, the update stays ready and is offered from the tray instead: _Restart to
update to …_.

Before installing, ChargeWatch stops the collector cleanly, records a gap for
the installation period — that time genuinely was not observed — and takes a
**pre-update backup**.

You can turn off automatic checking, automatic downloading, or automatic
installation independently, in **Settings → Updates**.

## SmartScreen

The installer is not code-signed, so Windows SmartScreen may show "Windows
protected your PC" on first run. Choose **More info → Run anyway** if you trust
the source of the download.

This is separate from, and weaker than, ChargeWatch's own signature check. Code
signing certifies who built the installer to Windows; ChargeWatch's Ed25519
check certifies to your _installed copy_ that an update came from the same
maintainer as the version you already trust. The second is the one that protects
your history.

## When an update is refused

The refusal names the specific check that failed, in **Settings → Updates**.
The common ones:

| What you see                                          | What it means                                         | What to do                                   |
| ----------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| Signature could not be verified                       | The manifest was not signed by a key your copy trusts | Do not install it manually. Report it.       |
| This release is older than one already installed      | Sequence replay                                       | Nothing. You already have something newer.   |
| Your history file is newer than this version can read | You previously ran a newer version                    | Install the newer version instead            |
| An intermediate version is required first             | The upgrade path skips a data migration               | Install the named version, then update again |
| Download did not match the expected file              | Truncated or substituted download                     | Retry. If it persists, report it.            |

A refused update is a working safety mechanism. The right response is never to
bypass it.

---

## Backups

ChargeWatch keeps backups in `%LOCALAPPDATA%\ChargeWatch\backups\`.

They are made through SQLite's **online backup API**, not by copying the file.
Copying a live SQLite database while a write-ahead log is in flight produces an
archive that looks fine and is subtly corrupt. If the active driver cannot do a
proper online backup, ChargeWatch **refuses to make a backup** and says so,
rather than producing one you would only discover was bad when you needed it.

Every backup is verified after it is written and before it is presented to you.
A backup that has not been proven readable is not offered as one.

They are made:

- daily, while the app is running;
- before a schema migration;
- before an update installs;
- before a restore;
- whenever you press **Back up now** in **Settings → Data and backups**.

## Restoring

**Settings → Data and backups → Restore from backup.**

Restoring previews first: it validates the archive, reports its schema version,
observation count, site count and the time range it covers, and refuses an
archive whose schema is newer than the running version can read. Only then does
it stage and swap.

Your previous database is **preserved**, not deleted, and the restore reports
where it was kept. If the restore turns out to have been the wrong choice, the
data you had is still there.

Collection stops before the database is touched and resumes afterwards.

## If the history file will not open

ChargeWatch will tell you this on startup, with the reason, and will **not**
delete or recreate anything. Collection stops until it is resolved.

**"This history file was written by a newer version."** Install that newer
version. The file is fine; this copy is too old to read it. Downgrading and
overwriting would lose data, so it refuses.

**"ChargeWatch could not upgrade its history file."** A migration failed. The
database is left at the last successfully applied version with its data intact,
and a pre-migration backup was taken before the attempt. Restore that backup, or
send a diagnostics export.

To inspect the file yourself without the application, from a clone of the
repository:

```powershell
npm run db:probe -- --file "$env:LOCALAPPDATA\ChargeWatch\database\chargewatch.sqlite"
```

That opens it **read-only** and prints schema version, applied migrations, row
counts, the observation time range, and the result of `PRAGMA integrity_check`.
It cannot modify or migrate anything.

## Diagnostics

**Settings → Diagnostics → Export diagnostics** writes a text file containing
the version and environment, database and collection state, health checks,
settings, and the recent log.

It is redacted before it is written: tokens, cookies, authorization headers and
your home directory path are removed. It never includes your database, a browser
profile, or any credential.

Read it before you attach it to a public issue. The redaction is good, but you
are the last check.

## Where your data is, and what removes it

|         |                                                          |
| ------- | -------------------------------------------------------- |
| History | `%LOCALAPPDATA%\ChargeWatch\database\chargewatch.sqlite` |
| Backups | `%LOCALAPPDATA%\ChargeWatch\backups\`                    |
| Logs    | `%LOCALAPPDATA%\ChargeWatch\logs\`                       |

All of it lives outside the install directory, so updating or uninstalling
cannot take it with it.

**Uninstalling keeps your history.** Removing your data is a separate, explicit
action: delete the folder yourself, or use **Settings → Data and
backups → Delete observations before…** for a date range. Losing years of
collection should never be a side effect of removing a program.
