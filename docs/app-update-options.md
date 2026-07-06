# Installed App Update Options

Dragonwilds Server Control is packaged with Electron and electron-builder, so updates should be shipped as packaged app releases instead of pulling raw source code on the server.

## Active Strategy: GitHub Releases Auto-Update

This is now wired into the app for `maurerk1993/dragonwilds_control`.

How it works:

1. CI builds the Windows installer whenever a version tag is pushed.
2. CI publishes the `.exe`, `.blockmap`, and `latest.yml` files to a GitHub Release.
3. The installed app checks GitHub Releases on startup.
4. If a newer release exists, the app downloads it and prompts to restart/install.

Why this is the best default:

- It matches the Electron/electron-builder ecosystem.
- It updates the installed app, not just source files.
- It keeps server setup simple after the first install.
- It supports differential downloads through the generated blockmap.

Important notes:

- Public repositories are easiest.
- Private repositories need a secure update feed plan; do not bake a long-lived GitHub token into the app.
- Windows update signature verification is currently disabled because the app is not code-signed yet. Add code signing before broad distribution, then re-enable signature verification.

## Release Runbook

1. Make the app change.
2. Bump `package.json`, `package-lock.json`, in-app release notes, and `CHANGELOG.md`.
3. Merge to `main`.
4. Create and push a tag that matches the app version, for example:

   ```powershell
   git tag v0.3.0
   git push origin v0.3.0
   ```

5. GitHub Actions runs `.github/workflows/release.yml`.
6. The workflow publishes the setup `.exe`, `.blockmap`, and `latest.yml` to the GitHub Release.
7. Existing installed apps see the update the next time they launch or when Check Now is clicked.

## Simple Alternative: Manual Update Check

The app can check a small `latest.json` file in the repository or on a static host.

That file would contain:

- latest version
- download URL
- release notes
- checksum

The app would show a button like `Download Update`, then open the browser to the installer.

Pros:

- Easy to implement.
- Works with almost any host.
- Safer for private repositories because the app does not need repo write access.

Tradeoffs:

- Less automatic.
- The user still runs the installer manually.
- The app must handle checksum verification itself if we want integrity checks.

## Controlled Server Share

The app can check a UNC path or file share, for example `\\duneserv\Shared\DragonwildsControl\latest.json`.

Pros:

- Good for a private home/server environment.
- No public release hosting required.
- Easy to copy a new installer into place.

Tradeoffs:

- Only works on your LAN or VPN.
- Needs file-share permissions.
- Not ideal if the app needs to update from outside your network.

## Not Recommended: Git Pull On The Server

Do not make the installed app update itself by running `git pull`, `npm install`, and rebuilding on the server.

Why:

- It requires developer tooling on the server.
- It can break if dependencies or build tools change.
- It updates source code rather than the installed app.
- It is much harder to recover when an update fails.

## Recommendation

Use GitHub Releases auto-update for the polished app path. Use the manual `latest.json` or LAN share option only if you want maximum simplicity before setting up CI releases.
