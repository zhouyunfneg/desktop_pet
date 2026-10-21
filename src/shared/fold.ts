/**
 * 「收进文件夹」整理模式的纯逻辑（不碰 fs、不碰 FFI，能直接在 node 下单测）。
 *
 * 两件事：
 *  ① planFold：看桌面上散着哪些文件，按分类规则算出「哪个文件该进桌面哪个文件夹」。
 *     快捷方式、文件夹、系统桌面项一律不动 —— 这个模式只收「散文件」。
 *  ② planColumns：收纳完之后（或者不收纳时）把剩下的图标按类型分成竖栏排齐，
 *     用户不用再手画区域。
 *
 * 真移动文件的风险都压在执行层（src/main/fold.ts），这里只负责把「该动谁」算清楚，
 * 并且把所有不能动的情况都写成一条带理由的 skipped —— 预览清单要靠它说话。
 */
import { CATCH_ALL_ID, extOf, type CategoryRule, type Rect } from "./config";

/** 系统虚拟桌面项：不在磁盘上，永远不动 */
export const VIRTUAL_NAMES = new Set([
  "此电脑",
  "回收站",
  "网络",
  "控制面板",
  "电脑",
  "this pc",
  "computer",
  "recycle bin"
]);

/** 桌面上一个真实存在的条目（执行层用 fs 读出来传进来） */
export interface DeskItem {
  /** 磁盘上的真名（含扩展名） */
  name: string;
  isDir: boolean;
  /** 所在目录，用来区分「用户桌面」和「公共桌面」两份同名文件 */
  where: string;
}

/** 一组要收进同一个文件夹的文件 */
export interface FoldGroup {
  ruleId: string;
  label: string;
  color: string;
  /** 桌面上那个分类文件夹的名字 */
  folder: string;
  /** 这个文件夹是这次新建的还是本来就有 */
  folderExists: boolean;
  files: { name: string; where: string }[];
}

export interface FoldSkip {
  name: string;
  reason: string;
}

export interface FoldPlan {
  groups: FoldGroup[];
  skipped: FoldSkip[];
  /** 会被收起来的散文件总数 */
  total: number;
}

export interface FoldContext {
  /** 分类文件夹名 → 里面已有的文件名（小写）。没有这个文件夹就给空数组 */
  folderContents: Map<string, string[]>;
  /** 不许碰的名字（食盆、老版区域落点目录、以及分类文件夹本身由内部处理） */
  protectedNames: Set<string>;
  /** 只收这些目录里的文件；公共桌面通常没写权限，默认排除 */
  writableDirs: Set<string>;
}

/** 分类文件夹就叫分类名：文档 / 图片 / 视频 / 音频 / 压缩包 / 安装包 / 其他 */
export function folderNameOf(rule: CategoryRule): string {
  return rule.label.trim() || rule.id;
}

/** 一个扩展名归哪类；没扩展名算「其他」 */
export function ruleIdOf(ext: string, rules: CategoryRule[]): string {
  const hit = ext ? rules.find((r) => r.exts.includes(ext.toLowerCase())) : undefined;
  return hit?.id ?? CATCH_ALL_ID;
}

const lower = (s: string): string => s.trim().toLowerCase();

/**
 * 算「哪些散文件进哪个文件夹」。
 * 顺序稳定（按分类在 rules 里的先后，再按名字），同一批多次调用结果必须一样，
 * 否则预览和实际执行会不一致。
 */
export function planFold(items: DeskItem[], rules: CategoryRule[], ctx: FoldContext): FoldPlan {
  const groups = new Map<string, FoldGroup>();
  const skipped: FoldSkip[] = [];
  /** 已经决定要收进来的名字（分类文件夹小写 → 文件名小写集合），防同批撞名 */
  const taken = new Map<string, Set<string>>();
  const folderByRule = new Map<string, CategoryRule>();
  for (const r of rules) folderByRule.set(r.id, r);

  const sorted = [...items].sort(
    (a, b) =>
      rules.findIndex((r) => r.id === ruleIdOf(a.isDir ? "" : extOf(a.name), rules)) -
        rules.findIndex((r) => r.id === ruleIdOf(b.isDir ? "" : extOf(b.name), rules)) ||
      a.name.localeCompare(b.name, "zh-Hans-CN")
  );

  for (const it of sorted) {
    const disp = it.name.trim();
    if (!disp) continue;
    if (VIRTUAL_NAMES.has(lower(disp))) continue;
    if (lower(disp) === "desktop.ini") continue;
    if (ctx.protectedNames.has(lower(disp))) {
      skipped.push({ name: disp, reason: "食盆 / 落点目录本身，不动" });
      continue;
    }
    if (it.isDir) {
      skipped.push({ name: disp, reason: "文件夹留在桌面，只收散文件" });
      continue;
    }
    const ext = extOf(disp);
    if (ext === "lnk" || ext === "url") {
      skipped.push({ name: disp, reason: "快捷方式留在桌面" });
      continue;
    }
    if (!ctx.writableDirs.has(it.where)) {
      skipped.push({ name: disp, reason: "在公共桌面里，没写权限" });
      continue;
    }

    const rule = folderByRule.get(ruleIdOf(ext, rules)) ?? rules.find((r) => r.id === CATCH_ALL_ID);
    if (!rule) {
      skipped.push({ name: disp, reason: "没有「其他」分类兜底，配置有问题" });
      continue;
    }
    const folder = folderNameOf(rule);
    const existing = ctx.folderContents.get(lower(folder)) ?? [];
    const mine = taken.get(lower(folder)) ?? new Set<string>();
    if (existing.some((f) => lower(f) === lower(disp)) || mine.has(lower(disp))) {
      skipped.push({ name: disp, reason: `「${folder}」里已有同名文件` });
      continue;
    }
    mine.add(lower(disp));
    taken.set(lower(folder), mine);

    let g = groups.get(rule.id);
    if (!g) {
      g = {
        ruleId: rule.id,
        label: rule.label,
        color: rule.color,
        folder,
        folderExists: existing.length > 0 || ctx.folderContents.has(lower(folder)),
        files: []
      };
      groups.set(rule.id, g);
    }
    g.files.push({ name: it.name, where: it.where });
  }

  return { groups: [...groups.values()], skipped, total: groups.size ? [...groups.values()].reduce((a, g) => a + g.files.length, 0) : 0 };
}

/** 竖栏排布用的格子尺寸（与 Windows 桌面默认图标间距一致，DIP） */
export const COL_W = 76;
export const COL_H = 101;
/** 每栏图标列数：2 列时栏头标签刚好压在栏上方，不会挤到下一栏 */
export const BAND_COLS = 2;
/** 栏与栏之间空一列，留出视觉边界 */
export const BAND_GAP = 1;

export interface ColumnInput {
  /** 显示名 */
  name: string;
  /** 分类规则 id；系统项用 "sys" */
  ruleId: string;
  label: string;
  color: string;
}

export interface ColumnSlot {
  name: string;
  x: number;
  y: number;
  ruleId: string;
  label: string;
  color: string;
}

export interface ColumnBand {
  ruleId: string;
  label: string;
  color: string;
  rect: Rect;
  count: number;
}

export interface ColumnPlan {
  slots: ColumnSlot[];
  bands: ColumnBand[];
  /** 桌面宽度放不下、这次没排的名字 */
  overflow: string[];
}

/**
 * 把图标按分类排成从左到右的竖栏。
 * 系统项（此电脑 / 回收站）留在原位：它们有自己的固定位置习惯，挪了反而找不到。
 * 每栏内部按名字排序，栏内先填满一列再开下一列（和 Windows 的竖排习惯一致）。
 *
 * grid 传桌面上现有图标的最左 / 最上格点（实测原点 14,2），落点才会正好踩在系统网格上；
 * maxCols 是工作区放得下的列数，超出就丢进 overflow 报告出去，不能把图标甩到屏幕外。
 */
export function planColumns(
  items: (ColumnInput & { x: number; y: number })[],
  grid: { ox: number; oy: number },
  maxRows: number,
  maxCols: number
): ColumnPlan {
  const slots: ColumnSlot[] = [];
  const bands: ColumnBand[] = [];
  const overflow: string[] = [];
  for (const k of items) {
    if (k.ruleId !== "sys") continue;
    slots.push({ name: k.name, x: k.x, y: k.y, ruleId: "sys", label: k.label, color: k.color });
  }

  const order: string[] = [];
  const byRule = new Map<string, ColumnInput[]>();
  for (const i of items) {
    if (i.ruleId === "sys") continue;
    if (!byRule.has(i.ruleId)) {
      byRule.set(i.ruleId, []);
      order.push(i.ruleId);
    }
    byRule.get(i.ruleId)!.push(i);
  }

  let col = 0;
  for (const ruleId of order) {
    const list = byRule.get(ruleId)!.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    const rows = Math.max(1, Math.min(maxRows, Math.ceil(list.length / BAND_COLS)));
    const cols = Math.max(1, Math.ceil(list.length / rows));
    if (col + cols > maxCols) {
      overflow.push(...list.map((i) => i.name));
      continue;
    }
    const first = grid.ox + col * COL_W;
    list.forEach((i, n) => {
      slots.push({
        name: i.name,
        x: first + (n % cols) * COL_W,
        y: grid.oy + Math.floor(n / cols) * COL_H,
        ruleId,
        label: i.label,
        color: i.color
      });
    });
    bands.push({
      ruleId,
      label: list[0].label,
      color: list[0].color,
      rect: { x: first - 4, y: grid.oy - 4, w: cols * COL_W + 8, h: rows * COL_H + 8 },
      count: list.length
    });
    col += cols + BAND_GAP;
  }
  return { slots, bands, overflow };
}
