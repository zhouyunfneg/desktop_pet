import { app, screen } from "electron";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { CATCH_ALL_ID, extOf, type Rect } from "../shared/config";
import { pickDesktopFile } from "../shared/file-attrs";
import {
  COL_H,
  COL_W,
  VIRTUAL_NAMES,
  planColumns,
  type ColumnInput
} from "../shared/fold";
import {
  dipListToPhys,
  IDENTITY_GEOMETRY,
  physListToDip,
  safeGeometry,
  type DisplayGeometry
} from "../shared/coords";
import {
  buildPlan,
  matchUndoTargets,
  type IconInput,
  type IconMove,
  type RealEntry,
  type SkippedFile
} from "../shared/organize";
import type { FoldPreviewResult, IconStep, OrganizeResult, UndoResult } from "../shared/ipc";
import { applyPositions, ensureManualArrange, readIcons } from "./desktop-icons";
import * as fold from "./fold";
import { refreshDesktop, setHidden } from "./file-attrs";
import { carryStore, configStore, organizeStore, type MoveRecord } from "./store";

/** 显示名统一按「去首尾空白 + 小写」回匹，explorer 返回的名字常带空格 */
const lower = (s: string): string => s.trim().toLowerCase();

/**
 * 桌面「挪图标」整理执行层：读桌面图标坐标 → 按分类算目标槽位 → 狗跑到图标处把它的
 * 隐藏属性临时打开（桌面上就只剩这一个不见）、嘴里画个假的代替 → 跑到落点时 settleIcon
 * 取消隐藏并按名字写下落点。
 * 文件本身不动，只改 explorer 里图标的显示位置。
 *
 * 为什么不直接挪真图标跟着狗走：Windows 桌面会把图标吸到 76×101 的网格点上，
 * 真图标只能一蹦一蹦地跟，看着就是「文件在桌面上抽风」。藏起来 + 画假的才连得上。
 *
 * 刷新桌面只用「让 explorer 重读文件所在目录」这一种通知（实测图标数只变化 1 个）。
 * 按 F5 会让整份桌面重画一次（图标数瞬间掉到 0），就是你看到的「屏幕一闪」，
 * 只在重读目录不管用的系统上才退回去用它。
 *
 * 单位约定：explorer 的 ListView 用物理像素，而区域配置、狗窗画布、Electron 的工作区
 * 都是 DIP。这里只在进出 FFI 的那一步换算，本层与渲染层之间一律传 DIP，
 * 否则显示缩放不等于 100% 时落点会整体偏移（图标被写到屏幕外、区域内判定也失效）。
 */

/**
 * 本次整理待落位的目标（DIP，显示名小写 → 目标点）。
 * into 非空 = 这一步不是「挪坐标」而是「把文件真的搬进那个文件夹」，狗跑到落点那一刻才动手。
 */
interface Target {
  x: number;
  y: number;
  /** 目标分类文件夹在桌面上的名字 */
  into?: string;
}
let pendingTargets = new Map<string, Target>();
/** 上一次整理还没返回就再点一次会并发写存档，这里挡一道 */
let organizing = false;
/** 落位队列最后一次动静的时间戳 */
let pendingIdleAt = 0;
/**
 * 落位靠狗逐个跑到位置才写，一批可能持续几十秒，organizing 锁早早就释放了。
 * 所以再用「最后一次动静」判断这批是否还在搬：超过这个时长没落位也没撤销，
 * 就说明动画被拎走/中断了，放行下一次整理，不能让队列把功能永久锁死。
 */
const PENDING_IDLE_MS = 20_000;

function pendingBusy(): boolean {
  if (pendingTargets.size === 0) return false;
  if (Date.now() - pendingIdleAt > PENDING_IDLE_MS) {
    pendingTargets = new Map();
    // 上一批超时作废：嘴里那只必须先放回去，不能让它一直隐藏着
    void cancelCarrying();
    return false;
  }
  return true;
}

/**
 * 主显示器的几何信息（整个应用都以主屏工作区为基准）。
 * Windows 的虚拟屏幕坐标是物理像素，Electron 的 bounds 是 DIP，
 * 主屏两者原点都是 0；副屏按 dipOrigin × scaleFactor 折算。
 */
function geometry(): DisplayGeometry {
  try {
    const d = screen.getPrimaryDisplay();
    const sf = d.scaleFactor;
    return safeGeometry({
      dipX: d.bounds.x,
      dipY: d.bounds.y,
      physX: d.bounds.x * sf,
      physY: d.bounds.y * sf,
      scaleFactor: sf
    });
  } catch (err) {
    console.warn("[organize] 拿不到显示器几何信息，按 100% 缩放处理", err);
    return IDENTITY_GEOMETRY;
  }
}

async function buildResolver(): Promise<(name: string) => RealEntry | undefined> {
  const dir = app.getPath("desktop");
  const map = new Map<string, RealEntry>();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const isDir = e.isDirectory();
      const rec: RealEntry = { realName: e.name, isDir, ext: isDir ? "" : extOf(e.name) };
      map.set(e.name.toLowerCase(), rec);
      const dot = e.name.lastIndexOf(".");
      // 桌面显示名默认隐藏扩展名，再按基名登记一次以便匹配
      if (!isDir && dot > 0) map.set(e.name.slice(0, dot).toLowerCase(), rec);
    }
  } catch (err) {
    console.warn("[organize] 读桌面目录失败", err);
  }
  return (name) => map.get(name.trim().toLowerCase());
}

/** 区域落点目录不该被挪走；“食盆”是老版本可能残留的目录，一并保护 */
function skipNames(): Set<string> {
  const set = new Set<string>();
  for (const z of configStore.get().zones) if (z.dir) set.add(z.dir.toLowerCase());
  set.add("食盆");
  return set;
}

/** 读桌面图标并换算成 DIP；拿不到返回 null */
function readIconDips(g: DisplayGeometry): IconInput[] | null {
  const icons = readIcons();
  if (!icons) return null;
  return physListToDip(
    icons.map((i) => ({ index: i.index, name: i.name, x: i.x, y: i.y })),
    g
  );
}

export function hasUndo(): boolean {
  return organizeStore.get().sessions.length > 0;
}

/**
 * 「衔到即消失」这套要不要开。
 *
 * false（现在）= 最初的体验：狗走到图标上、再走到区域里，落位那一刻图标才出现在新位置，
 * 全程不碰文件属性、嘴里也不画假图标。
 * true = 叼起来那一刻用隐藏属性让图标真的消失，嘴里画一张同分类的假图标跟着走。
 * 两套都留着：改这一个开关就能切，藏 / 现、崩溃找回那些代码原样还在下面。
 */
const CARRY_HIDE_ICON = false;

/** 狗嘴里正叼着的那个图标（真身被临时打了隐藏属性，从桌面上消失了） */
interface Carrying {
  key: string;
  /** 藏起来之前的物理坐标：中途被打断就放回这里 */
  homeX: number;
  homeY: number;
  /** 磁盘上的真实路径；null = 对不上文件，藏不了 */
  path: string | null;
  /** 是不是真的靠隐藏属性藏住了（false = 退回「到落点才挪」） */
  hidden: boolean;
  /** 动手之前它本来就是隐藏的 → 归还时不能替它显形 */
  wasHidden: boolean;
}
let carrying: Carrying | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 用户桌面 + 公共桌面：快捷方式常常只放在公共那一份里 */
function desktopDirs(): string[] {
  const out: string[] = [];
  try {
    out.push(app.getPath("desktop"));
  } catch {
    /* 拿不到桌面目录就直接走公共那份 */
  }
  const pub = process.env.PUBLIC ? join(process.env.PUBLIC, "Desktop") : "";
  if (pub && !out.includes(pub)) out.push(pub);
  return out;
}

/** 桌面显示名 → 磁盘上的真实路径；对不上或有同名嫌疑返回 null（宁可不藏） */
async function findItemPath(displayName: string): Promise<string | null> {
  for (const dir of desktopDirs()) {
    try {
      const files = await fs.readdir(dir);
      const hit = pickDesktopFile(displayName, files);
      if (hit) return join(dir, hit);
    } catch (err) {
      console.warn(`[organize] 读 ${dir} 失败`, err);
    }
  }
  return null;
}

/** 记到 carry.json 并立刻落盘：这是「崩溃后文件还隐藏着」唯一的线索 */
function rememberHidden(c: Carrying): void {
  if (!c.path) return;
  carryStore.replace({
    version: 1,
    hidden: [
      { path: c.path, name: c.key, wasHidden: c.wasHidden, homeX: c.homeX, homeY: c.homeY, at: Date.now() }
    ]
  });
  carryStore.flush();
}

function forgetHidden(): void {
  if (carryStore.get().hidden.length === 0) return;
  carryStore.replace({ version: 1, hidden: [] });
  carryStore.flush();
}

/**
 * 立刻按名字写坐标。
 * 一律现查 index、不用缓存的：桌面一刷新（藏 / 现的时候必然刷新一次）item 顺序就会重排，
 * 拿旧 index 写会把别人的图标挪走 —— 实测踩过。
 */
function putNow(name: string, want: { x: number; y: number }): boolean {
  const key = name.trim().toLowerCase();
  if (!Number.isFinite(want.x) || !Number.isFinite(want.y)) return false;
  const it = readIcons()?.find((i) => i.name.trim().toLowerCase() === key);
  if (!it) return false;
  return applyPositions([{ index: it.index, x: want.x, y: want.y }]);
}

/** 等某个图标回到桌面列表里，再把坐标写成 want（物理像素） */
async function putBack(name: string, want: { x: number; y: number }, tries = 12): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    await sleep(120);
    const key = name.trim().toLowerCase();
    const it = readIcons()?.find((x) => x.name.trim().toLowerCase() === key);
    if (!it) continue;
    if (Math.abs(it.x - want.x) <= 4 && Math.abs(it.y - want.y) <= 4) return true;
    return putNow(name, want);
  }
  return false;
}

/** 图标还在不在桌面列表里；读不到列表返回 null，让调用方自己决定信不信 */
function onDesktop(key: string): boolean | null {
  const list = readIcons();
  if (!list) return null;
  return list.some((i) => i.name.trim().toLowerCase() === key);
}

/**
 * 这台机器上「只重读所在目录」管不管用。null = 还没试过。
 * 管用（本机实测）：桌面图标总数只变化 1 个，不闪屏。
 * 不管用时才退回按一次 F5 —— 那会把整份桌面重画（总数瞬间掉到 0），就是「屏幕一闪」。
 * 记住结果，别让每个图标都白等一轮。
 */
let folderRefreshOk: boolean | null = null;

/** 等图标从桌面列表里消失 / 回来；等不到就用整屏刷新兜一次底 */
async function waitVisible(key: string, want: boolean): Promise<boolean> {
  const poll = async (ms: number): Promise<boolean> => {
    for (let i = 0; i < ms / 60; i++) {
      await sleep(60);
      if (onDesktop(key) === want) return true;
    }
    return false;
  };
  if (folderRefreshOk === false) {
    refreshDesktop();
    return poll(900);
  }
  if (await poll(420)) {
    folderRefreshOk = true;
    return true;
  }
  folderRefreshOk = false;
  refreshDesktop();
  return poll(900);
}

/**
 * 狗扒拉到图标了：把它的隐藏属性打开，桌面上这一个就真的消失，
 * 接下来由狗嘴上的假图标代替它出现。
 * 返回 true 之前一定核对过它真的从列表里没了 —— 只要还看得见，就绝不画假的。
 */
export async function startCarrying(name: string): Promise<boolean> {
  // 关着的时候什么都不做：狗只是空跑一趟，图标在落位那一刻才挪过去（最初的体验）
  if (!CARRY_HIDE_ICON) return false;
  const key = name.trim().toLowerCase();
  const hit = readIcons()?.find((i) => i.name.trim().toLowerCase() === key);
  if (!hit) return false;
  const path = await findItemPath(hit.name);
  if (!path) {
    console.warn(`[organize] ${name} 对不到桌面上的文件，这一趟改为到落点再挪`);
    return false;
  }
  const target = pendingTargets.get(key);
  // 收纳那一步不预写落点：文件马上就要被搬进文件夹，先把图标拖到文件夹上没意义
  const dropPhys =
    target && !target.into && Number.isFinite(target.x) && Number.isFinite(target.y)
      ? dipListToPhys([{ x: target.x, y: target.y }], geometry())[0]
      : null;
  // 先把落点写好再藏：只重读所在目录时，图标显形会留在藏之前那个位置（实测），
  // 这样放下那一下就直接出现在区域里，不会「先在别处冒头再跳过来」
  if (dropPhys) putNow(hit.name, dropPhys);
  const r = setHidden(path, true);
  if (!r.ok) {
    if (dropPhys) putNow(hit.name, { x: hit.x, y: hit.y });
    console.warn(`[organize] ${name} 改隐藏属性失败（可能没权限），这一趟改为到落点再挪`);
    return false;
  }
  carrying = { key, homeX: hit.x, homeY: hit.y, path, hidden: true, wasHidden: r.wasHidden };
  // 先记账再验收：后面任何一步失手，下次启动都能照着这条记录把属性改回来
  rememberHidden(carrying);
  if (await waitVisible(key, false)) return true;
  // 藏不住（开了「显示隐藏的项目」，或压根读不到桌面）→ 原样退回，交给落点再挪
  carrying = null;
  const gaveUp = r.wasHidden || setHidden(path, false).ok;
  if (gaveUp) forgetHidden();
  else console.error(`[organize] ${name} 藏不住且取消隐藏失败，已记在 carry.json，下次启动会自动恢复`);
  void putBack(key, { x: hit.x, y: hit.y });
  console.warn(`[organize] ${name} 藏不住（可能开了「显示隐藏的项目」），这一趟改为到落点再挪`);
  return false;
}

/**
 * 没叼完就中断（拎起狗、撤销、渲染层挂了）：让它显形并放回原来的位置。
 * 落位成功走的是 settleIcon，不会到这里。
 * 返回的 promise 在「图标重新回到桌面列表」后结束；不关心落点的调用方可以直接 fire-and-forget
 * （取消隐藏这一步是同步的，属性一定改回来了）。
 */
export async function cancelCarrying(): Promise<void> {
  const c = carrying;
  if (!c) return;
  carrying = null;
  forgetHidden();
  if (!c.hidden || !c.path) {
    void putNow(c.key, { x: c.homeX, y: c.homeY });
    return;
  }
  setHidden(c.path, false);
  await waitVisible(c.key, true);
  await putBack(c.key, { x: c.homeX, y: c.homeY });
}

/**
 * 放下：让它显形。
 * 只重读所在目录时，显形后图标会留在藏之前那个位置（实测），而起叼那一步已经把落点写好了，
 * 所以它冒出来的那一格就是区域里的目标格；这里再按名字核对一次落点，防止系统把位置吸回空位。
 */
async function reveal(c: Carrying, target: { x: number; y: number } | undefined): Promise<void> {
  forgetHidden();
  if (!c.path) return;
  const r = setHidden(c.path, false);
  if (!r.ok) {
    console.warn(`[organize] ${c.key} 取消隐藏失败，去资源管理器里把「隐藏」勾掉就能恢复`);
    return;
  }
  const want = target ? dipListToPhys([target], geometry())[0] : { x: c.homeX, y: c.homeY };
  await waitVisible(c.key, true);
  await putBack(c.key, want);
}

/**
 * 启动时收拾上一次崩溃留下的烂摊子：
 * 文件被藏了一半程序就没了，用户看到的就是「桌面少了个文件」。
 * carry.json 里记着路径、原属性和原坐标，按它改回来；
 * 顺带清一遍坐标跑到屏幕外的图标（这台机器上 explorer 会把它夹回来，别的系统未必）。
 */
export async function recoverCarry(): Promise<number> {
  if (carrying) {
    await cancelCarrying();
    return 1;
  }
  const stuck = carryStore.get().hidden;
  let n = 0;
  if (stuck.length > 0) {
    for (const rec of stuck) {
      if (!rec.wasHidden) {
        const r = setHidden(rec.path, false);
        if (!r.ok) {
          console.warn(`[organize] 上次叼着的 ${rec.path} 取消隐藏失败，需要手动恢复`);
          continue;
        }
      }
      n += 1;
      // 刚取消隐藏时 explorer 可能还没把它放回列表，直接写坐标会找不到 item
      await waitVisible(rec.name.trim().toLowerCase(), true);
      await putBack(rec.name, { x: rec.homeX, y: rec.homeY });
    }
    carryStore.replace({ version: 1, hidden: [] });
    carryStore.flush();
    console.log(`[organize] 启动找回上次没放好的图标 ${n} 个`);
  }
  // 兜底：按撤销记录把屏幕外的图标捞回来。一个一个写、每次现查 index ——
  // 批量写中途只要桌面重排一次，后面的旧 index 就会挪到别的图标上（实测踩过）
  const strays = (readIcons() ?? []).filter((i) => i.x < 0 || i.y < 0);
  if (strays.length === 0) return n;
  const g = geometry();
  const log = organizeStore.get();
  for (const stray of strays) {
    const key = stray.name.trim().toLowerCase();
    for (let i = log.sessions.length - 1; i >= 0; i--) {
      const s = log.sessions[i];
      const rec = s.moves.find((m) => m.name.trim().toLowerCase() === key);
      if (!rec) continue;
      const [home] = dipListToPhys([{ x: rec.x, y: rec.y }], { ...g, scaleFactor: s.scale });
      if (putNow(stray.name, home)) n += 1;
      break;
    }
  }
  console.log(`[organize] 发现 ${strays.length} 个图标在屏幕外，按撤销记录放回 ${n} 个`);
  return n;
}

export function planToSteps(moves: IconMove[]): IconStep[] {
  return moves.map((m) => ({
    index: m.index,
    name: m.name,
    category: m.category,
    grabX: m.fromX,
    grabY: m.fromY,
    dropX: m.toX,
    dropY: m.toY,
    color: m.color
  }));
}

/**
 * 整理桌面。dryRun=true 只算计划不写坐标。
 * 真跑：关自动排列 + 记 undo 原始坐标 + 缓存目标；实际写坐标由 settleIcon 逐步完成。
 */
export async function runOrganize(dryRun: boolean): Promise<OrganizeResult & { steps: IconStep[] }> {
  const noop: OrganizeResult & { steps: IconStep[] } = {
    moved: [],
    skipped: [],
    zones: [],
    canUndo: hasUndo(),
    steps: []
  };

  if (organizing) {
    return { ...noop, skipped: [{ name: "整理", reason: "上一批还在算，稍等一下" }] };
  }
  if (pendingBusy()) {
    return { ...noop, skipped: [{ name: "整理", reason: "狗还在搬上一批，等它跑完再整理" }] };
  }
  organizing = true;
  try {
    const g = geometry();
    const icons = readIconDips(g);
    if (!icons) {
      return { ...noop, skipped: [{ name: "桌面", reason: "无法读取桌面图标（系统结构不支持）" }] };
    }

    const config = configStore.get();
    const resolve = await buildResolver();
    // 以现有图标的最左/最上作为桌面网格原点（开了网格对齐时它们就在格点上），让落点与网格严丝合缝
    const grid = icons.length
      ? { ox: Math.min(...icons.map((i) => i.x)), oy: Math.min(...icons.map((i) => i.y)) }
      : undefined;
    const plan = buildPlan(icons, resolve, config, skipNames(), grid);

    if (dryRun || plan.moves.length === 0) {
      return {
        moved: plan.moves,
        skipped: plan.skipped,
        zones: plan.zones,
        canUndo: hasUndo(),
        steps: []
      };
    }

    ensureManualArrange();

    // 上一批万一还有没放回来的，先归位再开新一批
    await cancelCarrying();
    pendingTargets = new Map(plan.moves.map((m) => [m.name.trim().toLowerCase(), { x: m.toX, y: m.toY }]));
    pendingIdleAt = Date.now();
    const originals: MoveRecord[] = plan.moves.map((m) => ({ name: m.name, x: m.fromX, y: m.fromY }));
    const next = [
      ...organizeStore.get().sessions,
      // 记下这批坐标当时的缩放倍数：撤销要按记录时的倍数换算回去，而不是按现在的
      { id: `o-${Date.now().toString(36)}`, at: Date.now(), scale: g.scaleFactor, moves: originals }
    ];
    organizeStore.replace({ version: 1, sessions: next.slice(-20) });

    return {
      moved: plan.moves,
      skipped: plan.skipped,
      zones: plan.zones,
      canUndo: true,
      steps: planToSteps(plan.moves)
    };
  } finally {
    organizing = false;
  }
}

/**
 * 狗放下某个图标。
 * 藏成功的那条路：坐标在叼起来时就写到落点了，这里只要让它显形；
 * 其余（藏不住、或不是狗叼的）按显示名重查当前 index 写坐标 ——
 * 每挪一个图标后桌面可能重排 item 顺序，计划时缓存的 index 会失效，
 * 名字比较忽略大小写与首尾空白，否则会静默匹配不上、图标永远不落位。
 */
export function settleIcon(name: string): void {
  const key = name.trim().toLowerCase();
  const t = pendingTargets.get(key);
  const c = carrying && carrying.key === key ? carrying : null;
  // 收纳那一步：狗跑到分类文件夹上，这一刻才真的把文件搬进去
  if (t?.into && c?.path) {
    pendingTargets.delete(key);
    pendingIdleAt = Date.now();
    carrying = null;
    void foldInto(c, t.into);
    return;
  }
  if (c?.hidden) {
    pendingTargets.delete(key);
    pendingIdleAt = Date.now();
    carrying = null;
    void reveal(c, t);
    return;
  }
  if (!t) return;
  const g = geometry();
  const icons = readIcons();
  const idx = icons?.find((i) => i.name.trim().toLowerCase() === key)?.index;
  if (idx === undefined) return;
  // 目标点是 DIP，写进 FFI 前换算回物理像素
  const [phys] = dipListToPhys([t], g);
  // 换算结果必须是有限整数：writeInt32LE 拿到 NaN 会抛，图标静默不落位最难查
  if (!Number.isFinite(phys.x) || !Number.isFinite(phys.y)) {
    console.warn(`[organize] ${name} 的目标坐标无效：${phys.x},${phys.y}`);
    return;
  }
  if (!applyPositions([{ index: idx, x: phys.x, y: phys.y }])) return;
  pendingTargets.delete(key);
  pendingIdleAt = Date.now();
  carrying = null;
}

/**
 * 狗跑到分类文件夹上：这一刻才真的把文件搬进文件夹。
 * 搬成了就不用管它的图标（文件离开桌面目录，图标自然消失）；
 * 搬不成就必须让它显形回到原处 —— 宁可整理失败，也不能让文件看着消失。
 */
async function foldInto(c: Carrying, folderName: string): Promise<void> {
  const { user } = fold.desktopDirs();
  const fileName = basename(c.path ?? "");
  forgetHidden();
  if (!user || !fileName) {
    console.warn(`[organize] ${c.key} 找不到桌面目录或文件名，没搬`);
    if (c.path) setHidden(c.path, false);
    await waitVisible(c.key, true);
    void putBack(c.key, { x: c.homeX, y: c.homeY });
    return;
  }
  const r = await fold.moveInto(user, folderName, fileName);
  if (r.ok) {
    if (r.leftover) console.warn(`[organize] ${fileName} 已复制进「${folderName}」，但桌面上那份没删掉`);
    return;
  }
  console.warn(`[organize] ${fileName} 没搬进「${folderName}」：${r.reason}`);
  setHidden(c.path ?? "", false);
  await waitVisible(c.key, true);
  await putBack(c.key, { x: c.homeX, y: c.homeY });
}

/** 确认面板上的一组 */
export type { FoldGroupView, FoldPreviewResult } from "../shared/ipc";

/** 只读预览：给确认面板列「哪个文件进哪个文件夹、哪些不动」。绝不写盘 */
export async function previewFold(): Promise<FoldPreviewResult> {
  const { plan } = await fold.preview(configStore.get(), skipNames());
  return {
    groups: plan.groups.map((g) => ({
      label: g.label,
      folder: g.folder,
      color: g.color,
      files: g.files.map((f) => f.name),
      willCreate: !g.folderExists
    })),
    skipped: plan.skipped,
    total: plan.total,
    canUndo: fold.hasFoldUndo() || hasUndo()
  };
}

/** 主屏工作区（DIP）：算竖栏能排几行几列用 */
function workRect(): Rect {
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x, y: wa.y, w: wa.width, h: wa.height };
  } catch (err) {
    console.warn("[organize] 拿不到工作区，按 1920×1040 处理", err);
    return { x: 0, y: 0, w: 1920, h: 1040 };
  }
}

/** 收纳用的空结果 */
function foldNoop(reason: string): OrganizeResult & { steps: IconStep[] } {
  return {
    moved: [],
    skipped: [{ name: "收纳", reason }],
    zones: [],
    canUndo: fold.hasFoldUndo() || hasUndo(),
    steps: []
  };
}

/**
 * 第一步：把散文件衔进分类文件夹。
 * 先把要用到的文件夹建出来（狗得有真实图标可放），再按当前桌面图标算每一步从哪衔到哪。
 * 这一步不写 organize.json：文件真搬走了，坐标记录没有意义，账在 fold.json 里。
 */
export async function runFoldOrganize(): Promise<OrganizeResult & { steps: IconStep[] }> {
  if (organizing) return foldNoop("上一批还在算，稍等一下");
  if (pendingBusy()) return foldNoop("狗还在搬上一批，等它跑完再整理");
  organizing = true;
  try {
    const config = configStore.get();
    const { plan, scan: s } = await fold.preview(config, skipNames());
    if (plan.groups.length === 0) {
      return { ...foldNoop("没有需要收纳的散文件"), canUndo: fold.hasFoldUndo() || hasUndo() };
    }
    if (!s.userDir) return foldNoop("拿不到桌面目录");

    const made = await fold.makeFolders(
      s.userDir,
      plan.groups.map((g) => g.folder)
    );
    if (made.failed.length > 0) {
      return { ...foldNoop(`建不了分类文件夹：${made.failed[0].reason}`), skipped: made.failed };
    }

    ensureManualArrange();
    await cancelCarrying();

    const g = geometry();
    const dips = readIconDips(g);
    if (!dips) return foldNoop("无法读取桌面图标（系统结构不支持）");
    // 新建的文件夹要等 explorer 把图标放出来才知道位置，最多等 2 秒
    for (let i = 0; i < 20 && plan.groups.some((gr) => !dips.some((d) => d.name.trim().toLowerCase() === lower(gr.folder))); i++) {
      await sleep(100);
      const again = readIconDips(g);
      if (again) dips.splice(0, dips.length, ...again);
    }

    const moves: IconMove[] = [];
    const skipped: SkippedFile[] = [...plan.skipped];
    const targets = new Map<string, Target>();
    for (const grp of plan.groups) {
      const folderIcon = dips.find((d) => d.name.trim().toLowerCase() === lower(grp.folder));
      if (!folderIcon) {
        skipped.push(...grp.files.map((f) => ({ name: f.name, reason: `桌面上还没有「${grp.folder}」图标` })));
        continue;
      }
      for (const f of grp.files) {
        const disp = f.name.replace(/\.[^.]+$/, "");
        const icon = dips.find((d) => d.name.trim().toLowerCase() === lower(disp) || d.name.trim().toLowerCase() === lower(f.name));
        if (!icon) {
          skipped.push({ name: f.name, reason: "桌面上找不到它的图标" });
          continue;
        }
        moves.push({
          index: icon.index,
          name: icon.name,
          category: grp.label,
          zoneId: grp.ruleId,
          zoneName: grp.folder,
          color: grp.color,
          fromX: icon.x,
          fromY: icon.y,
          toX: folderIcon.x,
          toY: folderIcon.y
        });
        targets.set(lower(icon.name), { x: folderIcon.x, y: folderIcon.y, into: grp.folder });
      }
    }
    if (moves.length === 0) {
      return { moved: [], skipped, zones: [], canUndo: fold.hasFoldUndo() || hasUndo(), steps: [] };
    }
    pendingTargets = targets;
    pendingIdleAt = Date.now();
    return {
      moved: moves,
      skipped,
      zones: plan.groups.map((gr) => ({
        zoneId: gr.ruleId,
        name: gr.folder,
        color: gr.color,
        rect: { x: 0, y: 0, w: 0, h: 0 },
        count: gr.files.length
      })),
      canUndo: fold.hasFoldUndo() || hasUndo(),
      steps: planToSteps(moves)
    };
  } finally {
    organizing = false;
  }
}

/**
 * 第二步：把桌面上剩下的图标按类型排成竖栏（只挪坐标，不动文件）。
 * 这一步的坐标写进 organize.json，撤销时能一格一格放回去。
 */
export async function runColumns(): Promise<OrganizeResult & { steps: IconStep[] }> {
  if (organizing) return foldNoop("上一批还在算，稍等一下");
  if (pendingBusy()) return foldNoop("狗还在搬上一批，等它跑完再整理");
  organizing = true;
  try {
    const config = configStore.get();
    const g = geometry();
    const dips = readIconDips(g);
    if (!dips) return foldNoop("无法读取桌面图标（系统结构不支持）");
    const resolve = await buildResolver();
    const protect = skipNames();
    const bandOrder = ["lnk", "dir", ...config.rules.filter((r) => r.id !== "lnk").map((r) => r.id)];
    const inputs: (ColumnInput & { x: number; y: number })[] = [];
    const skipped: SkippedFile[] = [];
    for (const ic of dips) {
      const disp = ic.name.trim();
      if (!disp) continue;
      if (VIRTUAL_NAMES.has(lower(disp))) {
        inputs.push({ name: disp, ruleId: "sys", label: "系统", color: "#6B7B8C", x: ic.x, y: ic.y });
        continue;
      }
      const entry = resolve(disp);
      if (!entry) {
        skipped.push({ name: disp, reason: "非磁盘文件（虚拟项或已消失）" });
        continue;
      }
      if (protect.has(entry.realName.toLowerCase())) {
        skipped.push({ name: disp, reason: "食盆 / 落点目录本身" });
        continue;
      }
      if (entry.isDir) {
        inputs.push({ name: disp, ruleId: "dir", label: "文件夹", color: "#E0A23B", x: ic.x, y: ic.y });
        continue;
      }
      const rule = config.rules.find((r) => r.exts.includes(entry.ext)) ?? config.rules.find((r) => r.id === CATCH_ALL_ID);
      inputs.push({
        name: disp,
        ruleId: rule?.id ?? CATCH_ALL_ID,
        label: rule?.label ?? "其他",
        color: rule?.color ?? "#9AA0A6",
        x: ic.x,
        y: ic.y
      });
    }
    inputs.sort((a, b) => {
      const ai = a.ruleId === "sys" ? -1 : bandOrder.indexOf(a.ruleId);
      const bi = b.ruleId === "sys" ? -1 : bandOrder.indexOf(b.ruleId);
      return ai - bi;
    });
    const wr = workRect();
    const grid = { ox: Math.min(...dips.map((i) => i.x)), oy: Math.min(...dips.map((i) => i.y)) };
    const plan = planColumns(
      inputs.filter((i) => i.ruleId !== "sys"),
      grid,
      Math.max(1, Math.floor((wr.h - grid.oy) / COL_H)),
      Math.max(1, Math.floor((wr.x + wr.w - grid.ox) / COL_W))
    );
    for (const name of plan.overflow) skipped.push({ name, reason: "桌面宽度放不下，这次没排" });

    const moves: IconMove[] = [];
    const targets = new Map<string, Target>();
    for (const slot of plan.slots) {
      const icon = dips.find((d) => d.name.trim().toLowerCase() === lower(slot.name));
      if (!icon) continue;
      if (Math.abs(icon.x - slot.x) <= 4 && Math.abs(icon.y - slot.y) <= 4) continue;
      moves.push({
        index: icon.index,
        name: icon.name,
        category: slot.label,
        zoneId: slot.ruleId,
        zoneName: slot.label,
        color: slot.color,
        fromX: icon.x,
        fromY: icon.y,
        toX: slot.x,
        toY: slot.y
      });
      targets.set(lower(icon.name), { x: slot.x, y: slot.y });
    }
    if (moves.length === 0) {
      return { moved: [], skipped, zones: [], canUndo: fold.hasFoldUndo() || hasUndo(), steps: [] };
    }
    ensureManualArrange();
    await cancelCarrying();
    const originals: MoveRecord[] = moves.map((m) => ({ name: m.name, x: m.fromX, y: m.fromY }));
    organizeStore.replace({
      version: 1,
      sessions: [
        ...organizeStore.get().sessions,
        { id: `o-${Date.now().toString(36)}`, at: Date.now(), scale: g.scaleFactor, moves: originals }
      ].slice(-20)
    });
    pendingTargets = targets;
    pendingIdleAt = Date.now();
    return {
      moved: moves,
      skipped,
      zones: plan.bands.map((b) => ({ zoneId: b.ruleId, name: b.label, color: b.color, rect: b.rect, count: b.count })),
      canUndo: true,
      steps: planToSteps(moves)
    };
  } finally {
    organizing = false;
  }
}

/** 撤销：先把图标放回原位，再把文件从分类文件夹搬回桌面 */
export async function undoFoldAll(): Promise<{ icons: number; files: number; failed: SkippedFile[] }> {
  const icons = await runUndo();
  const f = await fold.undoLast();
  return {
    icons: icons.restored,
    files: f.restored,
    failed: [
      ...icons.failed,
      ...f.failed.map((r) => ({ name: basename(r.to), reason: "搬回桌面失败（同名或没权限）" }))
    ]
  };
}

/** 撤销最近一次整理：按显示名重新定位当前 index，把坐标写回去 */
export async function runUndo(): Promise<UndoResult> {
  // 先让嘴里那只显形并回到原处：它还藏在隐藏属性里的时候，
  // 下面的按名字回匹根本看不到它，撤销记录又会被弹出，就再也没机会找回坐标了
  await cancelCarrying();
  const log = organizeStore.get();
  if (log.sessions.length === 0) return { restored: 0, failed: [], remaining: 0 };
  const last = log.sessions[log.sessions.length - 1];

  const icons = readIcons();
  if (!icons) {
    return {
      restored: 0,
      failed: [{ name: "桌面", reason: "无法读取桌面图标" }],
      remaining: log.sessions.length
    };
  }

  // 记录里的坐标是当时的 DIP，按记录时存的缩放倍数换算回物理像素再写
  const undoGeom: DisplayGeometry = { dipX: 0, dipY: 0, physX: 0, physY: 0, scaleFactor: last.scale };
  const matched = matchUndoTargets(
    last.moves,
    icons.map((i) => ({ index: i.index, name: i.name }))
  );
  const failed: SkippedFile[] = matched.failed;
  const updates = dipListToPhys(matched.updates, undoGeom).filter(
    (u) => Number.isFinite(u.x) && Number.isFinite(u.y)
  );

  if (updates.length > 0) {
    ensureManualArrange();
    if (!applyPositions(updates)) {
      // 写坐标失败时不能把撤销记录弹掉：否则这批图标的原始坐标永久丢失，再也无法重试
      return {
        restored: 0,
        failed: [{ name: "桌面", reason: "写回图标坐标失败" }],
        remaining: log.sessions.length
      };
    }
  }
  pendingTargets = new Map();
  // updates 为空（这批图标已不在桌面上）也要弹出记录：留着它每次撤销都空转，
  // 而用户看到的失败清单已经说明这些图标不存在了
  organizeStore.replace({ version: 1, sessions: log.sessions.slice(0, -1) });
  return { restored: updates.length, failed, remaining: organizeStore.get().sessions.length };
}
