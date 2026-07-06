const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  getUpdateState,
  checkForAppUpdates,
  installDownloadedAppUpdate
} = require("./update-controller");

const appRoot = path.resolve(__dirname, "..");
const publicRoot = path.join(appRoot, "public");
const appPackage = require("../package.json");

const host = process.env.DWSC_HOST || "127.0.0.1";
const port = Number(process.env.DWSC_PORT || process.env.PORT || 8787);
const noOpen = process.env.DWSC_NO_OPEN === "1";
const dataDir = path.resolve(process.env.DWSC_DATA_DIR || path.join(appRoot, "data"));
const profilePath = path.join(dataDir, "profile.json");
const activityLogPath = path.join(dataDir, "activity.log");

let activeTask = null;
let serverProcess = null;
let controlServer = null;
let serverDetectionCache = null;

const serverExeCandidates = [
  "RSDragonwildsServer.exe",
  "RSDragonwilds.exe"
];
const taskOutputLimit = 5000;
const taskOutputSnapshotLimit = 1200;
const activityLogSnapshotLimit = 1800;
const serverLogSnapshotLimit = 1500;

const defaultProfile = {
  appId: "4019830",
  steamcmdUrl: "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip",
  paths: {
    steamcmdDir: "C:\\SteamCMD",
    serverDir: "C:\\GameServers\\RSDragonwildsDedicatedServer",
    configPath:
      "C:\\GameServers\\RSDragonwildsDedicatedServer\\RSDragonwilds\\Saved\\Config\\WindowsServer\\DedicatedServer.ini",
    saveDir: "C:\\GameServers\\RSDragonwildsDedicatedServer\\RSDragonwilds\\Saved\\Savegames",
    logPath: "C:\\GameServers\\RSDragonwildsDedicatedServer\\RSDragonwilds\\Saved\\Logs\\RSDragonwilds.log",
    backupDir: "C:\\GameServers\\RSDragonwildsDedicatedServer\\Backups"
  },
  server: {
    name: "The Dragonwilds Server",
    password: "",
    maxPlayers: 4,
    port: 7777,
    queryPort: 7778,
    publicServer: false,
    worldName: "Ashenfall",
    autoSaveMinutes: 15,
    launchArgs: "-log -NewConsole"
  },
  iniMappings: {
    name: { section: "Server", key: "ServerName" },
    password: { section: "Server", key: "ServerPassword" },
    maxPlayers: { section: "Server", key: "MaxPlayers" },
    port: { section: "Server", key: "Port" },
    queryPort: { section: "Server", key: "QueryPort" },
    publicServer: { section: "Server", key: "PublicServer" },
    worldName: { section: "Server", key: "WorldName" },
    autoSaveMinutes: { section: "Server", key: "AutoSaveIntervalMinutes" }
  },
  customIniValues: [],
  writeIniOnSave: true,
  createdBy: "Dragonwilds Server Control"
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = deepMerge(base ? base[key] : undefined, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

async function ensureDataDir() {
  await fsp.mkdir(dataDir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function getProfile() {
  const stored = await readJson(profilePath, {});
  return deepMerge(defaultProfile, stored);
}

async function saveProfile(profile) {
  const next = deepMerge(defaultProfile, profile);
  await writeJson(profilePath, next);
  serverDetectionCache = null;
  if (next.writeIniOnSave && exists(next.paths.configPath)) {
    await writeDedicatedServerIni(next);
  } else if (next.writeIniOnSave) {
    appendActivity(
      "Settings saved to profile. DedicatedServer.ini is not present yet; the game server usually creates it on first start."
    );
  }
  return next;
}

function normalizeBool(value) {
  return value ? "true" : "false";
}

function iniValuesFromProfile(profile) {
  const values = [
    ["name", profile.server.name],
    ["password", profile.server.password],
    ["maxPlayers", profile.server.maxPlayers],
    ["port", profile.server.port],
    ["queryPort", profile.server.queryPort],
    ["publicServer", normalizeBool(profile.server.publicServer)],
    ["worldName", profile.server.worldName],
    ["autoSaveMinutes", profile.server.autoSaveMinutes]
  ];

  const mapped = [];
  for (const [field, value] of values) {
    const mapping = profile.iniMappings[field];
    if (!mapping || !mapping.section || !mapping.key) continue;
    mapped.push({
      section: mapping.section,
      key: mapping.key,
      value: value === undefined || value === null ? "" : String(value)
    });
  }

  for (const custom of profile.customIniValues || []) {
    if (!custom.section || !custom.key) continue;
    mapped.push({
      section: String(custom.section),
      key: String(custom.key),
      value: custom.value === undefined || custom.value === null ? "" : String(custom.value)
    });
  }

  return mapped;
}

async function writeDedicatedServerIni(profile) {
  const configPath = profile.paths.configPath;
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  let lines = [];
  try {
    lines = (await fsp.readFile(configPath, "utf8")).split(/\r?\n/);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    lines = [
      "; Generated by Dragonwilds Server Control",
      "; If official Dragonwilds config keys differ, edit the key mappings in the app.",
      ""
    ];
  }

  for (const entry of iniValuesFromProfile(profile)) {
    lines = upsertIniValue(lines, entry.section, entry.key, entry.value);
  }

  await fsp.writeFile(configPath, `${lines.join(os.EOL).replace(/\s+$/g, "")}${os.EOL}`, "utf8");
}

function upsertIniValue(lines, section, key, value) {
  const sectionPattern = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*$`, "i");
  const anySectionPattern = /^\s*\[[^\]]+\]\s*$/;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "i");

  let sectionIndex = lines.findIndex((line) => sectionPattern.test(line));
  if (sectionIndex === -1) {
    const append = lines.length && lines[lines.length - 1].trim() !== "" ? [""] : [];
    return [...lines, ...append, `[${section}]`, `${key}=${value}`];
  }

  let insertIndex = sectionIndex + 1;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (anySectionPattern.test(line)) break;
    if (keyPattern.test(line)) {
      const prefix = line.match(/^(\s*)/)[1] || "";
      const comment = line.includes(";") ? ` ${line.slice(line.indexOf(";")).trim()}` : "";
      const replacement = `${prefix}${key}=${value}${comment}`;
      return lines.map((current, currentIndex) => (currentIndex === index ? replacement : current));
    }
    insertIndex = index + 1;
  }

  const next = [...lines];
  next.splice(insertIndex, 0, `${key}=${value}`);
  return next;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function steamAppManifestCandidates(profile) {
  return [
    path.join(profile.paths.serverDir, "steamapps", `appmanifest_${profile.appId}.acf`),
    path.join(profile.paths.steamcmdDir, "steamapps", `appmanifest_${profile.appId}.acf`)
  ];
}

function looksLikeServerExe(fileName) {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".exe") && lower.includes("dragonwilds") && lower.includes("server");
}

async function countServerPayloadFiles(serverDir, limit = 8) {
  if (!exists(serverDir)) return 0;
  const queue = [serverDir];
  let seen = 0;
  let scannedDirectories = 0;

  while (queue.length && scannedDirectories < 80 && seen < limit) {
    const current = queue.shift();
    scannedDirectories += 1;
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isFile()) {
        seen += 1;
        if (seen >= limit) break;
      } else if (entry.isDirectory() && !["backups", "savegames"].includes(entry.name.toLowerCase())) {
        queue.push(fullPath);
      }
    }
  }

  return seen;
}

async function findServerExe(serverDir) {
  if (!exists(serverDir)) return null;

  for (const fileName of serverExeCandidates) {
    const directPath = path.join(serverDir, fileName);
    if (exists(directPath)) return directPath;
  }

  const queue = [serverDir];
  let fallback = null;
  let scannedDirectories = 0;
  const candidateSet = new Set(serverExeCandidates.map((name) => name.toLowerCase()));

  while (queue.length && scannedDirectories < 650) {
    const current = queue.shift();
    scannedDirectories += 1;
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile()) {
        const lowerName = entry.name.toLowerCase();
        if (candidateSet.has(lowerName)) {
          return fullPath;
        }
        if (!fallback && looksLikeServerExe(entry.name)) {
          fallback = fullPath;
        }
      } else if (entry.isDirectory()) {
        queue.push(fullPath);
      }
    }
  }

  return fallback;
}

async function detectServerInstall(profile) {
  const cacheKey = [
    profile.appId,
    profile.paths.serverDir,
    profile.paths.steamcmdDir
  ].join("|");
  const now = Date.now();
  if (
    serverDetectionCache &&
    serverDetectionCache.key === cacheKey &&
    now - serverDetectionCache.checkedAt < 1800
  ) {
    return serverDetectionCache.result;
  }

  const serverDirExists = exists(profile.paths.serverDir);
  const serverExe = await findServerExe(profile.paths.serverDir);
  const manifestCandidates = steamAppManifestCandidates(profile);
  const manifestPath = manifestCandidates.find((candidate) => exists(candidate)) || null;
  const payloadFileCount = await countServerPayloadFiles(profile.paths.serverDir);
  const installed = Boolean(serverExe || manifestPath || payloadFileCount >= 3);
  const result = {
    installed,
    serverDirExists,
    serverExe,
    manifestPath,
    payloadFileCount,
    expectedExecutables: serverExeCandidates
  };

  serverDetectionCache = {
    key: cacheKey,
    checkedAt: now,
    result
  };
  return result;
}

async function readLastLines(filePath, lineCount = 300) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-Number(lineCount || 300));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    return [`[${timestamp()}] Could not read log: ${error.message}`];
  }
}

function appendActivity(line) {
  const formatted = `[${timestamp()}] ${line.replace(/\r?\n/g, os.EOL)}`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(activityLogPath, `${formatted}${os.EOL}`, "utf8");
}

function splitArgs(argsText) {
  if (!argsText) return [];
  const matches = String(argsText).match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((value) => value.replace(/^"|"$/g, ""));
}

function taskSnapshot() {
  if (!activeTask) return null;
  return {
    id: activeTask.id,
    name: activeTask.name,
    status: activeTask.status,
    startedAt: activeTask.startedAt,
    finishedAt: activeTask.finishedAt,
    exitCode: activeTask.exitCode,
    canReceiveInput:
      ["running", "stopping"].includes(activeTask.status) &&
      Boolean(activeTask.child?.stdin && !activeTask.child.stdin.destroyed),
    outputLineCount: activeTask.output.length,
    recentOutput: activeTask.output.slice(-taskOutputSnapshotLimit)
  };
}

function pushTaskOutput(task, line) {
  const cleanLine = String(line || "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").trimEnd();
  if (!cleanLine.trim()) return;
  task.output.push(cleanLine);
  if (task.output.length > taskOutputLimit) {
    task.output.splice(0, task.output.length - taskOutputLimit);
  }
  appendActivity(`${task.name}: ${cleanLine}`);
}

function handleTaskOutput(task, chunk) {
  const text = task.outputBuffer + chunk.toString();
  const parts = text.split(/\r\n|\n|\r/);
  task.outputBuffer = parts.pop() || "";
  for (const line of parts) {
    pushTaskOutput(task, line);
  }
  if (task.outputBuffer.length > 240) {
    pushTaskOutput(task, task.outputBuffer);
    task.outputBuffer = "";
  }
}

function beginTask(name, command, args, options = {}) {
  if (activeTask && ["running", "stopping"].includes(activeTask.status)) {
    throw new Error(`Task already running: ${activeTask.name}`);
  }

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const task = {
    id,
    name,
    status: "running",
    startedAt: timestamp(),
    finishedAt: null,
    exitCode: null,
    output: [],
    outputBuffer: "",
    child: null
  };
  activeTask = task;
  appendActivity(`Task started: ${name}`);

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...options
  });
  task.child = child;

  child.stdout?.on("data", (chunk) => handleTaskOutput(task, chunk));
  child.stderr?.on("data", (chunk) => handleTaskOutput(task, chunk));
  child.on("error", (error) => {
    task.status = "failed";
    task.finishedAt = timestamp();
    pushTaskOutput(task, error.message);
    appendActivity(`Task failed to start: ${name}: ${error.message}`);
  });
  child.on("close", (exitCode) => {
    if (task.outputBuffer.trim()) {
      pushTaskOutput(task, task.outputBuffer);
      task.outputBuffer = "";
    }
    task.status = exitCode === 0 ? "completed" : "failed";
    task.exitCode = exitCode;
    task.finishedAt = timestamp();
    serverDetectionCache = null;
    appendActivity(`Task finished: ${name} (exit ${exitCode})`);
  });

  return taskSnapshot();
}

function sendTaskInput(input) {
  if (!activeTask || !["running", "stopping"].includes(activeTask.status)) {
    throw new Error("No running task is available for console input.");
  }
  const text = String(input || "").trimEnd();
  if (!text) {
    throw new Error("Type a command before sending console input.");
  }
  if (!activeTask.child?.stdin || activeTask.child.stdin.destroyed) {
    throw new Error("The running task is not accepting console input.");
  }

  activeTask.child.stdin.write(`${text}${os.EOL}`);
  pushTaskOutput(activeTask, `> ${text}`);
  return taskSnapshot();
}

function stopActiveTask() {
  if (!activeTask || !["running", "stopping"].includes(activeTask.status)) {
    throw new Error("No running task is available to stop.");
  }
  if (activeTask.status !== "stopping") {
    activeTask.status = "stopping";
    pushTaskOutput(activeTask, "Stop requested from the control app.");
  }

  if (process.platform === "win32" && activeTask.child?.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(activeTask.child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    killer.stdout?.on("data", (chunk) => handleTaskOutput(activeTask, chunk));
    killer.stderr?.on("data", (chunk) => handleTaskOutput(activeTask, chunk));
  } else {
    activeTask.child?.kill("SIGTERM");
  }

  return taskSnapshot();
}

function powershellTask(name, script) {
  return beginTask(name, "powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ]);
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psArray(values) {
  return `@(${values.map(psString).join(",")})`;
}

function steamcmdString(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

async function runInstall(profile, validate) {
  const steamcmdExe = path.join(profile.paths.steamcmdDir, "steamcmd.exe");
  const steamcmdZip = path.join(os.tmpdir(), "steamcmd.zip");
  const scriptName = validate ? "steamcmd-install-validate.txt" : "steamcmd-update.txt";
  const steamcmdScript = [
    "@ShutdownOnFailedCommand 1",
    "@NoPromptForPassword 1",
    `force_install_dir ${steamcmdString(profile.paths.serverDir)}`,
    "login anonymous",
    `app_update ${profile.appId}${validate ? " validate" : ""}`,
    "quit"
  ];

  const script = [
    "$ErrorActionPreference='Stop'",
    `New-Item -ItemType Directory -Force -Path ${psString(dataDir)} | Out-Null`,
    `New-Item -ItemType Directory -Force -Path ${psString(profile.paths.steamcmdDir)} | Out-Null`,
    `New-Item -ItemType Directory -Force -Path ${psString(profile.paths.serverDir)} | Out-Null`,
    `if (!(Test-Path -LiteralPath ${psString(steamcmdExe)})) {`,
    `  Invoke-WebRequest -Uri ${psString(profile.steamcmdUrl)} -OutFile ${psString(steamcmdZip)}`,
    `  Expand-Archive -LiteralPath ${psString(steamcmdZip)} -DestinationPath ${psString(profile.paths.steamcmdDir)} -Force`,
    "}",
    `$steamcmdScriptPath = Join-Path ${psString(dataDir)} ${psString(scriptName)}`,
    `Set-Content -LiteralPath $steamcmdScriptPath -Encoding ASCII -Value ${psArray(steamcmdScript)}`,
    `& ${psString(steamcmdExe)} +runscript $steamcmdScriptPath`,
    "$steamcmdExitCode = $LASTEXITCODE",
    "Remove-Item -LiteralPath $steamcmdScriptPath -Force -ErrorAction SilentlyContinue",
    "exit $steamcmdExitCode"
  ].join("; ");

  return powershellTask(validate ? "Install or repair server with validate" : "Update server", script);
}

async function startGameServer(profile) {
  if (serverProcess && !serverProcess.killed) {
    throw new Error("Server process is already running from this control app.");
  }

  const install = await detectServerInstall(profile);
  if (!install.serverExe) {
    if (install.installed) {
      throw new Error(
        `Server files were found, but no runnable executable was detected. Expected one of: ${serverExeCandidates.join(", ")}.`
      );
    }
    throw new Error("The Dragonwilds dedicated server is not installed yet. Run the initial install first.");
  }

  const args = splitArgs(profile.server.launchArgs);
  if (exists(profile.paths.configPath)) {
    await writeDedicatedServerIni(profile);
  } else {
    appendActivity(
      "DedicatedServer.ini is not present before launch. Starting server first so the game can generate its config files."
    );
  }

  appendActivity(`Starting server: ${install.serverExe} ${args.join(" ")}`);
  serverProcess = spawn(install.serverExe, args, {
    cwd: path.dirname(install.serverExe),
    windowsHide: false
  });

  serverProcess.stdout?.on("data", (chunk) => appendActivity(`server: ${chunk.toString().trim()}`));
  serverProcess.stderr?.on("data", (chunk) => appendActivity(`server: ${chunk.toString().trim()}`));
  serverProcess.on("close", (exitCode) => {
    appendActivity(`Server exited with code ${exitCode}`);
    serverProcess = null;
  });
  serverProcess.on("error", (error) => {
    appendActivity(`Server process error: ${error.message}`);
    serverProcess = null;
  });

  return { pid: serverProcess.pid, startedAt: timestamp() };
}

function stopGameServer() {
  if (serverProcess && serverProcess.pid) {
    const pid = serverProcess.pid;
    return beginTask("Stop server process", "taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
  }
  const script = [
    "$stopped=$false",
    `foreach ($name in ${psArray(serverExeCandidates)}) {`,
    "  & taskkill.exe /IM $name /T /F",
    "  if ($LASTEXITCODE -eq 0) { $stopped=$true }",
    "}",
    "if (-not $stopped) { Write-Output 'No Dragonwilds server process was running.' }",
    "exit 0"
  ].join("; ");
  return powershellTask("Stop Dragonwilds server processes", script);
}

async function listBackups(profile) {
  const backupDir = profile.paths.backupDir;
  try {
    const entries = await fsp.readdir(backupDir, { withFileTypes: true });
    const backups = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".zip")) continue;
      const fullPath = path.join(backupDir, entry.name);
      const stat = await fsp.stat(fullPath);
      backups.push({
        id: entry.name,
        name: entry.name,
        path: fullPath,
        sizeBytes: stat.size,
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString()
      });
    }
    return backups.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function createBackup(profile) {
  if (!exists(profile.paths.saveDir)) {
    throw new Error(`Save folder not found: ${profile.paths.saveDir}`);
  }
  const backupName = `dragonwilds-save-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}.zip`;
  const outPath = path.join(profile.paths.backupDir, backupName);
  const script = [
    "$ErrorActionPreference='Stop'",
    `New-Item -ItemType Directory -Force -Path ${psString(profile.paths.backupDir)} | Out-Null`,
    `Compress-Archive -LiteralPath ${psString(profile.paths.saveDir)} -DestinationPath ${psString(outPath)} -Force`
  ].join("; ");
  return powershellTask("Create save backup", script);
}

async function restoreBackup(profile, backupId) {
  const safeName = path.basename(backupId);
  const backupPath = path.join(profile.paths.backupDir, safeName);
  const resolvedBackup = path.resolve(backupPath);
  const resolvedBackupDir = path.resolve(profile.paths.backupDir);
  if (!resolvedBackup.startsWith(resolvedBackupDir)) {
    throw new Error("Backup path is outside the configured backup folder.");
  }
  if (!exists(resolvedBackup)) {
    throw new Error(`Backup not found: ${safeName}`);
  }

  const safetyPath = `${profile.paths.saveDir}.before-restore-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}`;
  const script = [
    "$ErrorActionPreference='Stop'",
    `if (Test-Path -LiteralPath ${psString(profile.paths.saveDir)}) { Move-Item -LiteralPath ${psString(profile.paths.saveDir)} -Destination ${psString(safetyPath)} }`,
    `New-Item -ItemType Directory -Force -Path ${psString(profile.paths.saveDir)} | Out-Null`,
    `Expand-Archive -LiteralPath ${psString(resolvedBackup)} -DestinationPath ${psString(profile.paths.saveDir)} -Force`,
    `Write-Output ${psString(`Safety copy created at ${safetyPath}`)}`
  ].join("; ");
  return powershellTask(`Restore backup ${safeName}`, script);
}

function checkTcpPort(portNumber) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(350);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(Number(portNumber), "127.0.0.1");
  });
}

async function getStatus() {
  const profile = await getProfile();
  const steamcmdExe = path.join(profile.paths.steamcmdDir, "steamcmd.exe");
  const install = await detectServerInstall(profile);
  const backups = await listBackups(profile);
  const logLines = await readLastLines(profile.paths.logPath, serverLogSnapshotLimit);
  const activityLines = await readLastLines(activityLogPath, activityLogSnapshotLimit);
  const tcpPortOpen = await checkTcpPort(profile.server.port);

  return {
    appVersion: appPackage.version,
    generatedAt: timestamp(),
    serverRunning: Boolean(serverProcess && !serverProcess.killed),
    serverPid: serverProcess?.pid || null,
    task: taskSnapshot(),
    selectedPort: Number(profile.server.port),
    tcpPortOpen,
    paths: {
      steamcmd: { path: steamcmdExe, exists: exists(steamcmdExe) },
      serverDir: { path: profile.paths.serverDir, exists: install.serverDirExists },
      serverInstall: {
        installed: install.installed,
        manifestPath: install.manifestPath,
        payloadFileCount: install.payloadFileCount,
        expectedExecutables: install.expectedExecutables
      },
      serverExe: { path: install.serverExe, exists: Boolean(install.serverExe) },
      config: { path: profile.paths.configPath, exists: exists(profile.paths.configPath) },
      saves: { path: profile.paths.saveDir, exists: exists(profile.paths.saveDir) },
      log: { path: profile.paths.logPath, exists: exists(profile.paths.logPath) },
      backups: { path: profile.paths.backupDir, exists: exists(profile.paths.backupDir) }
    },
    backups: backups.slice(0, 8),
    logLines,
    activityLines
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendError(response, error, statusCode = 500) {
  sendJson(response, statusCode, {
    error: error.message || String(error)
  });
}

async function handleApi(request, response, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/app") {
      const [profile, releaseNotes, status] = await Promise.all([
        getProfile(),
        readJson(path.join(publicRoot, "release-notes.json"), null),
        getStatus()
      ]);
      sendJson(response, 200, {
        name: "Dragonwilds Server Control",
        version: appPackage.version,
        profile,
        releaseNotes,
        status,
        update: getUpdateState()
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, await getStatus());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/updates") {
      sendJson(response, 200, { update: getUpdateState() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/updates/check") {
      sendJson(response, 202, { update: await checkForAppUpdates() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/updates/install") {
      sendJson(response, 202, { update: await installDownloadedAppUpdate() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/settings") {
      sendJson(response, 200, await getProfile());
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const body = await readBody(request);
      const saved = await saveProfile(body);
      sendJson(response, 200, { profile: saved, status: await getStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/install") {
      sendJson(response, 202, { task: await runInstall(await getProfile(), true) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/update") {
      sendJson(response, 202, { task: await runInstall(await getProfile(), false) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/repair") {
      sendJson(response, 202, { task: await runInstall(await getProfile(), true) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tasks/active/input") {
      const body = await readBody(request);
      sendJson(response, 202, { task: sendTaskInput(body.input || body.command || "") });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tasks/active/stop") {
      sendJson(response, 202, { task: stopActiveTask() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/start") {
      sendJson(response, 202, { server: await startGameServer(await getProfile()) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/stop") {
      sendJson(response, 202, { task: stopGameServer() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/restart") {
      const profile = await getProfile();
      if (serverProcess && serverProcess.pid) {
        serverProcess.kill();
        serverProcess = null;
      }
      sendJson(response, 202, { server: await startGameServer(profile) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/backups") {
      sendJson(response, 200, { backups: await listBackups(await getProfile()) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/backups") {
      sendJson(response, 202, { task: await createBackup(await getProfile()) });
      return;
    }

    const restoreMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
    if (request.method === "POST" && restoreMatch) {
      sendJson(response, 202, {
        task: await restoreBackup(await getProfile(), decodeURIComponent(restoreMatch[1]))
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/logs") {
      const profile = await getProfile();
      const count = Math.min(Number(url.searchParams.get("lines") || 1200), 5000);
      sendJson(response, 200, {
        logLines: await readLastLines(profile.paths.logPath, count),
        activityLines: await readLastLines(activityLogPath, count)
      });
      return;
    }

    sendJson(response, 404, { error: "API route not found" });
  } catch (error) {
    sendError(response, error);
  }
}

async function serveStatic(request, response, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicRoot, safePath);

  if (!filePath.startsWith(publicRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const data = await fsp.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(data);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500);
    response.end(error.code === "ENOENT" ? "Not found" : error.message);
  }
}

function openBrowser(targetUrl) {
  if (noOpen) return;
  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", targetUrl] : [targetUrl];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function startControlServer() {
  if (controlServer) {
    const address = controlServer.address();
    const activePort = typeof address === "object" && address ? address.port : port;
    return {
      server: controlServer,
      url: `http://${host}:${activePort}`
    };
  }

  await ensureDataDir();
  await writeJson(profilePath, await getProfile());

  controlServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(request, response, url);
  });

  return new Promise((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(port, host, () => {
      controlServer.off("error", reject);
      const address = controlServer.address();
      const activePort = typeof address === "object" && address ? address.port : port;
      const targetUrl = `http://${host}:${activePort}`;
      console.log(`Dragonwilds Server Control ${appPackage.version}`);
      console.log(`Listening on ${targetUrl}`);
      console.log(`Data directory: ${dataDir}`);
      openBrowser(targetUrl);
      resolve({ server: controlServer, url: targetUrl });
    });
  });
}

function stopControlServer() {
  return new Promise((resolve, reject) => {
    if (!controlServer) {
      resolve();
      return;
    }
    controlServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      controlServer = null;
      resolve();
    });
  });
}

module.exports = {
  startControlServer,
  stopControlServer
};

if (require.main === module) {
  startControlServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
