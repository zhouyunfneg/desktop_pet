import { describe, expect, it } from "vitest";
import { normalizeFold } from "../src/shared/normalize";

/**
 * 收纳账本（fold.json）的清洗。这份账本会驱动「把文件搬回桌面」，
 * 所以脏数据必须一条都留不下来：路径不合法、目标不在那个文件夹里、
 * 自己搬自己，全部丢掉，宁可撤销时少搬一个也不能搬错一个。
 */
describe("normalizeFold 收纳账本清洗", () => {
  const rec = (partial: Record<string, unknown> = {}) => ({
    from: "E:\\桌面3\\报告.pdf",
    to: "E:\\桌面3\\文档\\报告.pdf",
    folder: "E:\\桌面3\\文档",
    madeFolder: true,
    done: true,
    at: 5,
    ...partial
  });
  const session = (records: unknown[]) => ({ id: "f-1", at: 1, records });
  const only = (raw: unknown) => normalizeFold(raw).sessions[0]?.records ?? [];

  it("合法记录原样保留", () => {
    expect(only({ sessions: [session([rec()])] })[0]).toEqual({
      from: "E:\\桌面3\\报告.pdf",
      to: "E:\\桌面3\\文档\\报告.pdf",
      folder: "E:\\桌面3\\文档",
      madeFolder: true,
      done: true,
      at: 5
    });
  });

  it("没有盘符、带 .. 或整个是脏值的路径一律丢掉", () => {
    const bad = ["报告.pdf", "文档\\报告.pdf", "E:\\桌面3\\..\\Windows\\x.pdf", "", "C:\\Windows\\x.pdf", 3, null, {}];
    for (const v of bad) {
      expect(normalizeFold({ sessions: [session([rec({ to: v })])] }).sessions).toEqual([]);
      expect(normalizeFold({ sessions: [session([rec({ from: v })])] }).sessions).toEqual([]);
    }
  });

  it("目标不在它自己那个文件夹下面 = 账本不可信，丢掉", () => {
    const out = normalizeFold({
      sessions: [session([rec({ to: "E:\\桌面3\\其他\\报告.pdf", folder: "E:\\桌面3\\文档" })])]
    });
    expect(out.sessions).toEqual([]);
  });

  it("自己搬自己不记账，撤销时不会去动不该动的文件", () => {
    const same = "E:\\桌面3\\文档\\报告.pdf";
    expect(normalizeFold({ sessions: [session([rec({ from: same, to: same })])] }).sessions).toEqual([]);
    // 只有大小写不同也算同一个文件
    expect(normalizeFold({ sessions: [session([rec({ from: same, to: same.toUpperCase() })])] }).sessions).toEqual([]);
  });

  it("done / madeFolder 只认真 true，字符串与 1 都算 false", () => {
    for (const v of ["true", 1, "yes", null, undefined]) {
      const r = only({ sessions: [session([rec({ done: v, madeFolder: v })])] })[0];
      expect(r.done).toBe(false);
      expect(r.madeFolder).toBe(false);
    }
  });

  it("路径末尾的分隔符会被去掉，文件夹前缀比较大小写不敏感", () => {
    const r = only({
      sessions: [session([rec({ folder: "E:\\桌面3\\文档\\", to: "e:\\桌面3\\文档\\报告.pdf" })])]
    })[0];
    expect(r.folder).toBe("E:\\桌面3\\文档");
    expect(r.to).toBe("e:\\桌面3\\文档\\报告.pdf");
  });

  it("空会话与整个坏掉的存档都回落到干净结构", () => {
    expect(normalizeFold({ sessions: [session([])] })).toEqual({ version: 1, sessions: [] });
    for (const bad of [null, undefined, 3, "x", [], {}]) {
      expect(normalizeFold(bad)).toEqual({ version: 1, sessions: [] });
    }
  });

  it("会话只留最近 10 个，账本不会无限长", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `f-${i}`, at: i, records: [rec({ at: i })] }));
    const out = normalizeFold({ sessions: many });
    expect(out.sessions).toHaveLength(10);
    expect(out.sessions[9].id).toBe("f-24");
  });
});
