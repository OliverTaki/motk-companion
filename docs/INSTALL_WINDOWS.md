# Windows installation and recovery

The public beta is a user-scope package and does not require administrator
rights. Extract the ZIP completely, inspect `RELEASE.json`, verify the published
ZIP SHA-256, then double-click:

```text
INSTALL MOTK COMPANION.cmd
```

The installer opens **MOTK Companion Setup**. Choose the local media folder and
camera method, then press **Save & Start**. Open **MOTK Companion - Copy Pairing
Key** from the Windows Start menu and paste the key into **MOTK Shoot → Settings
→ Camera → Tether**. The setup also opens the official MOTK Shoot page.

The application is installed under `%LOCALAPPDATA%\Programs\MOTK Companion`.
Mutable configuration, pairing state, job journals, logs, caches, and production
test data live separately under `%LOCALAPPDATA%\MOTK\Companion`. The first run
shows the pairing key once. Store it like a password.

Use the Start menu instead of opening scripts manually:

- **MOTK Companion** — start the local service and keep its window open.
- **MOTK Companion - Setup** — choose the local media folder and camera method.
- **MOTK Companion - Copy Pairing Key** — copy the private key for MOTK Shoot.
- **MOTK Companion - Open Local Media** — open the exact selected media folder.

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
