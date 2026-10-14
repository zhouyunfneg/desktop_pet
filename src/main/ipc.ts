import { ipcMain, type BrowserWindow } from "electron";
import { IPC, type AteEvent, type OrganizeEvent, type OrganizeResult, type Rect, type UndoResult, type UiState } from "../shared/ipc";
import { feedFiles } from "./feed";
import { hasUndo, runOrganize, runUndo, settleIcon } from "./organize";
import { holdOverlay } from "./overlay-window";
import { setHotRegion } from "./pet-window";
import { ensureTray } from "./tray";
import { fetchWeather, fetchNewsBatch, type NewsBatch } from "./info-service";

/**
 * 主进程 → 渲染层的单向通道。
 * 单独一层是为了断开循环引用：ipc → state → 这里，而不是 state 反过来 import ipc。
 */
let petWin: BrowserWindow | null = null;
let decoWin: BrowserWindow | null = null;
let provider: (() => UiState) | null = null;

export function bindPetWindow(win: BrowserWindow): void {
  petWin = win;
}

/** 装饰绘制层（区域框）也要收 stateChanged，才能跟着配置实时重画 */
export function bindDecoWindow(win: BrowserWindow): void {
  decoWin = win;
}

export function setStateProvider(fn: () => UiState): void {
  provider = fn;
}

function send<T>(channel: string, payload: T): void {
  if (!petWin || petWin.isDestroyed()) return;
  petWin.webContents.send(channel, payload);
}

function broadcast<T>(channel: string, payload: T): void {
  for (const w of [petWin, decoWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** 设置变了、存档重置了、拖喂倒计时变了 —— 都推这一份全量状态（狗窗 + 绘制层） */
export function pushState(): void {
  if (provider) broadcast(IPC.stateChanged, provider());
}

export function pushAte(event: AteEvent): void {
  send(IPC.ate, event);
}

/** 菜单里的「回到食盆旁」：狗位置是渲染层状态，只能发令 */
export function pushRecall(): void {
  send(IPC.recall, null);
}

/** 整理完成：推给狗窗驱动搬运动画 */
export function pushOrganize(event: OrganizeEvent): void {
  send(IPC.organizeDone, event);
}

/**
 * 整理/预览/撤销的统一入口：菜单和设置窗都走这里，保证「搬完让狗动 + 刷 canUndo」只有一份。
 * organize.ts 不 import 本模块，事件推送收在这一层，避免循环依赖。
 */
export async function organizeNow(): Promise<OrganizeResult> {
  const res = await runOrganize(false);
  if (res.moved.length > 0) {
    pushOrganize({ moved: res.moved.length, zones: res.zones, steps: res.steps });
    holdOverlay(8); // 狗逐个搬运时把目标区域框亮出来
  }
  pushState();
  return res;
}

export async function previewOrganizeNow(): Promise<OrganizeResult> {
  return runOrganize(true);
}

export async function undoOrganizeNow(): Promise<UndoResult> {
  const res = await runUndo();
  pushState();
  return res;
}

export { hasUndo };

/** 每小时推送新闻的定时器 */
let newsTimer: NodeJS.Timeout | null = null;
/** 最近一批新闻的内容日期：换天（如从 10-13 变 10-14）时重置已播记录 */
let newsDate = "";
/** 本轮已播报过的条目：一轮之内每条只播一次，避免全天重复同一条 */
const playedNews = new Set<string>();

/** 从当天批次里挑一条没播过的；全播完了就开下一轮继续播 */
function pickFreshNews(batch: NewsBatch): string {
  if (newsDate !== batch.date) {
    newsDate = batch.date;
    playedNews.clear();
  }
  let fresh = batch.items.filter((s) => !playedNews.has(s));
  if (fresh.length === 0) {
    playedNews.clear();
    fresh = batch.items;
  }
  const pick = fresh[Math.floor(Math.random() * fresh.length)];
  playedNews.add(pick);
  return pick;
}

function startNewsTimer(): void {
  if (newsTimer) clearInterval(newsTimer);
  // 每小时抓一次。源每天只更新一次（早晨出当天内容），抓取本身拿整批，
  // 推送时去重轮流播，一天内不会来回重复同一条
  newsTimer = setInterval(async () => {
    const batch = await fetchNewsBatch();
    if (batch) send(IPC.news, pickFreshNews(batch));
  }, 60 * 60 * 1000);
}

export function registerIpc(win: BrowserWindow): void {
  bindPetWindow(win);

  // 渲染层只在外接框变化时上报，都用 on 不用 handle，避开无谓的 promise
  ipcMain.on(IPC.setHotRegion, (_event, rects: Rect[]) => setHotRegion(rects));
  ipcMain.on(IPC.trayIcon, (_event, dataUrl: string) => ensureTray(dataUrl));

  // 只收路径：文件大小一律由主进程重新 stat，渲染层报的数不能信
  ipcMain.handle(IPC.feed, (_event, paths: string[]) => feedFiles(Array.isArray(paths) ? paths : []));

  // 桌面整理：预览只算不搬；整理/撤销完都刷一份状态（canUndo 变了）
  ipcMain.handle(IPC.previewOrganize, () => previewOrganizeNow());
  ipcMain.handle(IPC.organize, () => organizeNow());
  ipcMain.handle(IPC.undoOrganize, () => undoOrganizeNow());
  // 狗每放下一个图标，主进程按名字重查 index 后写它的坐标（图标跟着狗走）
  ipcMain.on(IPC.settleIcon, (_event, name: string) => {
    if (typeof name === "string" && name) settleIcon(name);
  });

  // 天气：点击狗头时请求
  ipcMain.handle(IPC.weather, () => fetchWeather());

  // 启动每小时新闻推送
  startNewsTimer();
}
