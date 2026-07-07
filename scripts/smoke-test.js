const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const port = 8897;
require("fs").rmSync(path.join(root, ".runtime-test"), { recursive: true, force: true });
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    DWSC_NO_OPEN: "1",
    DWSC_PORT: String(port),
    DWSC_DATA_DIR: path.join(root, ".runtime-test")
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

function requestJson(route, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": payload.length
            }
          : undefined
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = JSON.parse(raw);
            if (response.statusCode >= 400 || parsed.error) {
              reject(new Error(parsed.error || raw));
              return;
            }
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Invalid JSON from ${route}: ${raw}`));
          }
        });
      }
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      return await requestJson("/api/app");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Server did not start. Output:\n${output}`);
}

async function main() {
  const app = await waitForServer();
  if (app.version !== "0.5.8") {
    throw new Error(`Expected version 0.5.8, got ${app.version}`);
  }

  const serverSource = await fs.readFile(path.join(root, "server", "index.js"), "utf8");
  const appSource = await fs.readFile(path.join(root, "public", "app.js"), "utf8");
  if (serverSource.includes("startCommand") || serverSource.includes("/wait cmd.exe")) {
    throw new Error("External task launcher should not use the hidden start/wait wrapper.");
  }
  if (!serverSource.includes("detached: true") || !serverSource.includes("windowsHide: false")) {
    throw new Error("External task launcher should directly spawn a detached visible cmd.exe window.");
  }
  if (!serverSource.includes("async function runUpdateServerWorkflow")) {
    throw new Error("Update Server should use a dedicated stop-update-restart workflow.");
  }
  if (!serverSource.includes("runUpdateServerWorkflow(await getProfile())")) {
    throw new Error("Update endpoint should call the update workflow instead of raw SteamCMD install.");
  }
  if (serverSource.includes('task: await runInstall(await getProfile(), false)')) {
    throw new Error("Update endpoint is wired directly to SteamCMD without stopping the server first.");
  }
  if (
    !serverSource.includes("Stop server before update") ||
    !serverSource.includes("Dragonwilds was running before update") ||
    !serverSource.includes("managedServerWasRunning") ||
    !serverSource.includes("skipFirstRunConfigBootstrap")
  ) {
    throw new Error("Update workflow is missing stop, restart-marker, or update chaining behavior.");
  }
  if (
    !serverSource.includes("trySendGracefulQuitToManagedServer") ||
    !serverSource.includes("Graceful shutdown timed out; forcing")
  ) {
    throw new Error("Update workflow is missing graceful shutdown fallback coverage.");
  }
  if (!appSource.includes("Update workflow started")) {
    throw new Error("Update action should describe the stop-update-restart workflow.");
  }

  const profile = await requestJson("/api/settings");
  const testServerDir = path.join(root, ".runtime-test", "server");
  const configPath = path.join(
    testServerDir,
    "RSDragonwilds",
    "Saved",
    "Config",
    "WindowsServer",
    "DedicatedServer.ini"
  );
  const linuxTemplatePath = path.join(
    testServerDir,
    "RSDragonwilds",
    "Saved",
    "Config",
    "Linux",
    "DedicatedServer.ini"
  );
  await fs.mkdir(testServerDir, { recursive: true });
  await fs.mkdir(path.join(testServerDir, "steamapps"), { recursive: true });
  await fs.writeFile(path.join(testServerDir, "steamapps", "appmanifest_4019830.acf"), '"appid" "4019830"');
  await fs.writeFile(path.join(testServerDir, "steamcmd-downloading.tmp"), "partial payload marker");
  profile.server.port = 28888;
  profile.server.launchArgs = "-log -NewConsole -port=7777";
  profile.server.ownerId = "0002ff274ad9459abebf9ca7f3bed3cb";
  profile.server.name = "Smoke Test Dragonwilds Server";
  profile.server.worldName = "SmokeWorld";
  profile.server.adminPassword = "AdminSmokePassword";
  profile.server.worldPassword = "WorldSmokePassword";
  profile.server.password = profile.server.worldPassword;
  profile.paths.steamcmdDir = path.join(root, ".runtime-test", "steamcmd");
  profile.paths.serverDir = testServerDir;
  profile.paths.configPath = configPath;
  profile.paths.saveDir = path.join(testServerDir, "RSDragonwilds", "Saved", "Savegames");
  profile.paths.logPath = path.join(testServerDir, "RSDragonwilds", "Saved", "Logs", "RSDragonwilds.log");
  profile.paths.backupDir = path.join(testServerDir, "Backups");

  for (const invalidPort of [65535, "not-a-number"]) {
    const invalidProfile = JSON.parse(JSON.stringify(profile));
    invalidProfile.server.port = invalidPort;
    let rejected = false;
    try {
      await requestJson("/api/settings", "PUT", invalidProfile);
    } catch (error) {
      rejected = /Game Port must be a whole number from 1 to 65534/.test(error.message);
    }
    if (!rejected) {
      throw new Error(`Invalid game port was not rejected: ${invalidPort}`);
    }
  }

  const savedDuringPartialInstall = await requestJson("/api/settings", "PUT", profile);
  if (savedDuringPartialInstall.status.paths.serverInstall.installed) {
    throw new Error("Manifest-only install should not be treated as installed before the server executable exists.");
  }
  if (!savedDuringPartialInstall.status.paths.serverInstall.partialInstallDetected) {
    throw new Error("Manifest-only install should report a partial install state.");
  }
  if (savedDuringPartialInstall.status.configuration.lastPatchError) {
    throw new Error("Saving setup during a partial install should not report a missing DedicatedServer.ini patch error.");
  }
  try {
    await fs.access(configPath);
    throw new Error("DedicatedServer.ini was created during a partial install.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await fs.writeFile(path.join(testServerDir, "RSDragonwildsServer.exe"), "fake exe for detection smoke test");
  const savedWithoutTemplate = await requestJson("/api/settings", "PUT", profile);
  try {
    await fs.access(configPath);
    throw new Error("DedicatedServer.ini was created even though no official template existed.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (savedWithoutTemplate.status.configuration.lastPatchError) {
    throw new Error("Saving setup before a config/template exists should not report a patch error.");
  }
  if (savedWithoutTemplate.status.paths.config.exists || savedWithoutTemplate.status.configuration.templateAvailable) {
    throw new Error("Config source should not be reported before the Windows INI or official template exists.");
  }

  await fs.mkdir(path.dirname(linuxTemplatePath), { recursive: true });
  await fs.writeFile(
    linuxTemplatePath,
    [
      ";METADATA=(Diff=true, UseCommands=true)",
      "[/Script/Dominion.DedicatedServerSettings]",
      "OwnerId=",
      "ServerName=Template Server",
      "DefaultWorldName=",
      "AdminPassword=",
      "WorldPassword=",
      "ServerGuid=template-guid-should-survive",
      "bFutureOfficialSetting=True",
      ""
    ].join("\n"),
    "utf8"
  );

  const saved = await requestJson("/api/settings", "PUT", profile);
  if (saved.profile.server.port !== 28888) {
    throw new Error("Settings save did not persist the server port.");
  }
  if (saved.profile.server.queryPort !== 28889) {
    throw new Error(`Settings save did not derive the secondary port: ${saved.profile.server.queryPort}`);
  }
  if (!saved.status.configuration.ready) {
    throw new Error(`Saved profile should be config-ready: ${saved.status.configuration.missingRequired.join(", ")}`);
  }

  if (saved.status.configuration.lastPatchError) {
    throw new Error(`DedicatedServer.ini should patch cleanly after template exists: ${saved.status.configuration.lastPatchError.message}`);
  }

  const patchedIni = await fs.readFile(profile.paths.configPath, "utf8");
  const expectedIniParts = [
    ";METADATA=(Diff=true, UseCommands=true)",
    "[/Script/Dominion.DedicatedServerSettings]",
    "OwnerId=0002ff274ad9459abebf9ca7f3bed3cb",
    "ServerName=Smoke Test Dragonwilds Server",
    "DefaultWorldName=SmokeWorld",
    "AdminPassword=AdminSmokePassword",
    "WorldPassword=WorldSmokePassword",
    "ServerGuid=template-guid-should-survive",
    "bFutureOfficialSetting=True"
  ];
  for (const part of expectedIniParts) {
    if (!patchedIni.includes(part)) {
      throw new Error(`Patched DedicatedServer.ini is missing: ${part}`);
    }
  }

  const clearedProfile = JSON.parse(JSON.stringify(saved.profile));
  clearedProfile.server.ownerId = "";
  clearedProfile.server.name = "";
  clearedProfile.server.worldName = "";
  clearedProfile.server.adminPassword = "";
  clearedProfile.server.worldPassword = "";
  clearedProfile.server.password = "";
  await fs.writeFile(path.join(root, ".runtime-test", "profile.json"), `${JSON.stringify(clearedProfile, null, 2)}\n`);
  const hydratedProfile = await requestJson("/api/settings");
  if (
    hydratedProfile.server.ownerId !== "0002ff274ad9459abebf9ca7f3bed3cb" ||
    hydratedProfile.server.name !== "Smoke Test Dragonwilds Server" ||
    hydratedProfile.server.worldName !== "SmokeWorld" ||
    hydratedProfile.server.adminPassword !== "AdminSmokePassword" ||
    hydratedProfile.server.worldPassword !== "WorldSmokePassword"
  ) {
    throw new Error("Existing DedicatedServer.ini values were not hydrated into the profile.");
  }

  const status = await requestJson("/api/status");
  if (status.selectedPort !== 28888) {
    throw new Error("Status did not report the saved server port.");
  }
  if (status.secondaryPort !== 28889 || status.queryPort !== 28889) {
    throw new Error(`Status did not derive the secondary port: ${status.secondaryPort}/${status.queryPort}`);
  }
  if (!status.effectiveLaunchArgsText?.includes("-port=28888")) {
    throw new Error(`Status did not include the effective launch port: ${status.effectiveLaunchArgsText}`);
  }
  if (status.effectiveLaunchArgsText.includes("-port=7777")) {
    throw new Error(`Status kept a stale custom launch port: ${status.effectiveLaunchArgsText}`);
  }
  const portArgCount = (status.effectiveLaunchArgs || []).filter((arg) => arg.toLowerCase().startsWith("-port")).length;
  if (portArgCount !== 1) {
    throw new Error(`Expected exactly one effective -port argument, got ${portArgCount}.`);
  }
  if (!status.configuration.ready || !status.configuration.iniReady || !status.paths.config.exists) {
    throw new Error("Status did not report a ready patched DedicatedServer.ini.");
  }
  if (!status.configuration.iniText || !status.configuration.iniText.includes("OwnerId=0002ff274ad9459abebf9ca7f3bed3cb")) {
    throw new Error("Status did not include the DedicatedServer.ini contents.");
  }
  if (!status.paths.configTemplate.exists || status.paths.configTemplate.path !== linuxTemplatePath) {
    throw new Error("Status did not report the official Linux DedicatedServer.ini template.");
  }
  if (status.logRetentionHours !== 72) {
    throw new Error(`Status did not report 72-hour log retention: ${status.logRetentionHours}`);
  }
  if (!status.paths.serverInstall.installed) {
    throw new Error("Status did not detect the fake dedicated server install.");
  }
  if (!status.paths.serverExe.path.endsWith("RSDragonwildsServer.exe")) {
    throw new Error(`Status did not detect RSDragonwildsServer.exe: ${status.paths.serverExe.path}`);
  }

  const page = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/`, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
  if (!page.includes("Dragonwilds Server Control")) {
    throw new Error("Dashboard HTML did not load.");
  }
  if (!page.includes('data-view="console"') || !page.includes('id="consoleView"') || !page.includes("consoleSummary")) {
    throw new Error("Dashboard HTML is missing the dedicated Console tab markup.");
  }
  if (!page.includes("data-console-form") || !page.includes("icon-restart") || !page.includes("iniFileContents")) {
    throw new Error("Dashboard HTML is missing console form, SVG icon, or INI viewer markup.");
  }
  if (!page.includes("Use the external command window for install/update input")) {
    throw new Error("Dashboard HTML is missing the external command window console guidance.");
  }
  if (!page.includes('data-action="bootstrap-config"') || !page.includes("Generate DedicatedServer.ini")) {
    throw new Error("Dashboard HTML is missing the first-run config generation action.");
  }
  if (!page.includes("Game Port") || !page.includes("Secondary Port") || !page.includes('max="65534"')) {
    throw new Error("Dashboard HTML is missing Game Port or Secondary Port setup guidance.");
  }
  if (!page.includes("Edit Setup") || !page.includes("data-open-setup") || !page.includes("setupGateTitle")) {
    throw new Error("Dashboard HTML is missing the setup editor entry point.");
  }
  if (!page.includes('id="openIniFile"') || !page.includes("Open File")) {
    throw new Error("Dashboard HTML is missing the DedicatedServer.ini Open File action.");
  }
  if (page.includes("data-restore") || page.includes(">Restore<")) {
    throw new Error("Backup restore controls should not be rendered in the app UI.");
  }
  if (page.includes('id="logOutput"') || page.includes('data-view="logs"')) {
    throw new Error("Old dashboard log terminal or Logs nav markup should not be present.");
  }
  if (page.includes('data-view="settings"') || page.includes('id="settingsView"')) {
    throw new Error("Settings page markup should not be present.");
  }

  console.log("Smoke test passed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
  });
