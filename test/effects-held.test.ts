import { describe, expect, it } from "vitest";
import { Effects } from "../src/renderer/pet/effects";

/**
 * Effects 只用到 CanvasRenderingContext2D 的几个方法，node 下没有真画布，
 * 用替身记下「调了哪个方法、最后一次传了什么」，就能验证画没画、画多大、脏区报了什么。
 */
interface Stub {
  ctx: CanvasRenderingContext2D;
  /** 方法名 → 调用次数 */
  calls: Map<string, number>;
  /** 方法名 → 最后一次调用的参数 */
  last: Map<string, unknown[]>;
}

function stubCtx(): Stub {
  const calls = new Map<string, number>();
  const last = new Map<string, unknown[]>();
  const target: Record<string, unknown> = { globalAlpha: 1 };
  const handler: ProxyHandler<object> = {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        calls.set(prop, (calls.get(prop) ?? 0) + 1);
        last.set(prop, args);
      };
    },
    set(t, prop: string, value: unknown) {
      t[prop] = value;
      return true;
    }
  };
  return { ctx: new Proxy(target, handler) as unknown as CanvasRenderingContext2D, calls, last };
}

/** 纸上那条圆角矩形框的宽度 = 这一帧假图标画了多大 */
function drawnWidth(s: Stub): number {
  return Number(s.last.get("roundRect")?.[2] ?? NaN);
}

const DOG = { category: "图片", color: "#3BA776" };
const SIZE = 20;

describe("狗嘴上的假图标", () => {
  it("没主进程点头就不会出现", () => {
    const fx = new Effects();
    const s = stubCtx();
    expect(fx.holding).toBe(false);
    fx.drawHeld(s.ctx, 100, 100, 1, SIZE);
    expect(s.calls.get("roundRect") ?? 0).toBe(0);
    expect(fx.heldDirty()).toBeNull();
  });

  it("叼上之后才画，且脏区把图标外围整个包住（否则残影擦不掉）", () => {
    const fx = new Effects();
    const s = stubCtx();
    fx.setHeld(DOG);
    expect(fx.holding).toBe(true);
    fx.update(1 / 60);
    fx.drawHeld(s.ctx, 300, 200, 1, SIZE);
    expect(s.calls.get("roundRect") ?? 0).toBeGreaterThan(0);
    const rect = fx.heldDirty();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeLessThan(300);
    expect(rect!.x + rect!.w).toBeGreaterThan(300);
    expect(rect!.y).toBeLessThan(200);
    expect(rect!.y + rect!.h).toBeGreaterThan(200);
  });

  it("刚咬住时是弹出来的：先小后大，而不是一下子显形", () => {
    const fx = new Effects();
    const s = stubCtx();
    fx.setHeld(DOG);
    fx.drawHeld(s.ctx, 300, 200, 1, SIZE);
    const start = drawnWidth(s);
    for (let i = 0; i < 12; i++) {
      fx.update(1 / 60);
      fx.drawHeld(s.ctx, 300, 200, 1, SIZE);
    }
    const grown = drawnWidth(s);
    expect(start).toBeGreaterThan(0);
    expect(grown).toBeGreaterThan(start);
  });

  it("放下后先把缩没的那一小段画完，才把脏区交还", () => {
    const fx = new Effects();
    const s = stubCtx();
    fx.setHeld(DOG);
    fx.update(0.5);
    fx.drawHeld(s.ctx, 300, 200, 1, SIZE);
    const full = drawnWidth(s);

    fx.releaseHeld();
    expect(fx.holding).toBe(true); // 正在缩没，还在画
    fx.update(0.05);
    fx.drawHeld(s.ctx, 300, 200, 1, SIZE);
    expect(fx.heldDirty()).not.toBeNull(); // 这一帧仍要清掉上一帧的框
    expect(drawnWidth(s)).toBeLessThan(full);

    fx.update(0.2); // 超过缩没时长
    expect(fx.holding).toBe(false);
    fx.drawHeld(s.ctx, 300, 200, 1, SIZE);
    expect(fx.heldDirty()).toBeNull(); // 最后一帧报的就是残留框，之后必须清空
  });

  it("狗一路跑着叼完再放下，脏区不会越攒越大", () => {
    const fx = new Effects();
    const s = stubCtx();
    fx.setHeld(DOG);
    for (let i = 0; i < 30; i++) {
      fx.update(1 / 60);
      fx.drawHeld(s.ctx, 100 + i * 8, 200, 1, SIZE); // 狗一路往右跑
    }
    fx.releaseHeld();
    for (let i = 0; i < 20; i++) {
      fx.update(1 / 60);
      fx.drawHeld(s.ctx, 400, 200, 1, SIZE);
    }
    expect(fx.heldDirty()).toBeNull();
    expect(fx.dirty()).toBeNull(); // 粒子那套也没被牵连，狗停下时能回到只清一小块
  });

  it("连续叼第二个文件会重新弹一次，不接着上一个的进度", () => {
    const fx = new Effects();
    const s = stubCtx();
    fx.setHeld(DOG);
    for (let i = 0; i < 12; i++) {
      fx.update(1 / 60);
      fx.drawHeld(s.ctx, 300, 200, 1, SIZE);
    }
    const done = drawnWidth(s);
    fx.setHeld({ category: "文档", color: "#4C86E0" });
    fx.drawHeld(s.ctx, 300, 200, 1, SIZE);
    expect(drawnWidth(s)).toBeLessThan(done);
  });
});
