import { app, BrowserWindow, screen } from "electron";
import { URLSearchParams } from "node:url";
import { IPC, type Rect } from "../shared/ipc";
import { PRELOAD_PATH, RENDERER_INDEX } from "./paths";
import { settingsStore } from "./store";

/**
 * 宠物窗口 = 铺满工作区的一层透明画布。
 *
 * 为什么不是「一小块窗口跟着狗跑」：逐帧 SetWindowPos 会抖，而且狗跑不出窗口边界。
 * 关键约束：全屏透明窗一旦取消穿透，整个桌面的点击都会被它吞掉。
 * 所以不用 setIgnoreMouseEvents，改用 setShape —— 命中区域只等于「狗 + 食盆 + 气泡」，
 * 区域之外对系统的命中测试根本不存在，点击自然落到下面的窗口。
 * 附带好处：食盆一直在命中区里，资源管理器直接拖文件到碗上就能投喂，不需要额外开关。
 */

let win: BrowserWindow | null = null;
/** 渲染层上报的命中矩形（画布坐标 = 工作区相对坐标） */
let hotRects: Rect[] = [];
let cursorTimer: NodeJS.Timeout | null = null;
let lastCursor = { x: 0, y: 0 };
let shapeSig = "";
/** 首次显示门控：等渲染层报上第一次命中区（狗已画好）再 show，避免开场白边闪一下 */
let revealed = false;
/**
 * 菜单开着：命中区必须一直保持整块画布。
 * 渲染层的帧循环每帧都会重报「狗 + 碗 + 气泡」那一小块，不拦下来的话
 * SetWindowRgn 会把玻璃菜单面板一起裁掉，看起来就是菜单根本没弹出来。
 */
let menuHeld = false;

const CURSOR_HZ = 40;

export function workArea(): Rect {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x, y: wa.y, w: wa.width, h: wa.height };
}

/** 工作区相对坐标 → 窗口内坐标 */
function origin(): { x: number; y: number } {
  const b = win?.getBounds();
  return { x: b?.x ?? 0, y: b?.y ?? 0 };
}

function applyShape(): void {
  if (!win || win.isDestroyed()) return;
  const wa = workArea();
  const rects = hotRects.filter((r) => r.w > 0 && r.h > 0);

  const sig = JSON.stringify(rects);
  if (sig === shapeSig) return;
  shapeSig = sig;
  // Electron 的 Rectangle 用 width/height，内部 Rect 用 w/h，这里过一次转换
  const toElectron = (list: Rect[]) => list.map((r) => ({ x: r.x, y: r.y, width: r.w, height: r.h }));
  try {
    win.setShape(toElectron(rects.length > 0 ? rects : [{ x: -1, y: -1, w: 1, h: 1 }]));
  } catch (err) {
    // 个别驱动/远程桌面下 SetWindowRgn 会失败；退化成「狗身上可点」的穿透切换
    console.warn("[pet-window] setShape 失败，退化为鼠标穿透切换", err);
    win.setShape(toElectron([{ x: 0, y: 0, w: wa.w, h: wa.h }]));
    win.setIgnoreMouseEvents(true, { forward: true });
  }
}

/** 渲染层算好「狗 + 碗 + 气泡」的外接框后报上来 */
export function setHotRegion(rects: Rect[]): void {
  hotRects = Array.isArray(rects) ? rects.slice(0, 8) : [];
  if (!menuHeld) applyShape();
  reveal();
}

/** 菜单弹出时，临时把命中区放大到整块画布，让点击其他地方时菜单能正常关闭 */
export function onMenuOpen(): void {
  if (!win || win.isDestroyed()) return;
  menuHeld = true;
  const wa = workArea();
  win.setShape([{ x: 0, y: 0, width: wa.w, height: wa.h }]);
}

/** 菜单关闭后，恢复命中区 */
export function onMenuClose(): void {
  menuHeld = false;
  shapeSig = "";
  applyShape();
}

/**
 * 只在第一次命中区上报后显示窗口（此时区域已贴合狗，不会露出未绘制的白边）。
 * 兜底路径也必须先设命中区：透明窗在没调用过 setShape 之前是整块可点的，
 * 直接 show 会把整个桌面的点击都吞掉，用户表现为「桌面点不动了」。
 */
function reveal(): void {
  if (revealed || !win || win.isDestroyed()) return;
  if (hotRects.length === 0) applyShape();
  revealed = true;
  win.show();
}

function startCursorPolling(): void {
  if (cursorTimer) clearInterval(cursorTimer);
  // 命中区之外收不到 mousemove，追/躲行为需要的鼠标位置只能由主进程轮询
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    if (p.x === lastCursor.x && p.y === lastCursor.y) return;
    lastCursor = p;
    const o = origin();
    win.webContents.send(IPC.cursor, p.x - o.x, p.y - o.y);
  }, 1000 / CURSOR_HZ);
}

export function createPetWindow(): BrowserWindow {
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
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // 不可聚焦 = WS_EX_NOACTIVATE：摸狗不会把用户的打字焦点抢走
    focusable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      // preload 编译后需要 require 同项目的 shared 模块，沙箱化的 preload 只能 require electron。
      // 页面全部本地可信、且渲染层依旧拿不到 node，这里先关沙箱；M5 打包 preload 后再打开。
      sandbox: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });

  win.setMenu(null);
  applyTopmost(settingsStore.get().topmost);
  // 不在这里调用 applyShape()：此时 hotRects 是空的，setShape 会被设置为无效的 1x1 区域
  // 这个无效的 setShape 会导致后续切换时出现白边
  // 改在第一次 setHotRegion 时再调用 applyShape() 和 win.show()
  startCursorPolling();
  win.on("closed", () => {
    win = null;
    if (cursorTimer) clearInterval(cursorTimer);
    cursorTimer = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  // 只给开发/QA 用的查询串：DPET_DEBUG=1 画命中框并把 console 转印到终端，
  // DPET_STAGE=teen|adult 强制预览某个成长阶段。
  const debugQuery: Record<string, string> = {};
  if (process.env.DPET_DEBUG) debugQuery.debug = "1";
  if (process.env.DPET_STAGE) debugQuery.stage = process.env.DPET_STAGE;
  const hasQuery = Object.keys(debugQuery).length > 0;
  if (devUrl) {
    void win.loadURL(hasQuery ? `${devUrl}?${new URLSearchParams(debugQuery)}` : devUrl);
  } else {
    void win.loadFile(RENDERER_INDEX, hasQuery ? { query: debugQuery } : undefined);
  }

  // 不等 ready-to-show 就显示（那时狗还没画、区域还没设，会白边闪一下）；
  // 改由第一次 setHotRegion 上报时 reveal，这里只兑一个超时防渲染层挂掉时永远不显示
  win.once("ready-to-show", () => setTimeout(reveal, 1500));

  // 改分辨率/缩放后重新铺满，否则狗跑不出旧边界
  screen.on("display-metrics-changed", () => {
    if (!win || win.isDestroyed()) return;
    const next = workArea();
    win.setBounds({ x: next.x, y: next.y, width: next.w, height: next.h });
    shapeSig = "";
    applyShape();
  });

  return win;
}

export function getPetWindow(): BrowserWindow | null {
  return win;
}

export function applyTopmost(topmost: boolean): void {
  if (!win || win.isDestroyed()) return;
  // 'floating' 层级：盖在普通窗口之上，但不遮挡全屏播放
  win.setAlwaysOnTop(topmost, topmost ? "floating" : "normal");
}

/** 收起/唤出整个宠物层（狗和食盆一起，因为是同一张画布） */
export function toggleVisible(): boolean {
  if (!win || win.isDestroyed()) return false;
  if (win.isVisible()) {
    win.hide();
    return false;
  }
  win.show();
  return true;
}

/** 把狗叫回食盆旁：位置是渲染层状态，只能发消息过去 */
export function recallDog(): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC.recall);
}
