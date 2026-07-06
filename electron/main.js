const path = require("path");
const { spawn } = require("child_process");
const { app, BrowserWindow, dialog, shell } = require("electron");
const { configureAutoUpdater } = require("./updater");

process.env.DWSC_HOST = "127.0.0.1";
process.env.DWSC_PORT = "0";
process.env.DWSC_NO_OPEN = "1";

let mainWindow = null;
let serverHandle = null;

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function isRunningAsAdmin() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve(false);
      return;
    }
    const child = spawn("net.exe", ["session"], {
      windowsHide: true,
      stdio: "ignore"
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function relaunchAsAdmin() {
  const command = `Start-Process -FilePath ${psString(process.execPath)} -Verb RunAs`;
  spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  ).unref();
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 720,
    show: false,
    title: "Dragonwilds Server Control",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    backgroundColor: "#101312",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });

  mainWindow.loadURL(url);
}

async function startApp() {
  process.env.DWSC_DATA_DIR = path.join(app.getPath("userData"), "control-data");
  configureAutoUpdater(app);
  const { startControlServer } = require("../server/index");
  serverHandle = await startControlServer();
  createWindow(serverHandle.url);
}

app.whenReady().then(async () => {
  if (
    process.platform === "win32" &&
    app.isPackaged &&
    process.env.DWSC_SKIP_ELEVATION !== "1" &&
    !(await isRunningAsAdmin())
  ) {
    relaunchAsAdmin();
    app.quit();
    return;
  }

  startApp().catch((error) => {
    dialog.showErrorBox(
      "Dragonwilds Server Control could not start",
      error && error.stack ? error.stack : String(error)
    );
    app.quit();
  });
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
    createWindow(serverHandle.url);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  const { stopControlServer } = require("../server/index");
  if (!serverHandle) return;

  event.preventDefault();
  serverHandle = null;
  try {
    await stopControlServer();
  } finally {
    app.exit(0);
  }
});
