import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, type CategoryRule } from "../src/shared/config";
import {
  COL_H,
  COL_W,
  folderNameOf,
  planColumns,
  planFold,
  ruleIdOf,
  type ColumnInput,
  type DeskItem,
  type FoldContext
} from "../src/shared/fold";

function rules(): CategoryRule[] {
  return DEFAULT_RULES.map((r) => ({ ...r, exts: [...r.exts] }));
}

function item(name: string, where = "E:\\桌面3", isDir = false): DeskItem {
  return { name, where, isDir };
}

function ctx(partial: Partial<FoldContext> = {}): FoldContext {
  return {
    folderContents: new Map(),
    protectedNames: new Set(["食盆"]),
    writableDirs: new Set(["E:\\桌面3"]),
    ...partial
  };
}

describe("planFold：哪些散文件该收进哪个文件夹", () => {
  it("按类型分组，文件夹与快捷方式一律不动", () => {
    const plan = planFold(
      [
        item("报告.pdf"),
        item("备忘.txt"),
        item("截图.bmp"),
        item("金鹏", "E:\\桌面3", true),
        item("微信.lnk", "C:\\Users\\Public\\Desktop")
      ],
      rules(),
      ctx()
    );
    expect(plan.groups.map((g) => [g.folder, g.files.map((f) => f.name)])).toEqual([
      ["文档", ["报告.pdf", "备忘.txt"]],
      ["图片", ["截图.bmp"]]
    ]);
    expect(plan.total).toBe(3);
    // 文件夹和快捷方式都要在跳过清单里说清楚，不能默默消失
    expect(plan.skipped.map((s) => s.name).sort()).toEqual(["微信.lnk", "金鹏"]);
    expect(plan.skipped.find((s) => s.name === "金鹏")?.reason).toContain("文件夹");
    expect(plan.skipped.find((s) => s.name === "微信.lnk")?.reason).toContain("快捷方式");
  });

  it("同一批多次调用结果一致（预览和执行不能变卦）", () => {
    const items = [item("b.pdf"), item("a.txt"), item("c.png"), item("d.docx")];
    const one = planFold(items, rules(), ctx());
    const two = planFold([...items].reverse(), rules(), ctx());
    expect(JSON.stringify(one.groups)).toBe(JSON.stringify(two.groups));
  });

  it("目标文件夹里已有同名文件时跳过，绝不覆盖", () => {
    const plan = planFold(
      [item("报告.pdf"), item("新图.bmp")],
      rules(),
      ctx({ folderContents: new Map([["文档", ["报告.pdf"]]]) })
    );
    expect(plan.groups.find((g) => g.folder === "文档")).toBeUndefined();
    expect(plan.groups.find((g) => g.folder === "图片")?.files).toEqual([{ name: "新图.bmp", where: "E:\\桌面3" }]);
    expect(plan.skipped).toEqual([{ name: "报告.pdf", reason: "「文档」里已有同名文件" }]);
    expect(plan.total).toBe(1);
  });

  it("用户桌面与公共桌面的同名文件只收一个，另一个报冲突", () => {
    const plan = planFold(
      [item("说明.txt"), item("说明.txt", "C:\\Users\\Public\\Desktop")],
      rules(),
      ctx({ writableDirs: new Set(["E:\\桌面3", "C:\\Users\\Public\\Desktop"]) })
    );
    const doc = plan.groups.find((g) => g.folder === "文档");
    expect(doc?.files).toEqual([{ name: "说明.txt", where: "E:\\桌面3" }]);
    expect(plan.skipped).toEqual([{ name: "说明.txt", reason: "「文档」里已有同名文件" }]);
  });

  it("公共桌面没写权限时直说，不让用户以为收好了", () => {
    const plan = planFold([item("安装包.exe", "C:\\Users\\Public\\Desktop")], rules(), ctx());
    expect(plan.groups).toEqual([]);
    expect(plan.skipped).toEqual([{ name: "安装包.exe", reason: "在公共桌面里，没写权限" }]);
  });

  it("系统桌面项与 desktop.ini 静默忽略（它们不是磁盘上的散文件）", () => {
    const plan = planFold(
      [item("回收站", "E:\\桌面3", true), item("此电脑", "E:\\桌面3", true), item("desktop.ini")],
      rules(),
      ctx()
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.groups).toEqual([]);
    expect(plan.total).toBe(0);
  });

  it("食盆这类受保护目录本身不动", () => {
    const plan = planFold([item("食盆", "E:\\桌面3", true), item("杂物", "E:\\桌面3", true)], rules(), ctx());
    expect(plan.skipped.find((s) => s.name === "食盆")?.reason).toContain("食盆");
    expect(plan.skipped.find((s) => s.name === "杂物")?.reason).toContain("文件夹");
  });

  it("没扩展名的文件落到「其他」，分类兜底不能漏", () => {
    const plan = planFold([item("临时东西")], rules(), ctx());
    expect(plan.groups.map((g) => [g.ruleId, g.folder, g.files.length])).toEqual([["other", "其他", 1]]);
  });

  it("已有的分类文件夹标成 folderExists，新建的才会在撤销时删掉", () => {
    const plan = planFold(
      [item("报告.pdf"), item("猫.png")],
      rules(),
      ctx({ folderContents: new Map([["文档", ["旧文件.docx"]]]) })
    );
    expect(plan.groups.find((g) => g.folder === "文档")?.folderExists).toBe(true);
    expect(plan.groups.find((g) => g.folder === "图片")?.folderExists).toBe(false);
  });

  it("扩展名归类与文件夹名取自规则，改规则不用改代码", () => {
    const r = rules();
    expect(ruleIdOf("pdf", r)).toBe("doc");
    expect(ruleIdOf("PNG", r)).toBe("img");
    expect(ruleIdOf("", r)).toBe("other");
    expect(folderNameOf(r.find((x) => x.id === "arc")!)).toBe("压缩包");
  });
});

function col(name: string, ruleId: string, x = 0, y = 0): ColumnInput & { x: number; y: number } {
  return { name, ruleId, label: ruleId, color: "#fff", x, y };
}

describe("planColumns：按类型排成竖栏", () => {
  const grid = { ox: 14, oy: 2 };
  const maxRows = 9;
  const maxCols = 25;

  function plan(items: (ColumnInput & { x: number; y: number })[]) {
    return planColumns(items, grid, maxRows, maxCols);
  }

  it("系统项留在原来的格点上，不参与排栏", () => {
    const p = plan([col("此电脑", "sys", 14, 103), col("回收站", "sys", 14, 709), col("a.txt", "doc")]);
    const pc = p.slots.find((s) => s.name === "此电脑");
    const hs = p.slots.find((s) => s.name === "回收站");
    expect([pc?.x, pc?.y]).toEqual([14, 103]);
    expect([hs?.x, hs?.y]).toEqual([14, 709]);
    expect(p.bands.map((b) => b.ruleId)).toEqual(["doc"]);
  });

  it("所有落点都踩在桌面网格上（原点是图标自己的最左最上）", () => {
    const p = plan([col("a.txt", "doc"), col("b.txt", "doc"), col("c.png", "img"), col("d.png", "img")]);
    for (const s of p.slots) {
      expect((s.x - grid.ox) % COL_W).toBe(0);
      expect((s.y - grid.oy) % COL_H).toBe(0);
      expect(s.x).toBeGreaterThanOrEqual(grid.ox);
    }
  });

  it("栏与栏之间空一列，栏头不会压在下一栏图标上", () => {
    const p = plan([col("a.txt", "doc"), col("c.png", "img"), col("e.mp4", "vid")]);
    const starts = p.bands.map((b) => b.rect.x);
    expect(starts).toEqual([grid.ox - 4, grid.ox + 2 * COL_W - 4, grid.ox + 4 * COL_W - 4]);
  });

  it("一栏最多两列：11 个文件夹排成 6 行 × 2 列", () => {
    const items = Array.from({ length: 11 }, (_, i) => col(`f${i}`, "dir"));
    const p = plan(items);
    const band = p.bands.find((b) => b.ruleId === "dir")!;
    expect(band.rect.w).toBe(2 * COL_W + 8);
    expect(band.rect.h).toBe(6 * COL_H + 8);
    expect(new Set(p.slots.map((s) => s.x))).toEqual(new Set([grid.ox, grid.ox + COL_W]));
    expect(p.slots.length).toBe(11);
  });

  it("桌面放不下时不甩到屏幕外，改列进 overflow", () => {
    const items = [col("a.txt", "doc"), col("b.png", "img"), col("c.mp4", "vid"), col("d.zip", "arc")];
    const p = planColumns(items, grid, maxRows, 3);
    const placed = p.slots.filter((s) => s.ruleId !== "sys");
    expect(placed.every((s) => s.x <= grid.ox + 2 * COL_W)).toBe(true);
    expect(p.overflow).toEqual(["c.mp4", "d.zip"]);
  });

  it("栏内按名字排序：中文按拼音，纯英文名排在后面（本机 ICU 实测）", () => {
    const p = plan([col("微信", "lnk"), col("aseprite", "lnk"), col("Qoder", "lnk")]);
    expect(p.slots.map((s) => s.name)).toEqual(["微信", "aseprite", "Qoder"]);
  });

  it("空桌面什么都不排", () => {
    const p = plan([]);
    expect(p).toEqual({ slots: [], bands: [], overflow: [] });
  });
});
