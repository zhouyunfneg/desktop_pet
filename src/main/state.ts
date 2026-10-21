import { app, ipcMain, screen } from "electron";
import { defaultZones, validateConfig, type AppConfig, type Rect } from "../shared/config";
import { normalizeSettings } from "../shared/normalize";
import { IPC, type Settings, type UiState } from "../shared/ipc";
import { hasUndo } from "./organize";
import { refreshOverlay } from "./overlay-window";
import { pushState } from "./ipc";
import { applyTopmost } from "./pet-window";
import { configStore, settingsStore } from "./store";

/**
 * 设置相关状态的唯一出口。
 * 每个写操作都「落盘 + 让改动立刻生效 + 回一份全量 UiState」，
 * 这样设置窗不需要维护本地副本，不会出现「界面显示的和实际跑的不一样」。
 */

export function workArea(): Rect {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x, y: wa.y, w: wa.width, h: wa.height };
}

export function uiState(): UiState {
  return {
    settings: { ...settingsStore.get() },
    config: { ...configStore.get() },
    workArea: workArea(),
    desktopDir: app.getPath("desktop"),
    canUndo: hasUndo()
  };
}

export function patchSettings(patch: Partial<Settings>): UiState {
  settingsStore.set(patch);
  // IPC 与菜单都是信任边界：越界值当场按存档规则洗一遍，
  // 否则非法的 keepDistance / roamMode 会先被广播给渲染层，等下次启动才被洗掉
  settingsStore.replace(normalizeSettings(settingsStore.get()));
  const next = settingsStore.get();

  if (patch.topmost !== undefined) applyTopmost(next.topmost);
  // 漫游模式等改动由 pushState 带给渲染层，狗当场就换行为
  pushState();
  // 区域框画在另一栋穿透窗上，开关变了要显式刷它的可见性
  if (patch.showZones !== undefined) refreshOverlay();
  return uiState();
}

/** 菜单里的「跟随鼠标」勾选框：取消 = stay，狗自己跑去右下角蹲着 */
export function setFollow(on: boolean): UiState {
  return patchSettings({ roamMode: on ? "chase" : "stay" });
}

export function saveConfig(raw: AppConfig): UiState {
  const clean = validateConfig(raw, workArea());
  configStore.replace(clean);
  pushState();
  return uiState();
}

/** 区域编辑时点「生成默认区域」用，不做静默自动播种 */
export function seedZones(): UiState {
  const current = configStore.get();
  const clean = validateConfig(
    { ...current, zones: defaultZones(workArea(), current.rules) },
    workArea()
  );
  configStore.replace(clean);
  pushState();
  return uiState();
}

export function registerStateIpc(): void {
  ipcMain.handle(IPC.getState, () => uiState());
  ipcMain.handle(IPC.patchSettings, (_e, patch: Partial<Settings>) => patchSettings(patch));
  ipcMain.handle(IPC.saveConfig, (_e, config: AppConfig) => saveConfig(config));
  ipcMain.handle(IPC.seedZones, () => seedZones());
}
