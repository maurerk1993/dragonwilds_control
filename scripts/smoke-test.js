const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const port = 8897;
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
  if (app.version !== "0.3.1") {
    throw new Error(`Expected version 0.3.1, got ${app.version}`);
  }

  const profile = await requestJson("/api/settings");
  const testServerDir = path.join(root, ".runtime-test", "server");
  await fs.mkdir(testServerDir, { recursive: true });
  await fs.writeFile(path.join(testServerDir, "RSDragonwildsServer.exe"), "fake exe for detection smoke test");
  await fs.mkdir(path.join(testServerDir, "steamapps"), { recursive: true });
  await fs.writeFile(path.join(testServerDir, "steamapps", "appmanifest_4019830.acf"), '"appid" "4019830"');
  profile.server.port = 28888;
  profile.server.name = "Smoke Test Dragonwilds Server";
  profile.paths.steamcmdDir = path.join(root, ".runtime-test", "steamcmd");
  profile.paths.serverDir = testServerDir;
  profile.paths.configPath = path.join(
    testServerDir,
    "RSDragonwilds",
    "Saved",
    "Config",
    "WindowsServer",
    "DedicatedServer.ini"
  );
  profile.paths.saveDir = path.join(testServerDir, "RSDragonwilds", "Saved", "Savegames");
  profile.paths.logPath = path.join(testServerDir, "RSDragonwilds", "Saved", "Logs", "RSDragonwilds.log");
  profile.paths.backupDir = path.join(testServerDir, "Backups");
  const saved = await requestJson("/api/settings", "PUT", profile);
  if (saved.profile.server.port !== 28888) {
    throw new Error("Settings save did not persist the server port.");
  }

  const status = await requestJson("/api/status");
  if (status.selectedPort !== 28888) {
    throw new Error("Status did not report the saved server port.");
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
  if (!page.includes("data-console-form") || !page.includes("icon-restart")) {
    throw new Error("Dashboard HTML is missing live console or SVG icon markup.");
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
