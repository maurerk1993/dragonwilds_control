# Dragonwilds Server Control

Windows 11 local dashboard for deploying, controlling, configuring, and backing up a RuneScape: Dragonwilds dedicated server.

This app is based on the existing batch-file workflow:

- SteamCMD app ID: `4019830`
- SteamCMD folder: `C:\SteamCMD`
- Server install folder: `C:\GameServers\RSDragonwildsDedicatedServer`
- Dedicated executable: `RSDragonwilds.exe`
- Config path: `RSDragonwilds\Saved\Config\WindowsServer\DedicatedServer.ini`
- Save path: `RSDragonwilds\Saved\Savegames`
- Log path: `RSDragonwilds\Saved\Logs\RSDragonwilds.log`
- Default server port: `7777`

## Run Locally

```powershell
npm start
```

The dashboard opens at `http://127.0.0.1:8787`.

## Windows Server Desktop Launch

1. Copy this repo folder to the Windows 11 server.
2. Install Node.js 20 or newer on that server.
3. Double-click `Start-DragonwildsControl.bat`.
4. Optional: create a desktop shortcut:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\create-desktop-shortcut.ps1
```

## Settings

The app writes a local JSON profile and can update `DedicatedServer.ini` when settings are saved. The server port is editable in the UI and defaults to `7777`.

Public, authoritative Dragonwilds INI key documentation was not available during this initial build, so the app exposes editable INI mappings. If the generated server config uses different key names, update the mapping table in the Settings screen before saving.

## Backups

Backups use PowerShell `Compress-Archive` against the configured save folder. Restore moves the current save folder to a timestamped safety copy before extracting the selected backup.

Stop the dedicated server before restoring a backup.

## Deployment Options

See [docs/deployment-options.md](docs/deployment-options.md).

## Validation

```powershell
npm test
```

The smoke test starts the local dashboard on a test port, verifies the API, saves a test port setting, and confirms the dashboard HTML loads.
