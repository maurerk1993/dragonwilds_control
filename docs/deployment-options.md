# Deployment Options

This project now supports an installable Windows desktop app because the control panel needs direct access to SteamCMD, `RSDragonwilds.exe`, save files, logs, and backups on the server machine.

## Option A: Setup Installer

Recommended.

1. On your build machine, run `npm install`.
2. Run `npm run dist:exe`.
3. Copy the generated setup file from `dist\` to the Windows 11 server.
4. Double-click the setup file on the server.
5. Open `Dragonwilds Server Control` from the desktop shortcut or Start Menu.
6. Accept the Windows UAC prompt when the app opens.

Pros:
- Easiest server install.
- Bundles the app runtime.
- Creates desktop and Start Menu shortcuts.
- Relaunches with Administrator rights so the default server folders can be managed.

Tradeoffs:
- The installer is unsigned until you add a code-signing certificate, so Windows may show a publisher warning.

## Option B: MSI Package

Use this if you prefer MSI deployment.

1. Run `npm install`.
2. Run `npm run dist:msi`.
3. Copy the generated `.msi` from `dist\` to the Windows 11 server.
4. Install it on the server.

Pros:
- Familiar enterprise-style install format.
- Useful for some software deployment tools.

Tradeoffs:
- MSI generation can require additional Windows packaging tools depending on the local builder environment.
- The standard setup `.exe` is the smoother path for a personal Windows server.

## Option C: Windows Service Plus Web UI

Optional later enhancement if you want to administer the server from another computer.

The control backend runs as a Windows service and listens on the LAN. You would open the dashboard from another PC using the Windows server's IP address and port.

Pros:
- Runs after reboot without signing in.
- Can be opened from another PC.
- Good foundation for multi-admin access later.

Tradeoffs:
- Needs authentication before exposing beyond localhost.
- Needs firewall rules and a clear LAN/VPN security plan.
- Slightly more setup than a desktop launcher.

## Recommended Path

Use Option A unless you specifically need MSI. Move to Option C only if you want remote browser access from other machines.
