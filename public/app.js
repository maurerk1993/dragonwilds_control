const state = {
  profile: null,
  status: null,
  update: null,
  releaseNotes: null,
  activeView: "dashboard",
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

function hasServerExecutable(status = state.status) {
  return Boolean(status?.paths?.serverExe?.exists);
}

function hasSaveFolder(status = state.status) {
  return Boolean(status?.paths?.saves?.exists);
}

function isConfigReady(status = state.status) {
  return Boolean(status?.configuration?.ready);
}

function configMissingText(status = state.status) {
  const missing = status?.configuration?.missingRequired || [];
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
      toast("Health check refreshed.");
    }
  } finally {
    state.refreshInFlight = false;
    scheduleRefresh();
  }
}

function renderAll() {
  renderProfileForm();
  renderMappings();
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

  setText("appVersion", status.appVersion);
  setText("selectedPort", String(status.selectedPort));
  setText("maxPlayersTop", String(profile.server.maxPlayers));
  setText("serverStatus", status.serverRunning ? "ONLINE" : "OFFLINE");
  setText("serverPid", status.serverPid ? `PID ${status.serverPid}` : "Process not owned by app");
  setText("steamStatus", status.paths.steamcmd.exists ? "READY" : "MISSING");
  setText("steamPath", status.paths.steamcmd.path);
  setText("serverFileStatus", executableReady ? "READY" : installed ? "FILES FOUND" : "NOT INSTALLED");
  setText("serverPath", status.paths.serverExe.path || status.paths.serverDir.path);
  setText("portProbe", status.tcpPortOpen ? "TCP probe open" : "UDP setting; TCP closed");
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
    setText("taskDetails", status.task.recentOutput.slice(-1)[0] || "Waiting for output...");
  } else {
    taskNotice.hidden = true;
  }

  renderHealth(status);
  renderPaths(status);
  renderServerDetails(status);
  renderInstallMode(status);
  renderSetupGate(status);
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
  const items = [
    ["SteamCMD", healthValue(status.paths.steamcmd.exists, "Ready", "Missing")],
    ["Server files", healthValue(installed, "Installed", "Not installed")],
    [
      "Mandatory config",
      config.ready
        ? { text: "Ready", className: "ok" }
        : { text: `Missing: ${configMissingText(status)}`, className: "bad" }
    ],
    [
      "Owner ID",
      config.values?.ownerIdSet
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
      status.paths.config.exists
        ? { text: "Found", className: "ok" }
        : { text: config.ready ? "Will be created" : "Needs setup", className: config.ready ? "warn" : "bad" }
    ],
    [
      "Savegames folder",
      status.paths.saves.exists
        ? { text: "Found", className: "ok" }
        : { text: installed ? "After first start" : "Missing", className: installed ? "warn" : "bad" }
    ],
    ["Log file", healthValue(status.paths.log.exists, "Found", "No log yet")],
    ["Selected port", { text: `${status.selectedPort}`, className: status.tcpPortOpen ? "ok" : "warn" }],
    ["Backup folder", healthValue(status.paths.backups.exists, "Ready", "Will be created")]
  ];

  $("#healthList").innerHTML = items
    .map(
      ([name, value]) => `
        <div class="health-item">
          <span class="health-name">${escapeHtml(name)}</span>
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
    ["Launch args", profile.server.launchArgs],
    ["Configured server port", profile.server.port],
    ["Configured query port", profile.server.queryPort],
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
              <div>
                <div class="backup-name">${escapeHtml(backup.name)}</div>
                <div class="backup-meta">${new Date(backup.modifiedAt).toLocaleString()} &middot; ${formatBytes(backup.sizeBytes)}</div>
              </div>
              <button class="ghost-button" data-restore="${encodeURIComponent(backup.id)}">Restore</button>
            </div>
          `
        )
        .join("")
    : `<div class="backup-item"><span class="backup-name">No backups yet</span><span class="backup-meta">Use Backup Now after the save folder exists.</span></div>`;

  $("#recentBackups").innerHTML = list;
  $("#allBackups").innerHTML = list;
}

function renderLogs() {
  const search = ($("#logSearch")?.value || "").toLowerCase();
  const task = state.status?.task;
  const taskLines = task
    ? [
        `[TASK] ${task.name} - ${task.status}${task.outputLineCount ? ` (${task.outputLineCount} retained lines)` : ""}`,
        ...(task.recentOutput || []).map((line) => `[TASK] ${line}`)
      ]
    : [];
  const combined = [
    ...taskLines,
    ...(state.status?.logLines || []).map((line) => `[SERVER] ${line}`),
    ...(state.status?.activityLines || []).map((line) => `[CONTROL] ${line}`)
  ];
  const lines = search ? combined.filter((line) => line.toLowerCase().includes(search)) : combined;
  const output = lines.slice(-1600).join("\n") || "No logs found yet.";
  $("#logOutput").textContent = output;
  $("#fullLogOutput").textContent = output;
  if ($("#autoScroll").checked) {
    $("#logOutput").scrollTop = $("#logOutput").scrollHeight;
  }
  $("#fullLogOutput").scrollTop = $("#fullLogOutput").scrollHeight;
}

function renderProfileForm() {
  const profile = state.profile;
  const form = $("#settingsForm");
  form.ownerId.value = profile.server.ownerId || "";
  form.serverName.value = profile.server.name;
  form.worldName.value = profile.server.worldName;
  form.adminPassword.value = profile.server.adminPassword || "";
  form.worldPassword.value = profile.server.worldPassword || profile.server.password || "";
  form.maxPlayers.value = profile.server.maxPlayers;
  form.port.value = profile.server.port;
  form.queryPort.value = profile.server.queryPort;
  form.launchArgs.value = profile.server.launchArgs;
  form.saveDir.value = profile.paths.saveDir;

  $("#steamcmdDir").value = profile.paths.steamcmdDir;
  $("#serverDir").value = profile.paths.serverDir;
  $("#configPath").value = profile.paths.configPath;
  $("#logPath").value = profile.paths.logPath;
  $("#backupDir").value = profile.paths.backupDir;
}

function renderMappings() {
  const mappings = state.profile.iniMappings || {};
  const rows = Object.entries(mappings)
    .map(
      ([field, mapping]) => `
        <div class="mapping-row" data-field="${escapeHtml(field)}">
          <span>${escapeHtml(field)}</span>
          <label>
            <span>Section</span>
            <input data-map-section value="${escapeAttr(mapping.section)}" disabled>
          </label>
          <label>
            <span>Key</span>
            <input data-map-key value="${escapeAttr(mapping.key)}" disabled>
          </label>
        </div>
      `
    )
    .join("");

  const customRows = (state.profile.customIniValues || [])
    .map(
      (entry, index) => `
        <div class="mapping-row custom" data-custom-index="${index}">
          <label>
            <span>Custom section</span>
            <input data-custom-section value="${escapeAttr(entry.section || "")}">
          </label>
          <label>
            <span>Custom key</span>
            <input data-custom-key value="${escapeAttr(entry.key || "")}">
          </label>
          <label>
            <span>Value</span>
            <input data-custom-value value="${escapeAttr(entry.value || "")}">
          </label>
        </div>
      `
    )
    .join("");

  $("#mappingTable").innerHTML = rows + customRows;
}

function renderReleaseNotes() {
  if (state.status && !isServerInstalled(state.status)) return;
  if (state.status && isServerInstalled(state.status) && !hasServerExecutable(state.status)) return;
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
  const savesReady = hasSaveFolder(status);
  const configReady = isConfigReady(status);
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
  $$("[data-requires-saves]").forEach((element) => {
    element.disabled = !savesReady || taskIsActive();
  });

  const installButtons = $$("[data-action='install']");
  installButtons.forEach((button) => {
    button.disabled = (!configReady || taskIsActive()) && !button.hidden;
  });

  const help = $("#installModeHelp");
  if (help) {
    help.textContent = installed
      ? "Server files are detected. Use Update Installed Server for normal patches. Advanced repair validates files and asks for extra confirmation before it runs."
      : "Run the initial install first. After files are detected, this page switches to update-first controls and hides repair behind extra confirmation.";
  }

  if (!configReady) {
    $("#actionHint").textContent = `Complete setup before install/start. Missing: ${configMissingText(status)}.`;
  } else if (!executableReady && installed) {
    $("#actionHint").textContent = "Files were found, but the server executable was not detected.";
  } else if (!installed) {
    $("#actionHint").textContent = "Install the dedicated server before starting or updating it.";
  } else {
    renderReleaseNotes();
  }
}

function renderSetupGate(status) {
  const gate = $("#setupGate");
  if (!gate) return;
  const ready = isConfigReady(status);
  gate.hidden = ready;
  if (ready) return;
  $("#setupMissingList").innerHTML = (status.configuration?.missingRequired || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
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
      ? `${task.name} is ${task.status}; console input ${canSend ? "ready" : "not available"}`
      : "No running console task";
  });
}

function readProfileFromForm() {
  const form = $("#settingsForm");
  const next = structuredClone(state.profile);
  next.server.ownerId = form.ownerId.value.trim();
  next.server.name = form.serverName.value.trim();
  next.server.worldName = form.worldName.value.trim();
  next.server.adminPassword = form.adminPassword.value;
  next.server.worldPassword = form.worldPassword.value;
  next.server.password = next.server.worldPassword;
  next.server.maxPlayers = Number(form.maxPlayers.value || 4);
  next.server.port = Number(form.port.value || 7777);
  next.server.queryPort = Number(form.queryPort.value || next.server.port + 1);
  next.server.launchArgs = form.launchArgs.value.trim();
  next.paths.saveDir = form.saveDir.value.trim();

  next.paths.steamcmdDir = $("#steamcmdDir").value.trim();
  next.paths.serverDir = $("#serverDir").value.trim();
  next.paths.configPath = $("#configPath").value.trim();
  next.paths.logPath = $("#logPath").value.trim();
  next.paths.backupDir = $("#backupDir").value.trim();

  $$(".mapping-row[data-field]").forEach((row) => {
    const field = row.dataset.field;
    next.iniMappings[field] = {
      section: row.querySelector("[data-map-section]").value.trim(),
      key: row.querySelector("[data-map-key]").value.trim()
    };
  });

  next.customIniValues = $$(".mapping-row.custom")
    .map((row) => ({
      section: row.querySelector("[data-custom-section]").value.trim(),
      key: row.querySelector("[data-custom-key]").value.trim(),
      value: row.querySelector("[data-custom-value]").value
    }))
    .filter((entry) => entry.section || entry.key || entry.value);

  return next;
}

async function saveSettings() {
  const next = readProfileFromForm();
  const payload = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify(next)
  });
  state.profile = payload.profile;
  state.status = payload.status;
  renderAll();
  if (!payload.status.configuration.ready) {
    toast(`Settings saved. Finish required setup before install/start: ${configMissingText(payload.status)}.`);
  } else {
    toast(
      payload.status.paths.config.exists
        ? "Settings saved. DedicatedServer.ini was generated with the official Dragonwilds values."
        : "Settings saved. DedicatedServer.ini will be generated before install/start."
    );
  }
}

async function runAction(action) {
  const map = {
    install: ["/api/actions/install", "Install or repair task started"],
    update: ["/api/actions/update", "Update task started"],
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
  if (["install", "start", "restart"].includes(action) && !isConfigReady()) {
    setView("dashboard");
    $("#settingsForm").ownerId?.focus();
    toast(`Complete dedicated server setup before continuing. Missing: ${configMissingText()}.`);
    return;
  }
  if (["start", "restart"].includes(action) && !hasServerExecutable()) {
    toast("The server executable was not detected. Run the initial install first.");
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

async function restoreBackup(id) {
  await api(`/api/backups/${id}/restore`, { method: "POST", body: "{}" });
  toast("Restore task started. The current save folder will be moved to a safety copy first.");
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

    const restoreButton = event.target.closest("[data-restore]");
    if (restoreButton) {
      const backupId = restoreButton.dataset.restore;
      const confirmed = confirm("Restore this backup? The current save folder will be moved to a safety copy first.");
      if (!confirmed) return;
      try {
        restoreButton.disabled = true;
        await restoreBackup(backupId);
      } catch (error) {
        toast(error.message);
      } finally {
        restoreButton.disabled = false;
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

  $("#saveSettingsTop").addEventListener("click", saveSettings);
  $("#saveSetupGate").addEventListener("click", saveSettings);
  $("#saveSettingsDetail").addEventListener("click", saveSettings);
  $("#runFullCheck").addEventListener("click", (event) => manualHealthCheck(event.currentTarget));
  $("#refreshNow").addEventListener("click", () => refreshStatus({ toastOnSuccess: true }));
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
  $("#logSearch").addEventListener("input", renderLogs);
  $("#addCustomIni").addEventListener("click", () => {
    state.profile.customIniValues = state.profile.customIniValues || [];
    state.profile.customIniValues.push({
      section: "/Script/Dominion.DedicatedServerSettings",
      key: "",
      value: ""
    });
    renderMappings();
  });
}

wireEvents();
loadApp().catch((error) => {
  toast(error.message);
});
