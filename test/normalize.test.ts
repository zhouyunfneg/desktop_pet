import { describe, expect, it } from "vitest";
import { normalizeFold, normalizeSettings, normalizeUndo } from "../src/shared/normalize";
import type { Settings } from "../src/shared/ipc";

describe("normalizeSettings 存档清洗", () => {
  it("空存档/坏存档全部回落到默认值", () => {
    for (const raw of [null, undefined, {}, "string", 42, []]) {
      const s = normalizeSettings(raw);
      expect(s).toEqual({
        version: 1,
        topmost: true,
        roamMode: "chase",
        showZones: false,
        petName: "小柴",
        keepDistance: 380
      });
    }
  });

  it("非法字段逐项回落，合法字段保留", () => {
    const s = normalizeSettings({
      version: 1,
      topmost: "yes",
      roamMode: "teleport",
      showZones: 1,
      keepDistance: "far"
    } as unknown as Settings);
    expect(s.topmost).toBe(true);
    expect(s.roamMode).toBe("chase");
    expect(s.showZones).toBe(false);
    expect(s.keepDistance).toBe(380);
  });

  it("狗名：空的、非字符串、只有空白都回默认名", () => {
    for (const bad of [undefined, null, 42, {}, "", "   ", "\n", "\t\t"]) {
      expect(normalizeSettings({ version: 1, petName: bad as unknown }).petName).toBe("小柴");
    }
  });

  it("狗名：去首尾空格、压掉中间连续空白、剔掉换行与控制字符", () => {
    expect(normalizeSettings({ version: 1, petName: "  阿柴 大王 " }).petName).toBe("阿柴 大王");
    expect(normalizeSettings({ version: 1, petName: "阿柴\n大王\r\t第二行" }).petName).toBe("阿柴 大王 第二行");
  });

  it("狗名：最长 12 个字，emoji 按一个字算、不会被劈成半个乱码", () => {
    const twelve = normalizeSettings({ version: 1, petName: "一二三四五六七八九十甲乙" }).petName;
    expect(twelve).toBe("一二三四五六七八九十甲乙");
    expect(normalizeSettings({ version: 1, petName: "一二三四五六七八九十甲乙丙丁" }).petName).toBe(twelve);
    const withEmoji = normalizeSettings({ version: 1, petName: "🐶".repeat(20) }).petName;
    expect(Array.from(withEmoji).length).toBe(12);
    expect(withEmoji).toBe("🐶".repeat(12));
  });

  it("四种漫游模式都能读回", () => {
    for (const mode of ["chase", "flee", "wander", "stay"] as const) {
      expect(normalizeSettings({ version: 1, roamMode: mode }).roamMode).toBe(mode);
    }
  });

  it("保持距离夹到 150~900 并取整", () => {
    expect(normalizeSettings({ version: 1, keepDistance: 10 }).keepDistance).toBe(150);
    expect(normalizeSettings({ version: 1, keepDistance: 99999 }).keepDistance).toBe(900);
    expect(normalizeSettings({ version: 1, keepDistance: 380.7 }).keepDistance).toBe(381);
    // 非有限数（NaN/Infinity）视为坏值，直接回默认而不是夹到端点
    expect(normalizeSettings({ version: 1, keepDistance: Number.NaN }).keepDistance).toBe(380);
    expect(normalizeSettings({ version: 1, keepDistance: Number.POSITIVE_INFINITY }).keepDistance).toBe(380);
  });

  it("当前存档里用户选的 220 必须原样保留", () => {
    // 回归：设置窗滑块 150~900 步长 10，220 是合法值；
    // 旧实现无条件把 220 当历史默认值偷偷抬成 380，用户会觉得「调了没生效」
    expect(normalizeSettings({ version: 1, keepDistance: 220 }).keepDistance).toBe(220);
  });

  it("老存档（没有 version）里的 220 才做迁移", () => {
    expect(normalizeSettings({ keepDistance: 220 }).keepDistance).toBe(380);
    expect(normalizeSettings({ keepDistance: 300 }).keepDistance).toBe(300);
  });

  it("旧存档的 origin 字段被丢弃，不占新存档位置", () => {
    const s = normalizeSettings({ origin: { x: 10, y: 20 }, roamMode: "stay" });
    expect("origin" in s).toBe(false);
    expect(s.roamMode).toBe("stay");
  });

  it("清洗结果幂等：再洗一次完全一样", () => {
    const once = normalizeSettings({ keepDistance: 220, roamMode: "flee" });
    expect(normalizeSettings(once)).toEqual(once);
  });
});

describe("normalizeUndo 撤销栈清洗", () => {
  it("坏存档回落到空栈", () => {
    for (const raw of [null, undefined, {}, { sessions: "x" }, { sessions: [null, {}, 3] }]) {
      expect(normalizeUndo(raw).sessions).toEqual([]);
    }
  });

  it("丢掉缺字段的记录、坐标取整、空会话不占位", () => {
    const log = normalizeUndo({
      sessions: [
        {
          id: "o-1",
          at: 100,
          moves: [
            { name: "报告", x: 14.6, y: 2.2 },
            { name: "", x: 1, y: 1 },
            { name: "坏", x: Number.NaN, y: 1 },
            { x: 1, y: 1 }
          ]
        },
        { id: "o-2", at: 200, moves: [] },
        { id: "o-3", at: 300, moves: "nope" }
      ]
    });
    expect(log.sessions.map((s) => s.id)).toEqual(["o-1"]);
    expect(log.sessions[0].moves).toEqual([{ name: "报告", x: 15, y: 2 }]);
  });

  it("没有 id 的会话用时间戳兜底，保证撤销栈里能定位", () => {
    const log = normalizeUndo({ sessions: [{ at: 555, moves: [{ name: "a", x: 1, y: 2 }] }] });
    expect(log.sessions[0].id).toBe("s-555");
    const noId = normalizeUndo({ sessions: [{ moves: [{ name: "a", x: 1, y: 2 }] }] });
    expect(noId.sessions[0].id).toBe("s-0");
    expect(noId.sessions[0].at).toBe(0);
  });

  it("id 是空白字符串时也要兜底，不能留一个空 key", () => {
    const log = normalizeUndo({ sessions: [{ id: "   ", at: 7, moves: [{ name: "a", x: 1, y: 2 }] }] });
    expect(log.sessions[0].id).toBe("s-7");
  });

  it("清洗结果幂等", () => {
    const raw = { sessions: [{ id: "o-1", at: 1, moves: [{ name: "a", x: 3.4, y: 5.6 }] }] };
    const once = normalizeUndo(raw);
    expect(normalizeUndo(once)).toEqual(once);
  });

  it("老存档没写 scale 时按 1 处理：它存的是物理像素，原样写回才是对的", () => {
    const log = normalizeUndo({
      sessions: [{ id: "o-old", at: 1, moves: [{ name: "报告", x: 1838, y: 300 }] }]
    });
    expect(log.sessions[0].scale).toBe(1);
  });

  it("记录了缩放倍数的会话原样保留，非法值回落到 1", () => {
    const session = (scale: unknown) => ({
      id: "o-1",
      at: 1,
      scale,
      moves: [{ name: "a", x: 1000, y: 200 }]
    });
    expect(normalizeUndo({ sessions: [session(1.5)] }).sessions[0].scale).toBe(1.5);
    expect(normalizeUndo({ sessions: [session(1)] }).sessions[0].scale).toBe(1);
    for (const bad of [0, -1.5, "1.5", null, Number.NaN]) {
      expect(normalizeUndo({ sessions: [session(bad)] }).sessions[0].scale).toBe(1);
    }
  });
});

