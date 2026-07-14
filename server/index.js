const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
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
let publicIpCache = {
  address: null,
  checkedAt: 0,
  error: null,
  promise: null
};
let backupScheduleTimer = null;
let backupScheduleCheckInFlight = false;
let lastIniPatchError = null;
let lastActivityLogPruneAt = 0;
let maintenanceWorkflowActive = false;
let maintenanceWorkflowName = null;
let lastStartReadinessPromise = null;
let crashRestartTimer = null;
const intentionalServerExitPids = new Set();
const serverRuntimeState = {
  expectedRunning: false,
  lastStartedAt: null,
  readinessStatus: "unknown",
  readinessMessage: "Server has not been started by this app yet.",
  readyAt: null,
  lastExitAt: null,
  lastExitCode: null,
  lastCrashAt: null,
  restartAttempts: [],
  restartScheduledAt: null,
  crashLoop: false,
  crashMessage: null
};

const serverExeCandidates = [
  "RSDragonwildsServer.exe",
  "RSDragonwilds.exe"
];
const serverProcessNames = [
  ...serverExeCandidates.map((fileName) => path.basename(fileName, path.extname(fileName))),
  "RSDragonwildsServer-Win64-Shipping"
];
const serverProcessNameSet = new Set(serverProcessNames.map((name) => name.toLowerCase()));
const taskOutputLimit = 12000;
const taskOutputSnapshotLimit = 4000;
const activityLogSnapshotLimit = 8000;
const serverLogSnapshotLimit = 5000;
const logRetentionHours = 72;
const logRetentionMs = logRetentionHours * 60 * 60 * 1000;
const activityLogPruneIntervalMs = 5 * 60 * 1000;
const publicIpRefreshMs = 10 * 60 * 1000;
const publicIpLookupTimeoutMs = 1800;
const backupScheduleCheckIntervalMs = 30 * 1000;
const gracefulStopTimeoutSeconds = 30;
const saveConfirmationTimeoutMs = 15 * 1000;
const serverReadinessTimeoutMs = 90 * 1000;
const serverReadinessPollMs = 1000;
const crashRestartWindowMs = 15 * 60 * 1000;
const crashRestartDelaysSeconds = [5, 15, 30];
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
    retentionCount: 10,
    secondaryDir: "",
    schedule: {
      enabled: false,
      time: "03:00",
      nextRunAt: null,
      lastRunStartedAt: null,
      lastRunCompletedAt: null,
      lastRunStatus: null,
      lastRunMessage: null
    }
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
  maintenance: {
    lastUpdateStartedAt: null,
    lastUpdateCompletedAt: null,
    lastUpdateStatus: null,
    lastUpdateMessage: null,
    buildIdBefore: null,
    buildIdAfter: null,
    restartReadinessStatus: null,
    restartReadyAt: null
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

function isValidDailyTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function normalizeDailyTime(value) {
  return isValidDailyTime(value) ? String(value) : defaultProfile.backups.schedule.time;
}

function getNextDailyRunAt(time, fromDate = new Date()) {
  const [hours, minutes] = normalizeDailyTime(time).split(":").map((part) => Number(part));
  const next = new Date(fromDate);
  next.setHours(hours, minutes, 0, 0);
  if (next <= fromDate) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

function normalizeBackupSchedule(schedule) {
  const merged = {
    ...defaultProfile.backups.schedule,
    ...(schedule || {})
  };
  const time = normalizeDailyTime(merged.time);
  return {
    ...merged,
    enabled: Boolean(merged.enabled),
    time,
    nextRunAt: merged.enabled && merged.nextRunAt ? merged.nextRunAt : null,
    lastRunStartedAt: merged.lastRunStartedAt || null,
    lastRunCompletedAt: merged.lastRunCompletedAt || null,
    lastRunStatus: merged.lastRunStatus || null,
    lastRunMessage: merged.lastRunMessage || null
  };
}

function normalizeMaintenance(maintenance) {
  return {
    ...defaultProfile.maintenance,
    ...(maintenance || {})
  };
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
    retentionCount: Number.isInteger(retentionCount) && retentionCount > 0 ? Math.min(retentionCount, 999) : defaultProfile.backups.retentionCount,
    secondaryDir: String(next.backups?.secondaryDir || "").trim()
  };
  next.backups.schedule = normalizeBackupSchedule(next.backups.schedule);
  next.maintenance = normalizeMaintenance(next.maintenance);
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
  const current = normalizeProfile(await getProfile());
  const next = normalizeProfile(profile);
  next.backups = current.backups;
  next.maintenance = current.maintenance;
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

  const currentSchedule = normalizeBackupSchedule(profile.backups?.schedule);
  const scheduleEnabled =
    settings?.scheduleEnabled === undefined ? currentSchedule.enabled : Boolean(settings.scheduleEnabled);
  const scheduleTime =
    settings?.scheduleTime === undefined ? currentSchedule.time : String(settings.scheduleTime || "").trim();
  if (scheduleEnabled && !isValidDailyTime(scheduleTime)) {
    throw new Error("Daily maintenance time must be a valid 24-hour time like 03:30.");
  }
  const normalizedTime = normalizeDailyTime(scheduleTime);
  const secondaryDir = settings?.secondaryDir === undefined
    ? String(profile.backups?.secondaryDir || "").trim()
    : String(settings.secondaryDir || "").trim();
  if (secondaryDir && normalizePathForCompare(secondaryDir) === normalizePathForCompare(profile.paths.backupDir)) {
    throw new Error("Secondary backup folder must be different from the primary backup folder.");
  }
  const scheduleChanged =
    scheduleEnabled !== currentSchedule.enabled ||
    normalizedTime !== currentSchedule.time ||
    (scheduleEnabled && !currentSchedule.nextRunAt);

  profile.backups = {
    ...(profile.backups || {}),
    retentionCount,
    secondaryDir,
    schedule: {
      ...currentSchedule,
      enabled: scheduleEnabled,
      time: normalizedTime,
      nextRunAt: scheduleEnabled
        ? scheduleChanged
          ? getNextDailyRunAt(normalizedTime)
          : currentSchedule.nextRunAt
        : null,
      lastRunStatus: scheduleEnabled ? currentSchedule.lastRunStatus : null,
      lastRunMessage: scheduleEnabled ? currentSchedule.lastRunMessage : null
    }
  };
  await writeJson(profilePath, profile);
  await pruneBackups(profile);
  appendActivity(
    scheduleEnabled
      ? `Backup retention changed to keep last ${retentionCount}. Daily backup/update scheduled at ${normalizedTime}.${secondaryDir ? ` Secondary copies: ${secondaryDir}.` : ""}`
      : `Backup retention changed to keep last ${retentionCount}. Daily backup/update schedule disabled.${secondaryDir ? ` Secondary copies: ${secondaryDir}.` : ""}`
  );
  return profile;
}

async function updateMaintenanceState(updates) {
  const profile = normalizeProfile(await getProfile());
  profile.maintenance = normalizeMaintenance({
    ...profile.maintenance,
    ...updates
  });
  await writeJson(profilePath, profile);
  return profile.maintenance;
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

function parseLaunchPortValue(value) {
  const parsed = parseGamePort(value);
  return parsed !== null && parsed >= minGamePort && parsed <= maxGamePort ? parsed : null;
}

function getLaunchPortFromArgs(args, fallbackPort) {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = String(args[index] || "");
    const lowerArg = arg.toLowerCase();
    if (lowerArg.startsWith("-port=")) {
      const parsed = parseLaunchPortValue(arg.slice(arg.indexOf("=") + 1));
      if (parsed !== null) return parsed;
    }
    if (lowerArg === "-port" && index + 1 < args.length) {
      const parsed = parseLaunchPortValue(args[index + 1]);
      if (parsed !== null) return parsed;
    }
  }
  return assertValidGamePort(fallbackPort);
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

function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function getLocalServerIp() {
  const candidates = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.internal || item.family !== "IPv4" || !item.address) continue;
      candidates.push(item.address);
    }
  }
  return candidates.find(isPrivateIpv4) || candidates[0] || (host === "127.0.0.1" ? "127.0.0.1" : host);
}

function isLikelyIpAddress(value) {
  const text = String(value || "").trim();
  return (
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) ||
    /^[0-9a-f:]+$/i.test(text)
  );
}

function requestPublicIpAddress() {
  return new Promise((resolve, reject) => {
    const request = https.get("https://api.ipify.org?format=json", { timeout: publicIpLookupTimeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Public IP lookup returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          const ip = String(parsed.ip || "").trim();
          if (!isLikelyIpAddress(ip)) {
            reject(new Error("Public IP lookup returned an invalid address."));
            return;
          }
          resolve(ip);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("Public IP lookup timed out."));
    });
    request.on("error", reject);
  });
}

function refreshPublicIpAddressIfNeeded() {
  const now = Date.now();
  const hasFreshAddress = publicIpCache.address && now - publicIpCache.checkedAt < publicIpRefreshMs;
  const hasFreshFailure = publicIpCache.error && now - publicIpCache.checkedAt < publicIpRefreshMs && !publicIpCache.address;
  if (publicIpCache.promise || hasFreshAddress || hasFreshFailure) return;

  publicIpCache.promise = requestPublicIpAddress()
    .then((address) => {
      publicIpCache = {
        address,
        checkedAt: Date.now(),
        error: null,
        promise: null
      };
    })
    .catch((error) => {
      publicIpCache = {
        address: publicIpCache.address,
        checkedAt: Date.now(),
        error: error.message,
        promise: null
      };
    });
}

function getPublicIpSnapshot() {
  refreshPublicIpAddressIfNeeded();
  return {
    address: publicIpCache.address,
    checkedAt: publicIpCache.checkedAt ? new Date(publicIpCache.checkedAt).toISOString() : null,
    status: publicIpCache.promise
      ? publicIpCache.address
        ? "refreshing"
        : "checking"
      : publicIpCache.address
        ? "ready"
        : "unavailable",
    error: publicIpCache.error
  };
}

function formatJoinAddress(address, portNumber) {
  if (!address) return null;
  const text = String(address).trim();
  return text.includes(":") && !text.startsWith("[") ? `[${text}]:${portNumber}` : `${text}:${portNumber}`;
}

function getJoinAddresses(effectiveLaunchArgs, fallbackPort) {
  const portNumber = getLaunchPortFromArgs(effectiveLaunchArgs, fallbackPort);
  const localIp = getLocalServerIp();
  const publicIp = getPublicIpSnapshot();
  return {
    port: portNumber,
    local: {
      label: "Local Join",
      address: localIp,
      value: formatJoinAddress(localIp, portNumber)
    },
    public: {
      label: "Internet Join",
      address: publicIp.address,
      value: formatJoinAddress(publicIp.address, portNumber),
      status: publicIp.status,
      error: publicIp.error,
      checkedAt: publicIp.checkedAt
    }
  };
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
    if (exitCode === 0) {
      for (const filePath of cleanupPaths || []) removeQuietly(filePath);
    } else {
      for (const filePath of cleanupPaths || []) {
        if (exists(filePath)) pushTaskOutput(task, `Retained failed task script: ${filePath}`);
      }
    }
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
    onComplete,
    pauseAtEnd = true,
    ...taskOptions
  } = options;
  const taskSlug = `${Date.now()}-${safeTaskFileName(name)}`;
  const ps1Path = path.join(dataDir, `${taskSlug}.ps1`);
  const cmdPath = path.join(dataDir, `${taskSlug}.cmd`);
  const outputPath = path.join(dataDir, `${taskSlug}.output.log`);
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
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}" > "${outputPath}" 2>&1`,
    "set DWSC_EXIT=%ERRORLEVEL%",
    `if exist "${outputPath}" type "${outputPath}"`,
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
    onComplete: async (payload) => {
      try {
        const retainedOutput = fs.readFileSync(outputPath, "utf8");
        for (const line of retainedOutput.split(/\r\n|\n|\r/)) pushTaskOutput(payload.task, line);
      } catch {
        // Some commands finish before producing output.
      }
      if (payload.exitCode === 0) removeQuietly(outputPath);
      else pushTaskOutput(payload.task, `Retained failed task output: ${outputPath}`);
      if (typeof onComplete === "function") await onComplete(payload);
    },
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

function normalizePathForCompare(value) {
  if (!value) return "";
  return path.normalize(path.resolve(String(value))).replace(/[\\/]+$/, "").toLowerCase();
}

function isSameOrChildPath(basePath, candidatePath) {
  const base = normalizePathForCompare(basePath);
  const candidate = normalizePathForCompare(candidatePath);
  return Boolean(base && candidate && (candidate === base || candidate.startsWith(`${base}${path.sep}`)));
}

function isCurrentControlAppProcess(item) {
  const pid = Number(item?.pid);
  if (Number.isFinite(pid) && pid === process.pid) return true;

  const itemPath = normalizePathForCompare(item?.path);
  const currentPath = normalizePathForCompare(process.execPath);
  if (itemPath && currentPath && itemPath === currentPath) return true;

  const lowerName = String(item?.name || "").toLowerCase();
  return lowerName.includes("dragonwilds") && lowerName.includes("server") && lowerName.includes("control");
}

function looksLikeDragonwildsServerProcessName(name) {
  const lowerName = String(name || "").toLowerCase();
  return lowerName.includes("dragonwilds") && lowerName.includes("server") && !lowerName.includes("control");
}

function isLikelyDragonwildsServerProcess(item, profile, managedPid = null) {
  if (!item || !item.pid) return false;
  if (managedPid && Number(item.pid) === Number(managedPid)) return true;
  if (isCurrentControlAppProcess(item)) return false;

  const lowerName = String(item.name || "").toLowerCase();
  if (serverProcessNameSet.has(lowerName)) return true;
  if (!looksLikeDragonwildsServerProcessName(lowerName)) return false;

  if (!item.path) return false;
  return isSameOrChildPath(profile?.paths?.serverDir, item.path);
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

async function getRunningDragonwildsProcesses(profile = null) {
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
    const processes = items
      .filter((item) => item && item.Id)
      .map((item) => ({
        pid: Number(item.Id),
        name: item.ProcessName || "Dragonwilds server",
        path: item.Path || null
      }));
    const seen = new Set();
    const filtered = [];
    for (const item of processes) {
      if (seen.has(item.pid) || !isLikelyDragonwildsServerProcess(item, profile, managedPid)) continue;
      seen.add(item.pid);
      filtered.push({
        ...item,
        source: item.pid === managedPid ? "managed" : "external"
      });
    }
    return filtered;
  } catch (error) {
    appendActivity(`Could not scan Dragonwilds server processes: ${error.message}`);
    return managedPid ? [{ pid: managedPid, name: "App-managed server", source: "managed" }] : [];
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFileSize(filePath) {
  try {
    return (await fsp.stat(filePath)).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function readFileFromOffset(filePath, offset = 0) {
  try {
    const stat = await fsp.stat(filePath);
    const start = stat.size >= offset ? offset : 0;
    if (stat.size <= start) return "";
    const handle = await fsp.open(filePath, "r");
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function parseUnrealLogTimestamp(line) {
  const match = String(line || "").match(
    /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match.map(Number);
  const value = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function cleanTelemetryMessage(line) {
  return String(line || "")
    .replace(/^\[[^\]]+\]\s*\[[^\]]+\]\s*/, "")
    .trim()
    .slice(0, 500);
}

function parseServerTelemetry(lines, serverRunning = false) {
  const currentSessionStart = Math.max(
    0,
    lines.map((line) => (/^Log file open,/i.test(line) || /LogInit: Build:/i.test(line) ? 1 : 0)).lastIndexOf(1)
  );
  const sessionLines = lines.slice(currentSessionStart);
  const players = new Map();
  let lastSuccessfulSaveAt = null;
  let lastSuccessfulSaveMessage = null;
  let logBuild = null;
  let engineVersion = null;
  let listeningPort = null;
  let readyAt = null;
  const fatalErrors = [];

  for (const line of sessionLines) {
    const playerAdded = line.match(/Player\s+ADDED\s+to\s+session\s+\[([^\]]+)\]-\[([^\]]+)\]/i);
    if (playerAdded) {
      players.set(playerAdded[1], {
        id: playerAdded[1],
        name: playerAdded[2],
        joinedAt: parseUnrealLogTimestamp(line)
      });
    }
    const playerRemoved = line.match(/Player\s+Removed\s+from\s+session\s+\[([^\]]+)\]-\[([^\]]+)\]/i);
    if (playerRemoved) players.delete(playerRemoved[1]);

    if (/Save completed SUCCESSFULLY/i.test(line)) {
      lastSuccessfulSaveAt = parseUnrealLogTimestamp(line);
      lastSuccessfulSaveMessage = cleanTelemetryMessage(line);
    }
    const buildMatch = line.match(/LogInit:\s+Build:\s+(.+)$/i);
    if (buildMatch) logBuild = buildMatch[1].trim();
    const engineMatch = line.match(/LogInit:\s+Engine Version:\s+(.+)$/i);
    if (engineMatch) engineVersion = engineMatch[1].trim();
    const listeningMatch = line.match(/IpNetDriver listening on port\s+(\d+)/i);
    if (listeningMatch) {
      listeningPort = Number(listeningMatch[1]);
      readyAt = parseUnrealLogTimestamp(line);
    }
    if (
      /Fatal error:/i.test(line) ||
      /Unhandled Exception:/i.test(line) ||
      /LowLevelFatalError/i.test(line) ||
      /=== Critical error ===/i.test(line) ||
      /Out of memory/i.test(line) ||
      /Assertion failed:/i.test(line)
    ) {
      fatalErrors.push({
        at: parseUnrealLogTimestamp(line),
        message: cleanTelemetryMessage(line)
      });
    }
  }

  return {
    connectedPlayerCount: serverRunning ? players.size : 0,
    connectedPlayers: serverRunning ? Array.from(players.values()) : [],
    lastSuccessfulSaveAt,
    lastSuccessfulSaveMessage,
    logBuild,
    engineVersion,
    listeningPort: serverRunning ? listeningPort : null,
    readyAt: serverRunning ? readyAt : null,
    fatalErrorCount: fatalErrors.length,
    lastFatalError: fatalErrors.at(-1) || null,
    recentFatalErrors: fatalErrors.slice(-5)
  };
}

function parseSteamManifestText(text) {
  const buildId = String(text || "").match(/"buildid"\s+"(\d+)"/i)?.[1] || null;
  const lastUpdatedSeconds = Number(String(text || "").match(/"LastUpdated"\s+"(\d+)"/i)?.[1]);
  return {
    buildId,
    lastUpdatedAt: Number.isFinite(lastUpdatedSeconds) && lastUpdatedSeconds > 0
      ? new Date(lastUpdatedSeconds * 1000).toISOString()
      : null
  };
}

async function getInstalledServerVersion(profile, manifestPath = null) {
  const candidate = manifestPath || steamAppManifestCandidates(profile).find((item) => exists(item));
  if (!candidate) return { buildId: null, lastUpdatedAt: null, manifestPath: null };
  try {
    return {
      ...parseSteamManifestText(await fsp.readFile(candidate, "utf8")),
      manifestPath: candidate
    };
  } catch (error) {
    return { buildId: null, lastUpdatedAt: null, manifestPath: candidate, error: error.message };
  }
}

async function getDiskSpaceSnapshot(targetPath) {
  let current = path.resolve(targetPath || dataDir);
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    const stat = await fsp.statfs(current);
    const blockSize = Number(stat.bsize || stat.frsize || 0);
    const totalBytes = Number(stat.blocks) * blockSize;
    const freeBytes = Number(stat.bavail ?? stat.bfree) * blockSize;
    return {
      path: current,
      totalBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes) * 100 : null
    };
  } catch (error) {
    return { path: current, totalBytes: null, freeBytes: null, usedPercent: null, error: error.message };
  }
}

async function isDragonwildsServerRunning() {
  return (await getRunningDragonwildsProcesses(await getProfile())).length > 0;
}

function markManagedServerExitIntentional() {
  if (isManagedServerProcessRunning()) {
    intentionalServerExitPids.add(Number(serverProcess.pid));
  }
}

async function waitForLogPattern(logPath, startOffset, pattern, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let observed = "";
  while (Date.now() <= deadline) {
    observed += await readFileFromOffset(logPath, startOffset + Buffer.byteLength(observed, "utf8"));
    const match = observed.match(pattern);
    if (match) {
      return {
        ok: true,
        at: parseUnrealLogTimestamp(match[0]) || timestamp(),
        match: match[0]
      };
    }
    await delay(serverReadinessPollMs);
  }
  return {
    ok: false,
    at: null,
    message: `${label} was not found in the Dragonwilds log within ${Math.ceil(timeoutMs / 1000)} seconds.`
  };
}

function waitForSaveConfirmation(profile, logOffset) {
  return waitForLogPattern(
    profile.paths.logPath,
    logOffset,
    /^.*Save completed SUCCESSFULLY.*$/im,
    saveConfirmationTimeoutMs,
    "A successful save confirmation"
  );
}

async function waitForServerReadiness(profile, logOffset, processId) {
  const selectedPort = assertValidGamePort(profile.server.port);
  const pattern = new RegExp(`^.*IpNetDriver listening on port\\s+${selectedPort}\\b.*$`, "im");
  const deadline = Date.now() + serverReadinessTimeoutMs;
  let observed = "";
  while (Date.now() <= deadline) {
    if (processId && serverProcess?.pid !== processId) {
      return { ok: false, at: null, message: "The server process exited before readiness could be confirmed." };
    }
    observed += await readFileFromOffset(
      profile.paths.logPath,
      logOffset + Buffer.byteLength(observed, "utf8")
    );
    const match = observed.match(pattern);
    if (match) {
      return {
        ok: true,
        at: parseUnrealLogTimestamp(match[0]) || timestamp(),
        match: match[0]
      };
    }
    await delay(serverReadinessPollMs);
  }
  return {
    ok: false,
    at: null,
    message: `UDP readiness on port ${selectedPort} was not found in the Dragonwilds log within ${Math.ceil(serverReadinessTimeoutMs / 1000)} seconds.`
  };
}

function pruneCrashRestartAttempts(now = Date.now()) {
  serverRuntimeState.restartAttempts = serverRuntimeState.restartAttempts.filter(
    (value) => now - Date.parse(value) <= crashRestartWindowMs
  );
}

function clearCrashRestartTimer() {
  if (crashRestartTimer) clearTimeout(crashRestartTimer);
  crashRestartTimer = null;
  serverRuntimeState.restartScheduledAt = null;
}

function resetCrashRecoveryState() {
  clearCrashRestartTimer();
  serverRuntimeState.restartAttempts = [];
  serverRuntimeState.crashLoop = false;
  serverRuntimeState.crashMessage = null;
}

function scheduleCrashRestart() {
  pruneCrashRestartAttempts();
  const attemptIndex = serverRuntimeState.restartAttempts.length;
  if (attemptIndex >= crashRestartDelaysSeconds.length) {
    clearCrashRestartTimer();
    serverRuntimeState.crashLoop = true;
    serverRuntimeState.expectedRunning = false;
    serverRuntimeState.crashMessage = `Automatic restart stopped after ${crashRestartDelaysSeconds.length} attempts within 15 minutes. Review the fatal errors and server log, then start the server manually.`;
    appendActivity(`Crash-loop protection activated. ${serverRuntimeState.crashMessage}`);
    return;
  }

  const delaySeconds = crashRestartDelaysSeconds[attemptIndex];
  serverRuntimeState.restartScheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  serverRuntimeState.crashMessage = `The server exited unexpectedly. Automatic restart ${attemptIndex + 1} of ${crashRestartDelaysSeconds.length} is scheduled in ${delaySeconds} seconds.`;
  appendActivity(serverRuntimeState.crashMessage);
  crashRestartTimer = setTimeout(async () => {
    crashRestartTimer = null;
    serverRuntimeState.restartScheduledAt = null;
    if (maintenanceWorkflowActive || (activeTask && ["running", "stopping"].includes(activeTask.status))) {
      appendActivity("Automatic crash restart is waiting for the current maintenance task to finish.");
      scheduleCrashRestart();
      return;
    }
    serverRuntimeState.restartAttempts.push(timestamp());
    try {
      appendActivity(`Attempting automatic crash restart ${attemptIndex + 1} of ${crashRestartDelaysSeconds.length}.`);
      await startGameServer(await getProfile(), { source: "crash-recovery", resetCrashState: false });
    } catch (error) {
      serverRuntimeState.lastCrashAt = timestamp();
      serverRuntimeState.crashMessage = `Automatic restart could not start the server: ${error.message}`;
      appendActivity(serverRuntimeState.crashMessage);
      scheduleCrashRestart();
    }
  }, delaySeconds * 1000);
}

function handleManagedServerExit(child, exitCode, processError = null) {
  const processId = Number(child?.pid || 0);
  const intentional = intentionalServerExitPids.delete(processId);
  if (serverProcess === child) serverProcess = null;
  serverRuntimeState.lastExitAt = timestamp();
  serverRuntimeState.lastExitCode = Number.isInteger(exitCode) ? exitCode : null;
  serverRuntimeState.readinessStatus = "offline";
  serverRuntimeState.readyAt = null;

  const detail = processError ? processError.message : `exit code ${exitCode}`;
  appendActivity(`Server exited with ${detail}${intentional ? " (expected)" : ""}.`);
  if (intentional || !serverRuntimeState.expectedRunning) return;

  serverRuntimeState.lastCrashAt = timestamp();
  serverRuntimeState.readinessMessage = `Server exited unexpectedly with ${detail}.`;
  scheduleCrashRestart();
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

function gracefulStopDragonwildsTask(name, options = {}) {
  const {
    forceAfterTimeout = true,
    markerPath,
    timeoutSeconds = gracefulStopTimeoutSeconds,
    ...taskOptions
  } = options;
  const timeout = Math.max(5, Number(timeoutSeconds) || gracefulStopTimeoutSeconds);
  const managedServerWasRunning = isManagedServerProcessRunning();
  markManagedServerExitIntentional();
  trySendGracefulQuitToManagedServer(name);

  const script = [
    `$names = ${psArray(serverProcessNames)}`,
    `$timeoutSeconds = ${timeout}`,
    `$forceAfterTimeout = ${forceAfterTimeout ? "$true" : "$false"}`,
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
    "  if (!$forceAfterTimeout) { Write-Error ('Graceful shutdown timed out with {0} process(es) still running. Maintenance was aborted without force-closing Dragonwilds.' -f $remaining.Count); exit 1 }",
    "  Write-Output ('Graceful shutdown timed out; force-closing {0} remaining Dragonwilds process(es).' -f $remaining.Count)",
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

async function runUpdateServerWorkflow(profile, options = {}) {
  return runMaintenanceWorkflow(profile, {
    includeUpdate: true,
    name: "Backup, update, and restart Dragonwilds",
    onComplete: options.onComplete
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

async function startGameServer(profile, options = {}) {
  const {
    resetCrashState = true,
    source = "manual",
    waitUntilReady = false
  } = options;
  const runningProcesses = await getRunningDragonwildsProcesses(profile);
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
  const logOffset = await getFileSize(profile.paths.logPath);

  if (resetCrashState) resetCrashRecoveryState();
  serverRuntimeState.expectedRunning = true;
  serverRuntimeState.lastStartedAt = timestamp();
  serverRuntimeState.readinessStatus = "starting";
  serverRuntimeState.readinessMessage = `Waiting for Dragonwilds to listen on UDP port ${profile.server.port}.`;
  serverRuntimeState.readyAt = null;

  appendActivity(`Starting server (${source}): ${install.serverExe} ${formatLaunchArgsForDisplay(args)}`);
  const child = spawn(install.serverExe, args, {
    cwd: path.dirname(install.serverExe),
    windowsHide: false
  });
  serverProcess = child;

  child.stdout?.on("data", (chunk) => appendActivity(`server: ${chunk.toString().trim()}`));
  child.stderr?.on("data", (chunk) => appendActivity(`server: ${chunk.toString().trim()}`));
  let exitHandled = false;
  child.on("close", (exitCode) => {
    if (exitHandled) return;
    exitHandled = true;
    handleManagedServerExit(child, exitCode);
  });
  child.on("error", (error) => {
    if (exitHandled) return;
    exitHandled = true;
    appendActivity(`Server process error: ${error.message}`);
    handleManagedServerExit(child, null, error);
  });

  lastStartReadinessPromise = waitForServerReadiness(profile, logOffset, child.pid)
    .then((result) => {
      if (serverProcess !== child) return result;
      if (result.ok) {
        serverRuntimeState.readinessStatus = "ready";
        serverRuntimeState.readinessMessage = `UDP readiness confirmed on port ${profile.server.port}.`;
        serverRuntimeState.readyAt = result.at || timestamp();
        serverRuntimeState.crashMessage = null;
        appendActivity(serverRuntimeState.readinessMessage);
      } else {
        serverRuntimeState.readinessStatus = "warning";
        serverRuntimeState.readinessMessage = result.message;
        appendActivity(`Server readiness warning: ${result.message}`);
      }
      return result;
    })
    .catch((error) => {
      const result = { ok: false, at: null, message: error.message };
      if (serverProcess === child) {
        serverRuntimeState.readinessStatus = "warning";
        serverRuntimeState.readinessMessage = error.message;
      }
      appendActivity(`Server readiness check failed: ${error.message}`);
      return result;
    });

  const started = { pid: child.pid, startedAt: serverRuntimeState.lastStartedAt };
  if (waitUntilReady) {
    const readiness = await lastStartReadinessPromise;
    if (!readiness.ok) throw new Error(readiness.message);
    return { ...started, readiness };
  }
  return started;
}

async function restartGameServer(profile) {
  const runningProcesses = await getRunningDragonwildsProcesses(profile);
  if (!runningProcesses.length) {
    return startGameServer(profile);
  }

  serverRuntimeState.expectedRunning = true;
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
  const runningProcesses = await getRunningDragonwildsProcesses(await getProfile());
  if (!runningProcesses.length) {
    throw new Error("Dragonwilds dedicated server is not running.");
  }
  serverRuntimeState.expectedRunning = false;
  clearCrashRestartTimer();
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

async function listBackupsInDirectory(backupDir, options = {}) {
  const { managerOnly = false } = options;
  try {
    const entries = await fsp.readdir(backupDir, { withFileTypes: true });
    const backups = [];
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.toLowerCase().endsWith(".zip") ||
        entry.name.toLowerCase().endsWith(".partial.zip")
      ) continue;
      if (managerOnly && !/^dragonwilds-save-\d{8}T\d{6}Z\.zip$/i.test(entry.name)) continue;
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

async function listBackups(profile) {
  return listBackupsInDirectory(profile.paths.backupDir);
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

async function pruneBackupsInDirectory(backupDir, keepCount, label) {
  if (!backupDir || !Number.isInteger(keepCount) || keepCount < 1) return [];
  const backups = await listBackupsInDirectory(backupDir, { managerOnly: true });
  const remove = backups.slice(keepCount);
  for (const backup of remove) {
    await fsp.unlink(backup.path);
    appendActivity(`Pruned old ${label} backup ${backup.name}; keeping last ${keepCount}.`);
  }
  return remove;
}

async function pruneBackups(profile) {
  const keepCount = Number(profile.backups?.retentionCount || defaultProfile.backups.retentionCount);
  if (!Number.isInteger(keepCount) || keepCount < 1) return [];
  const removed = await pruneBackupsInDirectory(profile.paths.backupDir, keepCount, "primary");
  const secondaryDir = String(profile.backups?.secondaryDir || "").trim();
  if (secondaryDir && normalizePathForCompare(secondaryDir) !== normalizePathForCompare(profile.paths.backupDir)) {
    removed.push(...await pruneBackupsInDirectory(secondaryDir, keepCount, "secondary"));
  }
  return removed;
}

async function createFullBackupTask(profile, options = {}) {
  const {
    name = "Create verified full backup",
    onComplete
  } = options;
  if (!exists(profile.paths.saveDir)) {
    throw new Error(`Save folder not found: ${profile.paths.saveDir}`);
  }
  const backupName = `dragonwilds-save-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}.zip`;
  const outPath = path.join(profile.paths.backupDir, backupName);
  const tempPath = outPath.replace(/\.zip$/i, ".partial.zip");
  const stagingPath = path.join(profile.paths.backupDir, `.dragonwilds-backup-staging-${Date.now()}`);
  const secondaryDir = String(profile.backups?.secondaryDir || "").trim();
  const useSecondary = secondaryDir && normalizePathForCompare(secondaryDir) !== normalizePathForCompare(profile.paths.backupDir);
  const secondaryPath = useSecondary ? path.join(secondaryDir, backupName) : null;
  const installedVersion = await getInstalledServerVersion(profile);
  const metadata = JSON.stringify({
    formatVersion: 2,
    createdAt: timestamp(),
    appVersion: appPackage.version,
    steamBuildId: installedVersion.buildId,
    serverLogBuild: (await readLastLines(profile.paths.logPath, 500)).map((line) => line.match(/LogInit:\s+Build:\s+(.+)$/i)?.[1]?.trim()).filter(Boolean).at(-1) || null,
    gamePort: assertValidGamePort(profile.server.port),
    contents: [
      "Savegames",
      ...(exists(profile.paths.configPath) ? ["DedicatedServer.ini"] : []),
      ...(exists(profilePath) ? ["profile.json"] : [])
    ]
  }, null, 2);
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `New-Item -ItemType Directory -Force -Path ${psString(profile.paths.backupDir)} | Out-Null`,
    useSecondary ? `New-Item -ItemType Directory -Force -Path ${psString(secondaryDir)} | Out-Null` : null,
    `if (Test-Path -LiteralPath ${psString(stagingPath)}) { Remove-Item -LiteralPath ${psString(stagingPath)} -Recurse -Force }`,
    `if (Test-Path -LiteralPath ${psString(tempPath)}) { Remove-Item -LiteralPath ${psString(tempPath)} -Force }`,
    `New-Item -ItemType Directory -Force -Path (Join-Path ${psString(stagingPath)} 'Savegames') | Out-Null`,
    `New-Item -ItemType Directory -Force -Path (Join-Path ${psString(stagingPath)} 'Config') | Out-Null`,
    `New-Item -ItemType Directory -Force -Path (Join-Path ${psString(stagingPath)} 'Control') | Out-Null`,
    "function Get-FileSha256([string]$filePath) {",
    "  $sha = [System.Security.Cryptography.SHA256]::Create()",
    "  $stream = [System.IO.File]::OpenRead($filePath)",
    "  try { return [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') } finally { $stream.Dispose(); $sha.Dispose() }",
    "}",
    "try {",
    `  @(Get-ChildItem -LiteralPath ${psString(profile.paths.saveDir)} -Force) | Copy-Item -Destination (Join-Path ${psString(stagingPath)} 'Savegames') -Recurse -Force`,
    `  if (Test-Path -LiteralPath ${psString(profile.paths.configPath)}) { Copy-Item -LiteralPath ${psString(profile.paths.configPath)} -Destination (Join-Path ${psString(stagingPath)} 'Config\\DedicatedServer.ini') -Force }`,
    `  if (Test-Path -LiteralPath ${psString(profilePath)}) { Copy-Item -LiteralPath ${psString(profilePath)} -Destination (Join-Path ${psString(stagingPath)} 'Control\\profile.json') -Force }`,
    `  Set-Content -LiteralPath (Join-Path ${psString(stagingPath)} 'backup-metadata.json') -Encoding UTF8 -Value ${psString(metadata)}`,
    `  Compress-Archive -Path (Join-Path ${psString(stagingPath)} '*') -DestinationPath ${psString(tempPath)} -CompressionLevel Optimal -Force`,
    `  $archive = [System.IO.Compression.ZipFile]::OpenRead(${psString(tempPath)})`,
    "  try {",
    "    $entries = @($archive.Entries)",
    "    if (!($entries | Where-Object { $_.FullName -eq 'backup-metadata.json' })) { throw 'Backup verification failed: backup-metadata.json is missing.' }",
    "    if (!($entries | Where-Object { $_.FullName -match '^Savegames[/\\\\].+' })) { throw 'Backup verification failed: no savegame files were found in the archive.' }",
    "    foreach ($entry in $entries) { if ($entry.Length -gt 0) { $stream = $entry.Open(); try { $stream.CopyTo([System.IO.Stream]::Null) } finally { $stream.Dispose() } } }",
    "  } finally { $archive.Dispose() }",
    `  Move-Item -LiteralPath ${psString(tempPath)} -Destination ${psString(outPath)} -Force`,
    useSecondary ? `  Copy-Item -LiteralPath ${psString(outPath)} -Destination ${psString(secondaryPath)} -Force` : null,
    useSecondary ? `  if ((Get-FileSha256 ${psString(outPath)}) -ne (Get-FileSha256 ${psString(secondaryPath)})) { throw 'Secondary backup verification failed: SHA256 hashes do not match.' }` : null,
    `  Write-Output ${psString(`Verified full backup: ${outPath}`)}`,
    useSecondary ? `  Write-Output ${psString(`Verified secondary copy: ${secondaryPath}`)}` : null,
    "} finally {",
    `  if (Test-Path -LiteralPath ${psString(stagingPath)}) { Remove-Item -LiteralPath ${psString(stagingPath)} -Recurse -Force }`,
    `  if (Test-Path -LiteralPath ${psString(tempPath)}) { Remove-Item -LiteralPath ${psString(tempPath)} -Force }`,
    "}"
  ].filter(Boolean).join("\r\n");
  return powershellTask(name, script, {
    pauseAtEnd: false,
    onComplete: async ({ exitCode }) => {
      let completedExitCode = exitCode;
      if (exitCode === 0) {
        try {
          await pruneBackups(await getProfile());
        } catch (error) {
          completedExitCode = 1;
          appendActivity(`Backup was verified, but retention cleanup failed: ${error.message}`);
        }
      }
      if (typeof onComplete === "function") {
        await onComplete({ exitCode: completedExitCode, backupName, outPath, secondaryPath });
      }
    }
  });
}

async function runMaintenanceWorkflow(profile, options = {}) {
  const {
    includeUpdate = false,
    name = includeUpdate ? "Backup, update, and restart Dragonwilds" : "Backup and refresh Dragonwilds",
    onComplete
  } = options;
  if (maintenanceWorkflowActive) {
    throw new Error(`Maintenance already running: ${maintenanceWorkflowName}`);
  }
  if (activeTask && ["running", "stopping"].includes(activeTask.status)) {
    throw new Error(`Task already running: ${activeTask.name}`);
  }

  const currentProfile = normalizeProfile(profile);
  const runningProcesses = await getRunningDragonwildsProcesses(currentProfile);
  const shouldRestart = runningProcesses.length > 0;
  const saveLogOffset = shouldRestart ? await getFileSize(currentProfile.paths.logPath) : 0;
  const buildBefore = await getInstalledServerVersion(currentProfile);
  let buildAfter = buildBefore;
  let restartSucceeded = false;
  let workflowFinished = false;
  maintenanceWorkflowActive = true;
  maintenanceWorkflowName = name;
  serverRuntimeState.expectedRunning = shouldRestart;
  appendActivity(`${name} started. The server ${shouldRestart ? "will be stopped only after a confirmed world save" : "is offline and will remain offline"}.`);

  if (includeUpdate) {
    try {
      await updateMaintenanceState({
        lastUpdateStartedAt: timestamp(),
        lastUpdateCompletedAt: null,
        lastUpdateStatus: "running",
        lastUpdateMessage: "Safe maintenance workflow is running.",
        buildIdBefore: buildBefore.buildId,
        buildIdAfter: null,
        restartReadinessStatus: shouldRestart ? "pending" : "not-required",
        restartReadyAt: null
      });
    } catch (error) {
      maintenanceWorkflowActive = false;
      maintenanceWorkflowName = null;
      throw error;
    }
  }

  const finish = async (status, message) => {
    if (workflowFinished) return;
    workflowFinished = true;
    maintenanceWorkflowActive = false;
    maintenanceWorkflowName = null;
    if (status !== "completed" && shouldRestart && !restartSucceeded) {
      try {
        serverRuntimeState.expectedRunning = (await getRunningDragonwildsProcesses(await getProfile())).length > 0;
      } catch {
        serverRuntimeState.expectedRunning = false;
      }
    }
    if (includeUpdate) {
      await updateMaintenanceState({
        lastUpdateCompletedAt: timestamp(),
        lastUpdateStatus: status,
        lastUpdateMessage: message,
        buildIdBefore: buildBefore.buildId,
        buildIdAfter: buildAfter.buildId,
        restartReadinessStatus: shouldRestart
          ? (restartSucceeded ? "ready" : "failed")
          : "not-required",
        restartReadyAt: restartSucceeded ? serverRuntimeState.readyAt : null
      });
    }
    appendActivity(`${name} ${status}: ${message}`);
    if (typeof onComplete === "function") await onComplete({ status, message });
  };

  const restartOrFinish = async () => {
    if (!shouldRestart) {
      await finish("completed", includeUpdate
        ? "Verified full backup and update completed. Dragonwilds was already offline, so it was left offline."
        : "Verified full backup completed. Dragonwilds was already offline, so it was left offline.");
      return;
    }
    try {
      await startGameServer(await getProfile(), {
        source: includeUpdate ? "post-update maintenance" : "post-backup maintenance",
        resetCrashState: false,
        waitUntilReady: true
      });
      restartSucceeded = true;
      await finish("completed", includeUpdate
        ? `Verified full backup, update, and restart completed. UDP readiness was confirmed on port ${currentProfile.server.port}.`
        : `Verified full backup and restart completed. UDP readiness was confirmed on port ${currentProfile.server.port}.`);
    } catch (error) {
      await finish("failed", `${includeUpdate ? "Update completed, but" : "Backup completed, but"} restart readiness failed: ${error.message}`);
    }
  };

  const startUpdate = async () => {
    try {
      return await runInstall(await getProfile(), false, {
        skipFirstRunConfigBootstrap: true,
        onComplete: async ({ exitCode }) => {
          if (exitCode !== 0) {
            await finish("failed", `Verified backup completed, but SteamCMD update failed with exit code ${exitCode}. The server was left offline.`);
            return;
          }
          buildAfter = await getInstalledServerVersion(await getProfile());
          appendActivity(`SteamCMD update completed. Installed build: ${buildAfter.buildId || "unknown"}.`);
          await restartOrFinish();
        }
      });
    } catch (error) {
      await finish("failed", `Verified backup completed, but the SteamCMD update could not start: ${error.message}`);
      return null;
    }
  };

  const startBackup = async () => {
    try {
      return await createFullBackupTask(await getProfile(), {
        name: includeUpdate ? "Create verified pre-update backup" : "Create verified full backup",
        onComplete: async ({ exitCode }) => {
          if (exitCode !== 0) {
            await finish("failed", `Full backup failed with exit code ${exitCode}. ${includeUpdate ? "Update was skipped" : "The server was left offline"}.`);
            return;
          }
          appendActivity("Full backup verified successfully. Retention rules were applied after verification.");
          if (includeUpdate) await startUpdate();
          else await restartOrFinish();
        }
      });
    } catch (error) {
      await finish("failed", `Full backup could not start: ${error.message}`);
      return null;
    }
  };

  try {
    if (!shouldRestart) return await startBackup();
    return gracefulStopDragonwildsTask("Confirm save and stop Dragonwilds", {
      forceAfterTimeout: false,
      pauseAtEnd: false,
      onComplete: async ({ exitCode }) => {
        if (exitCode !== 0) {
          await finish("failed", "Dragonwilds did not stop gracefully. Backup and update were aborted without force-closing the server.");
          return;
        }
        const saveConfirmation = await waitForSaveConfirmation(await getProfile(), saveLogOffset);
        if (!saveConfirmation.ok) {
          await finish("failed", `${saveConfirmation.message} Backup and update were aborted.`);
          return;
        }
        appendActivity("Successful world save confirmed in the Dragonwilds log. Starting the full backup.");
        await startBackup();
      }
    });
  } catch (error) {
    await finish("failed", error.message);
    throw error;
  }
}

async function createBackup(profile) {
  return runMaintenanceWorkflow(profile, {
    includeUpdate: false,
    name: "Backup and refresh Dragonwilds"
  });
}

async function updateBackupScheduleState(updates) {
  const profile = normalizeProfile(await getProfile());
  profile.backups.schedule = normalizeBackupSchedule({
    ...profile.backups.schedule,
    ...updates
  });
  await writeJson(profilePath, profile);
  return profile.backups.schedule;
}

async function finishScheduledBackupUpdate(status, message) {
  await updateBackupScheduleState({
    lastRunCompletedAt: timestamp(),
    lastRunStatus: status,
    lastRunMessage: message
  });
  appendActivity(`Scheduled daily backup/update ${status}: ${message}`);
}

async function runScheduledBackupUpdateWorkflow(profile) {
  const schedule = normalizeBackupSchedule(profile.backups?.schedule);
  await updateBackupScheduleState({
    nextRunAt: getNextDailyRunAt(schedule.time),
    lastRunStartedAt: timestamp(),
    lastRunCompletedAt: null,
    lastRunStatus: "running",
    lastRunMessage: "Scheduled daily backup/update started."
  });
  appendActivity("Scheduled daily maintenance started with confirmed save, verified full backup, no-validate update, restart, and readiness checks.");

  try {
    return await runMaintenanceWorkflow(profile, {
      includeUpdate: true,
      name: "Scheduled daily maintenance",
      onComplete: async ({ status, message }) => finishScheduledBackupUpdate(status, message)
    });
  } catch (error) {
    await finishScheduledBackupUpdate("failed", `Maintenance workflow could not start: ${error.message}`);
    throw error;
  }
}

async function checkBackupSchedule() {
  if (backupScheduleCheckInFlight) return;
  backupScheduleCheckInFlight = true;
  try {
    const profile = await getProfile();
    const schedule = normalizeBackupSchedule(profile.backups?.schedule);
    if (!schedule.enabled) return;

    if (!schedule.nextRunAt) {
      await updateBackupScheduleState({ nextRunAt: getNextDailyRunAt(schedule.time) });
      return;
    }

    const dueAt = Date.parse(schedule.nextRunAt);
    if (!Number.isFinite(dueAt)) {
      await updateBackupScheduleState({ nextRunAt: getNextDailyRunAt(schedule.time) });
      return;
    }
    if (Date.now() < dueAt) return;

    if (maintenanceWorkflowActive || (activeTask && ["running", "stopping"].includes(activeTask.status))) {
      return;
    }

    if (!exists(profile.paths.saveDir)) {
      await updateBackupScheduleState({
        nextRunAt: getNextDailyRunAt(schedule.time),
        lastRunStartedAt: timestamp(),
        lastRunCompletedAt: timestamp(),
        lastRunStatus: "failed",
        lastRunMessage: `Save folder not found: ${profile.paths.saveDir}`
      });
      appendActivity(`Scheduled daily backup/update skipped because save folder was not found: ${profile.paths.saveDir}`);
      return;
    }

    await runScheduledBackupUpdateWorkflow(profile);
  } catch (error) {
    appendActivity(`Scheduled daily backup/update check failed: ${error.message}`);
  } finally {
    backupScheduleCheckInFlight = false;
  }
}

function startBackupScheduleTimer() {
  if (backupScheduleTimer) return;
  backupScheduleTimer = setInterval(() => {
    checkBackupSchedule().catch((error) => appendActivity(`Scheduled daily backup/update timer failed: ${error.message}`));
  }, backupScheduleCheckIntervalMs);
  checkBackupSchedule().catch((error) => appendActivity(`Scheduled daily backup/update startup check failed: ${error.message}`));
}

function stopBackupScheduleTimer() {
  if (!backupScheduleTimer) return;
  clearInterval(backupScheduleTimer);
  backupScheduleTimer = null;
}

async function restoreBackup(profile, backupId) {
  const { safeName, resolvedBackup } = resolveBackupPath(profile, backupId);
  if (!exists(resolvedBackup)) {
    throw new Error(`Backup not found: ${safeName}`);
  }
  if ((await getRunningDragonwildsProcesses(profile)).length) {
    throw new Error("Stop the Dragonwilds server before restoring a backup.");
  }

  const safetyPath = `${profile.paths.saveDir}.before-restore-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}`;
  const restoreStagingPath = path.join(dataDir, `.restore-${Date.now()}`);
  const script = [
    "$ErrorActionPreference='Stop'",
    `if (Test-Path -LiteralPath ${psString(restoreStagingPath)}) { Remove-Item -LiteralPath ${psString(restoreStagingPath)} -Recurse -Force }`,
    `New-Item -ItemType Directory -Force -Path ${psString(restoreStagingPath)} | Out-Null`,
    "try {",
    `  Expand-Archive -LiteralPath ${psString(resolvedBackup)} -DestinationPath ${psString(restoreStagingPath)} -Force`,
    `  $saveSource = Join-Path ${psString(restoreStagingPath)} 'Savegames'`,
    "  if (!(Test-Path -LiteralPath $saveSource)) { throw 'This archive does not contain a Savegames folder.' }",
    `  if (Test-Path -LiteralPath ${psString(profile.paths.saveDir)}) { Move-Item -LiteralPath ${psString(profile.paths.saveDir)} -Destination ${psString(safetyPath)} }`,
    `  Move-Item -LiteralPath $saveSource -Destination ${psString(profile.paths.saveDir)}`,
    `  $configSource = Join-Path ${psString(restoreStagingPath)} 'Config\\DedicatedServer.ini'`,
    `  if (Test-Path -LiteralPath $configSource) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${psString(profile.paths.configPath)}) | Out-Null; Copy-Item -LiteralPath $configSource -Destination ${psString(profile.paths.configPath)} -Force }`,
    `  Write-Output ${psString(`World restored. Previous save safety copy: ${safetyPath}`)}`,
    "} finally {",
    `  if (Test-Path -LiteralPath ${psString(restoreStagingPath)}) { Remove-Item -LiteralPath ${psString(restoreStagingPath)} -Recurse -Force }`,
    "}"
  ].join("\r\n");
  return powershellTask(`Restore backup ${safeName}`, script, { pauseAtEnd: false });
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
  const runningProcesses = await getRunningDragonwildsProcesses(profile);
  const serverRunning = runningProcesses.length > 0;
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
  const joinAddresses = getJoinAddresses(effectiveLaunchArgs, selectedPort);
  const telemetry = parseServerTelemetry(logLines, serverRunning);
  const installedVersion = await getInstalledServerVersion(profile, install.manifestPath);
  const [serverDiskSpace, backupDiskSpace] = await Promise.all([
    getDiskSpaceSnapshot(profile.paths.serverDir),
    getDiskSpaceSnapshot(profile.paths.backupDir)
  ]);
  const secondaryDir = String(profile.backups?.secondaryDir || "").trim();
  const secondaryDiskSpace = secondaryDir ? await getDiskSpaceSnapshot(secondaryDir) : null;
  const newestBackup = backups[0] || null;
  const newestBackupAgeMs = newestBackup ? Math.max(0, Date.now() - Date.parse(newestBackup.modifiedAt)) : null;
  const lastFatalAt = telemetry.lastFatalError?.at ? Date.parse(telemetry.lastFatalError.at) : NaN;
  const hasRecentFatalError = Boolean(
    telemetry.lastFatalError && (!Number.isFinite(lastFatalAt) || Date.now() - lastFatalAt <= 24 * 60 * 60 * 1000)
  );
  const logReady = serverRunning && telemetry.listeningPort === selectedPort;
  const readiness = isManagedServerProcessRunning()
    ? {
        status: serverRuntimeState.readinessStatus,
        message: serverRuntimeState.readinessMessage,
        readyAt: serverRuntimeState.readyAt
      }
    : {
        status: logReady ? "ready" : (serverRunning ? "warning" : "offline"),
        message: logReady
          ? `Dragonwilds log confirms UDP readiness on port ${selectedPort}.`
          : (serverRunning ? `Dragonwilds is running, but UDP readiness on port ${selectedPort} has not been confirmed in the current log.` : "Dragonwilds is offline."),
        readyAt: logReady ? telemetry.readyAt : null
      };
  pruneCrashRestartAttempts();

  return {
    appVersion: appPackage.version,
    generatedAt: timestamp(),
    serverRunning,
    serverPid: runningProcesses[0]?.pid || null,
    serverProcesses: runningProcesses,
    task: taskSnapshot(),
    selectedPort,
    secondaryPort,
    queryPort: secondaryPort,
    effectiveLaunchArgs,
    effectiveLaunchArgsText: formatLaunchArgsForDisplay(effectiveLaunchArgs),
    joinAddresses,
    tcpPortOpen,
    telemetry: {
      ...telemetry,
      hasRecentFatalError
    },
    readiness,
    runtime: {
      ...serverRuntimeState,
      restartAttempts: [...serverRuntimeState.restartAttempts],
      autoRestartLimit: crashRestartDelaysSeconds.length,
      autoRestartWindowMinutes: crashRestartWindowMs / 60000
    },
    maintenance: {
      active: maintenanceWorkflowActive,
      name: maintenanceWorkflowName,
      ...normalizeMaintenance(profile.maintenance)
    },
    installedVersion,
    diskSpace: {
      server: serverDiskSpace,
      backups: backupDiskSpace,
      secondaryBackups: secondaryDiskSpace
    },
    newestBackup,
    newestBackupAgeMs,
    logRetentionHours,
    backupRetentionCount: profile.backups?.retentionCount || defaultProfile.backups.retentionCount,
    backupSecondaryDir: secondaryDir,
    backupSchedule: normalizeBackupSchedule(profile.backups?.schedule),
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

function assertMaintenanceIdle(action) {
  if (maintenanceWorkflowActive) {
    throw new Error(`${action} is unavailable while ${maintenanceWorkflowName || "server maintenance"} is running.`);
  }
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
      assertMaintenanceIdle("Install or repair");
      sendJson(response, 202, { task: await runInstall(await getProfile(), true) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/update") {
      sendJson(response, 202, { task: await runUpdateServerWorkflow(await getProfile()) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/repair") {
      assertMaintenanceIdle("Install or repair");
      sendJson(response, 202, { task: await runInstall(await getProfile(), true) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/bootstrap-config") {
      assertMaintenanceIdle("Config generation");
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
      assertMaintenanceIdle("Start server");
      sendJson(response, 202, { server: await startGameServer(await getProfile()) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/stop") {
      assertMaintenanceIdle("Stop server");
      sendJson(response, 202, { task: await stopGameServer() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/actions/restart") {
      assertMaintenanceIdle("Restart server");
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
      assertMaintenanceIdle("Delete backup");
      const profile = await getProfile();
      sendJson(response, 200, {
        backup: await deleteBackup(profile, decodeURIComponent(deleteBackupMatch[1])),
        backups: await listBackups(profile)
      });
      return;
    }

    const restoreMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
    if (request.method === "POST" && restoreMatch) {
      assertMaintenanceIdle("Restore backup");
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
      startBackupScheduleTimer();
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
      stopBackupScheduleTimer();
      resolve();
    });
  });
}

module.exports = {
  startControlServer,
  stopControlServer,
  _internal: {
    isLikelyDragonwildsServerProcess,
    parseServerTelemetry,
    parseSteamManifestText
  }
};

if (require.main === module) {
  startControlServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
