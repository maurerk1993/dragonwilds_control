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
const ignoreExternalServerProcess = process.env.DWSC_TEST_IGNORE_EXTERNAL_SERVER_PROCESS === "1";
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
const serverProcessNames = [
  ...serverExeCandidates.map((fileName) => path.basename(fileName, path.extname(fileName))),
  "RSDragonwildsServer-Win64-Shipping"
];
const taskOutputLimit = 12000;
const taskOutputSnapshotLimit = 4000;
const activityLogSnapshotLimit = 8000;
const serverLogSnapshotLimit = 5000;
const logRetentionHours = 72;
const logRetentionMs = logRetentionHours * 60 * 60 * 1000;
const activityLogPruneIntervalMs = 5 * 60 * 1000;
const gracefulStopTimeoutSeconds = 30;
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
  backups: {
    retentionCount: 10
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
  const retentionCount = Number(next.backups?.retentionCount);
  if (!next.server.worldPassword && next.server.password) {
    next.server.worldPassword = next.server.password;
  }
  next.server.password = next.server.worldPassword || "";
  next.server.port = gamePort;
  next.server.queryPort = gamePort + 1;
  next.server.launchArgs = String(next.server.launchArgs || "").trim() || defaultProfile.server.launchArgs;
  next.backups = {
    ...defaultProfile.backups,
    ...(next.backups || {}),
    retentionCount: Number.isInteger(retentionCount) && retentionCount > 0 ? Math.min(retentionCount, 999) : defaultProfile.backups.retentionCount
  };
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
  if (next.writeIniOnSave && await isDragonwildsServerRunning()) {
    throw new Error("Stop the Dragonwilds server before saving setup changes. The game can overwrite live config edits.");
  }
  await writeJson(profilePath, next);
  serverDetectionCache = null;
  const config = getDedicatedConfigStatus(next);
  if (next.writeIniOnSave && config.ready) {
    const install = await detectServerInstall(next);
    if (isInstallTaskRunning()) {
      lastIniPatchError = null;
      appendActivity("Settings saved. DedicatedServer.ini patching is waiting for the current install/update task to finish.");
    } else if (install.readyForSetup) {
      if (!hasDedicatedConfigSource(next)) {
        lastIniPatchError = null;
        appendActivity("Settings saved. Run Generate Config to let Dragonwilds create DedicatedServer.ini before patching setup values.");
      } else {
        try {
          await patchDedicatedServerIni(next, { allowTemplateCopy: true });
        } catch (error) {
          lastIniPatchError = { message: error.message, at: timestamp() };
          appendActivity(`Settings saved, but DedicatedServer.ini was not patched: ${error.message}`);
        }
      }
    } else {
      lastIniPatchError = null;
      appendActivity("Settings saved. Waiting for the Dragonwilds server executable before checking DedicatedServer.ini.");
    }
  } else if (next.writeIniOnSave) {
    lastIniPatchError = null;
    appendActivity(
      `Settings saved to profile. DedicatedServer.ini was not written because setup is incomplete: ${config.missingRequired.join(", ")}.`
    );
  }
  return next;
}

async function saveBackupSettings(settings) {
  const profile = normalizeProfile(await getProfile());
  const retentionCount = Number(settings?.retentionCount);
  if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 999) {
    throw new Error("Keep last backups must be a whole number from 1 to 999.");
  }
  profile.backups = {
    ...(profile.backups || {}),
    retentionCount
  };
  await writeJson(profilePath, profile);
  await pruneBackups(profile);
  appendActivity(`Backup retention changed to keep last ${retentionCount}.`);
  return profile;
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
  const readyForSetup = Boolean(serverExe);
  const installed = readyForSetup;
  const result = {
    installed,
    readyForSetup,
    serverDirExists,
    serverExe,
    manifestPath,
    payloadFileCount,
    partialInstallDetected: Boolean(!readyForSetup && (manifestPath || payloadFileCount > 0)),
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
    windowCommand: activeTask.windowCommand,
    scriptPath: activeTask.scriptPath,
    userPrompt: activeTask.userPrompt || null,
    canReceiveInput:
      activeTask.acceptsInput &&
      ["running", "stopping"].includes(activeTask.status) &&
      Boolean(activeTask.child?.stdin && !activeTask.child.stdin.destroyed),
    outputLineCount: activeTask.output.length,
    recentOutput: activeTask.output.slice(-taskOutputSnapshotLimit)
  };
}

function isInstallTaskRunning() {
  return Boolean(
    activeTask &&
      ["running", "stopping"].includes(activeTask.status) &&
      /install|update|repair/i.test(activeTask.name || "")
  );
}

function hasDedicatedConfigSource(profile) {
  return exists(profile.paths.configPath) || getDedicatedConfigTemplateStatus(profile).exists;
}

function promptUserToCloseFirstRunConsole(taskId) {
  if (!activeTask || activeTask.id !== taskId || !["running", "stopping"].includes(activeTask.status)) return;
  const message =
    "Close the Dragonwilds server console now. After it closes, the app will check for DedicatedServer.ini again.";
  activeTask.userPrompt = message;
  pushTaskOutput(activeTask, message);
  appendActivity(message);
}

function safeTaskFileName(name) {
  return String(name || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

function safeWindowTitle(name) {
  return `Dragonwilds Server Control - ${String(name || "Task").replace(/["&<>|]/g, "")}`.slice(0, 120);
}

function removeQuietly(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Temporary task scripts are best-effort cleanup.
  }
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
    acceptsInput: options.acceptsInput !== false,
    externalWindow: Boolean(options.externalWindow),
    windowCommand: options.windowCommand || null,
    scriptPath: options.scriptPath || null,
    userPrompt: options.userPrompt || null
  };
  activeTask = task;
  appendActivity(`Task started: ${name}${task.externalWindow ? " (external command window opened)" : ""}`);

  for (const line of options.initialOutput || []) {
    pushTaskOutput(task, line);
  }

  const {
    acceptsInput,
    cleanupPaths,
    externalWindow,
    initialOutput,
    onComplete,
    scriptPath,
    windowCommand,
    windowsHide,
    ...spawnOptions
  } = options;
  const child = spawn(command, args, {
    stdio: [task.acceptsInput ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: process.platform === "win32" ? (windowsHide ?? !task.externalWindow) : true,
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
    for (const filePath of cleanupPaths || []) removeQuietly(filePath);
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
    for (const filePath of cleanupPaths || []) removeQuietly(filePath);
    if (typeof onComplete === "function") {
      setTimeout(() => {
        Promise.resolve(onComplete({ exitCode, task }))
          .catch((error) => appendActivity(`Post-task action failed for ${name}: ${error.message}`));
      }, 250);
    }
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

function powershellTask(name, script, options = {}) {
  if (process.platform === "win32") {
    return windowsExternalPowerShellTask(name, script, options);
  }

  return beginTask(name, "powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ], options);
}

function windowsExternalPowerShellTask(name, script, options = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const {
    initialOutput,
    pauseAtEnd = true,
    ...taskOptions
  } = options;
  const taskSlug = `${Date.now()}-${safeTaskFileName(name)}`;
  const ps1Path = path.join(dataDir, `${taskSlug}.ps1`);
  const cmdPath = path.join(dataDir, `${taskSlug}.cmd`);
  const title = safeWindowTitle(name);
  const ps1 = [
    "$ErrorActionPreference = 'Stop'",
    `$Host.UI.RawUI.WindowTitle = ${psString(title)}`,
    script
  ].join(os.EOL);
  const cmd = [
    "@echo off",
    `title ${title}`,
    "echo Dragonwilds Server Control",
    `echo Task: ${name.replace(/[&<>|]/g, "")}`,
    "echo.",
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}"`,
    "set DWSC_EXIT=%ERRORLEVEL%",
    "echo.",
    "echo Task finished with exit code %DWSC_EXIT%.",
    pauseAtEnd
      ? "echo Close this window or press any key to return to Dragonwilds Server Control."
      : "echo Returning to Dragonwilds Server Control automatically.",
    pauseAtEnd ? "pause >nul" : "timeout /t 2 >nul",
    "exit /b %DWSC_EXIT%"
  ].join(os.EOL);

  fs.writeFileSync(ps1Path, ps1, "utf8");
  fs.writeFileSync(cmdPath, cmd, "utf8");

  const commandArgs = ["/d", "/s", "/c", cmdPath];
  return beginTask(name, "cmd.exe", commandArgs, {
    acceptsInput: false,
    cleanupPaths: [ps1Path, cmdPath],
    detached: true,
    externalWindow: true,
    initialOutput: initialOutput || [
      `Opened a separate command window for ${name}.`,
      `Command: cmd.exe ${formatLaunchArgsForDisplay(commandArgs)}`,
      `Script: ${cmdPath}`,
      "Watch the external command window for live SteamCMD/PowerShell output and prompts.",
      pauseAtEnd
        ? "The app will mark this task finished after that window is closed or you press a key at the end."
        : "The app will continue automatically after that command window closes."
    ],
    scriptPath: cmdPath,
    stdio: "ignore",
    windowCommand: `cmd.exe ${formatLaunchArgsForDisplay(commandArgs)}`,
    windowsHide: false,
    ...taskOptions
  });
}

function cmdArgument(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function windowsExternalExecutableTask(name, executablePath, args, options = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const taskSlug = `${Date.now()}-${safeTaskFileName(name)}`;
  const cmdPath = path.join(dataDir, `${taskSlug}.cmd`);
  const title = safeWindowTitle(name);
  const commandLine = [cmdArgument(executablePath), ...(args || []).map(cmdArgument)].join(" ");
  const cmd = [
    "@echo off",
    `title ${title}`,
    "echo Dragonwilds Server Control",
    `echo Task: ${name.replace(/[&<>|]/g, "")}`,
    "echo.",
    "echo The dedicated server is being launched once so it can create its default config files.",
    "echo Leave this window open for at least 10 seconds.",
    "echo When the control app asks you to close this server console, close this window.",
    "echo.",
    commandLine,
    "set DWSC_EXIT=%ERRORLEVEL%",
    "echo.",
    "echo Server process exited with code %DWSC_EXIT%.",
    "echo Close this window or press any key to return to Dragonwilds Server Control.",
    "pause >nul",
    "exit /b %DWSC_EXIT%"
  ].join(os.EOL);

  fs.writeFileSync(cmdPath, cmd, "utf8");

  const commandArgs = ["/d", "/s", "/c", cmdPath];
  return beginTask(name, "cmd.exe", commandArgs, {
    acceptsInput: false,
    cleanupPaths: [cmdPath],
    detached: true,
    externalWindow: true,
    initialOutput: options.initialOutput || [
      `Opened ${path.basename(executablePath)} once to let Dragonwilds create DedicatedServer.ini.`,
      "Wait 10 seconds, then close the external server console when prompted.",
      `Script: ${cmdPath}`
    ],
    scriptPath: cmdPath,
    stdio: "ignore",
    windowCommand: `cmd.exe ${formatLaunchArgsForDisplay(commandArgs)}`,
    windowsHide: false,
    ...options
  });
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psArray(values) {
  return `@(${values.map(psString).join(",")})`;
}

function isManagedServerProcessRunning() {
  return Boolean(
    serverProcess &&
    serverProcess.pid &&
    serverProcess.exitCode === null &&
    serverProcess.signalCode === null
  );
}

function runProcessCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function getRunningDragonwildsProcesses() {
  const managedPid = isManagedServerProcessRunning() ? serverProcess.pid : null;
  if (ignoreExternalServerProcess) {
    return managedPid ? [{ pid: managedPid, name: "App-managed server", source: "managed" }] : [];
  }
  if (process.platform !== "win32") {
    return managedPid ? [{ pid: managedPid, name: "App-managed server", source: "managed" }] : [];
  }

  const script = [
    `$names = ${psArray(serverProcessNames)}`,
    "$items = @()",
    "foreach ($name in $names) {",
    "  foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {",
    "    $items += [PSCustomObject]@{ Id = $process.Id; ProcessName = $process.ProcessName; Path = $process.Path }",
    "  }",
    "}",
    "foreach ($process in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*Dragonwilds*Server*' })) {",
    "  $items += [PSCustomObject]@{ Id = $process.Id; ProcessName = $process.ProcessName; Path = $process.Path }",
    "}",
    "$items | Sort-Object -Property Id -Unique | ConvertTo-Json -Compress"
  ].join("; ");

  try {
    const result = await runProcessCapture("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ]);
    const raw = result.stdout.trim();
    if (!raw) {
      return managedPid ? [{ pid: managedPid, name: "App-managed server", source: "managed" }] : [];
    }
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter((item) => item && item.Id)
      .map((item) => ({
        pid: Number(item.Id),
        name: item.ProcessName || "Dragonwilds server",
        path: item.Path || null,
        source: Number(item.Id) === managedPid ? "managed" : "external"
      }));
  } catch (error) {
    appendActivity(`Could not scan Dragonwilds server processes: ${error.message}`);
    return managedPid ? [{ pid: managedPid, name: "App-managed server", source: "managed" }] : [];
  }
}

async function isDragonwildsServerRunning() {
  return (await getRunningDragonwildsProcesses()).length > 0;
}

function trySendGracefulQuitToManagedServer(taskName) {
  if (!isManagedServerProcessRunning() || !serverProcess.stdin || serverProcess.stdin.destroyed) {
    return false;
  }

  try {
    serverProcess.stdin.write(`quit${os.EOL}`);
    appendActivity(`${taskName}: sent quit command to the app-managed Dragonwilds server.`);
    return true;
  } catch (error) {
    appendActivity(`${taskName}: could not send quit command to the app-managed server: ${error.message}`);
    return false;
  }
}

function readServerWasRunningMarker(markerPath) {
  try {
    return fs.readFileSync(markerPath, "utf8").trim().toLowerCase() === "running";
  } catch {
    return false;
  }
}

function gracefulStopDragonwildsTask(name, options = {}) {
  const {
    markerPath,
    timeoutSeconds = gracefulStopTimeoutSeconds,
    ...taskOptions
  } = options;
  const timeout = Math.max(5, Number(timeoutSeconds) || gracefulStopTimeoutSeconds);
  const managedServerWasRunning = isManagedServerProcessRunning();
  trySendGracefulQuitToManagedServer(name);

  const script = [
    `$names = ${psArray(serverProcessNames)}`,
    `$timeoutSeconds = ${timeout}`,
    `$managedServerWasRunning = ${managedServerWasRunning ? "$true" : "$false"}`,
    "function Get-DragonwildsProcesses {",
    "  $items = @()",
    "  foreach ($name in $names) {",
    "    $items += @(Get-Process -Name $name -ErrorAction SilentlyContinue)",
    "  }",
    "  $items | Sort-Object -Property Id -Unique",
    "}",
    "$initial = @(Get-DragonwildsProcesses)",
    markerPath ? `New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${psString(markerPath)}) | Out-Null` : null,
    markerPath
      ? `Set-Content -LiteralPath ${psString(markerPath)} -Encoding ASCII -Value $(if ($initial.Count -gt 0 -or $managedServerWasRunning) { 'running' } else { 'not-running' })`
      : null,
    "if ($initial.Count -eq 0) { Write-Output 'No Dragonwilds server process was running.'; exit 0 }",
    "Write-Output ('Found {0} Dragonwilds server process(es). Requesting graceful shutdown for up to {1} seconds.' -f $initial.Count, $timeoutSeconds)",
    "foreach ($process in $initial) {",
    "  try { if ($process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() } } catch {}",
    "}",
    "Start-Sleep -Seconds 2",
    "foreach ($process in $initial) {",
    "  $processId = $process.Id",
    "  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { & taskkill.exe /PID $processId /T | Out-Host }",
    "}",
    "$deadline = (Get-Date).AddSeconds($timeoutSeconds)",
    "while ((Get-Date) -lt $deadline) {",
    "  Start-Sleep -Seconds 1",
    "  if (@(Get-DragonwildsProcesses).Count -eq 0) { Write-Output 'Dragonwilds server stopped gracefully.'; exit 0 }",
    "}",
    "$remaining = @(Get-DragonwildsProcesses)",
    "if ($remaining.Count -gt 0) {",
    "  Write-Output ('Graceful shutdown timed out; forcing {0} remaining Dragonwilds process(es).' -f $remaining.Count)",
    "  foreach ($process in $remaining) {",
    "    $processId = $process.Id",
    "    & taskkill.exe /PID $processId /T /F | Out-Host",
    "  }",
    "}",
    "Start-Sleep -Seconds 2",
    "$after = @(Get-DragonwildsProcesses)",
    "if ($after.Count -gt 0) { Write-Error ('Unable to stop Dragonwilds server process(es): {0}' -f (($after | Select-Object -ExpandProperty Id) -join ', ')); exit 1 }",
    "Write-Output 'Dragonwilds server processes are stopped.'",
    "exit 0"
  ].filter(Boolean).join("; ");

  return powershellTask(name, script, {
    pauseAtEnd: false,
    ...taskOptions
  });
}

function steamcmdString(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

async function runInstall(profile, validate, options = {}) {
  const {
    onComplete,
    skipFirstRunConfigBootstrap = false,
    ...taskOptions
  } = options;
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

  return powershellTask(validate ? "Install or repair server with validate" : "Update server", script, {
    ...taskOptions,
    onComplete: async ({ exitCode, task }) => {
      if (exitCode === 0 && !skipFirstRunConfigBootstrap) {
        await maybeStartFirstRunConfigBootstrap();
      }
      if (typeof onComplete === "function") {
        await onComplete({ exitCode, task });
      }
    }
  });
}

async function runUpdateServerWorkflow(profile) {
  fs.mkdirSync(dataDir, { recursive: true });
  const restartMarkerPath = path.join(dataDir, `${Date.now()}-update-server-restart-state.txt`);
  appendActivity("Update workflow started. Dragonwilds will be stopped before SteamCMD updates the server files.");

  return gracefulStopDragonwildsTask("Stop server before update", {
    markerPath: restartMarkerPath,
    onComplete: async ({ exitCode }) => {
      if (exitCode !== 0) {
        removeQuietly(restartMarkerPath);
        appendActivity("Update server skipped because Dragonwilds could not be stopped cleanly.");
        return;
      }

      const shouldRestart = readServerWasRunningMarker(restartMarkerPath);
      appendActivity(
        shouldRestart
          ? "Dragonwilds was running before update. It will restart after SteamCMD finishes."
          : "Dragonwilds was already offline before update. It will stay offline after SteamCMD finishes."
      );

      try {
        await runInstall(await getProfile(), false, {
          skipFirstRunConfigBootstrap: true,
          onComplete: async ({ exitCode: updateExitCode }) => {
            removeQuietly(restartMarkerPath);
            if (updateExitCode !== 0) {
              appendActivity(`Server restart skipped because SteamCMD update failed (exit ${updateExitCode}).`);
              return;
            }
            if (!shouldRestart) {
              appendActivity("Update complete. Dragonwilds was offline before update, so it was left offline.");
              return;
            }

            try {
              await startGameServer(await getProfile());
              appendActivity("Update complete. Dragonwilds server restarted.");
            } catch (error) {
              appendActivity(`Update complete, but the server could not be restarted: ${error.message}`);
            }
          }
        });
      } catch (error) {
        removeQuietly(restartMarkerPath);
        appendActivity(`Update server did not start after stopping Dragonwilds: ${error.message}`);
      }
    }
  });
}

async function maybeStartFirstRunConfigBootstrap() {
  const profile = await getProfile();
  const install = await detectServerInstall(profile);
  if (!install.readyForSetup || !install.serverExe) {
    appendActivity("Install finished, but the Dragonwilds server executable was not detected yet. First-run config generation was skipped.");
    return null;
  }

  if (hasDedicatedConfigSource(profile)) {
    appendActivity("DedicatedServer.ini or official config template already exists. First-run config generation was skipped.");
    return null;
  }

  appendActivity("No DedicatedServer.ini/template was found after install. Launching the server executable once to let Dragonwilds generate config files.");
  return startFirstRunConfigBootstrap(profile, install.serverExe);
}

function startFirstRunConfigBootstrap(profile, serverExe) {
  const args = getEffectiveLaunchArgs(profile);
  const snapshot = windowsExternalExecutableTask("Generate DedicatedServer.ini first-run config", serverExe, args, {
    onComplete: async () => {
      serverDetectionCache = null;
      const currentProfile = await getProfile();
      if (hasDedicatedConfigSource(currentProfile)) {
        appendActivity("DedicatedServer.ini/config template is now available. Complete setup values and save them before starting the server.");
      } else {
        appendActivity(
          `DedicatedServer.ini is still missing after first-run config generation. Expected ${currentProfile.paths.configPath} or ${getDedicatedConfigTemplateStatus(currentProfile).path}.`
        );
      }
    }
  });

  setTimeout(() => promptUserToCloseFirstRunConsole(snapshot.id), 10000);
  return snapshot;
}

async function startGameServer(profile) {
  const runningProcesses = await getRunningDragonwildsProcesses();
  if (runningProcesses.length) {
    throw new Error("Dragonwilds dedicated server is already running.");
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

async function restartGameServer(profile) {
  const runningProcesses = await getRunningDragonwildsProcesses();
  if (!runningProcesses.length) {
    return startGameServer(profile);
  }

  return gracefulStopDragonwildsTask("Restart Dragonwilds server", {
    pauseAtEnd: false,
    onComplete: async ({ exitCode }) => {
      if (exitCode !== 0) {
        appendActivity("Restart skipped because Dragonwilds could not be stopped cleanly.");
        return;
      }
      await startGameServer(await getProfile());
    }
  });
}

async function stopGameServer() {
  const runningProcesses = await getRunningDragonwildsProcesses();
  if (!runningProcesses.length) {
    throw new Error("Dragonwilds dedicated server is not running.");
  }
  return gracefulStopDragonwildsTask("Stop Dragonwilds server processes");
}

function openPathDetached(targetPath, selectFile = false) {
  const resolvedTarget = path.resolve(targetPath);
  if (process.platform === "win32") {
    const args = selectFile ? [`/select,${resolvedTarget}`] : [resolvedTarget];
    const child = spawn("explorer.exe", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return;
  }

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [resolvedTarget], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

async function openDedicatedConfigFile(profile) {
  const configPath = path.resolve(profile.paths.configPath);
  if (exists(configPath)) {
    openPathDetached(configPath, true);
    return { openedPath: configPath, selectedFile: true };
  }

  const configDir = path.dirname(configPath);
  if (exists(configDir)) {
    openPathDetached(configDir, false);
    return { openedPath: configDir, selectedFile: false };
  }

  throw new Error("DedicatedServer.ini does not exist yet. Install the server and generate config first.");
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

function resolveBackupPath(profile, backupId) {
  const safeName = path.basename(backupId);
  if (!safeName || safeName !== backupId || !safeName.toLowerCase().endsWith(".zip")) {
    throw new Error("Invalid backup name.");
  }
  const resolvedBackupDir = path.resolve(profile.paths.backupDir);
  const resolvedBackup = path.resolve(path.join(resolvedBackupDir, safeName));
  if (resolvedBackupDir !== resolvedBackup && !resolvedBackup.startsWith(`${resolvedBackupDir}${path.sep}`)) {
    throw new Error("Backup path is outside the configured backup folder.");
  }
  return { safeName, resolvedBackup };
}

async function deleteBackup(profile, backupId) {
  const { safeName, resolvedBackup } = resolveBackupPath(profile, backupId);
  if (!exists(resolvedBackup)) {
    throw new Error(`Backup not found: ${safeName}`);
  }
  await fsp.unlink(resolvedBackup);
  appendActivity(`Deleted backup ${safeName}.`);
  return { deleted: safeName };
}

async function pruneBackups(profile) {
  const keepCount = Number(profile.backups?.retentionCount || defaultProfile.backups.retentionCount);
  if (!Number.isInteger(keepCount) || keepCount < 1) return [];
  const backups = await listBackups(profile);
  const remove = backups.slice(keepCount);
  for (const backup of remove) {
    await fsp.unlink(backup.path);
    appendActivity(`Pruned old backup ${backup.name}; keeping last ${keepCount}.`);
  }
  return remove;
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
  return powershellTask("Create save backup", script, {
    onComplete: async ({ exitCode }) => {
      if (exitCode === 0) {
        await pruneBackups(await getProfile());
      }
    }
  });
}

async function restoreBackup(profile, backupId) {
  const { safeName, resolvedBackup } = resolveBackupPath(profile, backupId);
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
  await pruneBackups(profile);
  const backups = await listBackups(profile);
  const runningProcesses = await getRunningDragonwildsProcesses();
  pruneActivityLogIfNeeded();
  const logLines = await readLastLines(profile.paths.logPath, serverLogSnapshotLimit, { maxAgeMs: logRetentionMs });
  const activityLines = await readLastLines(activityLogPath, activityLogSnapshotLimit, { maxAgeMs: logRetentionMs });
  const tcpPortOpen = await checkTcpPort(profile.server.port);
  const configuration = getDedicatedConfigStatus(profile);
  const configExists = install.readyForSetup ? exists(profile.paths.configPath) : false;
  const configTemplate = install.readyForSetup
    ? getDedicatedConfigTemplateStatus(profile)
    : {
        path: dedicatedConfigTemplateCandidates(profile)[0],
        exists: false,
        candidates: dedicatedConfigTemplateCandidates(profile)
      };
  const configText = install.readyForSetup ? await readDedicatedServerIniText(profile.paths.configPath) : "";
  const selectedPort = assertValidGamePort(profile.server.port);
  const secondaryPort = getSecondaryPort(selectedPort);
  const effectiveLaunchArgs = getEffectiveLaunchArgs(profile);

  return {
    appVersion: appPackage.version,
    generatedAt: timestamp(),
    serverRunning: runningProcesses.length > 0,
    serverPid: runningProcesses[0]?.pid || null,
    serverProcesses: runningProcesses,
    task: taskSnapshot(),
    selectedPort,
    secondaryPort,
    queryPort: secondaryPort,
    effectiveLaunchArgs,
    effectiveLaunchArgsText: formatLaunchArgsForDisplay(effectiveLaunchArgs),
    tcpPortOpen,
    logRetentionHours,
    backupRetentionCount: profile.backups?.retentionCount || defaultProfile.backups.retentionCount,
    configuration: {
      ...configuration,
      iniReady: configuration.ready && configExists,
      templateAvailable: configTemplate.exists,
      lastPatchError: install.readyForSetup ? lastIniPatchError : null,
      iniText: configText
    },
    paths: {
      steamcmd: { path: steamcmdExe, exists: exists(steamcmdExe) },
      serverDir: { path: profile.paths.serverDir, exists: install.serverDirExists },
      serverInstall: {
        installed: install.installed,
        readyForSetup: install.readyForSetup,
        partialInstallDetected: install.partialInstallDetected,
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
    backups,
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
      sendJson(response, 202, { task: await runUpdateServerWorkflow(await getProfile()) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/repair") {
      sendJson(response, 202, { task: await runInstall(await getProfile(), true) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/bootstrap-config") {
      const profile = await getProfile();
      const install = await detectServerInstall(profile);
      if (!install.serverExe) {
        throw new Error("Install the Dragonwilds dedicated server before generating DedicatedServer.ini.");
      }
      sendJson(response, 202, { task: startFirstRunConfigBootstrap(profile, install.serverExe) });
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
      sendJson(response, 202, { task: await stopGameServer() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/restart") {
      const result = await restartGameServer(await getProfile());
      sendJson(response, 202, result?.status ? { task: result } : { server: result });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/files/config/open") {
      sendJson(response, 202, { file: await openDedicatedConfigFile(await getProfile()) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/backups") {
      sendJson(response, 200, { backups: await listBackups(await getProfile()) });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/backups/settings") {
      const profile = await saveBackupSettings(await readBody(request));
      sendJson(response, 200, { profile, status: await getStatus() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/backups") {
      sendJson(response, 202, { task: await createBackup(await getProfile()) });
      return;
    }

    const deleteBackupMatch = url.pathname.match(/^\/api\/backups\/([^/]+)$/);
    if (request.method === "DELETE" && deleteBackupMatch) {
      const profile = await getProfile();
      sendJson(response, 200, {
        backup: await deleteBackup(profile, decodeURIComponent(deleteBackupMatch[1])),
        backups: await listBackups(profile)
      });
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
