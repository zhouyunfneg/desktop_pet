import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_NEWS, pickNews, type NewsRound } from "../src/shared/news";

const ITEMS = ["A 一条", "B 两条", "C 三条", "D 四条"];
const D = "2026-10-21";

/** 让随机变成「按顺序取」，好把轮播逻辑钉死 */
function sequential(): void {
  let n = 0;
  vi.spyOn(Math, "random").mockImplementation(() => (n++ % 97) / 97);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pickNews：一天那批里每条只播一次", () => {
  it("第一次点（没有任何记录）能挑到一条，并把它记进本轮", () => {
    sequential();
    const r = pickNews(ITEMS, D, null);
    expect(r).not.toBeNull();
    expect(ITEMS).toContain(r!.text);
    expect(r!.round.played).toEqual([r!.text]);
    expect(r!.total).toBe(4);
    expect(r!.left).toBe(3);
    expect(r!.wrapped).toBe(false);
  });

  it("已经播过的不会再播", () => {
    const round: NewsRound = { date: D, played: ["A 一条", "B 两条"] };
    for (let i = 0; i < 12; i++) {
      vi.spyOn(Math, "random").mockImplementation(() => i / 12);
      const r = pickNews(ITEMS, D, round);
      expect(["A 一条", "B 两条"]).not.toContain(r!.text);
    }
  });

  it("连着点四次把当天播完，第五次开新一轮并说明是新一轮", () => {
    sequential();
    let round: NewsRound | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = pickNews(ITEMS, D, round)!;
      round = r.round;
      seen.push(r.text);
      expect(r.wrapped).toBe(false);
      expect(r.left).toBe(3 - i);
    }
    // 四条各不相同 = 一轮里不会重复
    expect(new Set(seen).size).toBe(4);
    expect(round!.played.length).toBe(4);
    const next = pickNews(ITEMS, D, round)!;
    expect(next.wrapped).toBe(true);
    expect(next.round.played).toEqual([next.text]);
    expect(next.left).toBe(3);
  });

  it("换天了（源每天更新一次）旧的已播记录作废", () => {
    sequential();
    const yesterday: NewsRound = { date: "2026-10-20", played: [...ITEMS] };
    const r = pickNews(ITEMS, D, yesterday)!;
    expect(r.wrapped).toBe(false);
    expect(r.total).toBe(4);
    expect(r.round.date).toBe(D);
  });

  it("接口挂了就返回 null，渲染层据此什么都不播", () => {
    expect(pickNews([], D, null)).toBeNull();
    expect(pickNews(["", ""], D, null)).toBeNull();
    expect(pickNews([undefined as unknown as string], D, null)).toBeNull();
    expect(NO_NEWS.text).toBe("");
  });

  it("记录里混着已经不在今天这批里的旧条目，不会被算进名额", () => {
    const round: NewsRound = { date: D, played: ["昨天的老新闻", "A 一条"] };
    const r = pickNews(ITEMS, D, round)!;
    expect(r.text).not.toBe("A 一条");
    expect(r.round.played).toContain("A 一条");
    expect(r.total).toBe(4);
  });
});
