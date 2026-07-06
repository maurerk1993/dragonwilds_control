# Deployment Options

This project starts as a local Windows control dashboard because the app needs direct access to SteamCMD, `RSDragonwilds.exe`, save files, logs, and backups on the server machine.

## Option A: Desktop Launcher

Best first step.

1. Copy this folder to the Windows 11 server, for example `C:\Apps\DragonwildsServerControl`.
2. Install Node.js 20 or newer on the Windows server.
3. Double-click `Start-DragonwildsControl.bat`.
4. The dashboard opens at `http://127.0.0.1:8787`.
5. Run `scripts\create-desktop-shortcut.ps1` from PowerShell to create a desktop shortcut.

Pros:
- Fastest to deploy.
- Easy to debug.
- Matches the current batch-file workflow.

Tradeoffs:
- A console window stays open while the dashboard is running.
- Node.js must be installed unless this is packaged later.

## Option B: Electron Desktop App

Best polished desktop experience.

The same UI and backend can be wrapped with Electron so the server gets a normal Windows installer, bundled runtime, app icon, and desktop shortcut.

Pros:
- Feels like a native desktop app.
- No separate Node.js install for the final packaged app.
- Easy desktop launch.

Tradeoffs:
- Adds packaging dependencies and a larger install size.
- Needs a follow-up packaging pass.

## Option C: Windows Service Plus Web UI

Best if you want to administer the server from another computer.

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

Start with Option A for the first live server install. Once the workflow is proven on the Windows 11 server, package Option B for a cleaner desktop app. Move to Option C only if you want remote browser access from other machines.
