import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPC,
  type AteEvent,
  type AppConfig,
  type FeedReply,
  type OrganizeEvent,
  type OrganizeResult,
  type PetBridge,
  type Rect,
  type Settings,
  type UiState,
  type UndoResult
} from "../shared/ipc";

/**
 * 渲染层能做的全部越界动作，都在这个白名单里。
 * nodeIntegration 关闭、contextIsolation 开启，狗本身没有任何文件系统权限 ——
 * 「吃掉文件」只能递路径过来，能不能吃、进不进回收站全由主进程判定。
 */
const api: PetBridge = {
  setHotRegion(rects: Rect[]): void {
    ipcRenderer.send(IPC.setHotRegion, rects);
  },
  sendTrayIcon(dataUrl: string): void {
    ipcRenderer.send(IPC.trayIcon, dataUrl);
  },
  feed(paths: string[]): Promise<FeedReply> {
    return ipcRenderer.invoke(IPC.feed, paths) as Promise<FeedReply>;
  },
  // Electron 34 起 File.path 被移除，拖放拿绝对路径只能走 webUtils，且必须在 preload 里调
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
  onAte(handler: (event: AteEvent) => void): void {
    ipcRenderer.on(IPC.ate, (_event, payload: AteEvent) => handler(payload));
  },
  onState(handler: (state: UiState) => void): void {
    ipcRenderer.on(IPC.stateChanged, (_event, payload: UiState) => handler(payload));
  },
  onCursor(handler: (x: number, y: number) => void): void {
    ipcRenderer.on(IPC.cursor, (_event, x: number, y: number) => handler(x, y));
  },
  onRecall(handler: () => void): void {
    ipcRenderer.on(IPC.recall, () => handler());
  },
  onOrganize(handler: (event: OrganizeEvent) => void): void {
    ipcRenderer.on(IPC.organizeDone, (_event, payload: OrganizeEvent) => handler(payload));
  },
  getState(): Promise<UiState> {
    return ipcRenderer.invoke(IPC.getState) as Promise<UiState>;
  },
  patchSettings(patch: Partial<Settings>): Promise<UiState> {
    return ipcRenderer.invoke(IPC.patchSettings, patch) as Promise<UiState>;
  },
  saveConfig(config: AppConfig): Promise<UiState> {
    return ipcRenderer.invoke(IPC.saveConfig, config) as Promise<UiState>;
  },
  seedZones(): Promise<UiState> {
    return ipcRenderer.invoke(IPC.seedZones) as Promise<UiState>;
  },
  setFeedingMode(seconds: number): Promise<number> {
    return ipcRenderer.invoke(IPC.setFeedingMode, seconds) as Promise<number>;
  },
  organize(): Promise<OrganizeResult> {
    return ipcRenderer.invoke(IPC.organize) as Promise<OrganizeResult>;
  },
  previewOrganize(): Promise<OrganizeResult> {
    return ipcRenderer.invoke(IPC.previewOrganize) as Promise<OrganizeResult>;
  },
  undoOrganize(): Promise<UndoResult> {
    return ipcRenderer.invoke(IPC.undoOrganize) as Promise<UndoResult>;
  },
  settleIcon(name: string): void {
    ipcRenderer.send(IPC.settleIcon, name);
  },
  getWeather(): Promise<string> {
    return ipcRenderer.invoke(IPC.weather) as Promise<string>;
  },
  onNews(handler: (text: string) => void): void {
    ipcRenderer.on(IPC.news, (_event, text: string) => handler(text));
  }
};

contextBridge.exposeInMainWorld("pet", api);
