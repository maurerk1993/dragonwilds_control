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
let lastIniPatchError = null;
let lastActivityLogPruneAt = 0;

const serverExeCandidates = [
  "RSDragonwildsServer.exe",
  "RSDragonwilds.exe"
];
const taskOutputLimit = 12000;
const taskOutputSnapshotLimit = 4000;
const activityLogSnapshotLimit = 8000;
const serverLogSnapshotLimit = 5000;
const logRetentionHours = 72;
const logRetentionMs = logRetentionHours * 60 * 60 * 1000;
const activityLogPruneIntervalMs = 5 * 60 * 1000;
const dedicatedServerSection = "/Script/Dominion.DedicatedServerSettings";
const defaultGamePort = 7777;
const minGamePort = 1;
const maxGamePort = 65534;
const dedicatedConfigFields = [
  { field: "ownerId", label: "Owner ID", key: "OwnerId", required: true },
  { field: "name", label: "Server Name", key: "ServerName", required: true },
  { field: "worldName", label: "Default World Name", key: "DefaultWorldName", required: true },
  { field: "adminPassword", label: "Admin Password", key: "AdminPassword", required: true },
  { field: "worldPassword", label: "World Password", key: "WorldPassword", required: false }
];

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
    ownerId: "",
    name: "The Dragonwilds Server",
    password: "",
    adminPassword: "",
    worldPassword: "",
    maxPlayers: 4,
    port: defaultGamePort,
    queryPort: defaultGamePort + 1,
    publicServer: false,
    worldName: "Ashenfall",
    autoSaveMinutes: 15,
    launchArgs: "-log -NewConsole"
  },
  iniMappings: {
    ownerId: { section: dedicatedServerSection, key: "OwnerId" },
    name: { section: dedicatedServerSection, key: "ServerName" },
    worldName: { section: dedicatedServerSection, key: "DefaultWorldName" },
    adminPassword: { section: dedicatedServerSection, key: "AdminPassword" },
    worldPassword: { section: dedicatedServerSection, key: "WorldPassword" }
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

function parseGamePort(value) {
  const port = Number(value);
  return Number.isInteger(port) ? port : null;
}

function gamePortValidationMessage() {
  return `Game Port must be a whole number from ${minGamePort} to ${maxGamePort}. Dragonwilds also uses the next port as the Secondary Port.`;
}

function assertValidGamePort(value) {
  const port = parseGamePort(value);
  if (port === null || port < minGamePort || port > maxGamePort) {
    throw new Error(gamePortValidationMessage());
  }
  return port;
}

function normalizeGamePort(value) {
  const port = parseGamePort(value);
  if (port === null || port < minGamePort || port > maxGamePort) {
    return defaultGamePort;
  }
  return port;
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

function normalizeProfile(profile) {
  const next = deepMerge(defaultProfile, profile || {});
  const gamePort = normalizeGamePort(next.server.port);
  if (!next.server.worldPassword && next.server.password) {
    next.server.worldPassword = next.server.password;
  }
  next.server.password = next.server.worldPassword || "";
  next.server.port = gamePort;
  next.server.queryPort = gamePort + 1;
  next.server.launchArgs = String(next.server.launchArgs || "").trim() || defaultProfile.server.launchArgs;
  next.iniMappings = { ...defaultProfile.iniMappings };
  next.customIniValues = Array.isArray(next.customIniValues) ? next.customIniValues : [];
  return next;
}

async function readDedicatedServerIniValues(configPath) {
  let text = "";
  try {
    text = await fsp.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  const sectionPattern = new RegExp(`^\\s*\\[${escapeRegExp(dedicatedServerSection)}\\]\\s*$`, "i");
  const anySectionPattern = /^\s*\[[^\]]+\]\s*$/;
  const values = {};
  let inSection = false;

  for (const line of text.split(/\r?\n/)) {
    if (sectionPattern.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && anySectionPattern.test(line)) break;
    if (!inSection) continue;
    const match = line.match(/^\s*([^=;#]+?)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1].trim().toLowerCase()] = match[2].trim();
  }

  return {
    ownerId: values.ownerid,
    name: values.servername,
    worldName: values.defaultworldname,
    adminPassword: values.adminpassword,
    worldPassword: values.worldpassword
  };
}

async function readDedicatedServerIniText(configPath) {
  try {
    return await fsp.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    return `Could not read DedicatedServer.ini: ${error.message}`;
  }
}

function dedicatedConfigTemplateCandidates(profile) {
  return [
    path.join(profile.paths.serverDir, "RSDragonwilds", "Saved", "Config", "Linux", "DedicatedServer.ini"),
    path.join(profile.paths.serverDir, "RSDragonwilds", "Saved", "Config", "LinuxServer", "DedicatedServer.ini")
  ];
}

function getDedicatedConfigTemplateStatus(profile) {
  const candidates = dedicatedConfigTemplateCandidates(profile);
  const existing = candidates.find((candidate) => exists(candidate));
  return {
    path: existing || candidates[0],
    exists: Boolean(existing),
    candidates
  };
}

function hasIniSection(lines, section) {
  const sectionPattern = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*$`, "i");
  return lines.some((line) => sectionPattern.test(line));
}

async function hydrateProfileFromIni(profile) {
  const next = normalizeProfile(profile);
  const iniValues = await readDedicatedServerIniValues(next.paths.configPath);
  for (const field of dedicatedConfigFields) {
    const value = iniValues[field.field];
    if (valueIsSet(value) && !valueIsSet(next.server[field.field])) {
      next.server[field.field] = value;
    }
  }
  next.server.password = next.server.worldPassword || "";
  return next;
}

async function getProfile() {
  const stored = await readJson(profilePath, {});
  return hydrateProfileFromIni(stored);
}

async function saveProfile(profile) {
  assertValidGamePort(profile?.server?.port ?? defaultProfile.server.port);
  const next = normalizeProfile(profile);
  await writeJson(profilePath, next);
  serverDetectionCache = null;
  const config = getDedicatedConfigStatus(next);
  if (next.writeIniOnSave && config.ready) {
    const install = await detectServerInstall(next);
    if (install.installed) {
      try {
        await patchDedicatedServerIni(next, { allowTemplateCopy: true });
      } catch (error) {
        lastIniPatchError = { message: error.message, at: timestamp() };
        appendActivity(`Settings saved, but DedicatedServer.ini was not patched: ${error.message}`);
      }
    } else {
      lastIniPatchError = null;
      appendActivity("Settings saved. Install the dedicated server before patching DedicatedServer.ini.");
    }
  } else if (next.writeIniOnSave) {
    lastIniPatchError = null;
    appendActivity(
      `Settings saved to profile. DedicatedServer.ini was not written because setup is incomplete: ${config.missingRequired.join(", ")}.`
    );
  }
  return next;
}

function valueIsSet(value) {
  return String(value || "").trim().length > 0;
}

function getDedicatedConfigStatus(profile) {
  const missingRequired = dedicatedConfigFields
    .filter((field) => field.required && !valueIsSet(profile.server[field.field]))
    .map((field) => field.label);

  return {
    ready: missingRequired.length === 0,
    missingRequired,
    requiredFields: dedicatedConfigFields.filter((field) => field.required).map((field) => field.label),
    optionalFields: dedicatedConfigFields.filter((field) => !field.required).map((field) => field.label),
    values: {
      ownerIdSet: valueIsSet(profile.server.ownerId),
      serverNameSet: valueIsSet(profile.server.name),
      defaultWorldNameSet: valueIsSet(profile.server.worldName),
      adminPasswordSet: valueIsSet(profile.server.adminPassword),
      worldPasswordSet: valueIsSet(profile.server.worldPassword)
    }
  };
}

function assertDedicatedConfigReady(profile, action) {
  const config = getDedicatedConfigStatus(profile);
  if (!config.ready) {
    throw new Error(
      `Complete dedicated server setup before ${action}. Missing: ${config.missingRequired.join(", ")}.`
    );
  }
  return config;
}

function iniValuesFromProfile(profile) {
  const mapped = [];
  for (const field of dedicatedConfigFields) {
    const mapping = defaultProfile.iniMappings[field.field];
    const value = profile.server[field.field];
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

async function ensureDedicatedServerIniForPatch(profile, options = {}) {
  const configPath = profile.paths.configPath;
  if (exists(configPath)) {
    return { path: configPath, source: "windows" };
  }

  if (!options.allowTemplateCopy) {
    throw new Error(`DedicatedServer.ini was not found at ${configPath}. Install the server first, then save setup.`);
  }

  const template = getDedicatedConfigTemplateStatus(profile);
  if (!template.exists) {
    throw new Error(
      `DedicatedServer.ini was not found. Install or update the server first, then save setup again. Expected Windows config at ${configPath} or official Linux template at ${template.path}.`
    );
  }

  const templateText = await fsp.readFile(template.path, "utf8");
  const templateLines = templateText.split(/\r?\n/);
  if (!hasIniSection(templateLines, dedicatedServerSection)) {
    throw new Error(
      `The official template at ${template.path} does not contain [${dedicatedServerSection}], so the app refused to create a Windows config from it.`
    );
  }

  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.copyFile(template.path, configPath);
  appendActivity(`Copied official DedicatedServer.ini template from ${template.path} to ${configPath}.`);
  return { path: configPath, source: "template", copiedFrom: template.path };
}

async function patchDedicatedServerIni(profile, options = {}) {
  const configPath = profile.paths.configPath;
  await ensureDedicatedServerIniForPatch(profile, options);
  let lines = (await fsp.readFile(configPath, "utf8")).split(/\r?\n/);

  const sections = new Set();
  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (match) sections.add(match[1].trim().toLowerCase());
  }

  for (const entry of iniValuesFromProfile(profile)) {
    if (!sections.has(entry.section.toLowerCase())) {
      throw new Error(
        `DedicatedServer.ini does not contain [${entry.section}], so the app refused to create that section.`
      );
    }
    lines = upsertIniValue(lines, entry.section, entry.key, entry.value);
  }

  await fsp.writeFile(configPath, `${lines.join(os.EOL).replace(/\s+$/g, "")}${os.EOL}`, "utf8");
  lastIniPatchError = null;
  appendActivity(`Patched DedicatedServer.ini using the official file at ${configPath}.`);
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
      const replacement = `${prefix}${key}=${value}`;
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

function parseLogTimestamp(line) {
  const match = String(line || "").match(/^\[([^\]]+)\]/);
  if (!match) return null;
  const time = Date.parse(match[1]);
  return Number.isFinite(time) ? time : null;
}

function filterLinesByAge(lines, maxAgeMs, keepUndated = true) {
  if (!maxAgeMs) return lines;
  const cutoff = Date.now() - maxAgeMs;
  return lines.filter((line) => {
    const time = parseLogTimestamp(line);
    if (time === null) return keepUndated;
    return time >= cutoff;
  });
}

function pruneActivityLogIfNeeded(force = false) {
  const now = Date.now();
  if (!force && now - lastActivityLogPruneAt < activityLogPruneIntervalMs) return;
  lastActivityLogPruneAt = now;
  if (!exists(activityLogPath)) return;

  try {
    const text = fs.readFileSync(activityLogPath, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const retained = filterLinesByAge(lines, logRetentionMs, true);
    if (retained.length !== lines.length) {
      fs.writeFileSync(activityLogPath, `${retained.join(os.EOL)}${retained.length ? os.EOL : ""}`, "utf8");
    }
  } catch (error) {
    console.warn(`Could not prune activity log: ${error.message}`);
  }
}

async function readLastLines(filePath, lineCount = 300, options = {}) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    const lines = filterLinesByAge(
      text.split(/\r?\n/).filter(Boolean),
      options.maxAgeMs,
      options.keepUndated !== false
    );
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
  pruneActivityLogIfNeeded();
}

function splitArgs(argsText) {
  if (!argsText) return [];
  const matches = String(argsText).match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((value) => value.replace(/^"|"$/g, ""));
}

function getSecondaryPort(gamePort) {
  return assertValidGamePort(gamePort) + 1;
}

function getEffectiveLaunchArgs(profile) {
  const gamePort = assertValidGamePort(profile.server.port);
  const args = splitArgs(profile.server.launchArgs);
  const filteredArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const lowerArg = arg.toLowerCase();
    if (lowerArg === "-port") {
      index += 1;
      continue;
    }
    if (lowerArg.startsWith("-port=")) {
      continue;
    }
    filteredArgs.push(arg);
  }

  return [...filteredArgs, `-port=${gamePort}`];
}

function formatLaunchArgsForDisplay(args) {
  return args
    .map((arg) => {
      const text = String(arg);
      return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
    })
    .join(" ");
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
    externalWindow: Boolean(activeTask.externalWindow),
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
    child: null,
    externalWindow: process.platform === "win32" && options.showWindow !== false
  };
  activeTask = task;
  appendActivity(`Task started: ${name}${task.externalWindow ? " (external command window requested)" : ""}`);

  const { showWindow, ...spawnOptions } = options;
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32" ? !task.externalWindow : true,
    ...spawnOptions
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

  assertDedicatedConfigReady(profile, "starting the server");
  const install = await detectServerInstall(profile);
  if (!install.serverExe) {
    if (install.installed) {
      throw new Error(
        `Server files were found, but no runnable executable was detected. Expected one of: ${serverExeCandidates.join(", ")}.`
      );
    }
    throw new Error("The Dragonwilds dedicated server is not installed yet. Run the initial install first.");
  }

  const args = getEffectiveLaunchArgs(profile);
  await patchDedicatedServerIni(profile, { allowTemplateCopy: true });

  appendActivity(`Starting server: ${install.serverExe} ${formatLaunchArgsForDisplay(args)}`);
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
  pruneActivityLogIfNeeded();
  const logLines = await readLastLines(profile.paths.logPath, serverLogSnapshotLimit, { maxAgeMs: logRetentionMs });
  const activityLines = await readLastLines(activityLogPath, activityLogSnapshotLimit, { maxAgeMs: logRetentionMs });
  const tcpPortOpen = await checkTcpPort(profile.server.port);
  const configuration = getDedicatedConfigStatus(profile);
  const configExists = exists(profile.paths.configPath);
  const configTemplate = getDedicatedConfigTemplateStatus(profile);
  const configText = await readDedicatedServerIniText(profile.paths.configPath);
  const selectedPort = assertValidGamePort(profile.server.port);
  const secondaryPort = getSecondaryPort(selectedPort);
  const effectiveLaunchArgs = getEffectiveLaunchArgs(profile);

  return {
    appVersion: appPackage.version,
    generatedAt: timestamp(),
    serverRunning: Boolean(serverProcess && !serverProcess.killed),
    serverPid: serverProcess?.pid || null,
    task: taskSnapshot(),
    selectedPort,
    secondaryPort,
    queryPort: secondaryPort,
    effectiveLaunchArgs,
    effectiveLaunchArgsText: formatLaunchArgsForDisplay(effectiveLaunchArgs),
    tcpPortOpen,
    logRetentionHours,
    configuration: {
      ...configuration,
      iniReady: configuration.ready && configExists,
      templateAvailable: configTemplate.exists,
      lastPatchError: lastIniPatchError,
      iniText: configText
    },
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
      config: { path: profile.paths.configPath, exists: configExists },
      configTemplate,
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
      const count = Math.min(Number(url.searchParams.get("lines") || 5000), 12000);
      pruneActivityLogIfNeeded();
      sendJson(response, 200, {
        logRetentionHours,
        task: taskSnapshot(),
        logLines: await readLastLines(profile.paths.logPath, count, { maxAgeMs: logRetentionMs }),
        activityLines: await readLastLines(activityLogPath, count, { maxAgeMs: logRetentionMs })
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
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
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
