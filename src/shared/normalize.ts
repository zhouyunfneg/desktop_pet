/**
 * 存档清洗（纯函数，从 main/store.ts 挪过来以便单测）。
 * 这里的目标只有一个：任何来源的存档——老版本、用户用记事本手改、写了一半——
 * 都只能得到合法值，不能有能力把应用带进沟里。
 */
import { type RoamMode, type Settings } from "./ipc";

/** 一次整理会话里一个图标的原始坐标 */
export interface MoveRecord {
  /** 图标显示名（index 会变，按名字回匹更稳） */
  name: string;
  x: number;
  y: number;
}

export interface MoveSession {
  id: string;
  at: number;
  moves: MoveRecord[];
  /**
   * 记录这批坐标时的显示缩放倍数。
   * 坐标存的是 DIP，撤销要按「记录时」的倍数换算回物理像素；
   * 老版本存档没写这个字段，当时存的是物理像素，只能按 1 处理（等价于旧行为）。
   */
  scale: number;
}

export interface UndoLog {
  version: 1;
  sessions: MoveSession[];
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** 保持距离的合法区间与当前默认值 */
const KEEP_MIN = 150;
const KEEP_MAX = 900;
const KEEP_DEFAULT = 380;
/** 上一版（v0 存档）的默认值，当时没人会手动调它 */
const LEGACY_KEEP = 220;

/** 没起名字时菜单头部显示什么 */
export const DEFAULT_PET_NAME = "小柴";
/** 狗名最长几个字（按码点算，一个 emoji 算一个字）：菜单头部一行放不下更多 */
const NAME_MAX = 12;

/**
 * 狗名清洗：剔掉换行与控制字符、压掉连续空白、去首尾空格，再按码点截到 12 个。
 * 空的或压根不是字符串一律回默认名 —— 菜单头部不能是空白，也不能把面板撑破。
 * 截断用 Array.from 而不是 slice：后者会把 emoji 的代理对劈成半个乱码字符。
 */
function nameOf(v: unknown): string {
  if (typeof v !== "string") return DEFAULT_PET_NAME;
  const clean = v
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  const cut = (chars.length > NAME_MAX ? chars.slice(0, NAME_MAX).join("") : clean).trim();
  return cut || DEFAULT_PET_NAME;
}

/** 漫游模式之外的任何值都退回默认的追鼠标 */
function roamModeOf(v: unknown): RoamMode {
  return v === "flee" || v === "wander" || v === "stay" ? v : "chase";
}

function boolOf(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * 老版本/手改坏的字段一律回落到默认值。
 *
 * 注意 keepDistance 的历史迁移：只有 v0 存档（不带 version 字段）里的 220 才是
 * 「上一版的默认值」，需要抬到 380；当前版本的设置窗允许用户合法地把它调成 220，
 * 不能每次读档都当成遗留值偷偷改掉。
 */
export function normalizeSettings(raw: unknown): Settings {
  const o = (raw ?? {}) as Partial<Settings> & { origin?: unknown };
  // 存档可能整个是个标量（记事本里手滑），`in` 运算符对非对象会抛异常，先挡掉
  const isLegacy = typeof o !== "object" || o === null || !("version" in o);
  const keep = Math.min(Math.max(Math.round(num(o.keepDistance, KEEP_DEFAULT)), KEEP_MIN), KEEP_MAX);
  return {
    version: 1,
    topmost: boolOf(o.topmost, true),
    roamMode: roamModeOf(o.roamMode),
    showZones: boolOf(o.showZones, false),
    petName: nameOf(o.petName),
    // 旧存档里的 origin 字段直接丢弃：狗窗现在铺满工作区，窗口位置没意义了
    keepDistance: isLegacy && keep === LEGACY_KEEP ? KEEP_DEFAULT : keep
  };
}

/** 撤销栈：每个会话记下这批图标的原始坐标，撤销就是把它们写回去 */
export function normalizeUndo(raw: unknown): UndoLog {
  const o = (raw ?? {}) as Partial<UndoLog>;
  const sessions = Array.isArray(o.sessions) ? o.sessions : [];
  return {
    version: 1,
    sessions: sessions
      .map((s) => ({
        id: typeof s?.id === "string" && s.id.trim() ? s.id : `s-${num(s?.at, 0)}`,
        at: num(s?.at, 0),
        // 老存档没写 scale：它存的是物理像素，按 1 处理正好等于「原样写回」
        scale: typeof s?.scale === "number" && Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1,
        moves: (Array.isArray(s?.moves) ? s.moves : [])
          .filter(
            (m) =>
              typeof m?.name === "string" &&
              m.name.length > 0 &&
              Number.isFinite(m?.x) &&
              Number.isFinite(m?.y)
          )
          .map((m) => ({ name: m.name, x: Math.round(m.x), y: Math.round(m.y) }))
      }))
      // 空会话不占位，免得撤销点了没反应
      .filter((s) => s.moves.length > 0)
  };
}

/** 一只被狗「叼走」的图标：桌面显示名对应的真实文件被临时打上了隐藏属性 */
export interface HiddenRecord {
  /** 磁盘上的真实路径，归还时要改的就是它的属性 */
  path: string;
  /** 桌面显示名（隐藏扩展名的那一份），放回坐标时按它回匹 */
  name: string;
  /** 动手之前它是不是本来就隐藏的：是的话归还时不能替它显形 */
  wasHidden: boolean;
  /** 藏起来之前的坐标（DIP），被打断或崩溃时按它放回原位 */
  homeX: number;
  homeY: number;
  at: number;
}

export interface CarryLog {
  version: 1;
  hidden: HiddenRecord[];
}

/**
 * 这份存档是「崩溃时桌面上少了个文件」的唯一线索，所以宁可少记也不能记错：
 * 路径为空、坐标不是数字的记录一律丢掉，免得启动时照着脏数据去改不相干的文件属性。
 */
export function normalizeCarry(raw: unknown): CarryLog {
  const o = (raw ?? {}) as Partial<CarryLog>;
  const list = Array.isArray(o.hidden) ? o.hidden : [];
  return {
    version: 1,
    hidden: list
      .filter(
        (h) =>
          typeof h?.path === "string" &&
          h.path.trim().length > 0 &&
          Number.isFinite(h?.homeX) &&
          Number.isFinite(h?.homeY)
      )
      .map((h) => ({
        path: h.path.trim(),
        name: typeof h.name === "string" ? h.name : "",
        wasHidden: h.wasHidden === true,
        homeX: Math.round(h.homeX),
        homeY: Math.round(h.homeY),
        at: num(h.at, 0)
      }))
  };
}

/**
 * 一次「收进文件夹」里对单个文件动的手。
 * 这是真搬文件，所以撤销和崩溃找回全靠这条记录，写错比不写更糟：
 * 路径必须是带盘符的绝对路径、不能含 ".."，否则整条丢掉（执行层还会再验一遍是不是在桌面里）。
 */
export interface FoldRecord {
  /** 桌面上原来的完整路径 */
  from: string;
  /** 分类文件夹里的新完整路径 */
  to: string;
  /** 目标分类文件夹的完整路径，撤销时它空了就删掉 */
  folder: string;
  /** 这个文件夹是这次整理新建的（本来就有的一律不删） */
  madeFolder: boolean;
  /** rename 已经成功。false = 记了意图但还没真搬，撤销时无事可做 */
  done: boolean;
  at: number;
}

export interface FoldSession {
  id: string;
  at: number;
  records: FoldRecord[];
}

export interface FoldLog {
  version: 1;
  sessions: FoldSession[];
}

/** 只认 "D:\..." / "D:/..." 这种带盘符的绝对路径，且路径里不许有 ".." */
function safePath(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const p = v.trim().replace(/[\\/]+$/, "");
  if (!/^[a-zA-Z]:[\\/]/.test(p)) return null;
  if (p.split(/[\\/]/).some((seg) => seg === "..")) return null;
  return p;
}

export function normalizeFold(raw: unknown): FoldLog {
  const o = (raw ?? {}) as Partial<FoldLog>;
  const sessions = Array.isArray(o.sessions) ? o.sessions : [];
  return {
    version: 1,
    sessions: sessions
      .map((s) => ({
        id: typeof s?.id === "string" && s.id.trim() ? s.id.trim() : `f-${num(s?.at, 0)}`,
        at: num(s?.at, 0),
        records: (Array.isArray(s?.records) ? s.records : [])
          .map((r) => {
            const from = safePath(r?.from);
            const to = safePath(r?.to);
            const folder = safePath(r?.folder);
            if (!from || !to || !folder) return null;
            // 搬进自己 = 空转
            if (to.toLowerCase() === from.toLowerCase()) return null;
            // 只认「从 folder 的兄弟位置搬进 folder」这一种形状：
            // to 必须正好是 folder\ + from 的文件名。脏账本里写着别的位置，一律不信
            const base = from.split(/[\\/]/).pop() ?? "";
            if (!base || `${folder}\\${base}`.toLowerCase() !== to.toLowerCase()) return null;
            return {
              from,
              to,
              folder,
              madeFolder: r?.madeFolder === true,
              done: r?.done === true,
              at: num(r?.at, 0)
            } satisfies FoldRecord;
          })
          .filter((r): r is FoldRecord => r !== null)
      }))
      .filter((s) => s.records.length > 0)
      .slice(-10)
  };
}
