# Windows installation and recovery

The public beta is a user-scope package and does not require administrator
rights. Extract the ZIP completely, inspect `RELEASE.json`, verify the published
ZIP SHA-256, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The application is installed under `%LOCALAPPDATA%\Programs\MOTK Companion`.
Mutable configuration, pairing state, job journals, logs, caches, and production
test data live separately under `%LOCALAPPDATA%\MOTK\Companion`. The first run
shows the pairing key once. Store it like a password.

Run `scripts\diagnose.ps1` from the installed directory for a secret-free health
report. Configure a real production root, exact hosted origin, project identity,
and owner-controlled service keys in the data directory's `companion.json`.

To update, extract the new public beta and run `update.ps1`. The package is checked
against its manifest before the existing install changes. The previous install is
kept under the data directory for rollback, while configuration, pairing keys, and
jobs remain untouched.

Run installed `uninstall.ps1` to remove the application while retaining data.
Use `-RemoveData` only when permanent removal of local configuration, pairing
keys, job history, logs, caches, and test production files is intended.

The public beta is unsigned. Windows may display a publisher warning. Verify
the published SHA-256 before installation. No code-signing purchase is assumed.
