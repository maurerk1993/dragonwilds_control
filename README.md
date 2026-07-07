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
- Default server port: `7777`

## Build The Windows Installer

```powershell
npm install
npm run dist:exe
```

The generated setup `.exe` will be in `dist\`. Copy it to the Windows 11 server, install it, then open `Dragonwilds Server Control` from the desktop or Start Menu.

The packaged app asks Windows for Administrator elevation when it opens. This is intentional so it can create and manage the default `C:\SteamCMD` and `C:\GameServers` paths.

On first setup, enter the mandatory Dragonwilds dedicated server values before running the install/start actions:

- Owner ID: your RuneScape: Dragonwilds Player ID from the in-game Settings menu
- Server Name
- Default World Name
- Admin Password
- Optional World Password

The app writes those values to `RSDragonwilds\Saved\Config\WindowsServer\DedicatedServer.ini` using the official `/Script/Dominion.DedicatedServerSettings` section.

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

## Settings

The app writes a local JSON profile and updates `DedicatedServer.ini` when the required official values are present. The server port is editable in the UI and defaults to `7777`.

Dragonwilds requires the Windows dedicated server config at `RSDragonwilds\Saved\Config\WindowsServer\DedicatedServer.ini`. The app generates that file with `OwnerId`, `ServerName`, `DefaultWorldName`, `AdminPassword`, and optional `WorldPassword`. Stop the server before changing these values because Dragonwilds documentation warns that changes made while the server is running can be lost.

If an existing `DedicatedServer.ini` is already present, the app reads those official values back into the profile so existing installs can be managed without retyping everything.

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

The smoke test starts the local dashboard on a test port, verifies the API, saves a test port and required dedicated-server setup values, confirms `DedicatedServer.ini` is generated, and confirms the dashboard HTML loads.
