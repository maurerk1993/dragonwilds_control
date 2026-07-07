# Changelog

## 0.5.7 - Safer server updates

- Changed Update Server so it stops Dragonwilds before running the SteamCMD update.
- Added a graceful shutdown path that tries the managed server console first, then a normal Windows close, and only force-stops remaining processes after a timeout.
- Restarted Dragonwilds automatically after a successful update only when it was running before the update began.
- Left the server offline after updates that started while the server was already offline.
- Updated the dashboard action copy so admins can tell that update is now a stop-update-restart workflow.

## 0.5.6 - Setup editor and dashboard polish

- Added Edit Setup controls on the Dashboard and Server page so saved dedicated-server values can be changed after first setup.
- Kept the setup form automatic for fresh installs once `DedicatedServer.ini` or the official template exists.
- Blocked setup saves while the managed Dragonwilds server process is running to avoid live config edits being overwritten.
- Updated the setup editor copy so required first-run setup and later edits are clearly different states.
- Replaced the visible `DedicatedServer.ini` path with an Open File action to avoid header clipping.
- Cleaned up the fullscreen dashboard layout so the console summary no longer stretches into a giant empty panel.
- Restyled the health and backup panels and removed restore buttons from the backup lists.

## 0.5.5 - First-run config generation

- Added a first-run config generation task that launches the Dragonwilds server executable once after install when no `DedicatedServer.ini` or official template exists.
- Added a 10-second prompt telling the user to close the server console so the generated config can be patched by the app.
- Added a manual Generate DedicatedServer.ini action for already-installed servers that still need the first-run config file.
- Hid the setup prompt until a Windows config or official template is actually available.

## 0.5.4 - Force visible CMD launch

- Replaced the hidden `cmd /c start /wait` launcher with a direct detached `cmd.exe` task process using `windowsHide: false`.
- Added the launched command and temporary script path to task status output so failed external-window launches are diagnosable.
- Kept the external task window pause so admins can read the final SteamCMD or PowerShell result before closing it.

## 0.5.3 - Wait for install completion

- Changed install detection so SteamCMD manifests or partial payload files no longer count as a complete dedicated server install.
- Hid first-run setup prompts until the Dragonwilds server executable is detected.
- Stopped `DedicatedServer.ini` template checks and patch attempts while install/update is still running or before the server executable exists.
- Added smoke coverage for manifest-only partial installs so the app does not report missing INI errors too early.

## 0.5.2 - Visible install command window

- Changed PowerShell-backed tasks so install, update, repair, backup, restore, and stop actions launch through a real external `cmd.exe` window on Windows.
- Kept the external task window open at the end with a prompt so admins can read the final SteamCMD or PowerShell result before closing it.
- Updated in-app console status copy so admins know to use the external command window for live output and input.

## 0.5.1 - Game port launch control

- Changed server start so the saved Game Port is passed to Dragonwilds as `-port=<port>`.
- Replaced stale custom `-port` launch args with the saved Game Port while preserving other custom launch flags.
- Added Secondary Port status and setup guidance so admins know to forward UDP for the Game Port and the next port.
- Added validation so Game Port must be a whole number from `1` to `65534`.

## 0.5.0 - Dedicated console workspace

- Added a dedicated Console tab with a larger live output view for active task output, server log lines, and control activity.
- Replaced the cramped dashboard log terminal with a compact console summary card and an Open Console action.
- Changed long-running task launches so Windows command windows are no longer hidden while the app still mirrors output into the Console tab.
- Added 72-hour retention for the app control activity log and filtered status/API log output to recent retained lines.
- Kept the safer official `DedicatedServer.ini` setup workflow from `0.4.2`: install first, then patch an existing Windows config or copied official Linux template before start.

## 0.4.2 - Safer official INI setup

- Changed first-run flow so the SteamCMD server install can run before required Dragonwilds setup values are entered.
- Changed `DedicatedServer.ini` handling so the app patches an existing Windows config or copies the installed official Linux template first instead of generating the file from scratch.
- Added config-template status to health checks and paths so admins can see whether the installed official template is available.
- Updated Start and Restart gating so the server cannot launch until required setup values are saved and the Windows `DedicatedServer.ini` is ready.
- Updated smoke coverage to confirm the app refuses to fabricate `DedicatedServer.ini` without an official template and preserves unknown official INI fields while patching known values.

## 0.4.1 - Simplified config surface

- Removed the unfinished Settings page from the sidebar while the configuration workflow is still being shaped.
- Moved first-run setup fields into the setup prompt so initial installs can still generate the required `DedicatedServer.ini`.
- Replaced the dashboard server settings form with a read-only viewer that shows the current contents of `DedicatedServer.ini`.
- Added `DedicatedServer.ini` contents to the app status payload and smoke test coverage.

## 0.4.0 - Official first-run server setup

- Added a first-run setup prompt for the mandatory Dragonwilds dedicated server values: Owner ID, Server Name, Default World Name, and Admin Password.
- Changed settings saves and server launches to generate `RSDragonwilds\Saved\Config\WindowsServer\DedicatedServer.ini` with the official `/Script/Dominion.DedicatedServerSettings` section before install/start can continue.
- Added support for the optional World Password value while preserving older saved password values as the World Password during profile migration.
- Added existing INI hydration so an already configured server can populate the app profile from `DedicatedServer.ini` instead of showing false missing-setup warnings.
- Updated health checks and action gating so install, start, and restart clearly explain which required setup values are missing.

## 0.3.2 - Automatic administrator prompt

- Changed the Windows packaged app manifest to request administrator access on launch so double-clicking the app shows the UAC prompt automatically.
- Re-enabled executable resource editing during Windows packaging so the requested execution level is actually written into the built `.exe`.
- Kept the runtime elevation relaunch fallback for extra protection if the app is ever launched from an unpacked or unusual build.

## 0.3.1 - Live install console and first-run fixes

- Added live task console output for install, repair, update, backup, and stop tasks with much larger retained output.
- Added console input controls so admins can type into a running SteamCMD task, send `quit`, or stop a stuck task from the app.
- Fixed Dragonwilds dedicated server detection to prefer `RSDragonwildsServer.exe` and report installed files, missing executables, and Steam manifests separately.
- Updated first-run behavior so fresh install is prominent only while server files are missing; once installed, normal update controls are emphasized and repair requires extra confirmation.
- Changed settings saves so `DedicatedServer.ini` is not created prematurely before the game server has generated it.
- Replaced fallback letter/C-shaped action icons with real SVG icons.
- Reworked dashboard sizing so the sidebar footer and live logs fit inside the app window without whole-page scrolling.

## 0.3.0 - GitHub Releases auto-update

- Added `electron-updater` integration so the packaged desktop app checks GitHub Releases on launch.
- Added app update status and manual update controls to the Deploy page.
- Added release publishing metadata for `maurerk1993/dragonwilds_control`.
- Added a GitHub Actions workflow that builds and publishes the Windows NSIS updater release when a `v*` tag is pushed.
- Disabled Windows update signature verification for now because the app is not code-signed yet; this should be turned back on after a signing certificate is configured.

## 0.2.1 - More reliable first install

- Changed SteamCMD install, repair, and update tasks to run through a generated SteamCMD script with an explicit `quit` command instead of relying on chained command-line arguments.
- Removed the separate SteamCMD `+quit` preflight from install/update tasks so the app no longer starts two SteamCMD console sessions for one install.
- Added documentation for installed-app update options, including GitHub Releases based auto-updates.

## 0.2.0 - Installable Windows app

- Added an Electron desktop shell so Dragonwilds Server Control opens in its own Windows app window instead of a browser tab.
- Added Windows installer build scripts for a standard setup `.exe`, plus an MSI build command for environments that prefer MSI deployment.
- Updated installed-app data handling so the packaged app stores its control profile under the user's Windows app data folder.
- Added packaged-app elevation relaunch so the installed app can manage the default SteamCMD and server folders after a normal double-click.
- Updated deployment notes to recommend the installer-first workflow for a Windows 11 server.

## 0.1.0 - Initial desktop-control preview

- Added a Windows-friendly local dashboard for installing, updating, starting, stopping, restarting, and monitoring a RuneScape: Dragonwilds dedicated server.
- Added editable server settings with port, server name, password, max players, launch arguments, and configurable INI key mappings.
- Added backup management for savegames, including backup creation, listing, and restore with a safety copy of the current save folder.
- Added live status panels for SteamCMD, server files, config paths, logs, backups, and the selected server port.
- Added in-app release notes and deployment guidance for running the dashboard from a Windows 11 desktop shortcut.
