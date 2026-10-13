const { app, BrowserWindow, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { getWidgetSize, getWidgetBounds } = require('./widget-layout');

// Claim the app before starting its local service.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => showWidget());

const monitorServer = require('./server.js');

let widgetWindow = null;
let controlWindow = null;
let CONFIG_FILE;
let widgetConversationCount = 0;
let serviceReady = false;
const APP_DISPLAY_NAME = 'ChatGPT Light';

function getAppDisplayName() {
  return APP_DISPLAY_NAME;
}

function initConfigPath() {
  if (!CONFIG_FILE) {
    const userData = app.getPath('userData');
    CONFIG_FILE = path.join(userData, 'traffic-light-config.json');
    const legacy = path.join(app.getPath('appData'), 'codex-light', 'traffic-light-config.json');
    if (['chatgpt-light', APP_DISPLAY_NAME].includes(path.basename(userData)) && !fs.existsSync(CONFIG_FILE) && fs.existsSync(legacy)) {
      fs.mkdirSync(userData, { recursive: true });
      fs.copyFileSync(legacy, CONFIG_FILE);
    }
  }
}

function getSavedPosition() {
  initConfigPath();
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.widgetX !== undefined && config.widgetY !== undefined) {
        return { x: config.widgetX, y: config.widgetY };
      }
    } catch (err) {
      console.error('Failed to parse config for position:', err.message);
    }
  }
  return null;
}

function savePosition(x, y) {
  try {
    let config = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      } catch (e) {}
    }
    config.widgetX = x;
    config.widgetY = y;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save window position:', err.message);
  }
}

function createControlWindow() {
  if (controlWindow) {
    controlWindow.show();
    controlWindow.focus();
    return;
  }

  controlWindow = new BrowserWindow({
    width: 480,
    height: 564,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: `${getAppDisplayName()} 设置`,
    backgroundColor: '#f5f5f7',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });

  controlWindow.loadURL(`${monitorServer.url}/index.html`);

  controlWindow.on('closed', () => {
    controlWindow = null;
  });
}

function resizeWidget() {
  if (!widgetWindow) return;
  const previous = widgetWindow.getBounds();
  const workArea = screen.getDisplayMatching(previous).workArea;
  const size = getWidgetSize(widgetConversationCount, monitorServer.getConfig().scale, workArea);
  widgetWindow.setBounds(getWidgetBounds(size, workArea, previous));
}

function createWidgetWindow() {
  initConfigPath();
  const savedPos = getSavedPosition();
  const workArea = savedPos ? screen.getDisplayNearestPoint(savedPos).workArea : screen.getPrimaryDisplay().workArea;
  const size = getWidgetSize(widgetConversationCount, monitorServer.getConfig().scale, workArea);
  const previous = savedPos ? { ...savedPos, width: size.width } : null;
  widgetWindow = new BrowserWindow({
    ...getWidgetBounds(size, workArea, previous),
    title: `${getAppDisplayName()} 对话灯条`,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required' }
  });
  widgetWindow.loadURL(`${monitorServer.url}/widget.html`);

  const { Menu, MenuItem } = require('electron');
  const contextMenu = new Menu();
  contextMenu.append(new MenuItem({
    label: '设置',
    click: () => createControlWindow()
  }));
  contextMenu.append(new MenuItem({ type: 'separator' }));
  contextMenu.append(new MenuItem({
    label: '退出应用',
    click: () => { app.quit(); }
  }));

  widgetWindow.webContents.on('context-menu', () => {
    contextMenu.popup(widgetWindow);
  });

  let saveTimeout = null;
  widgetWindow.on('move', () => {
    if (!widgetWindow) return;
    const [currX, currY] = widgetWindow.getPosition();
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      savePosition(currX, currY);
    }, 500);
  });

  widgetWindow.on('closed', () => {
    widgetWindow = null;
  });
}

function showWidget() {
  if (!app.isReady() || !serviceReady) return;
  if (widgetWindow) widgetWindow.showInactive();
  else createWidgetWindow();
}
monitorServer.onCodexDetected = showWidget;

monitorServer.onQuitRequested = () => {
  app.quit();
};

monitorServer.onConfigUpdated = () => {
  if (controlWindow) controlWindow.setTitle(`${getAppDisplayName()} 设置`);
  resizeWidget();
};
monitorServer.onWidgetLayout = count => {
  widgetConversationCount = count;
  resizeWidget();
};
monitorServer.onShowControl = () => createControlWindow();

Promise.all([app.whenReady(), monitorServer.ready]).then(() => {
  serviceReady = true;
  showWidget();
  app.on('activate', showWidget);
}).catch(async error => {
  await app.whenReady();
  dialog.showErrorBox(`无法启动 ${getAppDisplayName()}`, `本地状态服务无法启动：${error.message}`);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => monitorServer.close());
