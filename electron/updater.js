const { dialog } = require("electron");
const log = require("electron-log");
const { autoUpdater } = require("electron-updater");
const { setUpdateController } = require("../server/update-controller");

const state = {
  enabled: false,
  status: "disabled",
  message: "Auto-update has not started.",
  currentVersion: null,
  availableVersion: null,
  downloadedVersion: null,
  percent: null,
  lastCheckedAt: null,
  lastError: null
};

function snapshot() {
  return { ...state };
}

function updateState(patch) {
  Object.assign(state, patch);
}

function describeError(error) {
  return error && error.message ? error.message : String(error);
}

function configureAutoUpdater(app) {
  updateState({
    currentVersion: app.getVersion()
  });

  if (!app.isPackaged) {
    updateState({
      enabled: false,
      status: "disabled",
      message: "Auto-update checks run only from the packaged app."
    });
    setUpdateController({
      getState: snapshot
    });
    return;
  }

  if (process.env.DWSC_DISABLE_AUTO_UPDATE === "1") {
    updateState({
      enabled: false,
      status: "disabled",
      message: "Auto-update is disabled by DWSC_DISABLE_AUTO_UPDATE."
    });
    setUpdateController({
      getState: snapshot
    });
    return;
  }

  log.transports.file.level = "info";
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  updateState({
    enabled: true,
    status: "idle",
    message: "Ready to check for app updates."
  });

  autoUpdater.on("checking-for-update", () => {
    updateState({
      status: "checking",
      message: "Checking GitHub Releases for updates...",
      lastCheckedAt: new Date().toISOString(),
      lastError: null
    });
  });

  autoUpdater.on("update-available", (info) => {
    updateState({
      status: "downloading",
      message: `Downloading version ${info.version}...`,
      availableVersion: info.version,
      percent: 0
    });
  });

  autoUpdater.on("update-not-available", () => {
    updateState({
      status: "current",
      message: "You are running the latest version.",
      percent: null
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    updateState({
      status: "downloading",
      message: `Downloading update: ${Math.round(progress.percent)}%`,
      percent: progress.percent
    });
  });

  autoUpdater.on("update-downloaded", async (info) => {
    updateState({
      status: "downloaded",
      message: `Version ${info.version} is ready to install.`,
      downloadedVersion: info.version,
      percent: 100
    });

    const result = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Dragonwilds Server Control update ready",
      message: `Version ${info.version} has been downloaded.`,
      detail: "Restart the control app to install the update. Your server files and settings will stay in their configured folders."
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on("error", (error) => {
    updateState({
      status: "error",
      message: "Update check failed.",
      lastError: describeError(error),
      percent: null
    });
  });

  setUpdateController({
    getState: snapshot,
    async checkNow() {
      if (!state.enabled) {
        throw new Error(state.message);
      }
      await autoUpdater.checkForUpdates();
      return snapshot();
    },
    async installNow() {
      if (state.status !== "downloaded") {
        throw new Error("No downloaded app update is ready to install.");
      }
      autoUpdater.quitAndInstall(false, true);
      return snapshot();
    }
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      updateState({
        status: "error",
        message: "Update check failed.",
        lastError: describeError(error)
      });
    });
  }, 4000);
}

module.exports = {
  configureAutoUpdater
};
