# Dragonwilds Server Control

Windows 11 desktop app for deploying, controlling, configuring, and backing up a RuneScape: Dragonwilds dedicated server.

This app is based on the existing batch-file workflow:

- SteamCMD app ID: `4019830`
- SteamCMD folder: `C:\SteamCMD`
- Server install folder: `C:\GameServers\RSDragonwildsDedicatedServer`
- Dedicated executable: `RSDragonwildsServer.exe`
- Config path: `RSDragonwilds\Saved\Config\WindowsServer\DedicatedServer.ini`
- Save path: `RSDragonwilds\Saved\Savegames`
- Log path: `RSDragonwilds\Saved\Logs\RSDragonwilds.log`
- Default Game Port: `7777`

## Build The Windows Installer

```powershell
npm install
npm run dist:exe
```

The generated setup `.exe` will be in `dist\`. Copy it to the Windows 11 server, install it, then open `Dragonwilds Server Control` from the desktop or Start Menu.

The packaged app asks Windows for Administrator elevation when it opens. This is intentional so it can create and manage the default `C:\SteamCMD` and `C:\GameServers` paths.

On a fresh machine, run the initial server install first. After server files are detected, enter the mandatory Dragonwilds dedicated server values before starting:

- Owner ID: your RuneScape: Dragonwilds Player ID from the in-game Settings menu
- Server Name
- Default World Name
- Admin Password
- Optional World Password
- Game Port, which defaults to `7777`

The app patches those values into the official `RSDragonwilds\Saved\Config\WindowsServer\DedicatedServer.ini` file. If the Windows file is missing, it first copies the installed official Linux template from `RSDragonwilds\Saved\Config\Linux\DedicatedServer.ini` and then patches the `/Script/Dominion.DedicatedServerSettings` section.

Dragonwilds also uses the next port as its Secondary Port. If the Game Port is `7777`, the Secondary Port is `7778`. The app launches the server with `-port=<Game Port>` and shows both values so you can forward UDP for both ports in Windows Firewall, your router, and any host/ISP firewall.

For MSI packaging:

```powershell
npm run dist:msi
```

The setup `.exe` is recommended for a personal Windows 11 server because it is the least fussy path.

## Run Locally For Development

```powershell
npm start
```

The dashboard opens at `http://127.0.0.1:8787`.

To run the desktop shell during development:

```powershell
npm run desktop
```

## Windows Server Desktop Launch

The installer path above is recommended. The batch launcher remains available for development or emergency fallback:

1. Copy this repo folder to the Windows 11 server.
2. Install Node.js 20 or newer on that server.
3. Double-click `Start-DragonwildsControl.bat`.
4. Optional: create a desktop shortcut:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-desktop-shortcut.ps1
```

## DedicatedServer.ini Configuration

The app writes a local JSON profile and updates `DedicatedServer.ini` only after the server files are installed and the required official values are present. The Game Port is entered during setup and defaults to `7777`; the app passes it to Dragonwilds as `-port=<Game Port>` and derives Secondary Port as `Game Port + 1`.

Dragonwilds requires the Windows dedicated server config at `RSDragonwilds\Saved\Config\WindowsServer\DedicatedServer.ini`. The app does not generate this file from scratch. It patches an existing Windows config, or copies the installed official Linux template from `RSDragonwilds\Saved\Config\Linux\DedicatedServer.ini` into `WindowsServer` before patching `OwnerId`, `ServerName`, `DefaultWorldName`, `AdminPassword`, and optional `WorldPassword`. Stop the server before changing these values because Dragonwilds documentation warns that changes made while the server is running can be lost.

The dashboard shows the current raw `DedicatedServer.ini` contents in a read-only viewer. The unfinished Settings page is intentionally hidden until the editing workflow is ready. If an existing `DedicatedServer.ini` is already present, the app reads those official values back into the profile so existing installs can be managed without retyping everything.

## Console And Logs

The external command window is the primary place to watch live install/update/repair output. The Console tab shows task status, server log lines, and retained control activity, while the dashboard only shows a compact console summary so the main screen does not become a cramped terminal.

Long-running tasks open a visible Windows command window for their live stdout/stderr. If SteamCMD or PowerShell needs direct attention, use the external command window; the in-app Console remains useful for task status, retained control activity, and game log history.

On Windows, install, update, repair, backup, restore, and stop tasks launch in a real external `cmd.exe` window. The window pauses when the task finishes so you can read the final SteamCMD or PowerShell result before closing it. While that window is open, use it for live output and any command input.

The control app prunes its own activity log to the most recent 72 hours. Game server log files are read through the same recent-log view but are not deleted by the app.

## Backups

Backups use PowerShell `Compress-Archive` against the configured save folder. Restore moves the current save folder to a timestamped safety copy before extracting the selected backup.

Stop the dedicated server before restoring a backup.

## Deployment Options

See [docs/deployment-options.md](docs/deployment-options.md).

## App Updates

See [docs/app-update-options.md](docs/app-update-options.md). The packaged app checks GitHub Releases for updates on launch. Push a `v*` version tag to trigger the release workflow.

## Validation

```powershell
npm test
```

The smoke test starts the local dashboard on a test port, verifies the API, saves a test Game Port and required dedicated-server setup values, confirms the effective launch args include the selected `-port`, confirms `DedicatedServer.ini` is not fabricated without an official template, confirms the installed template is copied and patched, and confirms the dashboard HTML loads.
