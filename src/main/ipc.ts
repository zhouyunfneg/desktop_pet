import { ipcMain, type BrowserWindow } from "electron";
import {
  IPC,
  type AteEvent,
  type FoldUndoResult,
  type MenuRequest,
  type OrganizeEvent,
  type OrganizeResult,
  type Rect,
  type UndoResult,
  type UiState
} from "../shared/ipc";
import { feedFiles } from "./feed";
import {
  cancelCarrying,
  hasUndo,
  previewFold,
  runColumns,
  runFoldOrganize,
  runOrganize,
  runUndo,
  settleIcon,
  startCarrying,
  undoFoldAll
} from "./organize";
import { holdOverlay } from "./overlay-window";
import { setHotRegion } from "./pet-window";
import { ensureTray } from "./tray";
import { fetchWeather, fetchNewsBatch } from "./info-service";
import { NO_NEWS, pickNews, type NewsReply, type NewsRound } from "../shared/news";

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

/** 设置变了、存档重置了 —— 都推这一份全量状态（狗窗 + 绘制层） */
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

/** 右键「整理桌面」：先把只读算出来的收纳清单交给确认面板，用户点了才会真搬 */
export async function askFoldNow(): Promise<void> {
  const preview = await previewFold();
  if (preview.total === 0) {
    // 没有散文件可收，就只把图标排整齐，不用打扰用户确认
    const res = await columnsNow();
    if (res.moved.length === 0) pushBubble(preview.skipped[0]?.reason ?? "桌面已经很整齐了");
    return;
  }
  send(IPC.foldAsk, preview);
}

/** 气泡：整理这类「不用点」的短反馈，交给渲染层画在狗头上 */
function pushBubble(text: string): void {
  send(IPC.ate, { items: [], note: text });
}

/** 收纳：真的移动文件（只在确认面板上点过「开始」之后才走到这里） */
export async function foldNow(): Promise<OrganizeResult> {
  const res = await runFoldOrganize();
  if (res.moved.length > 0) {
    pushOrganize({ moved: res.moved.length, zones: res.zones, steps: res.steps, phase: "fold" });
  } else {
    pushBubble(res.skipped[0]?.reason ?? "没有需要收纳的文件");
  }
  pushState();
  return res;
}

/** 排整齐：只挪图标坐标 */
export async function columnsNow(): Promise<OrganizeResult> {
  const res = await runColumns();
  if (res.moved.length > 0) {
    pushOrganize({ moved: res.moved.length, zones: res.zones, steps: res.steps, phase: "columns" });
    holdOverlay(8);
  }
  pushState();
  return res;
}

/** 撤销一次收纳：图标回原位 + 文件从分类文件夹搬回桌面 */
export async function undoFoldNow(): Promise<FoldUndoResult> {
  await cancelCarrying();
  const res = await undoFoldAll();
  pushRecall();
  pushState();
  return res;
}

/**
 * 老的区域模式（先画区域再整理）。按需求封存：入口从菜单里收掉了，
 * 代码和存档都留着，想恢复只要把菜单项加回来。
 */
export async function organizeNow(): Promise<OrganizeResult> {
  const res = await runOrganize(false);
  if (res.moved.length > 0) {
    pushOrganize({ moved: res.moved.length, zones: res.zones, steps: res.steps, phase: "zones" });
    holdOverlay(8); // 狗逐个搬运时把目标区域框亮出来
  }
  pushState();
  return res;
}

/** 右键菜单：null 表示收起（渲染层收到就把面板拆掉） */
export function pushMenu(request: MenuRequest | null): void {
  send(IPC.menuShow, request);
}

export async function previewOrganizeNow(): Promise<OrganizeResult> {
  return runOrganize(true);
}

export async function undoOrganizeNow(): Promise<UndoResult> {
  // 嘴里那只先就地放回原位：撤销不依赖渲染层配合，也不能把文件留在隐藏状态
  await cancelCarrying();
  const res = await runUndo();
  // 这批整理作废了，狗要是还在搬剩下的路点必须叫停：
  // 搬运期间命中区被放大到整块画布，让它继续空跑会让桌面点不动
  pushRecall();
  pushState();
  return res;
}

export { hasUndo };

/** 最近一次抓到的当天新闻批次 */
let newsBatch: { at: number; date: string; items: string[] } | null = null;
/** 轮播状态：一天那批里每条只播一次，全播完自动开下一轮 */
let newsRound: NewsRound | null = null;
/** 抓到的留 1 小时：这个源每天只更新一次，反复重抓没意义 */
const NEWS_TTL = 60 * 60 * 1000;
/** 抓失败只压 30 秒：网络抖一下不该让接下来半小时点了都没反应 */
const NEWS_FAIL_TTL = 30 * 1000;

/**
 * 点狗前胸口：挑一条今天还没播过的新闻。
 * 原来是每小时自动推一条（一天里它会自己打断你七八次），现在改成点一下才播。
 */
async function newsNow(): Promise<NewsReply> {
  const now = Date.now();
  const alive = newsBatch && now - newsBatch.at < (newsBatch.items.length > 0 ? NEWS_TTL : NEWS_FAIL_TTL);
  let batch = alive ? newsBatch : null;
  if (!batch) {
    const fresh = await fetchNewsBatch();
    batch = fresh ? { at: now, date: fresh.date, items: fresh.items } : { at: now, date: "", items: [] };
    newsBatch = batch;
  }
  const pick = pickNews(batch.items, batch.date, newsRound);
  if (!pick) return NO_NEWS;
  newsRound = pick.round;
  return { text: pick.text, total: pick.total, left: pick.left, wrapped: pick.wrapped };
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
  ipcMain.handle(IPC.foldPreview, () => previewFold());
  ipcMain.handle(IPC.foldRun, () => foldNow());
  ipcMain.handle(IPC.columnsRun, () => columnsNow());
  ipcMain.handle(IPC.undoOrganize, () => undoOrganizeNow());
  ipcMain.handle(IPC.undoFold, () => undoFoldNow());
  // 狗每放下一个图标，主进程按名字重查 index 后把这个真图标写到落点
  ipcMain.on(IPC.settleIcon, (_event, name: string) => {
    if (typeof name === "string" && name) settleIcon(name);
  });
  // 叼起来：主进程把真图标临时藏起来，只有真藏好了渲染层才画嘴里那个假的
  ipcMain.handle(IPC.grabIcon, async (_event, name: string): Promise<boolean> =>
    typeof name === "string" && name.length > 0 ? startCarrying(name) : false
  );
  // 没叼完就中断（拎起狗、叫回来）：让它显形并回到原处
  ipcMain.on(IPC.carryCancel, () => void cancelCarrying());

  // 天气：点击狗头时请求；新闻：点击狗前胸口时请求（两个都不再自动推）
  ipcMain.handle(IPC.weather, () => fetchWeather());
  ipcMain.handle(IPC.news, () => newsNow());
}
