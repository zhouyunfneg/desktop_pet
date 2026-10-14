import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, type AppConfig, type Rect, type Zone } from "../src/shared/config";
import { buildPlan, CELL_H, CELL_W, type IconInput, type RealEntry } from "../src/shared/organize";

function zone(partial: Partial<Zone> & { id: string; ruleId: string }): Zone {
  return {
    name: partial.name ?? partial.id,
    rect: partial.rect ?? { x: 100, y: 100, w: 300, h: 300 },
    dir: partial.dir ?? partial.id,
    color: partial.color ?? "#4C86E0",
    enabled: partial.enabled ?? true,
    ruleId: partial.ruleId,
    id: partial.id
  };
}

function cfg(zones: Zone[]): AppConfig {
  return { version: 1, rules: DEFAULT_RULES.map((r) => ({ ...r, exts: [...r.exts] })), zones };
}

/** 用一张表当 resolve：显示名 → 真实条目 */
function resolver(table: Record<string, RealEntry>): (name: string) => RealEntry | undefined {
  return (name) => table[name.toLowerCase()];
}

const icon = (index: number, name: string, x = 10, y = 10): IconInput => ({ index, name, x, y });
const noSkip = new Set<string>();

describe("buildPlan 图标→区域映射", () => {
  it("命中启用区域：给出目标槽位与分类", () => {
    const plan = buildPlan(
      [icon(0, "报告", 500, 500)],
      resolver({ 报告: { realName: "报告.pdf", isDir: false, ext: "pdf" } }),
      cfg([zone({ id: "z-doc", ruleId: "doc", rect: { x: 100, y: 100, w: 300, h: 300 } })]),
      noSkip
    );
    expect(plan.moves).toHaveLength(1);
    const m = plan.moves[0];
    expect(m.category).toBe("文档");
    expect(m.fromX).toBe(500);
    expect(m.toX).toBe(100 + 10); // rect.x + PAD
    expect(m.toY).toBe(100 + 10);
  });

  it("文件夹归入兜底「其他」分类", () => {
    const plan = buildPlan(
      [icon(0, "资料")],
      resolver({ 资料: { realName: "资料", isDir: true, ext: "" } }),
      cfg([zone({ id: "z-other", ruleId: "other" })]),
      noSkip
    );
    expect(plan.moves[0].category).toBe("其他");
    expect(plan.moves[0].zoneId).toBe("z-other");
  });

  it("快捷方式按 .lnk 命中「快捷方式」分类", () => {
    const plan = buildPlan(
      [icon(0, "微信")],
      resolver({ 微信: { realName: "微信.lnk", isDir: false, ext: "lnk" } }),
      cfg([zone({ id: "z-lnk", ruleId: "lnk" })]),
      noSkip
    );
    expect(plan.moves[0].category).toBe("快捷方式");
  });

  it("虚拟桌面项（此电脑/回收站）跳过", () => {
    const plan = buildPlan(
      [icon(0, "此电脑"), icon(1, "回收站")],
      resolver({}),
      cfg([zone({ id: "z-other", ruleId: "other" })]),
      noSkip
    );
    expect(plan.moves).toHaveLength(0);
    expect(plan.skipped).toHaveLength(2);
  });

  it("显示名匹配不到磁盘条目 = 跳过", () => {
    const plan = buildPlan(
      [icon(0, "某个消失的东西")],
      resolver({}),
      cfg([zone({ id: "z-other", ruleId: "other" })]),
      noSkip
    );
    expect(plan.skipped[0].reason).toContain("非磁盘文件");
  });

  it("落点目录/食盆本身被跳过", () => {
    const plan = buildPlan(
      [icon(0, "文档")],
      resolver({ 文档: { realName: "文档", isDir: true, ext: "" } }),
      cfg([zone({ id: "z-other", ruleId: "other" })]),
      new Set(["文档"])
    );
    expect(plan.moves).toHaveLength(0);
    expect(plan.skipped[0].reason).toContain("落点目录");
  });

  it("分类没有启用区域时跳过", () => {
    const plan = buildPlan(
      [icon(0, "视频", 5, 5)],
      resolver({ 视频: { realName: "a.mp4", isDir: false, ext: "mp4" } }),
      cfg([zone({ id: "z-doc", ruleId: "doc", enabled: true })]),
      noSkip
    );
    expect(plan.skipped[0].reason).toContain("视频");
  });

  it("同区域多图标排成网格，槽位不重叠", () => {
    const r: Rect = { x: 0, y: 0, w: CELL_W * 3, h: CELL_H * 3 };
    const plan = buildPlan(
      // 图标放在区域外（否则会被「已在区域内」跳过），验证从外面搬进来时排成网格
      [icon(0, "a", 500, 500), icon(1, "b", 500, 500), icon(2, "c", 500, 500)],
      resolver({
        a: { realName: "a.txt", isDir: false, ext: "txt" },
        b: { realName: "b.txt", isDir: false, ext: "txt" },
        c: { realName: "c.txt", isDir: false, ext: "txt" }
      }),
      cfg([zone({ id: "z-doc", ruleId: "doc", rect: r })]),
      noSkip
    );
    const xs = plan.moves.map((m) => m.toX);
    const ys = plan.moves.map((m) => m.toY);
    // 三个图标占三个不同格子
    expect(new Set(plan.moves.map((m) => `${m.toX},${m.toY}`)).size).toBe(3);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(ys[0]).toBe(ys[1]);
  });

  it("区域排满后多余的跳过", () => {
    const r: Rect = { x: 0, y: 0, w: CELL_W, h: CELL_H }; // 只放得下 1 个
    const plan = buildPlan(
      [icon(0, "a", 500, 500), icon(1, "b", 500, 500)],
      resolver({
        a: { realName: "a.png", isDir: false, ext: "png" },
        b: { realName: "b.png", isDir: false, ext: "png" }
      }),
      cfg([zone({ id: "z-img", ruleId: "img", rect: r })]),
      noSkip
    );
    expect(plan.moves).toHaveLength(1);
    expect(plan.skipped[0].reason).toContain("排满");
  });

  it("区域汇总按收到图标数计数", () => {
    const plan = buildPlan(
      [icon(0, "a"), icon(1, "b"), icon(2, "c")],
      resolver({
        a: { realName: "a.png", isDir: false, ext: "png" },
        b: { realName: "b.png", isDir: false, ext: "png" },
        c: { realName: "c.txt", isDir: false, ext: "txt" }
      }),
      cfg([zone({ id: "z-img", ruleId: "img" }), zone({ id: "z-doc", ruleId: "doc" })]),
      noSkip
    );
    const img = plan.zones.find((z) => z.zoneId === "z-img");
    expect(img?.count).toBe(2);
  });
});
