import { afterEach, describe, expect, it, vi } from "vitest";
import { Dog } from "../src/renderer/pet/state";
import type { CarryPoint } from "../src/renderer/pet/state";
import { headAnchor, mouthAnchor, dogBox, paramsFor, shapeNeedsReport } from "../src/renderer/pet/params";

/** 房间固定成 1000×600，食盆在右下 */
function makeDog(): Dog {
  const dog = new Dog();
  dog.room = { width: 1000, groundY: 560, bowlX: 940 };
  dog.setSize("adult");
  return dog;
}

function point(x: number, y: number, drop: boolean, name = `n${x}`): CarryPoint {
  return {
    x,
    y,
    fx: x,
    fy: y,
    color: "#4C86E0",
    category: "文档",
    drop,
    index: 0,
    name
  };
}

/** 把行为机推进 n 帧 */
function tick(dog: Dog, frames: number, dt = 1 / 60): void {
  for (let i = 0; i < frames; i++) dog.update(dt);
}

/** 推进到狗真的叼上某个图标为止，避免把帧数算成测试的一部分 */
function tickUntilCarried(dog: Dog, name: string, max = 3000): void {
  for (let i = 0; i < max; i++) {
    dog.update(1 / 60);
    if (dog.carriedName === name) return;
  }
  throw new Error(`推进 ${max} 帧仍未叼上 ${name}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Dog 行为机：帧内一致性", () => {
  it("update 返回的 Pose 位置必须等于狗的当前位置（否则命中区与画面对不上）", () => {
    const dog = makeDog();
    dog.dragTo(300, 560);
    dog.endDrag();
    dog.setRoam("chase", 100);
    dog.setCursor(900, 560); // 远处有鼠标，这一帧狗一定会迈步
    const pose = dog.update(1 / 60);
    expect(dog.canvasX).toBeGreaterThan(300);
    expect(pose.x).toBe(dog.canvasX);
    expect(pose.groundY).toBe(dog.anchorY);
  });

  it("翻面那一帧，Pose 与狗的实际朝向必须一致（否则头会甩慢半拍）", () => {
    const dog = makeDog();
    dog.dragTo(500, 560);
    dog.endDrag();
    dog.setFacing(1);
    dog.setRoam("wander", 380);
    dog.setCursor(100, 560); // 鼠标跑到左边远处
    const pose = dog.update(1 / 60);
    expect(dog.facing).toBe(-1);
    expect(pose.dir).toBe(-1);
  });

  it("被拎到任何位置都不会越出可达范围", () => {
    const dog = makeDog();
    dog.dragTo(999999, 999999);
    dog.endDrag();
    expect(dog.canvasX).toBeLessThanOrEqual(1000);
    expect(dog.anchorY).toBeLessThanOrEqual(560);
    dog.dragTo(-999999, -999999);
    dog.endDrag();
    expect(dog.anchorY).toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) {
      const pose = dog.update(1 / 60);
      expect(Number.isFinite(pose.x)).toBe(true);
      expect(Number.isFinite(pose.groundY)).toBe(true);
    }
  });

  it("被拎着时腿部摆动按真实帧长累加，高刷屏不会甩成 60Hz 的速度", () => {
    const dog = makeDog();
    dog.dragTo(300, 560);
    dog.beginDrag();
    dog.update(1 / 60);
    const a = dog.update(1 / 60).legPhase;
    const b = dog.update(1 / 60).legPhase;
    const step60 = b - a;
    const c = dog.update(1 / 144).legPhase;
    const step144 = c - b;
    // 帧长比 = 144Hz 分之一 vs 60Hz 分之一；写死固定帧长的话这两个增量会相等
    expect(step60).toBeGreaterThan(0);
    expect(step144 / step60).toBeCloseTo(60 / 144, 1);
  });
});

describe("Dog 行为机：搬运动画", () => {
  it("按路点顺序逐个报到，每个路点只报一次", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.dragTo(100, 560);
    dog.endDrag();
    const seen: string[] = [];
    dog.startCarry([point(300, 560, false, "grab1"), point(700, 300, true, "drop1")], (p) =>
      seen.push(p.name)
    );
    tick(dog, 900);
    expect(seen).toEqual(["grab1", "drop1"]);
    expect(dog.behavior).not.toBe("carry"); // 队列跑空要回待机
  });

  it("搬运途中被抚摸打断，之后必须自己接着搬完剩下的路点", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.dragTo(100, 560);
    dog.endDrag();
    const seen: string[] = [];
    dog.startCarry(
      [point(300, 560, false, "grab1"), point(700, 560, true, "drop1"), point(900, 200, true, "drop2")],
      (p) => seen.push(p.name)
    );
    tick(dog, 20); // 刚走几步
    expect(seen).toEqual([]);
    dog.pet(); // 用户点了一下狗身
    expect(dog.behavior).toBe("happy");
    tick(dog, 1800); // 摸完、待机计时到点
    expect(seen).toEqual(["grab1", "drop1", "drop2"]);
  });

  it("搬运途中开饭也不能丢下没搬完的图标", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.dragTo(100, 560);
    dog.endDrag();
    const seen: string[] = [];
    dog.startCarry([point(500, 560, false, "grab1"), point(800, 400, true, "drop1")], (p) =>
      seen.push(p.name)
    );
    tick(dog, 10);
    dog.startMeal(2); // 中途投喂
    tick(dog, 2400);
    expect(seen).toEqual(["grab1", "drop1"]);
  });

  it("贴右边边缘的路点不会把狗卡死：夹到可达范围内照样到位", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.dragTo(400, 560);
    dog.endDrag();
    const seen: string[] = [];
    // 目标 x=999 已超出狗能站到的位置（身体会顶出屏幕），旧实现会永远判不到位
    dog.startCarry([point(999, 560, true, "edge")], (p) => seen.push(p.name));
    tick(dog, 1200);
    expect(seen).toEqual(["edge"]);
  });

  it("走到图标处就算叼起来了，放下后嘴里才空", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.dragTo(100, 560);
    dog.endDrag();
    dog.startCarry([point(400, 560, false, "报告"), point(800, 560, true, "报告")], () => undefined);
    expect(dog.carriedName).toBeNull();
    tickUntilCarried(dog, "报告");
    expect(dog.carriedName).toBe("报告");
    tick(dog, 900); // 跑到区域放下
    expect(dog.carriedName).toBeNull();
  });

  it("叼着走的时候嘴是张着的（否则图标看着像飘在旁边）", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.dragTo(100, 560);
    dog.endDrag();
    dog.startCarry([point(900, 560, false, "照片"), point(400, 300, true, "照片")], () => undefined);
    tickUntilCarried(dog, "照片");
    let sawOpenMouth = false;
    for (let i = 0; i < 60; i++) {
      const pose = dog.update(1 / 60);
      if (pose.mouth > 0.5) sawOpenMouth = true;
    }
    expect(sawOpenMouth).toBe(true);
  });

  it("叼着的时候能报出它是哪一类、送往哪个区域（嘴上的假图标照这个画）", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.dragTo(100, 560);
    dog.endDrag();
    const grab: CarryPoint = {
      x: 400,
      y: 560,
      fx: 400,
      fy: 560,
      color: "#3BA776",
      category: "图片",
      drop: false,
      index: 7,
      name: "截图.png"
    };
    dog.startCarry([grab, { ...grab, x: 800, drop: true }], () => undefined);
    expect(dog.carriedCategory).toBeNull();
    tickUntilCarried(dog, "截图.png");
    expect(dog.carriedCategory).toBe("图片");
    expect(dog.carriedColor).toBe("#3BA776");
    tick(dog, 900); // 放下
    expect(dog.carriedCategory).toBeNull();
    expect(dog.carriedColor).toBeNull();
  });

  it("拎起来或叫回来时嘴里要立刻空掉，不能继续拖着图标", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.dragTo(100, 560);
    dog.endDrag();
    dog.startCarry([point(500, 560, false, "笔记"), point(900, 400, true, "笔记")], () => undefined);
    tickUntilCarried(dog, "笔记");
    dog.beginDrag();
    expect(dog.carriedName).toBeNull();

    dog.dragTo(100, 560);
    dog.endDrag();
    dog.startCarry([point(500, 560, false, "笔记"), point(900, 400, true, "笔记")], () => undefined);
    tickUntilCarried(dog, "笔记");
    dog.recall(); // 撤销整理会叫狗回来
    expect(dog.carriedName).toBeNull();
  });

  it("拎起狗会中止本轮搬运，松手后不会自己乱跑回队列", () => {
    const dog = makeDog();
    dog.dragTo(100, 560);
    dog.endDrag();
    const seen: string[] = [];
    dog.startCarry([point(800, 560, true, "drop1")], (p) => seen.push(p.name));
    dog.beginDrag();
    tick(dog, 300);
    expect(dog.behavior).toBe("drag");
    expect(seen).toEqual([]);
  });

  it("撤销整理后叫狗回来，没搬完的路点必须作废而不是继续空跑", () => {
    // 搬运期间命中区被放大到整块画布，队列不清空会让桌面在剩下那段时间里点不动
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.dragTo(100, 560);
    dog.endDrag();
    const seen: string[] = [];
    dog.startCarry([point(300, 560, false, "grab1"), point(700, 560, true, "drop1")], (p) =>
      seen.push(p.name)
    );
    tick(dog, 5);
    dog.recall();
    tick(dog, 1800);
    expect(seen).toEqual([]);
    expect(dog.behavior).not.toBe("carry");
  });
});

describe("狗嘴锚点", () => {
  it("嘴在头的前下方，且随朝向镜像", () => {
    const p = paramsFor("adult");
    const right = mouthAnchor(p, 500, 600, 1);
    const left = mouthAnchor(p, 500, 600, -1);
    const head = headAnchor(p, 500, 600, 1);
    expect(right.x).toBeGreaterThan(head.x); // 比头中心更靠前
    expect(right.y).toBeGreaterThan(head.y); // 画布 y 向下：嘴在头下方
    expect(right.x - 500).toBeCloseTo(500 - left.x, 6); // 左右镜像
    expect(right.y).toBe(left.y);
  });
});

describe("Dog 行为机：漫游与状态", () => {
  it("追鼠标追到保持距离外就待机，不会贴到鼠标上", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.dragTo(100, 560);
    dog.endDrag();
    dog.setRoam("chase", 380);
    dog.setCursor(900, 560);
    tick(dog, 600);
    expect(dog.canvasX).toBeGreaterThan(100); // 确实追过去了
    expect(Math.abs(dog.canvasX - 900)).toBeGreaterThanOrEqual(360); // 但停在保持距离外
    // 停下后不再继续逼近：原地小动作（喘气/待机）不会改变脚底位置
    const parked = dog.canvasX;
    tick(dog, 300);
    expect(dog.behavior).not.toBe("run");
    expect(dog.canvasX).toBeCloseTo(parked, 5);
  });

  it("蹲点模式不依赖鼠标位置，启动就能自己跑去右下角", () => {
    const dog = makeDog();
    dog.dragTo(200, 300);
    dog.endDrag();
    dog.setRoam("stay", 380);
    tick(dog, 900);
    expect(dog.canvasX).toBeCloseTo(940 - 120, 0);
    expect(dog.anchorY).toBe(560);
  });

  it("躲鼠标不会靠过去", () => {
    const dog = makeDog();
    dog.dragTo(500, 560);
    dog.endDrag();
    dog.setRoam("flee", 380);
    dog.setCursor(520, 560);
    const before = dog.canvasX;
    tick(dog, 120);
    expect(dog.canvasX).toBeLessThan(before);
  });

  it("鼠标停在狗身上时冻结朝向，头不会跟着转", () => {
    // 松手后待机只计时 0.4 秒，到点就随机挑小动作；「转圈」那一档自己会翻面，
    // 会把这条测试十次里撞坏两三次。钉成 0.95 = 打哈欠（原地动作，不改朝向），
    // 手法与本文件末尾的转圈测试一致。
    const real = Math.random;
    Math.random = () => 0.95;
    try {
      const dog = makeDog();
      dog.dragTo(500, 560);
      dog.endDrag();
      dog.setFacing(1);
      dog.setCursor(505, 560); // 就在狗身上
      tick(dog, 30);
      expect(dog.facing).toBe(1);
      dog.setCursor(20, 560); // 走远了才允许翻面
      tick(dog, 30);
      expect(dog.facing).toBe(-1);
    } finally {
      Math.random = real;
    }
  });

  it("抚摸动画结束后一定回待机，不会卡在 happy", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const dog = makeDog();
    dog.setRoam("wander", 380);
    dog.pet();
    expect(dog.behavior).toBe("happy");
    tick(dog, 300);
    expect(dog.behavior).not.toBe("happy");
  });
});

describe("朝向相关的两处坑", () => {
  /** 把随机池钉死成「下一次待机动作 = 转圈」，别的都不动 */
  function forceSpin(): void {
    Math.random = () => 0.8;
  }

  it("转圈一圈最多翻两次面，而且转回原来那面（一秒翻 9 次看着像画面故障）", () => {
    const real = Math.random;
    try {
      forceSpin();
      const dog = new Dog();
      dog.room = { width: 1920, groundY: 1040, bowlX: 1800 };
      dog.setSize("adult");
      dog.setRoam("wander", 380);

      let flips = 0;
      let episodes = 0;
      let inSpin = false;
      let spinStartDir = dog.facing;
      let last = dog.facing;
      let lastSpinDir = dog.facing;
      for (let i = 0; i < 60 * 30; i++) {
        dog.update(1 / 60);
        const spinning = dog.behavior === "spin";
        if (spinning && !inSpin) {
          episodes += 1;
          spinStartDir = dog.facing;
        }
        if (spinning) lastSpinDir = dog.facing;
        if (spinning && dog.facing !== last) flips += 1;
        if (!spinning && inSpin) {
          // 一整圈下来必须回到出发时那面
          expect(lastSpinDir).toBe(spinStartDir);
        }
        inSpin = spinning;
        last = dog.facing;
      }
      expect(episodes).toBeGreaterThan(2);
      // 30 秒里三轮多转圈，每轮 2 次翻面：总数应该个位数，而不是原来的一百多次
      expect(flips).toBeLessThanOrEqual(episodes * 2);
    } finally {
      Math.random = real;
    }
  });

  it("身体两侧宽度差几十像素，所以掉头那一帧必须重报命中区", () => {
    const p = paramsFor("adult");
    const right = dogBox(p, 500, 900, 1, 0);
    const left = dogBox(p, 500, 900, -1, 0);
    const front = right.right - 500; // 头那一侧伸出去多宽
    const back = 500 - right.left; // 屁股那一侧伸出去多宽
    expect(front - back).toBeGreaterThan(40);
    // 区域还留在旧朝向时，掉头后头那一侧有 (front - back) 那么宽落在窗口区域外，被直接裁掉
    expect(right.left - left.left).toBeCloseTo(front - back, 6);
    // 28px 的 padding 补不满这个差，所以只能靠「掉头立刻重报」
    expect(front - back).toBeGreaterThan(28);
  });

  it("命中区迟滞：原地不动不重报，走出一大步重报，原地掉头立刻重报", () => {
    const prev = { x: 500, y: 900, dir: 1 as const };
    expect(shapeNeedsReport(null, prev)).toBe(true);
    expect(shapeNeedsReport(prev, { x: 500, y: 900, dir: 1 })).toBe(false);
    expect(shapeNeedsReport(prev, { x: 512, y: 906, dir: 1 })).toBe(false);
    expect(shapeNeedsReport(prev, { x: 530, y: 900, dir: 1 })).toBe(true);
    expect(shapeNeedsReport(prev, { x: 500, y: 900, dir: -1 })).toBe(true);
    expect(shapeNeedsReport(prev, { x: 495, y: 905, dir: -1 })).toBe(true);
  });
});
