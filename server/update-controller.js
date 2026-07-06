let controller = {
  getState() {
    return {
      status: "unavailable",
      message: "App updates are available only in the packaged desktop app."
    };
  },
  async checkNow() {
    throw new Error("App updates are available only in the packaged desktop app.");
  },
  async installNow() {
    throw new Error("No downloaded app update is ready to install.");
  }
};

function setUpdateController(nextController) {
  controller = {
    ...controller,
    ...nextController
  };
}

function getUpdateState() {
  return controller.getState();
}

function checkForAppUpdates() {
  return controller.checkNow();
}

function installDownloadedAppUpdate() {
  return controller.installNow();
}

module.exports = {
  setUpdateController,
  getUpdateState,
  checkForAppUpdates,
  installDownloadedAppUpdate
};
