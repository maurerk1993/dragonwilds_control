const state = {
  profile: null,
  status: null,
  update: null,
  releaseNotes: null,
  activeView: "dashboard",
  setupEditorOpen: false,
  refreshTimer: null,
  refreshInFlight: false
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(element.timeout);
  element.timeout = setTimeout(() => {
    element.hidden = true;
  }, 5200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function setView(view) {
  state.activeView = view;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.remove("active"));
  $(`#${view}View`)?.classList.add("active");
}

function isServerInstalled(status = state.status) {
  return Boolean(status?.paths?.serverInstall?.installed || status?.paths?.serverExe?.exists);
}

function isServerInstallPartial(status = state.status) {
  return Boolean(status?.paths?.serverInstall?.partialInstallDetected);
}

function isInstallOrUpdateTaskActive(status = state.status) {
  const task = status?.task;
  return Boolean(task && ["running", "stopping"].includes(task.status) && /install|update|repair/i.test(task.name || ""));
}

function hasServerExecutable(status = state.status) {
  return Boolean(status?.paths?.serverExe?.exists);
}

function hasSaveFolder(status = state.status) {
  return Boolean(status?.paths?.saves?.exists);
}

function hasRequiredSetupValues(status = state.status) {
  return Boolean(status?.configuration?.ready);
}

function hasWindowsConfig(status = state.status) {
  return Boolean(status?.paths?.config?.exists);
}

function hasConfigSource(status = state.status) {
  return Boolean(status?.paths?.config?.exists || status?.configuration?.templateAvailable);
}

function isConfigReady(status = state.status) {
  return Boolean(status?.configuration?.iniReady ?? (hasRequiredSetupValues(status) && hasWindowsConfig(status)));
}

function configMissingItems(status = state.status) {
  const missing = status?.configuration?.missingRequired || [];
  const items = [...missing];
  if (isServerInstalled(status) && hasRequiredSetupValues(status) && !hasWindowsConfig(status)) {
    items.push("DedicatedServer.ini Windows copy");
  }
  return items;
}

function configMissingText(status = state.status) {
  const missing = configMissingItems(status);
  return missing.length ? missing.join(", ") : "required setup values";
}

async function loadApp() {
  const payload = await api("/api/app");
  state.profile = payload.profile;
  state.status = payload.status;
  state.update = payload.update;
  state.releaseNotes = payload.releaseNotes;
  renderAll();
  scheduleRefresh();
}

function taskIsActive() {
  return ["running", "stopping"].includes(state.status?.task?.status);
}

function nextRefreshDelay() {
  return taskIsActive() ? 900 : 4000;
}

function scheduleRefresh(delay = nextRefreshDelay()) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refreshStatus, delay);
}

async function refreshStatus(options = {}) {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    state.status = await api("/api/status");
    const updatePayload = await api("/api/updates");
    state.update = updatePayload.update;
    renderStatus();
    renderUpdateState();
    renderBackups();
    renderLogs();
    if (options.toastOnSuccess) {
      toast(options.toastMessage || "Health check refreshed.");
    }
  } finally {
    state.refreshInFlight = false;
    scheduleRefresh();
  }
}

function renderAll() {
  renderProfileForm();
  renderStatus();
  renderUpdateState();
  renderBackups();
  renderLogs();
  renderReleaseNotes();
}

function renderStatus() {
  const status = state.status;
  const profile = state.profile;
  if (!status || !profile) return;
  const installed = isServerInstalled(status);
  const executableReady = hasServerExecutable(status);
  const installStillRunning = isInstallOrUpdateTaskActive(status);
  const partialInstall = isServerInstallPartial(status);

  setText("appVersion", status.appVersion);
  setText("selectedPort", String(status.selectedPort));
  setText("maxPlayersTop", String(profile.server.maxPlayers));
  setText("serverStatus", status.serverRunning ? "ONLINE" : "OFFLINE");
  setText("serverPid", status.serverPid ? `PID ${status.serverPid}` : "Process not owned by app");
  setText("steamStatus", status.paths.steamcmd.exists ? "READY" : "MISSING");
  setText("steamPath", status.paths.steamcmd.path);
  setText(
    "serverFileStatus",
    executableReady ? "READY" : installStillRunning || partialInstall ? "INSTALLING" : "NOT INSTALLED"
  );
  setText("serverPath", status.paths.serverExe.path || status.paths.serverDir.path);
  setText(
    "portProbe",
    `Secondary ${status.secondaryPort || Number(status.selectedPort) + 1}; ${status.tcpPortOpen ? "TCP probe open" : "forward UDP"}`
  );
  setText(
    "healthLastChecked",
    status.generatedAt ? `Last checked ${new Date(status.generatedAt).toLocaleTimeString()}` : "Not checked yet"
  );

  const footerDot = $("#footerStatusDot");
  footerDot.classList.toggle("online", status.serverRunning);
  footerDot.classList.toggle("offline", !status.serverRunning);
  setText("footerStatusText", status.serverRunning ? "Server process is running" : "Server process is stopped");

  const taskNotice = $("#taskNotice");
  if (status.task && status.task.status === "running") {
    taskNotice.hidden = false;
    setText("taskName", status.task.name);
    setText("taskDetails", status.task.userPrompt || status.task.recentOutput.slice(-1)[0] || "Waiting for output...");
  } else {
    taskNotice.hidden = true;
  }

  renderHealth(status);
  renderPaths(status);
  renderServerDetails(status);
  renderInstallMode(status);
  renderSetupGate(status);
  renderIniFile(status);
  renderConsoleControls(status);
}

function healthValue(ok, goodText, badText) {
  return {
    text: ok ? goodText : badText,
    className: ok ? "ok" : "bad"
  };
}

function renderHealth(status) {
  const installed = isServerInstalled(status);
  const executableReady = hasServerExecutable(status);
  const config = status.configuration || {};
  const setupValuesReady = hasRequiredSetupValues(status);
  const templateReady = Boolean(status.paths.configTemplate?.exists);
  const installStillRunning = isInstallOrUpdateTaskActive(status);
  const partialInstall = isServerInstallPartial(status);
  const configFileStatus = status.paths.config.exists
    ? { text: "Found", className: "ok" }
    : installed && templateReady
      ? { text: "Template ready", className: "warn" }
      : installed
        ? { text: "Generate config", className: "warn" }
        : { text: "Install first", className: "warn" };
  const items = [
    ["SteamCMD", healthValue(status.paths.steamcmd.exists, "Ready", "Missing")],
    [
      "Server files",
      installed
        ? { text: "Installed", className: "ok" }
        : installStillRunning || partialInstall
          ? { text: "Installing", className: "warn" }
          : { text: "Not installed", className: "bad" }
    ],
    [
      "Setup values",
      !installed
        ? { text: "After install", className: "warn" }
        : setupValuesReady
        ? { text: "Ready", className: "ok" }
        : { text: `Missing: ${configMissingText(status)}`, className: "bad" }
    ],
    [
      "Owner ID",
      !installed
        ? { text: "After install", className: "warn" }
        : config.values?.ownerIdSet
        ? { text: "Set", className: "ok" }
        : { text: "Required", className: "bad" }
    ],
    [
      "Server executable",
      executableReady
        ? { text: "Found", className: "ok" }
        : { text: installed ? "Missing executable" : "Missing", className: "bad" }
    ],
    [
      "DedicatedServer.ini",
      configFileStatus
    ],
    [
      "Savegames folder",
      status.paths.saves.exists
        ? { text: "Found", className: "ok" }
        : { text: installed ? "After first start" : "Missing", className: installed ? "warn" : "bad" }
    ],
    ["Log file", healthValue(status.paths.log.exists, "Found", "No log yet")],
    ["Game port", { text: `${status.selectedPort}`, className: status.tcpPortOpen ? "ok" : "warn" }],
    ["Secondary port", { text: `${status.secondaryPort || Number(status.selectedPort) + 1}`, className: "warn" }],
    ["Backup folder", healthValue(status.paths.backups.exists, "Ready", "Will be created")]
  ];

  $("#healthList").innerHTML = items
    .map(
      ([name, value]) => `
        <div class="health-item health-item-${value.className}">
          <span class="health-name"><span class="health-dot" aria-hidden="true"></span>${escapeHtml(name)}</span>
          <span class="health-value ${value.className}">${escapeHtml(value.text)}</span>
        </div>
      `
    )
    .join("");
}

function renderPaths(status) {
  const paths = [
    ["SteamCMD", status.paths.steamcmd.path],
    ["Install status", isServerInstalled(status) ? "Server files detected" : "Server files not detected"],
    ["Server folder", status.paths.serverDir.path],
    ["Executable", status.paths.serverExe.path || "Not found yet"],
    ["Steam manifest", status.paths.serverInstall?.manifestPath || "Not found yet"],
    ["Config", status.paths.config.path],
    ["Official Linux template", status.paths.configTemplate?.path || "Not found yet"],
    ["Savegames", status.paths.saves.path],
    ["Log file", status.paths.log.path],
    ["Backups", status.paths.backups.path]
  ];

  $("#installPaths").innerHTML = paths
    .map(
      ([name, value]) => `
        <div class="path-item">
          <span class="path-name">${escapeHtml(name)}</span>
          <span class="path-value">${escapeHtml(value)}</span>
        </div>
      `
    )
    .join("");
}

function renderServerDetails(status) {
  const profile = state.profile;
  const details = [
    ["App ID", profile.appId],
    ["Custom launch args", profile.server.launchArgs],
    ["Effective launch args", status.effectiveLaunchArgsText || profile.server.launchArgs],
    ["Game port", status.selectedPort || profile.server.port],
    ["Secondary port", status.secondaryPort || profile.server.queryPort],
    ["Server folder", status.paths.serverDir.path],
    ["Executable", status.paths.serverExe.path || "Not installed"],
    ["Expected executable", (status.paths.serverInstall?.expectedExecutables || []).join(", ")]
  ];

  $("#serverDetails").innerHTML = details
    .map(
      ([name, value]) => `
        <div class="detail-item">
          <span class="detail-name">${escapeHtml(name)}</span>
          <span class="detail-value">${escapeHtml(String(value))}</span>
        </div>
      `
    )
    .join("");
}

function renderBackups() {
  const backups = state.status?.backups || [];
  const list = backups.length
    ? backups
        .map(
          (backup) => `
            <div class="backup-item">
              <div class="backup-icon" aria-hidden="true">B</div>
              <div class="backup-copy">
                <div class="backup-name">${escapeHtml(backup.name)}</div>
                <div class="backup-meta">${new Date(backup.modifiedAt).toLocaleString()} &middot; ${formatBytes(backup.sizeBytes)}</div>
              </div>
            </div>
          `
        )
        .join("")
    : `
      <div class="backup-empty">
        <strong>No backups yet</strong>
        <span>Use Backup Now after the save folder exists.</span>
      </div>
    `;

  $("#recentBackups").innerHTML = list;
  $("#allBackups").innerHTML = list;
}

function buildConsoleLines(status = state.status) {
  const task = status?.task;
  const taskLines = task
    ? [
        `[TASK] ${task.name} - ${task.status}${task.outputLineCount ? ` (${task.outputLineCount} retained lines)` : ""}${task.externalWindow ? " - external command window opened" : ""}`,
        ...(task.recentOutput || []).map((line) => `[TASK] ${line}`)
      ]
    : [];
  return [
    ...taskLines,
    ...(status?.logLines || []).map((line) => `[SERVER] ${line}`),
    ...(status?.activityLines || []).map((line) => `[CONTROL] ${line}`)
  ];
}

function statCard(label, value) {
  return `
    <div class="console-stat">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeAttr(value)}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderConsoleSummary(status = state.status) {
  const task = status?.task;
  const active = ["running", "stopping"].includes(task?.status);
  const summary = $("#consoleSummary");
  if (summary) {
    summary.innerHTML = [
      statCard("Task", active ? `${task.name} (${task.status})` : "No running task"),
      statCard("Window", task?.externalWindow ? "External command window opened" : "None active"),
      task?.scriptPath ? statCard("Script", task.scriptPath) : "",
      statCard("Retained", `${status?.logRetentionHours || 72} hours`),
      statCard("Lines", String(buildConsoleLines(status).length))
    ].join("");
  }

  const meta = $("#consoleMeta");
  if (meta) {
    meta.innerHTML = [
      statCard("Task", active ? `${task.name} (${task.status})` : "No running task"),
      statCard("Console Input", task?.canReceiveInput ? "Ready" : "Not available"),
      statCard("Window", task?.externalWindow ? "External command window opened" : "None active"),
      task?.windowCommand ? statCard("Command", task.windowCommand) : "",
      statCard("Retention", `${status?.logRetentionHours || 72} hours`)
    ].join("");
  }
}

function renderLogs() {
  const search = ($("#consoleSearch")?.value || "").toLowerCase();
  const combined = buildConsoleLines(state.status);
  const lines = search ? combined.filter((line) => line.toLowerCase().includes(search)) : combined;
  const output = lines.join("\n") || "No console output found in the retained window.";
  const fullOutput = $("#fullLogOutput");
  if (fullOutput) {
    fullOutput.textContent = output;
    if ($("#consoleAutoScroll")?.checked) {
      fullOutput.scrollTop = fullOutput.scrollHeight;
    }
  }
  renderConsoleSummary(state.status);
}

function renderProfileForm() {
  const profile = state.profile;
  const form = $("#setupForm");
  if (!form) return;
  form.elements.ownerId.value = profile.server.ownerId || "";
  form.elements.serverName.value = profile.server.name;
  form.elements.worldName.value = profile.server.worldName;
  form.elements.adminPassword.value = profile.server.adminPassword || "";
  form.elements.worldPassword.value = profile.server.worldPassword || profile.server.password || "";
  form.elements.port.value = profile.server.port;
}

function renderIniFile(status = state.status) {
  const output = $("#iniFileContents");
  if (!output || !status) return;
  const configPath = status.paths?.config?.path || "DedicatedServer.ini";
  const templatePath = status.paths?.configTemplate?.path || "official Linux DedicatedServer.ini template";
  const openButton = $("#openIniFile");
  if (openButton) {
    openButton.disabled = !status.paths?.config?.exists;
    openButton.title = status.paths?.config?.exists
      ? `Open ${configPath}`
      : "DedicatedServer.ini is not available yet.";
  }

  if (status.paths?.config?.exists) {
    setText("iniFilePath", "Windows config file");
    output.textContent = status.configuration?.iniText || "DedicatedServer.ini is empty.";
  } else if (!isServerInstalled(status)) {
    setText("iniFilePath", "Install required");
    output.textContent = `DedicatedServer.ini is not available yet.\n\nInstall the Dragonwilds dedicated server first. After SteamCMD places the official config template, the setup prompt can copy and patch it for Windows.\n\nExpected Windows path:\n${configPath}`;
  } else if (status.paths?.configTemplate?.exists) {
    setText("iniFilePath", "Template ready");
    output.textContent = `Windows DedicatedServer.ini is not in place yet.\n\nSave setup to copy the official installed template and patch your required values before starting the server.\n\nWindows path:\n${configPath}\n\nOfficial template:\n${templatePath}`;
  } else {
    setText("iniFilePath", "Generate config first");
    output.textContent = `DedicatedServer.ini was not found.\n\nRun Update or Repair so SteamCMD provides the official template, then save setup again. The app will not generate this file from scratch.\n\nExpected Windows path:\n${configPath}\n\nExpected template:\n${templatePath}`;
  }
}

function renderReleaseNotes() {
  if (state.status && !isServerInstalled(state.status)) return;
  if (state.status && isServerInstalled(state.status) && !hasServerExecutable(state.status)) return;
  if (state.status && !isConfigReady(state.status)) return;
  const notes = state.releaseNotes?.notes || [];
  if (!notes.length) return;
  const text = notes.map((note) => `${note.heading}: ${note.body}`).join(" ");
  $("#actionHint").textContent = `v${state.releaseNotes.version} - ${notes[0].heading}`;
  $("#actionHint").title = text;
}

function renderUpdateState() {
  const update = state.update || {
    status: "unavailable",
    message: "Updates are available from the packaged desktop app."
  };
  const label = {
    disabled: "Disabled",
    unavailable: "Unavailable",
    idle: "Ready",
    checking: "Checking",
    current: "Up to date",
    downloading: "Downloading",
    downloaded: "Ready to install",
    error: "Error"
  }[update.status] || update.status || "Unknown";

  setText("updateStatus", label);
  setText("updateMessage", update.lastError ? `${update.message} ${update.lastError}` : update.message);
  const installButton = $("#installAppUpdate");
  if (installButton) {
    installButton.disabled = update.status !== "downloaded";
  }

  const details = [
    ["Current version", update.currentVersion || state.status?.appVersion || "Unknown"],
    ["Available version", update.availableVersion || "None"],
    ["Downloaded version", update.downloadedVersion || "None"],
    ["Last checked", update.lastCheckedAt ? new Date(update.lastCheckedAt).toLocaleString() : "Not yet"],
    ["Download progress", Number.isFinite(update.percent) ? `${Math.round(update.percent)}%` : "Not active"]
  ];

  const container = $("#updateDetails");
  if (!container) return;
  container.innerHTML = details
    .map(
      ([name, value]) => `
        <div class="detail-item">
          <span class="detail-name">${escapeHtml(name)}</span>
          <span class="detail-value">${escapeHtml(String(value))}</span>
        </div>
      `
    )
    .join("");
}

function renderInstallMode(status) {
  const installed = isServerInstalled(status);
  const executableReady = hasServerExecutable(status);
  const installStillRunning = isInstallOrUpdateTaskActive(status);
  const partialInstall = isServerInstallPartial(status);
  const savesReady = hasSaveFolder(status);
  const configReady = isConfigReady(status);
  const setupValuesReady = hasRequiredSetupValues(status);
  $("#installGate").hidden = installed;

  $$("[data-show-when-missing]").forEach((element) => {
    element.hidden = installed;
  });
  $$("[data-show-when-installed]").forEach((element) => {
    element.hidden = !installed;
  });
  $$("[data-requires-installed]").forEach((element) => {
    element.disabled = !installed || taskIsActive();
  });
  $$("[data-requires-exe]").forEach((element) => {
    element.disabled = !executableReady || !configReady || taskIsActive();
  });
  $$("[data-requires-server-exe]").forEach((element) => {
    element.disabled = !executableReady || hasConfigSource(status) || taskIsActive();
  });
  $$("[data-requires-saves]").forEach((element) => {
    element.disabled = !savesReady || taskIsActive();
  });

  const installButtons = $$("[data-action='install']");
  installButtons.forEach((button) => {
    button.disabled = taskIsActive() && !button.hidden;
  });

  const help = $("#installModeHelp");
  if (help) {
    help.textContent = installed
      ? "Server files are detected. Use Update Installed Server for normal patches. Advanced repair validates files and asks for extra confirmation before it runs."
      : installStillRunning || partialInstall
        ? "SteamCMD has started writing files, but the dedicated server executable is not detected yet. Wait for the external command window to finish before setup."
      : "Run the initial install first. After files are detected, this page switches to update-first controls and hides repair behind extra confirmation.";
  }

  if (!installed && (installStillRunning || partialInstall)) {
    $("#actionHint").textContent = "Install is still running or incomplete. Wait for the external command window to finish, then refresh.";
  } else if (!installed) {
    $("#actionHint").textContent = "Install the dedicated server first. Setup prompts appear after files are detected.";
  } else if (!hasConfigSource(status)) {
    $("#actionHint").textContent = "Run Generate Config to launch the server once, then close its console after 10 seconds so DedicatedServer.ini can be created.";
  } else if (!setupValuesReady) {
    $("#actionHint").textContent = `Complete setup before start. Missing: ${configMissingText(status)}.`;
  } else if (!status.paths.config.exists) {
    $("#actionHint").textContent = "Save setup to copy and patch the official DedicatedServer.ini before starting.";
  } else if (!executableReady && installed) {
    $("#actionHint").textContent = "Files were found, but the server executable was not detected.";
  } else {
    renderReleaseNotes();
  }
}

function renderSetupGate(status) {
  const gate = $("#setupGate");
  if (!gate) return;
  const ready = isConfigReady(status);
  const installed = isServerInstalled(status);
  const installStillRunning = isInstallOrUpdateTaskActive(status);
  const partialInstall = isServerInstallPartial(status);
  const canOpenSetup = installed && !installStillRunning && !partialInstall && hasConfigSource(status);
  const setupRequired = !ready;
  const showEditor = canOpenSetup && (setupRequired || state.setupEditorOpen);

  $$("[data-open-setup]").forEach((button) => {
    button.disabled = !canOpenSetup;
    button.title = canOpenSetup
      ? status.serverRunning
        ? "Stop the server before saving setup changes."
        : "Edit setup values and patch DedicatedServer.ini."
      : "Install the server and generate DedicatedServer.ini before editing setup.";
  });

  if (!canOpenSetup) {
    state.setupEditorOpen = false;
  }

  gate.hidden = !showEditor;
  gate.classList.toggle("is-ready", ready);
  if (!showEditor) return;

  setText("setupGateTitle", setupRequired ? "Dedicated server setup is required" : "Edit dedicated server setup");
  setText(
    "setupGateDescription",
    setupRequired
      ? "Dragonwilds will not start until the installed official DedicatedServer.ini is copied into the WindowsServer folder and patched with your Owner ID, Server Name, Default World Name, and Admin Password."
      : "Update the saved Owner ID, names, passwords, or Game Port, then save while the server is stopped so the app can patch DedicatedServer.ini."
  );

  const missingList = $("#setupMissingList");
  missingList.hidden = !setupRequired;
  missingList.innerHTML = setupRequired
    ? configMissingItems(status)
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")
    : "";

  const closeButton = $("#closeSetupGate");
  if (closeButton) {
    closeButton.hidden = setupRequired;
    closeButton.disabled = taskIsActive();
  }

  const saveButton = $("#saveSetupGate");
  if (saveButton) {
    saveButton.disabled = taskIsActive() || Boolean(status.serverRunning);
    saveButton.textContent = setupRequired ? "Save Setup" : "Save Changes";
    saveButton.title = status.serverRunning
      ? "Stop the server before saving setup changes."
      : "Save setup and patch DedicatedServer.ini.";
  }
}

function renderConsoleControls(status) {
  const task = status?.task;
  const canSend = Boolean(task?.canReceiveInput);
  const active = ["running", "stopping"].includes(task?.status);
  $$("[data-console-form]").forEach((form) => {
    form.querySelectorAll("input, button").forEach((element) => {
      if (element.matches("[data-stop-task]")) {
        element.disabled = !active;
      } else {
        element.disabled = !canSend;
      }
    });
  });
  $$("[data-console-state]").forEach((element) => {
    element.textContent = active
      ? `${task.name} is ${task.status}; ${task.externalWindow ? "use the external command window for input" : `console input ${canSend ? "ready" : "not available"}`}`
      : "No running console task";
  });
}

function readProfileFromForm() {
  const form = $("#setupForm");
  const next = structuredClone(state.profile);
  if (!form) return next;
  next.server.ownerId = form.elements.ownerId.value.trim();
  next.server.name = form.elements.serverName.value.trim();
  next.server.worldName = form.elements.worldName.value.trim();
  next.server.adminPassword = form.elements.adminPassword.value;
  next.server.worldPassword = form.elements.worldPassword.value;
  next.server.password = next.server.worldPassword;
  const gamePort = Number(form.elements.port.value || 7777);
  if (!Number.isInteger(gamePort) || gamePort < 1 || gamePort > 65534) {
    throw new Error("Game Port must be a whole number from 1 to 65534 because Dragonwilds also uses the next port.");
  }
  next.server.port = gamePort;
  next.server.queryPort = Number(next.server.port) + 1;

  return next;
}

async function saveSettings() {
  if (state.status?.serverRunning) {
    throw new Error("Stop the Dragonwilds server before saving setup changes. The game can overwrite live config edits.");
  }
  const next = readProfileFromForm();
  const payload = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify(next)
  });
  state.profile = payload.profile;
  state.status = payload.status;
  if (isConfigReady(payload.status)) {
    state.setupEditorOpen = false;
  }
  renderAll();
  if (payload.status.configuration.lastPatchError) {
    toast(`Setup saved, but DedicatedServer.ini was not patched: ${payload.status.configuration.lastPatchError.message}`);
  } else if (!hasRequiredSetupValues(payload.status)) {
    toast(`Setup saved. Finish required setup before start: ${configMissingText(payload.status)}.`);
  } else {
    toast(
      payload.status.paths.config.exists
        ? "Setup saved. DedicatedServer.ini was patched using the official file/template."
        : "Setup saved. Install the server first, then save setup again to patch the official DedicatedServer.ini."
    );
  }
}

async function runAction(action) {
  const map = {
    install: ["/api/actions/install", "Install or repair task started"],
    update: ["/api/actions/update", "Update workflow started"],
    "bootstrap-config": ["/api/actions/bootstrap-config", "First-run config generation started"],
    start: ["/api/actions/start", "Server start requested"],
    stop: ["/api/actions/stop", "Server stop requested"],
    restart: ["/api/actions/restart", "Server restart requested"],
    backup: ["/api/backups", "Backup task started"]
  };
  const [path, message] = map[action] || [];
  if (!path) return;

  if (taskIsActive()) {
    toast("A task is already running. Watch it in the live console or stop it before starting another.");
    return;
  }
  if (["update"].includes(action) && !isServerInstalled()) {
    toast("Install the Dragonwilds dedicated server before running updates.");
    return;
  }
  if (["start", "restart"].includes(action) && !hasServerExecutable()) {
    toast("The server executable was not detected. Run the initial install first.");
    return;
  }
  if (action === "bootstrap-config" && !hasServerExecutable()) {
    toast("Install the Dragonwilds dedicated server before generating DedicatedServer.ini.");
    return;
  }
  if (action === "bootstrap-config" && hasConfigSource()) {
    toast("DedicatedServer.ini or the official config template is already available. Fill setup and save it.");
    return;
  }
  if (["start", "restart"].includes(action) && !isConfigReady()) {
    setView("dashboard");
    $("#setupForm").elements.ownerId?.focus();
    toast(`Complete dedicated server setup before starting. Missing: ${configMissingText()}.`);
    return;
  }
  if (action === "backup" && !hasSaveFolder()) {
    toast("The save folder does not exist yet. Start the server once before creating backups.");
    return;
  }
  if (action === "install" && isServerInstalled()) {
    const first = confirm("Server files are already installed. Run repair/validate instead of a normal update?");
    if (!first) return;
    const second = confirm("Repair can take longer because SteamCMD validates the install. Are you sure you want to continue?");
    if (!second) return;
  }

  const payload = await api(path, { method: "POST", body: "{}" });
  toast(message);
  if (payload.task) state.status.task = payload.task;
  await refreshStatus();
}

async function sendConsoleInput(input) {
  const payload = await api("/api/tasks/active/input", {
    method: "POST",
    body: JSON.stringify({ input })
  });
  if (payload.task) state.status.task = payload.task;
  renderStatus();
  renderLogs();
}

async function stopConsoleTask() {
  const payload = await api("/api/tasks/active/stop", {
    method: "POST",
    body: "{}"
  });
  if (payload.task) state.status.task = payload.task;
  toast("Stop requested for the running task.");
  renderStatus();
  renderLogs();
}

async function openIniFile() {
  const payload = await api("/api/files/config/open", { method: "POST", body: "{}" });
  toast(payload.file?.selectedFile ? "Opened DedicatedServer.ini." : "Opened the config folder.");
}

async function manualHealthCheck(button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Checking...";
  try {
    await refreshStatus({ toastOnSuccess: true });
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function wireEvents() {
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  document.body.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      try {
        actionButton.disabled = true;
        await runAction(actionButton.dataset.action);
      } catch (error) {
        toast(error.message);
      } finally {
        actionButton.disabled = false;
      }
    }

    const openViewButton = event.target.closest("[data-open-view]");
    if (openViewButton) {
      setView(openViewButton.dataset.openView);
    }

    const openSetupButton = event.target.closest("[data-open-setup]");
    if (openSetupButton) {
      state.setupEditorOpen = true;
      setView("dashboard");
      renderSetupGate(state.status);
      $("#setupGate")?.scrollIntoView({ block: "start", behavior: "smooth" });
      $("#setupForm")?.elements.ownerId?.focus();
    }

    const closeSetupButton = event.target.closest("[data-close-setup]");
    if (closeSetupButton) {
      state.setupEditorOpen = false;
      renderSetupGate(state.status);
    }

    const quitButton = event.target.closest("[data-console-send]");
    if (quitButton) {
      try {
        await sendConsoleInput(quitButton.dataset.consoleSend);
      } catch (error) {
        toast(error.message);
      }
    }

    const stopTaskButton = event.target.closest("[data-stop-task]");
    if (stopTaskButton) {
      try {
        stopTaskButton.disabled = true;
        await stopConsoleTask();
      } catch (error) {
        toast(error.message);
      } finally {
        stopTaskButton.disabled = false;
      }
    }

  });

  document.body.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-console-form]");
    if (!form) return;
    event.preventDefault();
    const input = form.elements.command.value;
    try {
      await sendConsoleInput(input);
      form.reset();
    } catch (error) {
      toast(error.message);
    }
  });

  $("#setupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveSettings();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#runFullCheck").addEventListener("click", (event) => manualHealthCheck(event.currentTarget));
  $("#refreshNow").addEventListener("click", () => refreshStatus({ toastOnSuccess: true }));
  $("#refreshIniView").addEventListener("click", () =>
    refreshStatus({ toastOnSuccess: true, toastMessage: "DedicatedServer.ini refreshed." })
  );
  $("#openIniFile").addEventListener("click", async () => {
    try {
      await openIniFile();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#refreshLogs").addEventListener("click", () => refreshStatus({ toastOnSuccess: true }));
  $("#checkAppUpdate").addEventListener("click", async () => {
    try {
      const payload = await api("/api/updates/check", { method: "POST", body: "{}" });
      state.update = payload.update;
      renderUpdateState();
      toast("App update check started.");
    } catch (error) {
      toast(error.message);
      await refreshStatus();
    }
  });
  $("#installAppUpdate").addEventListener("click", async () => {
    try {
      await api("/api/updates/install", { method: "POST", body: "{}" });
    } catch (error) {
      toast(error.message);
      await refreshStatus();
    }
  });
  $("#consoleSearch").addEventListener("input", renderLogs);
}

wireEvents();
loadApp().catch((error) => {
  toast(error.message);
});
