import { app } from "electron";
import { promises as fs } from "node:fs";
import { extOf } from "../shared/config";
import {
  buildPlan,
  type IconInput,
  type IconMove,
  type RealEntry,
  type SkippedFile
} from "../shared/organize";
import type { IconStep, OrganizeResult, UndoResult } from "../shared/ipc";
import { applyPositions, ensureManualArrange, readIcons } from "./desktop-icons";
import { configStore, organizeStore, type MoveRecord } from "./store";

/**
 * 桌面「挪图标」整理执行层：读桌面图标坐标 → 按分类算目标槽位 → 狗跑到图标处、
 * 每放下一个就 settleIcon 真正写坐标（图标跟着狗走）→ 记 undo（原始坐标）可整批撤销。
 * 文件本身不动，只改 explorer 里图标的显示位置。
 */

/** 本次整理待落位的目标坐标（显示名 → 目标点）；settleIcon 按名字消费 */
let pendingTargets = new Map<string, { x: number; y: number }>();

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
  return (name) => map.get(name.toLowerCase());
}

/** 区域落点目录不该被挪走；“食盆”是老版本可能残留的目录，一并保护 */
function skipNames(): Set<string> {
  const set = new Set<string>();
  for (const z of configStore.get().zones) if (z.dir) set.add(z.dir.toLowerCase());
  set.add("食盆");
  return set;
}

export function hasUndo(): boolean {
  return organizeStore.get().sessions.length > 0;
}

export function planToSteps(moves: IconMove[]): IconStep[] {
  return moves.map((m) => ({
    index: m.index,
    name: m.name,
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

  const icons = readIcons();
  if (!icons) {
    return { ...noop, skipped: [{ name: "桌面", reason: "无法读取桌面图标（系统结构不支持）" }] };
  }

  const config = configStore.get();
  const resolve = await buildResolver();
  const inputs: IconInput[] = icons.map((i) => ({ index: i.index, name: i.name, x: i.x, y: i.y }));
  // 以现有图标的最左/最上作为桌面网格原点（开了网格对齐时它们就在格点上），让落点与网格严丝合缝
  const grid = icons.length
    ? { ox: Math.min(...icons.map((i) => i.x)), oy: Math.min(...icons.map((i) => i.y)) }
    : undefined;
  const plan = buildPlan(inputs, resolve, config, skipNames(), grid);

  if (dryRun) {
    return { moved: plan.moves, skipped: plan.skipped, zones: plan.zones, canUndo: hasUndo(), steps: [] };
  }

  if (plan.moves.length === 0) {
    return { moved: [], skipped: plan.skipped, zones: plan.zones, canUndo: hasUndo(), steps: [] };
  }

  ensureManualArrange();

  pendingTargets = new Map(plan.moves.map((m) => [m.name, { x: m.toX, y: m.toY }]));
  const originals: MoveRecord[] = plan.moves.map((m) => ({ name: m.name, x: m.fromX, y: m.fromY }));
  const next = [...organizeStore.get().sessions, { id: `o-${Date.now().toString(36)}`, at: Date.now(), moves: originals }];
  organizeStore.replace({ version: 1, sessions: next.slice(-20) });

  return {
    moved: plan.moves,
    skipped: plan.skipped,
    zones: plan.zones,
    canUndo: true,
    steps: planToSteps(plan.moves)
  };
}

/**
 * 狗放下某个图标时写它的坐标。按显示名重新查当前 index：
 * 每挪一个图标后桌面可能重排 item 顺序，计划时缓存的 index 会失效。
 */
export function settleIcon(name: string): void {
  const t = pendingTargets.get(name);
  if (!t) return;
  const icons = readIcons();
  const idx = icons?.find((i) => i.name === name)?.index;
  if (idx === undefined) return;
  applyPositions([{ index: idx, x: t.x, y: t.y }]);
  pendingTargets.delete(name);
}

/** 撤销最近一次整理：按显示名重新定位当前 index，把坐标写回去 */
export async function runUndo(): Promise<UndoResult> {
  const log = organizeStore.get();
  if (log.sessions.length === 0) return { restored: 0, failed: [], remaining: 0 };
  const last = log.sessions[log.sessions.length - 1];

  const icons = readIcons();
  const failed: SkippedFile[] = [];
  let restored = 0;

  if (!icons) {
    return { restored: 0, failed: [{ name: "桌面", reason: "无法读取桌面图标" }], remaining: log.sessions.length };
  }
  const byName = new Map(icons.map((i) => [i.name.toLowerCase(), i.index] as const));
  const updates: { index: number; x: number; y: number }[] = [];
  for (const m of last.moves) {
    const idx = byName.get(m.name.toLowerCase());
    if (idx === undefined) {
      failed.push({ name: m.name, reason: "图标已不在桌面" });
      continue;
    }
    updates.push({ index: idx, x: m.x, y: m.y });
    restored += 1;
  }
  if (updates.length > 0) {
    ensureManualArrange();
    if (!applyPositions(updates)) restored = 0;
  }
  pendingTargets = new Map();
  organizeStore.replace({ version: 1, sessions: log.sessions.slice(0, -1) });
  return { restored, failed, remaining: organizeStore.get().sessions.length };
}
