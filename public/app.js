const state = {
  profile: null,
  status: null,
  update: null,
  releaseNotes: null,
  activeView: "dashboard",
  refreshTimer: null
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

async function loadApp() {
  const payload = await api("/api/app");
  state.profile = payload.profile;
  state.status = payload.status;
  state.update = payload.update;
  state.releaseNotes = payload.releaseNotes;
  renderAll();
}

async function refreshStatus() {
  state.status = await api("/api/status");
  const updatePayload = await api("/api/updates");
  state.update = updatePayload.update;
  renderStatus();
  renderUpdateState();
  renderBackups();
  renderLogs();
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

  setText("appVersion", status.appVersion);
  setText("selectedPort", String(status.selectedPort));
  setText("maxPlayersTop", String(profile.server.maxPlayers));
  setText("serverStatus", status.serverRunning ? "ONLINE" : "OFFLINE");
  setText("serverPid", status.serverPid ? `PID ${status.serverPid}` : "Process not owned by app");
  setText("steamStatus", status.paths.steamcmd.exists ? "READY" : "MISSING");
  setText("steamPath", status.paths.steamcmd.path);
  setText("serverFileStatus", status.paths.serverExe.exists ? "READY" : "NOT INSTALLED");
  setText("serverPath", status.paths.serverDir.path);
  setText("portProbe", status.tcpPortOpen ? "TCP probe open" : "UDP setting; TCP closed");

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
}

function healthValue(ok, goodText, badText) {
  return {
    text: ok ? goodText : badText,
    className: ok ? "ok" : "bad"
  };
}

function renderHealth(status) {
  const items = [
    ["SteamCMD", healthValue(status.paths.steamcmd.exists, "Ready", "Missing")],
    ["Server executable", healthValue(status.paths.serverExe.exists, "Found", "Missing")],
    ["DedicatedServer.ini", healthValue(status.paths.config.exists, "Found", "Will be created")],
    ["Savegames folder", healthValue(status.paths.saves.exists, "Found", "Missing")],
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
    ["Server folder", status.paths.serverDir.path],
    ["Executable", status.paths.serverExe.path || "Not found yet"],
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
    ["Executable", status.paths.serverExe.path || "Not installed"]
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
                <div class="backup-meta">${new Date(backup.modifiedAt).toLocaleString()} · ${formatBytes(backup.sizeBytes)}</div>
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
  const combined = [
    ...(state.status?.logLines || []).map((line) => `[SERVER] ${line}`),
    ...(state.status?.activityLines || []).map((line) => `[CONTROL] ${line}`)
  ];
  const lines = search ? combined.filter((line) => line.toLowerCase().includes(search)) : combined;
  const output = lines.slice(-420).join("\n") || "No logs found yet.";
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
  form.serverName.value = profile.server.name;
  form.password.value = profile.server.password || "";
  form.maxPlayers.value = profile.server.maxPlayers;
  form.port.value = profile.server.port;
  form.queryPort.value = profile.server.queryPort;
  form.worldName.value = profile.server.worldName;
  form.launchArgs.value = profile.server.launchArgs;
  form.saveDir.value = profile.paths.saveDir;

  $("#steamcmdDir").value = profile.paths.steamcmdDir;
  $("#serverDir").value = profile.paths.serverDir;
  $("#configPath").value = profile.paths.configPath;
  $("#logPath").value = profile.paths.logPath;
  $("#backupDir").value = profile.paths.backupDir;
}

function renderMappings() {
  const mappings = state.profile.iniMappings;
  const rows = Object.entries(mappings)
    .map(
      ([field, mapping]) => `
        <div class="mapping-row" data-field="${escapeHtml(field)}">
          <span>${escapeHtml(field)}</span>
          <label>
            <span>Section</span>
            <input data-map-section value="${escapeAttr(mapping.section)}">
          </label>
          <label>
            <span>Key</span>
            <input data-map-key value="${escapeAttr(mapping.key)}">
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

function readProfileFromForm() {
  const form = $("#settingsForm");
  const next = structuredClone(state.profile);
  next.server.name = form.serverName.value.trim();
  next.server.password = form.password.value;
  next.server.maxPlayers = Number(form.maxPlayers.value || 4);
  next.server.port = Number(form.port.value || 7777);
  next.server.queryPort = Number(form.queryPort.value || next.server.port + 1);
  next.server.worldName = form.worldName.value.trim();
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
  toast("Settings saved. DedicatedServer.ini was updated using the current mappings.");
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

  $("#saveSettingsTop").addEventListener("click", saveSettings);
  $("#saveSettingsDetail").addEventListener("click", saveSettings);
  $("#runFullCheck").addEventListener("click", refreshStatus);
  $("#refreshNow").addEventListener("click", refreshStatus);
  $("#refreshLogs").addEventListener("click", refreshStatus);
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
    state.profile.customIniValues.push({ section: "Server", key: "", value: "" });
    renderMappings();
  });
}

wireEvents();
loadApp()
  .then(() => {
    state.refreshTimer = setInterval(refreshStatus, 5000);
  })
  .catch((error) => {
    toast(error.message);
  });
