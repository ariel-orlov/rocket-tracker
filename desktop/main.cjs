// Rocket Tracker for macOS: the web app in its own window, with the app files bundled so it
// runs with no internet (map tiles you've already looked at are kept for offline use).
// Electron's Chromium keeps USB serial and Bluetooth working, which Safari-based wrappers can't.
const { app, BrowserWindow, dialog, session, shell } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// A fixed local address, because the browser keeps settings, the last fix and offline map
// tiles per address. 127.0.0.1 counts as a secure page, which USB and Bluetooth require.
const PORT = 47615;
const ROOT = path.join(__dirname, "app");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".bin": "application/octet-stream",
};

function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
      if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
      if (url.pathname.endsWith("/")) file = path.join(file, "index.html");
      fs.readFile(file, (err, data) => {
        if (err) return void res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
        res.end(data);
      });
    });
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---------- USB: pick the board without Chrome's port picker ----------
function chooseSerialPort(win, portList, callback) {
  // Only USB devices (the Mac's Bluetooth and debug ports have no vendor ID).
  const usb = portList.filter((p) => p.vendorId);
  if (usb.length === 1) return callback(usb[0].portId);
  if (usb.length === 0) {
    callback("");
    dialog.showMessageBox(win, {
      type: "info", message: "No board found on USB",
      detail: "Plug the ground station or flight unit in with a USB-C data cable (some cables only charge), then press USB again.",
    });
    return;
  }
  const labels = usb.map((p) => `${p.displayName || "USB device"} (${p.portName})`);
  dialog
    .showMessageBox(win, { type: "question", message: "Which board?", buttons: [...labels, "Cancel"], cancelId: labels.length })
    .then(({ response }) => callback(response < usb.length ? usb[response].portId : ""));
}

// ---------- Bluetooth: take the ground station as soon as the scan finds it ----------
let btPending = null;
let btTimer = null;
function chooseBluetoothDevice(win, devices, callback) {
  // Chromium calls this again every time the scan finds something new; the page's filter
  // already limits the list to the ground station's service and name.
  if (devices.length) {
    clearTimeout(btTimer);
    btTimer = null;
    btPending = null;
    return callback(devices[0].deviceId);
  }
  btPending = callback;
  if (btTimer) return;
  btTimer = setTimeout(() => {
    btTimer = null;
    btPending?.("");
    btPending = null;
    dialog.showMessageBox(win, {
      type: "info", message: "Couldn't find the ground station over Bluetooth",
      detail: "Check that it's switched on and close by. If macOS asked about Bluetooth, allow it; otherwise turn it on for Rocket Tracker in System Settings → Privacy & Security → Bluetooth.",
    });
  }, 20000);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 380, minHeight: 560,
    title: "Rocket Tracker", backgroundColor: "#10161d", show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => process.env.RT_SELFTEST || win.show());
  win.webContents.on("select-bluetooth-device", (event, devices, callback) => {
    event.preventDefault();
    chooseBluetoothDevice(win, devices, callback);
  });
  // Links like "Google Maps" open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.RT_SELFTEST) selfTest(win);
  void win.loadURL(`http://127.0.0.1:${PORT}/`);
  return win;
}

// RT_SELFTEST=1: print what the page can do, then quit. Used to check a build from the terminal.
function selfTest(win) {
  setTimeout(() => { console.log("SELFTEST timed out"); app.exit(1); }, 30000);
  win.webContents.on("console-message", (e) => console.log(`[page ${e.level}] ${e.message}`));
  win.webContents.on("did-finish-load", async () => {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const r = await win.webContents.executeJavaScript(`(async () => ({
        title: document.title, secure: isSecureContext, serial: "serial" in navigator, bluetooth: "bluetooth" in navigator,
        tabs: [...document.querySelectorAll(".tabs a")].map(a => a.textContent),
        connect: [...document.querySelectorAll(".conn .btn.primary")].map(b => b.textContent + (b.disabled ? " (disabled)" : "")),
        banners: [...document.querySelectorAll(".banner")].map(b => b.textContent),
        sw: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistration()) ? "registered" : "none yet" : "unsupported",
        firmware: await fetch("firmware/manifest.json").then(r => r.ok ? r.json().then(j => Object.keys(j.targets)) : r.status).catch(e => String(e)),
      }))()`);
      console.log("SELFTEST " + JSON.stringify(r));
    } catch (e) {
      console.log("SELFTEST failed: " + e);
    }
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  app.whenReady().then(async () => {
    const ses = session.defaultSession;
    ses.on("select-serial-port", (event, portList, webContents, callback) => {
      event.preventDefault();
      chooseSerialPort(BrowserWindow.fromWebContents(webContents), portList, callback);
    });
    // USB and Bluetooth stay allowed, so the app reconnects by itself when a board resets.
    ses.setPermissionCheckHandler((_wc, permission) => ["serial", "bluetooth", "geolocation", "clipboard-sanitized-write"].includes(permission));
    ses.setDevicePermissionHandler((d) => d.deviceType === "serial" || d.deviceType === "bluetooth");
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(["geolocation", "clipboard-sanitized-write", "fullscreen"].includes(permission)));
    try {
      await serve();
    } catch (e) {
      dialog.showErrorBox("Rocket Tracker can't start", `Port ${PORT} on this Mac is taken by another program (${e.message}).`);
      app.quit();
      return;
    }
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
