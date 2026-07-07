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
  if (app.version !== "0.5.0") {
    throw new Error(`Expected version 0.5.0, got ${app.version}`);
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
  await fs.writeFile(path.join(testServerDir, "RSDragonwildsServer.exe"), "fake exe for detection smoke test");
  await fs.mkdir(path.join(testServerDir, "steamapps"), { recursive: true });
  await fs.writeFile(path.join(testServerDir, "steamapps", "appmanifest_4019830.acf"), '"appid" "4019830"');
  profile.server.port = 28888;
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
  const savedWithoutTemplate = await requestJson("/api/settings", "PUT", profile);
  try {
    await fs.access(configPath);
    throw new Error("DedicatedServer.ini was created even though no official template existed.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!savedWithoutTemplate.status.configuration.lastPatchError) {
    throw new Error("Saving setup without an official template should report a patch error.");
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
