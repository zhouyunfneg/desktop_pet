import { describe, expect, it } from "vitest";
import {
  CATCH_ALL_ID,
  DEFAULT_RULES,
  defaultConfig,
  defaultZones,
  rectsOverlap,
  ruleOf,
  validateConfig,
  zoneForFile
} from "../src/shared/config";

const WA = { x: 0, y: 0, w: 1920, h: 1040 };

describe("分类匹配", () => {
  it("按扩展名命中，大小写与前置点号都不敏感", () => {
    expect(ruleOf("Report.PDF").id).toBe("doc");
    expect(ruleOf("photo.PNG").id).toBe("img");
    expect(ruleOf("a.mp4").id).toBe("vid");
  });

  it("点开头的隐藏文件名算没有扩展名（这类文件本来也会被食盆跳过）", () => {
    expect(ruleOf(".png").id).toBe(CATCH_ALL_ID);
  });

  it("无扩展名或未收录的都落兜底", () => {
    expect(ruleOf("noext").id).toBe(CATCH_ALL_ID);
    expect(ruleOf("a.unknownext").id).toBe(CATCH_ALL_ID);
  });

  it("用户删掉某分类的扩展名后，该文件改落兜底而不是残留旧映射", () => {
    const rules = DEFAULT_RULES.map((r) => (r.id === "vid" ? { ...r, exts: [] } : r));
    expect(ruleOf("a.mp4", rules).id).toBe(CATCH_ALL_ID);
  });
});

describe("validateConfig 清洗", () => {
  it("空输入也能得到一个能用的配置", () => {
    const c = validateConfig(null);
    expect(c.rules.some((r) => r.id === CATCH_ALL_ID)).toBe(true);
    expect(c.zones).toEqual([]);
  });

  it("跨分类重复的扩展名只保留第一次出现", () => {
    const c = validateConfig({
      version: 1,
      rules: [
        { id: "a", label: "A", exts: ["txt", "md"], color: "#111111" },
        { id: "b", label: "B", exts: ["txt"], color: "#222222" }
      ],
      zones: []
    });
    expect(c.rules.find((r) => r.id === "a")?.exts).toEqual(["txt", "md"]);
    expect(c.rules.find((r) => r.id === "b")?.exts).toEqual([]);
  });

  it("重复 id 会被改名，避免 key 冲突", () => {
    const c = validateConfig({
      version: 1,
      rules: [
        { id: "x", label: "一", exts: [], color: "#ffffff" },
        { id: "x", label: "二", exts: [], color: "#ffffff" }
      ],
      zones: []
    });
    expect(new Set(c.rules.map((r) => r.id)).size).toBe(c.rules.length);
  });

  it("非法颜色回落，缺兜底分类会补上", () => {
    const c = validateConfig({
      version: 1,
      rules: [{ id: "x", label: "X", exts: [], color: "red" }],
      zones: []
    });
    expect(c.rules[0].color).not.toBe("red");
    expect(c.rules.some((r) => r.id === CATCH_ALL_ID)).toBe(true);
  });

  it("区域目录不允许穿越到别处", () => {
    const c = validateConfig({
      version: 1,
      rules: DEFAULT_RULES,
      zones: [
        {
          id: "z",
          name: "",
          ruleId: "doc",
          rect: { x: 10, y: 10, w: 200, h: 200 },
          dir: "../../Windows",
          color: "#333333",
          enabled: true
        }
      ]
    });
    expect(c.zones[0].dir).toBe("Windows");
    // 名称为空时回落到分类名 + 区
    expect(c.zones[0].name).toBe("文档区");
  });

  it("越界区域被夹回工作区，且不会小于最小尺寸", () => {
    const c = validateConfig(
      {
        version: 1,
        rules: DEFAULT_RULES,
        zones: [
          {
            id: "z",
            name: "Z",
            ruleId: "nope",
            rect: { x: 5000, y: 5000, w: 10, h: 10 },
            dir: "d",
            color: "#444444",
            enabled: true
          }
        ]
      },
      WA
    );
    const r = c.zones[0].rect;
    expect(r.x + r.w).toBeLessThanOrEqual(WA.w);
    expect(r.y + r.h).toBeLessThanOrEqual(WA.h);
    expect(r.w).toBeGreaterThanOrEqual(64);
    // ruleId 不存在时指向一个真实存在的分类
    expect(c.rules.some((x) => x.id === c.zones[0].ruleId)).toBe(true);
  });
});

describe("区域归类", () => {
  it("按扩展名找到启用的区域，未启用则不算", () => {
    const c = defaultConfig();
    c.zones = [
      {
        id: "z1",
        name: "文档",
        ruleId: "doc",
        rect: { x: 0, y: 0, w: 100, h: 100 },
        dir: "文档",
        color: "#4C86E0",
        enabled: true
      },
      {
        id: "z2",
        name: "图片",
        ruleId: "img",
        rect: { x: 0, y: 0, w: 100, h: 100 },
        dir: "图片",
        color: "#3BA776",
        enabled: false
      }
    ];
    expect(zoneForFile(c, "a.pdf")?.id).toBe("z1");
    expect(zoneForFile(c, "a.png")?.id).toBeUndefined();
    // 未知扩展名走兜底分类，没有对应区域就是没有
    expect(zoneForFile(c, "a.unknownext")?.id).toBeUndefined();
  });

  it("默认三个区域互不重叠且都在工作区内", () => {
    const zones = defaultZones(WA, DEFAULT_RULES);
    expect(zones.length).toBe(3);
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        expect(rectsOverlap(zones[i].rect, zones[j].rect)).toBe(false);
      }
      const r = zones[i].rect;
      expect(r.x).toBeGreaterThanOrEqual(WA.x);
      expect(r.y).toBeGreaterThanOrEqual(WA.y);
      expect(r.x + r.w).toBeLessThanOrEqual(WA.x + WA.w);
      expect(r.y + r.h).toBeLessThanOrEqual(WA.y + WA.h);
    }
  });
});
