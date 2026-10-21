import { extOf, type AppConfig, type Rect } from "./config";

/**
 * 桌面「挪图标整理」的纯逻辑：把读到的桌面图标按分类映射到启用区域，
 * 在区域矩形里排成网格，给出每个图标从哪挪到哪。不碰文件系统也不碰 FFI，
 * 所以能在 node 下直接单测；真实类型判定（显示名隐藏了扩展名）由上层用 fs 解析后传进来。
 *
 * 语义 = 只挪图标位置，文件留在原地（可撤销：记原始坐标）。
 */

/** FFI 读到的一个桌面图标（坐标已由上层换算成 DIP，与区域配置同一单位） */
export interface IconInput {
  index: number;
  /** 显示名（Windows 默认隐藏扩展名，可能不含 .xxx） */
  name: string;
  /** 屏幕坐标（DIP） */
  x: number;
  y: number;
}

/** 上层用 fs 解析出的真实条目：显示名 → 是不是目录、真实扩展名 */
export interface RealEntry {
  realName: string;
  isDir: boolean;
  ext: string;
}

export interface IconMove {
  index: number;
  name: string;
  category: string;
  zoneId: string;
  zoneName: string;
  color: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface SkippedFile {
  name: string;
  reason: string;
}

export interface ZoneSummary {
  zoneId: string;
  name: string;
  color: string;
  rect: Rect;
  count: number;
}

export interface OrganizePlan {
  moves: IconMove[];
  skipped: SkippedFile[];
  zones: ZoneSummary[];
}

/** 图标网格排布：单元格尺寸取 Windows 桌面默认图标间距（DIP，100% 缩放下即 76×101 像素） */
export const CELL_W = 76;
export const CELL_H = 101;
const PAD = 10;
/** 网格吸附时图标距区域边框的最小留白，避免图标正好压在边框线上 */
const GRID_INSET = 6;

/** 这些是系统虚拟桌面项，不是磁盘文件，永远不挪 */
const VIRTUAL = new Set(["此电脑", "回收站", "网络", "控制面板", "电脑", "this pc", "computer"]);

function categoryOf(entry: RealEntry, config: AppConfig): { ruleId: string; label: string } {
  const ext = entry.isDir ? "" : entry.ext || extOf(entry.realName);
  const rule =
    (ext ? config.rules.find((r) => r.exts.includes(ext)) : undefined) ??
    config.rules.find((r) => r.id === "other") ??
    config.rules[config.rules.length - 1];
  return { ruleId: rule?.id ?? "other", label: rule?.label ?? "其他" };
}

/**
 * 生成挪图标计划。
 * resolve 把图标的显示名解析成真实条目（找不到 = 虚拟项/已消失，跳过）。
 * skipNames 是区域落点目录、食盆这类不该被挪走的文件夹（小写）。
 */
export function buildPlan(
  icons: IconInput[],
  resolve: (displayName: string) => RealEntry | undefined,
  config: AppConfig,
  skipNames: Set<string>,
  grid?: { ox: number; oy: number }
): OrganizePlan {
  const moves: IconMove[] = [];
  const skipped: SkippedFile[] = [];
  const byZone = new Map<string, ZoneSummary>();
  /** 每个区域已排到第几个槽位（包括已在区域内的文件） */
  const slot = new Map<string, number>();

  // 第一遍：统计每个区域里已经有多少文件（这些文件占用 slot，但不出现在 moves 里）
  for (const ic of icons) {
    const disp = ic.name.trim();
    if (!disp) continue;
    if (VIRTUAL.has(disp.toLowerCase())) continue;
    const entry = resolve(disp);
    if (!entry) continue;
    if (skipNames.has(entry.realName.toLowerCase())) continue;

    const { ruleId } = categoryOf(entry, config);
    const zone = config.zones.find((z) => z.enabled && z.ruleId === ruleId);
    if (!zone) continue;

    // 如果文件已经在对应区域内，占用一个 slot
    if (
      ic.x >= zone.rect.x &&
      ic.x < zone.rect.x + zone.rect.w &&
      ic.y >= zone.rect.y &&
      ic.y < zone.rect.y + zone.rect.h
    ) {
      slot.set(zone.id, (slot.get(zone.id) ?? 0) + 1);
    }
  }

  // 第二遍：生成搬运计划
  for (const ic of icons) {
    const disp = ic.name.trim();
    if (!disp) continue;
    if (VIRTUAL.has(disp.toLowerCase())) {
      skipped.push({ name: disp, reason: "系统桌面项，不动" });
      continue;
    }
    const entry = resolve(disp);
    if (!entry) {
      skipped.push({ name: disp, reason: "非磁盘文件（虚拟项或已消失）" });
      continue;
    }
    if (skipNames.has(entry.realName.toLowerCase())) {
      skipped.push({ name: disp, reason: "整理落点目录/食盆本身" });
      continue;
    }

    const { ruleId, label } = categoryOf(entry, config);
    const zone = config.zones.find((z) => z.enabled && z.ruleId === ruleId);
    if (!zone) {
      skipped.push({ name: disp, reason: `「${label}」还没有启用的区域` });
      continue;
    }

    // 如果文件已经在对应区域内，跳过（不重复整理）
    if (
      ic.x >= zone.rect.x &&
      ic.x < zone.rect.x + zone.rect.w &&
      ic.y >= zone.rect.y &&
      ic.y < zone.rect.y + zone.rect.h
    ) {
      skipped.push({ name: disp, reason: `已在「${zone.name}」内` });
      continue;
    }

    const n = slot.get(zone.id) ?? 0;
    let cols: number;
    let rows: number;
    let toX: number;
    let toY: number;
    if (grid) {
      // 只用完全落在区域内（留 inset）的格点：ceil 找区域内第一个格点起步，
      // 避免 round 把落点舍到区域左边框之外/之上、图标正好压在边框上。
      const firstCol = Math.ceil((zone.rect.x + GRID_INSET - grid.ox) / CELL_W);
      const firstRow = Math.ceil((zone.rect.y + GRID_INSET - grid.oy) / CELL_H);
      const lastCol = Math.floor((zone.rect.x + zone.rect.w - GRID_INSET - grid.ox) / CELL_W);
      const lastRow = Math.floor((zone.rect.y + zone.rect.h - GRID_INSET - grid.oy) / CELL_H);
      cols = Math.max(1, lastCol - firstCol + 1);
      rows = Math.max(1, lastRow - firstRow + 1);
      if (n >= cols * rows) {
        skipped.push({ name: disp, reason: `${zone.name} 已排满` });
        continue;
      }
      toX = grid.ox + (firstCol + (n % cols)) * CELL_W;
      toY = grid.oy + (firstRow + Math.floor(n / cols)) * CELL_H;
    } else {
      cols = Math.max(1, Math.floor((zone.rect.w - PAD) / CELL_W));
      rows = Math.max(1, Math.floor((zone.rect.h - PAD) / CELL_H));
      if (n >= cols * rows) {
        skipped.push({ name: disp, reason: `${zone.name} 已排满` });
        continue;
      }
      toX = zone.rect.x + PAD + (n % cols) * CELL_W;
      toY = zone.rect.y + PAD + Math.floor(n / cols) * CELL_H;
    }
    slot.set(zone.id, n + 1);

    moves.push({
      index: ic.index,
      name: disp,
      category: label,
      zoneId: zone.id,
      zoneName: zone.name,
      color: zone.color,
      fromX: ic.x,
      fromY: ic.y,
      toX,
      toY
    });

    const sum = byZone.get(zone.id);
    if (sum) sum.count += 1;
    else byZone.set(zone.id, { zoneId: zone.id, name: zone.name, color: zone.color, rect: zone.rect, count: 1 });
  }

  return { moves, skipped, zones: [...byZone.values()] };
}

/** 撤销时按显示名回匹到的当前图标位置 */
export interface UndoTarget {
  index: number;
  x: number;
  y: number;
}

/**
 * 撤销用的名字回匹：把记录里的原始坐标对到当前桌面图标的 index。
 *
 * 桌面可能重排 item 顺序，所以只认显示名；比较时忽略大小写与首尾空白 ——
 * explorer 返回的名字带不带空格、显示名的大小写差异，都不该让撤销悄悄失灵。
 */
export function matchUndoTargets(
  records: { name: string; x: number; y: number }[],
  icons: { index: number; name: string }[]
): { updates: UndoTarget[]; failed: SkippedFile[] } {
  const byName = new Map<string, number>();
  for (const ic of icons) {
    const key = ic.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, ic.index);
  }
  const updates: UndoTarget[] = [];
  const failed: SkippedFile[] = [];
  for (const m of records) {
    const idx = byName.get(m.name.trim().toLowerCase());
    if (idx === undefined) {
      failed.push({ name: m.name, reason: "图标已不在桌面" });
      continue;
    }
    updates.push({ index: idx, x: m.x, y: m.y });
  }
  return { updates, failed };
}
