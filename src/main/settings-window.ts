import { app, BrowserWindow } from "electron";
import { PRELOAD_PATH, RENDERER_INDEX } from "./paths";

/**
 * 设置窗口。
 * 与狗窗共用同一份构建产物，靠 ?view=settings 分支渲染不同界面，
 * 省掉第二套打包入口和第二份依赖。
 */
let win: BrowserWindow | null = null;

const SIZE = { width: 470, height: 660 };

export function openSettings(): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show();
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    ...SIZE,
    minWidth: 400,
    minHeight: 480,
    title: "桌面宠物 · 设置",
    backgroundColor: "#F6F4F0",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });

  win.setMenu(null);
  // 关掉就当收起：下次秒开，也不用重建渲染进程
  win.on("close", (event) => {
    if (!win || win.isDestroyed()) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    win = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(`${devUrl}?view=settings`);
  } else {
    void win.loadFile(RENDERER_INDEX, { query: { view: "settings" } });
  }

  win.once("ready-to-show", () => win?.show());
  return win;
}

export function closeSettings(): void {
  if (win && !win.isDestroyed()) {
    win.destroy();
  }
  win = null;
}

export function isSettingsOpen(): boolean {
  return win !== null && !win.isDestroyed() && win.isVisible();
}
