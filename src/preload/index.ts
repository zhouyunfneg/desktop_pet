import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPC,
  type AteEvent,
  type AppConfig,
  type FeedReply,
  type FoldPreviewResult,
  type FoldUndoResult,
  type MenuAction,
  type MenuRequest,
  type NewsReply,
  type OrganizeEvent,
  type OrganizeResult,
  type PetBridge,
  type Rect,
  type Settings,
  type UiState,
  type UndoResult,
  type WeatherReply
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
  organize(): Promise<OrganizeResult> {
    return ipcRenderer.invoke(IPC.organize) as Promise<OrganizeResult>;
  },
  previewOrganize(): Promise<OrganizeResult> {
    return ipcRenderer.invoke(IPC.previewOrganize) as Promise<OrganizeResult>;
  },
  foldPreview(): Promise<FoldPreviewResult> {
    return ipcRenderer.invoke(IPC.foldPreview) as Promise<FoldPreviewResult>;
  },
  foldRun(): Promise<OrganizeResult> {
    return ipcRenderer.invoke(IPC.foldRun) as Promise<OrganizeResult>;
  },
  columnsRun(): Promise<OrganizeResult> {
    return ipcRenderer.invoke(IPC.columnsRun) as Promise<OrganizeResult>;
  },
  onFoldAsk(handler: (preview: FoldPreviewResult) => void): void {
    ipcRenderer.on(IPC.foldAsk, (_event, payload: FoldPreviewResult) => handler(payload));
  },
  undoOrganize(): Promise<UndoResult> {
    return ipcRenderer.invoke(IPC.undoOrganize) as Promise<UndoResult>;
  },
  undoFold(): Promise<FoldUndoResult> {
    return ipcRenderer.invoke(IPC.undoFold) as Promise<FoldUndoResult>;
  },
  settleIcon(name: string): void {
    ipcRenderer.send(IPC.settleIcon, name);
  },
  grabIcon(name: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC.grabIcon, name) as Promise<boolean>;
  },
  cancelCarry(): void {
    ipcRenderer.send(IPC.carryCancel);
  },
  getWeather(): Promise<WeatherReply> {
    return ipcRenderer.invoke(IPC.weather) as Promise<WeatherReply>;
  },
  getNews(): Promise<NewsReply> {
    return ipcRenderer.invoke(IPC.news) as Promise<NewsReply>;
  },
  onMenu(handler: (request: MenuRequest | null) => void): void {
    ipcRenderer.on(IPC.menuShow, (_event, request: MenuRequest | null) => handler(request));
  },
  pickMenu(action: MenuAction | null): void {
    ipcRenderer.send(IPC.menuPick, action);
  }
};

contextBridge.exposeInMainWorld("pet", api);
