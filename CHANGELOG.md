# Changelog

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
