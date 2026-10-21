import { describe, expect, it } from "vitest";
import { Effects } from "../src/renderer/pet/effects";

/**
 * 气泡折行的单测。node 下没有真画布，用替身：
 * measureText 按「中文 14px / 其他 7px」估宽（和真实 13px 雅黑的比例接近），
 * 其余方法只记下调用次数与参数。
 */
function stub() {
  const calls: Record<string, unknown[][]> = {};
  const target: Record<string, unknown> = {
    globalAlpha: 1,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textAlign: "",
    textBaseline: "",
    measureText: (t: string) => {
      let w = 0;
      for (const ch of t) w += /[\u3000-\u9fff\u{ff00}-\u{ffef}]/u.test(ch) ? 14 : 7;
      return { width: w };
    }
  };
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        (calls[prop] ||= []).push(args);
      };
    },
    set(t, prop: string, value: unknown) {
      t[prop] = value;
      return true;
    }
  }) as unknown as CanvasRenderingContext2D;
  return { fx: new Effects(), ctx, calls };
}

/** 纸上那条圆角矩形框 = 气泡板子真正占的位置（脏区还会多包住尾巴） */
function panel(s: { calls: Record<string, unknown[][]> }): [number, number, number, number] {
  const a = s.calls.roundRect?.[0] ?? [];
  return [Number(a[0]), Number(a[1]), Number(a[2]), Number(a[3])];
}

/** 长句子：以前那种报天气的写法、现在每小时那条新闻，都得折成两行 */
const LONG = "🌫 16~24℃ · Smoky haze · 湿度44% · 风19km/h · 紫外线1 · 降水0mm";
const SHORT = "汪！";

describe("气泡折行：长句子不许横着盖住动画", () => {
  it("短句保持一行", () => {
    const s = stub();
    s.fx.say(SHORT);
    s.fx.drawBubble(s.ctx, 400, 200);
    expect(s.calls.fillText?.length).toBe(1);
    expect(s.calls.fillText?.[0]?.[0]).toBe(SHORT);
    const box = s.fx.bubbleDirty();
    expect(box?.h).toBeLessThanOrEqual(36);
    expect(box?.w).toBeLessThanOrEqual(120);
  });

  it("头顶那种长句（新闻）最多三行、宽不超 322，一整条新闻不被截掉", () => {
    const s = stub();
    s.fx.say(LONG);
    s.fx.drawBubble(s.ctx, 400, 200);
    const lines = (s.calls.fillText ?? []).map((a) => String(a[0]));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    // 头顶的额度比嘴前方大，就是为了整条新闻能说完
    expect(lines.join("").replace("…", "")).toContain("Smoky");
    expect(lines.join("").includes("降水0mm")).toBe(true);
    const box = s.fx.bubbleDirty();
    expect(box!.w).toBeLessThanOrEqual(322);
    expect(box!.h).toBeGreaterThan(48);
    // 后一行画在前一行下面，不是叠在一起
    expect(Number(s.calls.fillText![1][2])).toBeGreaterThan(Number(s.calls.fillText![0][2]));
  });

  it("三行额度也用不完时，最后一行截断加省略号，绝不折出第四行", () => {
    const s = stub();
    // 100 个中文字 ≈ 1400px，头顶三行只有 960px 额度，必然要说不完
    s.fx.say("提".repeat(100));
    s.fx.drawBubble(s.ctx, 400, 200);
    const lines = (s.calls.fillText ?? []).map((a) => String(a[0]));
    expect(lines.length).toBe(3);
    expect(lines[2].endsWith("…")).toBe(true);
    expect(s.fx.bubbleDirty()!.w).toBeLessThanOrEqual(322);
  });

  it("中间那行不会因为第一行没占满而被截掉（会整体重排行宽）", () => {
    const s = stub();
    // 前半句很短、后半句很长且没有可断的标点：贪心装箱会把第一行留得很空
    s.fx.say("提醒：你已经坐了两个小时了该起来走两步了顺便给眼睛放个假啊继续坐着腰会坏掉啊");
    s.fx.drawBubble(s.ctx, 400, 200);
    const lines = (s.calls.fillText ?? []).map((a) => String(a[0]));
    expect(lines.length).toBeLessThanOrEqual(3);
    // 一整句都在，没有被省略号吃掉
    expect(lines.join("").endsWith("假")).toBe(false);
    expect(lines.join("").replace("…", "").length).toBe("提醒：你已经坐了两个小时了该起来走两步了顺便给眼睛放个假啊继续坐着腰会坏掉啊".length);
    expect(lines.some((l) => l.includes("…"))).toBe(false);
  });

  it("嘴前方那种最多两行、面板宽不超 236：天气短句一行就够，长一点也不许撑宽", () => {
    const s = stub();
    s.fx.say(LONG, 4.5, "front");
    s.fx.drawBubble(s.ctx, 400, 200, 1);
    const lines = (s.calls.fillText ?? []).map((a) => String(a[0]));
    expect(lines.length).toBe(2);
    const [px, , pw] = panel(s);
    expect(pw).toBeLessThanOrEqual(236);
    // 脏区还要多包住朝内的尾巴，所以比面板宽一点
    expect(s.fx.bubbleDirty()!.w).toBeLessThanOrEqual(pw + 10);
    expect(s.fx.bubbleDirty()!.x).toBeLessThanOrEqual(px);
  });

  it("整句一个标点都没有，也按等长分行、不把后半句整个丢掉", () => {
    const s = stub();
    const text = "坐下太久了起来走两步吧顺便给眼睛放个假啊顺便活动一下肩膀";
    s.fx.say(text, 4.5, "front");
    s.fx.drawBubble(s.ctx, 400, 200, 1);
    const lines = (s.calls.fillText ?? []).map((a) => String(a[0]));
    expect(lines.length).toBe(2);
    expect(lines[0].length).toBeGreaterThan(6);
    expect(lines[1].length).toBeGreaterThan(6);
    // 两行尽量一样长，不是「一行十几个字、另一行剩四个字」
    expect(Math.abs(lines[0].length - lines[1].length)).toBeLessThanOrEqual(2);
    expect(lines.map((l) => l.replace("…", "")).join("").length).toBe(text.length);
  });

  it("命中区估算跟着折行走：头顶不超过 330、嘴前方不超过 254，不会报出半屏宽的框", () => {
    const s = stub();
    s.fx.say(LONG);
    const above = s.fx.bubbleRect(400, 200)!;
    // 320 的折行上限 + 描边外扩
    expect(above.w).toBeLessThanOrEqual(330);
    expect(above.h).toBeGreaterThan(40); // 三行里至少占两行 + 尾巴
    const s2 = stub();
    s2.fx.say(LONG, 4.5, "front");
    const front = s2.fx.bubbleRect(400, 200, 1)!;
    // 236 的上限 + 外扩 + 朝内的尾巴
    expect(front.w).toBeLessThanOrEqual(254);
  });

  it("气泡从锚点往上长，尾巴尖还是指着那个点（改位置靠锚点，不靠画死的坐标）", () => {
    const s = stub();
    s.fx.say(LONG);
    s.fx.drawBubble(s.ctx, 400, 200);
    const box = s.fx.bubbleDirty()!;
    expect(box.y + box.h).toBeLessThanOrEqual(200 + 9);
    expect(box.y).toBeLessThan(200 - 40);
  });

  it("报天气那句标成「嘴前方」，其他话照旧在头顶", () => {
    const s = stub();
    expect(s.fx.bubblePlace).toBe("above");
    s.fx.say("汪！");
    expect(s.fx.bubblePlace).toBe("above");
    s.fx.say("🌫 现在 18℃ · 薄雾", 4.5, "front");
    expect(s.fx.bubblePlace).toBe("front");
  });

  it("嘴前方：狗朝右就画在右边、竖直居中在嘴上，尾巴朝内", () => {
    const s = stub();
    s.fx.say("🌫 现在 18℃ · 雾霾", 4.5, "front");
    s.fx.drawBubble(s.ctx, 400, 200, 1);
    const [px, py, pw, ph] = panel(s);
    // 板子左边正好从嘴前方 16px 起，不压狗头也不压狗嘴
    expect(px).toBe(416);
    // 竖直方向以嘴为中心，而不是从嘴往上顶
    expect(Math.abs(py + ph / 2 - 200)).toBeLessThanOrEqual(1);
    expect(py).toBeLessThan(200);
    expect(py + ph).toBeGreaterThan(200);
    // 文字画在板子中间（锚点在狗嘴里，画在锚点上就糊狗脸上了）
    expect(Number(s.calls.fillText![0][1])).toBeCloseTo(px + pw / 2, 0);
    // 脏区比板子多包住朝内的尾巴，否则残留擦不掉
    const box = s.fx.bubbleDirty()!;
    expect(box.x).toBeLessThan(px);
    expect(box.x + box.w).toBeGreaterThanOrEqual(px + pw);
  });

  it("嘴前方：狗朝左就整个镜像到左边", () => {
    const s = stub();
    s.fx.say("🌫 现在 18℃ · 雾霾", 4.5, "front");
    s.fx.drawBubble(s.ctx, 400, 200, -1);
    const [px, , pw] = panel(s);
    expect(px + pw).toBe(384); // 400 - 16
    expect(Number(s.calls.fillText![0][1])).toBeLessThan(400);
  });

  it("头顶那种气泡忽略 side，不会被人误传到狗嘴里", () => {
    const s = stub();
    s.fx.say("汪！");
    s.fx.drawBubble(s.ctx, 400, 200, 1);
    const box = s.fx.bubbleDirty()!;
    expect(box.x).toBeLessThan(400);
    expect(box.x + box.w).toBeGreaterThan(400);
    expect(box.y + box.h).toBeLessThanOrEqual(209);
  });

  it("命中区估算和真实画的框对得上（对不上就会被窗口形状裁掉）", () => {
    const s = stub();
    s.fx.say("🌫 现在 18℃ · 雾霾", 4.5, "front");
    const est = s.fx.bubbleRect(400, 200, 1)!;
    s.fx.drawBubble(s.ctx, 400, 200, 1);
    const real = s.fx.bubbleDirty()!;
    expect(est.x).toBeLessThanOrEqual(real.x);
    // 估算宁宽勿窄：右边和竖直方向都要多包住一点，不然句尾或描边被裁
    expect(est.x + est.w).toBeGreaterThanOrEqual(real.x + real.w);
    expect(est.y).toBeLessThanOrEqual(real.y);
    expect(est.y + est.h).toBeGreaterThanOrEqual(real.y + real.h);
    // 朝左那侧镜像后同样对得上
    const s2 = stub();
    s2.fx.say("🌫 现在 18℃ · 雾霾", 4.5, "front");
    const est2 = s2.fx.bubbleRect(400, 200, -1)!;
    s2.fx.drawBubble(s2.ctx, 400, 200, -1);
    const real2 = s2.fx.bubbleDirty()!;
    expect(est2.x).toBeLessThanOrEqual(real2.x);
    expect(est2.x + est2.w).toBeGreaterThanOrEqual(real2.x + real2.w);
  });
});
