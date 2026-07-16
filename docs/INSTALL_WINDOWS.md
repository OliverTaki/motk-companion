# Windows installation and recovery

The public beta is a user-scope package and does not require administrator
rights. Extract the ZIP completely, then double-click:

```text
INSTALL MOTK COMPANION.cmd
```

Choose the folder and camera once, then press **SAVE**. After that the Control
Center has only two large normal-use actions:

- **SHOOT** opens MOTK Shoot, transfers the local pairing key in a URL fragment,
  removes the fragment immediately, and connects automatically.
- **FILES** opens the exact local production folder.

The extracted download shows only the installer and `_internal`. The installed
application shows only `MOTK Companion.exe` and `_internal`. Storage, camera,
SIGMA SDK selection, manual pairing for another device, and Media Tools remain
behind the settings control.

It is safe to run the installer or updater while Companion is open. The package
stops only its own installed processes before the directory swap. A normal
update restarts Companion automatically; the double-click installer continues
into the Control Center and starts it after **SAVE**.

The application is installed under `%LOCALAPPDATA%\Programs\MOTK Companion`.
Mutable configuration, pairing state, job journals, logs, caches, and production
test data live separately under `%LOCALAPPDATA%\MOTK\Companion`. The first run
shows the pairing key once. Store it like a password.

The Start menu contains one normal-use entry: **MOTK Companion**. It opens the
Control Center and starts the local service when needed.

Run `_internal\scripts\diagnose.ps1` from the installed directory for a secret-free health
report. Configure a real production root, exact hosted origin, project identity,
and owner-controlled service keys in the data directory's `companion.json`.

To update, extract the new public beta and run `_internal\update.ps1`. The package is checked
against its manifest before the existing install changes. The previous install is
kept under the data directory for rollback, while configuration, pairing keys, and
jobs remain untouched.

Run installed `_internal\uninstall.ps1` to remove the application while retaining data.
Use `-RemoveData` only when permanent removal of local configuration, pairing
keys, job history, logs, caches, and test production files is intended.

The public beta is unsigned. Windows may display a publisher warning. Verify
the published SHA-256 before installation. No code-signing purchase is assumed.
