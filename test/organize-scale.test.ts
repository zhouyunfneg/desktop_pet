import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, defaultZones, type AppConfig, type Rect } from "../src/shared/config";
import { buildPlan, type IconInput, type RealEntry } from "../src/shared/organize";
import { dipListToPhys, physListToDip, type DisplayGeometry } from "../src/shared/coords";

/**
 * 整理链路在显示缩放不等于 100% 时的端到端单位一致性回归。
 * 屏幕数据取自一次真实读取：物理 1920×1080，桌面图标横坐标最大到 1838。
 */
const PHYS_W = 1920;
const PHYS_H = 1080;
const SCALE = 1.5;
const WORK_AREA_DIP: Rect = { x: 0, y: 0, w: Math.round(PHYS_W / SCALE), h: Math.round(PHYS_H / SCALE) - 27 };
const GEOMETRY: DisplayGeometry = { dipX: 0, dipY: 0, physX: 0, physY: 0, scaleFactor: SCALE };

/** FFI 读回来的坐标是物理像素 */
const PHYS_ICONS: IconInput[] = [
  { index: 0, name: "报告", x: 1838, y: 2 }, // 折算成 DIP 是 1225，本来就在文档区里
  { index: 1, name: "照片", x: 14, y: 204 },
  { index: 2, name: "素材", x: 912, y: 406 },
  { index: 3, name: "笔记", x: 14, y: 610 }
];

const TABLE: Record<string, RealEntry> = {
  报告: { realName: "报告.pdf", isDir: false, ext: "pdf" },
  照片: { realName: "照片.png", isDir: false, ext: "png" },
  素材: { realName: "素材.zip", isDir: false, ext: "zip" },
  笔记: { realName: "笔记.txt", isDir: false, ext: "txt" }
};
const resolve = (name: string): RealEntry | undefined => TABLE[name];

function config(workArea: Rect): AppConfig {
  const rules = DEFAULT_RULES.map((r) => ({ ...r, exts: [...r.exts] }));
  // starter 区域里「杂项区」默认没启用，这里全部打开，让每类文件都有落点
  const zones = defaultZones(workArea, rules).map((z) => ({ ...z, enabled: true }));
  return { version: 1, rules, zones };
}

describe("150% 缩放下的整理落点", () => {
  it("修复后：落点与区域同单位，写回物理像素也不会跑出屏幕", () => {
    const cfg = config(WORK_AREA_DIP);
    const dipIcons = physListToDip(PHYS_ICONS, GEOMETRY);
    const plan = buildPlan(dipIcons, resolve, cfg, new Set());
    expect(plan.moves.length).toBeGreaterThan(0);

    for (const m of plan.moves) {
      const zone = cfg.zones.find((z) => z.id === m.zoneId)!;
      expect(m.toX).toBeGreaterThanOrEqual(zone.rect.x);
      expect(m.toX).toBeLessThan(zone.rect.x + zone.rect.w);
      expect(m.toY).toBeGreaterThanOrEqual(zone.rect.y);
    }
    // 写回 FFI 前换算成物理像素：不能跑出屏幕
    const phys = dipListToPhys(
      plan.moves.map((m) => ({ x: m.toX, y: m.toY })),
      GEOMETRY
    );
    for (const p of phys) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(PHYS_W);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(PHYS_H);
    }
  });

  it("修复后：已经排在区域内的图标不会再被搬一遍", () => {
    const cfg = config(WORK_AREA_DIP);
    const plan = buildPlan(physListToDip(PHYS_ICONS, GEOMETRY), resolve, cfg, new Set());
    expect(plan.moves.some((m) => m.name === "报告")).toBe(false);
    expect(plan.skipped.some((s) => s.name === "报告" && s.reason.includes("已在"))).toBe(true);
  });

  it("修复前：物理像素当 DIP 用，区域内的图标会被误判成区外、每次整理都重搬", () => {
    const cfg = config(WORK_AREA_DIP);
    // 旧行为：图标物理坐标不换算，直接和 DIP 的区域矩形比
    const plan = buildPlan(PHYS_ICONS, resolve, cfg, new Set());
    expect(plan.moves.some((m) => m.name === "报告")).toBe(true);

    // 而算出来的落点是 DIP 数值，旧代码直接写进 FFI（当作物理像素）→ 位置整体偏左
    const [first] = plan.moves;
    const writtenByOldCode = Math.round(first.toX);
    const writtenByFixedCode = dipListToPhys([{ x: first.toX, y: first.toY }], GEOMETRY)[0].x;
    expect(Math.abs(writtenByFixedCode - writtenByOldCode)).toBeGreaterThan(100);
  });

  it("修复后：连点两次整理，第二次没有活可干", () => {
    const cfg = config(WORK_AREA_DIP);
    const dipIcons = physListToDip(PHYS_ICONS, GEOMETRY);
    const first = buildPlan(dipIcons, resolve, cfg, new Set());
    const settled: IconInput[] = dipIcons.map((ic) => {
      const moved = first.moves.find((m) => m.index === ic.index);
      return moved ? { ...ic, x: moved.toX, y: moved.toY } : ic;
    });
    const second = buildPlan(settled, resolve, cfg, new Set());
    expect(second.moves).toHaveLength(0);
  });

  it("100% 缩放时新旧行为逐条相同，修复不会改变现有机器上的结果", () => {
    const cfg = config({ x: 0, y: 0, w: PHYS_W, h: PHYS_H - 40 });
    const identity: DisplayGeometry = { dipX: 0, dipY: 0, physX: 0, physY: 0, scaleFactor: 1 };
    const converted = physListToDip(PHYS_ICONS, identity);
    expect(converted).toEqual(PHYS_ICONS);
    const a = buildPlan(converted, resolve, cfg, new Set());
    const b = buildPlan(PHYS_ICONS, resolve, cfg, new Set());
    expect(a.moves.map((m) => `${m.name}@${m.toX},${m.toY}`)).toEqual(
      b.moves.map((m) => `${m.name}@${m.toX},${m.toY}`)
    );
  });
});
