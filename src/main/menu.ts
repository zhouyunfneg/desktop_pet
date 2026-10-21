import { Menu, app, ipcMain, type MenuItemConstructorOptions } from "electron";
import { IPC } from "../shared/ipc";
import {
  buildMenu,
  isMenuAction,
  statusLineOf,
  type MenuAction,
  type MenuGroup,
  type MenuInput,
  type MenuRequest
} from "../shared/menu";
import { getPetWindow, onMenuClose, onMenuOpen, toggleVisible } from "./pet-window";
import { pushMenu, pushRecall, organizeNow } from "./ipc";
import { patchSettings, setFollow } from "./state";
import { openSettings } from "./settings-window";
import { openFeedDialog } from "./feeding";
import { settingsStore } from "./store";
import { refreshTrayMenu } from "./tray";

/**
 * 右键菜单。
 *
 * 狗身上的右键菜单现在是渲染层画的玻璃面板（原生 Menu 碰不到样式），
 * 这里只负责「按当前状态算出菜单结构」和「把选中的动作执行掉」。
 * 系统托盘那一份没法自绘，仍用原生 Menu，但吃的是同一份结构，
 * 不会出现两边勾选状态不一致。
 */

/** 菜单最多停留这么久；渲染层要是没回话，命中区不能一直占着整块画布 */
const MENU_WATCHDOG_MS = 15_000;
let watchdog: NodeJS.Timeout | null = null;
let menuOpen = false;

/** 开发调试启动时才给「打断点调试」这一项：正常用时菜单里没有它 */
const debugMenu = !app.isPackaged && process.env.PET_DEV === "1";

function currentState(): MenuInput {
  const s = settingsStore.get();
  const win = getPetWindow();
  return {
    roamMode: s.roamMode,
    keepDistance: s.keepDistance,
    topmost: s.topmost,
    dogVisible: Boolean(win && win.isVisible()),
    debugMenu,
    petName: s.petName,
    // 陪伴时长按本次进程启动算：主进程一起来就计时，狗窗没建起来的那几秒也算进去
    uptimeSeconds: process.uptime()
  };
}

export function menuGroups(): MenuGroup[] {
  return buildMenu(currentState());
}

function clearWatchdog(): void {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

/** 收起菜单：恢复命中区，并让渲染层把面板拆掉 */
export function closePetMenu(): void {
  if (!menuOpen) return;
  menuOpen = false;
  clearWatchdog();
  onMenuClose();
  pushMenu(null);
}

/** 右键了：算好结构交给渲染层画 */
export function showPetContextMenu(x: number, y: number): void {
  const win = getPetWindow();
  if (!win) return;
  // 菜单可能比狗身宽大得多，命中区先放大到整块画布，点外面才收得到
  onMenuOpen();
  menuOpen = true;
  clearWatchdog();
  watchdog = setTimeout(closePetMenu, MENU_WATCHDOG_MS);
  const state = currentState();
  const request: MenuRequest = {
    x,
    y,
    groups: buildMenu(state),
    name: state.petName,
    statusLine: statusLineOf(state)
  };
  pushMenu(request);
}

/** 执行一个菜单动作；action 为 null 表示用户点了菜单外 */
export function runMenuAction(action: MenuAction | null): void {
  closePetMenu();
  if (!action) return;
  const s = currentState();
  switch (action) {
    case "follow":
      setFollow(s.roamMode === "stay");
      break;
    case "recall":
      pushRecall();
      break;
    case "organize":
      void organizeNow();
      break;
    case "feed":
      void openFeedDialog();
      break;
    case "topmost":
      patchSettings({ topmost: !s.topmost });
      break;
    case "toggleVisible":
      toggleVisible();
      break;
    case "settings":
      openSettings();
      break;
    case "devtools":
      getPetWindow()?.webContents.toggleDevTools();
      break;
    case "quit":
      app.quit();
      return;
    default:
      console.warn("[menu] 不认识的动作，已忽略");
      return;
  }
  refreshTrayMenu();
}

/** 渲染层回传的入口：只认白名单里的动作名 */
export function handleMenuPick(raw: unknown): void {
  if (raw === null || raw === undefined) {
    closePetMenu();
    return;
  }
  if (!isMenuAction(raw)) {
    console.warn("[menu] 收到非法动作，已忽略");
    closePetMenu();
    return;
  }
  runMenuAction(raw);
}

/**
 * 菜单自己的 IPC 在这里注册，而不是塞进 ipc.ts：
 * ipc.ts 已经导出 pushMenu 给本模块用，反向 import 会成环。
 */
export function registerMenuIpc(): void {
  ipcMain.on(IPC.menuPick, (_event, action: unknown) => handleMenuPick(action));
}

/** 托盘那一份没法自绘：把同一份结构翻译成原生菜单项 */
export function buildTrayMenu(): Menu {
  const items: MenuItemConstructorOptions[] = [];
  menuGroups().forEach((group, gi) => {
    if (gi > 0) items.push({ type: "separator" });
    items.push({ label: group.title, enabled: false });
    for (const entry of group.items) {
      items.push({
        label: entry.label + (entry.hint ? `  (${entry.hint})` : ""),
        type: entry.checked === undefined ? "normal" : "checkbox",
        checked: entry.checked,
        enabled: entry.enabled,
        click: () => runMenuAction(entry.action)
      });
    }
  });
  return Menu.buildFromTemplate(items);
}
