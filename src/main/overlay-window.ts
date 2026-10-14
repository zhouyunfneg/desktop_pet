import { app, BrowserWindow, screen } from "electron";
import { isDesktopForeground } from "./desktop-icons";
import { workArea } from "./pet-window";
import { PRELOAD_PATH, RENDERER_INDEX } from "./paths";
import { settingsStore } from "./store";

/**
 * 装饰绘制层：一块铺满工作区、永远点击穿透的透明窗，专门画「整理区域框」。
 *
 * 为什么单独开一扇窗：狗窗用 setShape(SetWindowRgn) 做局部可交互，而 Windows 的
 * SetWindowRgn 会同时裁剪「绘制」和「命中测试」——狗窗只在狗+食盆那几块热区里画得出东西，
 * 区域框在热区之外根本显示不出来。所以把区域可视化拆到这扇纯绘制、全程穿透的窗里。
 *
 * 层级策略：WorkerW 贴桌面底层在部分 Win10 上催生不出可挂的壁纸层、HWND_BOTTOM 又会让
 * 透明窗跑到壁纸之下看不见。所以改用「floating + 只在桌面为前台时显示」：你在桌面时区域框出现，
 * 一旦切到任何应用窗口就自动隐藏 —— 效果上就是「只在桌面显示、不常驻最上层」。
 */

let win: BrowserWindow | null = null;
/** 整理时临时把区域框亮几秒的截止时间戳 */
let holdUntil = 0;
let poll: NodeJS.Timeout | null = null;

const POLL_MS = 500;

export function createOverlay(): BrowserWindow | null {
  if (win && !win.isDestroyed()) return win;
  const wa = workArea();
  win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.w,
    height: wa.h,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
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
  // 全程穿透：这层只负责画，任何鼠标动作都落到下面的真实桌面/窗口上
  win.setIgnoreMouseEvents(true, { forward: true });
  // floating：显示时能盖在桌面上（配合下面的前台判断，只在你看桌面时才显示）
  win.setAlwaysOnTop(true, "floating");
  win.loadFile(RENDERER_INDEX, { query: { view: "overlay" } });

  win.webContents.once("did-finish-load", () => refreshOverlay());

  win.on("closed", () => {
    win = null;
    if (poll) {
      clearInterval(poll);
      poll = null;
    }
  });

  // 改分辨率/缩放后重新铺满，否则区域框坐标和真实桌面对不上
  screen.on("display-metrics-changed", () => {
    if (!win || win.isDestroyed()) return;
    const next = workArea();
    win.setBounds({ x: next.x, y: next.y, width: next.w, height: next.h });
  });

  // 轮询前台窗口：桌面→显示，应用→隐藏
  if (poll) clearInterval(poll);
  poll = setInterval(() => refreshOverlay(), POLL_MS);

  return win;
}

export function getOverlay(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/** 可见条件：开着常驻或整理高亮未过期，并且当前前台是桌面本身 */
export function refreshOverlay(): void {
  if (!win || win.isDestroyed()) return;
  const want = (settingsStore.get().showZones || Date.now() < holdUntil) && isDesktopForeground();
  if (want && !win.isVisible()) win.show();
  else if (!want && win.isVisible()) win.hide();
}

/** 整理时临时把区域框亮几秒（狗跑动时能看到目标区域） */
export function holdOverlay(seconds = 5): void {
  holdUntil = Date.now() + seconds * 1000;
  refreshOverlay();
}

export function destroyOverlay(): void {
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
  win?.destroy();
  win = null;
}
