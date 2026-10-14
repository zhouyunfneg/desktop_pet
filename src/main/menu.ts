import { Menu, app, type MenuItemConstructorOptions } from "electron";
import { openFeedDialog } from "./feeding";
import {
  applyTopmost,
  getFeedingSecondsLeft,
  getPetWindow,
  onMenuClose,
  onMenuOpen,
  setFeedingMode,
  toggleVisible
} from "./pet-window";
import { pushRecall, organizeNow, undoOrganizeNow, hasUndo } from "./ipc";
import { patchSettings, setFollow } from "./state";
import { openSettings } from "./settings-window";
import { settingsStore } from "./store";
import { refreshTrayMenu } from "./tray";

/** 右键 = 设置类 UI：M3 已有独立设置窗，菜单只留高频开关 */
const CANVAS_CLICK_SECONDS = 30;

function buildItems(): MenuItemConstructorOptions[] {
  const win = getPetWindow();
  const topmost = settingsStore.get().topmost;
  const feeding = getFeedingSecondsLeft();
  const following = settingsStore.get().roamMode !== "stay";
  const showZones = settingsStore.get().showZones;
  const undoable = hasUndo();
  return [
    {
      label: "跟随鼠标",
      type: "checkbox",
      checked: following,
      click: () => {
        setFollow(!following);
        refreshTrayMenu();
      }
    },
    { label: `保持距离 ${settingsStore.get().keepDistance} px（在设置里调）`, enabled: false },
    { type: "separator" },
    {
      label: "整理桌面（按分类把文件搬进区域）",
      click: () => {
        void organizeNow().then(refreshTrayMenu);
      }
    },
    {
      label: "撤销上一次整理",
      enabled: undoable,
      click: () => {
        void undoOrganizeNow().then(refreshTrayMenu);
      }
    },
    {
      label: "显示整理区域",
      type: "checkbox",
      checked: showZones,
      click: () => {
        patchSettings({ showZones: !showZones });
        refreshTrayMenu();
      }
    },
    { type: "separator" },
    {
      label: "喂文件…（进回收站）",
      click: () => {
        void openFeedDialog().then(refreshTrayMenu);
      }
    },
    {
      label: feeding ? `整块画布可点（还剩 ${feeding} 秒）` : "整块画布可点 30 秒",
      click: () => {
        setFeedingMode(feeding ? 0 : CANVAS_CLICK_SECONDS);
        refreshTrayMenu();
      }
    },
    { type: "separator" },
    {
      label: "始终置顶",
      type: "checkbox",
      checked: topmost,
      click: () => {
        const next = !settingsStore.get().topmost;
        settingsStore.set({ topmost: next });
        applyTopmost(next);
      }
    },
    {
      label: win?.isVisible() ? "隐藏小狗" : "显示小狗",
      click: () => toggleVisible()
    },
    { label: "回到食盆旁", click: () => pushRecall() },
    { type: "separator" },
    { label: "设置…", click: () => openSettings() },
    ...(app.isPackaged
      ? []
      : [
          {
            label: "开发者工具",
            click: () => getPetWindow()?.webContents.toggleDevTools()
          }
        ]),
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ];
}

export function showPetContextMenu(x: number, y: number): void {
  const win = getPetWindow();
  if (!win) return;
  // 菜单弹出时，临时把命中区放大到整块画布，让点击其他地方时菜单能正常关闭
  onMenuOpen();
  const menu = Menu.buildFromTemplate(buildItems());
  menu.on("menu-will-close", () => {
    // 菜单关闭后，恢复命中区
    onMenuClose();
  });
  menu.popup({ window: win, x, y });
}

export function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate(buildItems());
}
