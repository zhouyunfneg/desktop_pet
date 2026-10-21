import type { WeatherMood } from "../../shared/weather";
import { MOOD_SECONDS } from "../../shared/weather";
import type { Pose } from "./pose";

/**
 * 天气效果层：点狗头查到天气之后播一次，几秒后自己停。
 *
 * 刻意做成「一次性」而不是常驻：狗的日常动画归状态机管，天气只借用这几秒改改姿态数字、
 * 撒一点粒子，不新增状态、不打断追鼠标/搬运/吃饭。
 * 接线方式见 src/renderer/main.ts：dog.update() 拿到姿态 → pose() 打补丁 → 画完狗再 draw()。
 *
 * 两个必须跟着走的约束：
 * 1. 粒子层自己报脏区（dirty()），否则雨丝雪花消失后会留残影 —— 这是气泡先踩过的坑；
 * 2. 这一框还要交给命中区（hotRects），因为窗口形状是 SetWindowRgn 裁的，
 *    不在形状里的像素直接画不出来（雨丝会被切成狗框那么宽的一条）。
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  tone: "water" | "snow" | "puff" | "spark" | "dust" | "steam" | "cloud";
}

/** 效果范围：以脚底为中心向外扩这些像素（雨丝、雪、风线都在这框里） */
const PAD_X = 120;
const PAD_UP = 150;

export class WeatherFx {
  private mood: WeatherMood = "other";
  private left = 0;
  private dur = 0;
  private t = 0;
  /** 本帧开始前的累计秒数：every() 用它判断有没有跨过触发点，不能按固定 1/60 算（高刷屏会漏撒或重撒） */
  private t0 = 0;
  private parts: Particle[] = [];
  /** 本帧要画的范围（跟着脚底走） */
  private box: Box = { x: 0, y: 0, w: 0, h: 0 };
  /** 上一帧真正画过的范围：狗走动了或效果刚停，靠它把旧位置的雨丝雪片擦干净 */
  private lastDrawn: Box | null = null;

  get active(): boolean {
    return this.left > 0;
  }

  /** 同一次点击只保留最后一次；重复点不会把粒子堆爆 */
  start(mood: WeatherMood): void {
    this.mood = mood;
    this.dur = MOOD_SECONDS[mood] ?? 2.2;
    this.left = this.dur;
    this.t = 0;
    this.t0 = 0;
    this.parts.length = 0;
  }

  stop(): void {
    this.left = 0;
    this.parts.length = 0;
  }

  /** anchor = 头的位置（嘴、耳朵的粒子从这儿出），foot = 脚底（水洼、雪堆从这儿出） */
  update(dt: number, anchor: { x: number; y: number }, foot: { x: number; y: number }, facing: 1 | -1): void {
    if (this.left <= 0) return;
    this.t0 = this.t;
    this.left -= dt;
    this.t += dt;
    this.box = { x: foot.x - PAD_X, y: foot.y - PAD_UP, w: PAD_X * 2, h: PAD_UP + 24 };
    if (this.left <= 0) {
      this.parts.length = 0;
      return;
    }
    const back = { x: foot.x - facing * 26, y: foot.y - 96 };

    if (this.mood === "rain" && this.every(1.2)) {
      for (let i = 0; i < 7; i++) {
        this.push(foot.x + facing * 34, foot.y - 78, facing * (60 + Math.random() * 110), -70 - Math.random() * 70, 0.6, 1.7, "water");
      }
    }
    if (this.mood === "snow" && this.every(0.5)) {
      // 背上落雪：落在背线附近，抖的时候被甩掉
      this.push(back.x + (Math.random() - 0.5) * 60, back.y - Math.random() * 12, 0, 0, 1.6, 1.9, "snow");
    }
    if (this.mood === "snow" && this.every(1.7)) {
      for (const p of this.parts) if (p.tone === "snow" && p.life > 0.6) p.vy = -60 - Math.random() * 40;
    }
    if (this.mood === "cold" && this.every(1.1)) {
      // 一口一口白气：一次三团、越飘越大，单团在浅色桌布上根本看不见
      for (let i = 0; i < 3; i++) {
        this.push(anchor.x + facing * (26 + i * 5), anchor.y + 6 - i * 3, facing * (24 + i * 8), -20 - i * 6, 1.2, 4 + i, "puff");
      }
    }
    if (this.mood === "haze" && this.every(0.55)) {
      // 灰黄的尘粒从鼻子前面飘出去 + 空气中一直在浮尘
      for (let i = 0; i < 3; i++) {
        this.push(anchor.x + facing * 30, anchor.y + 4, facing * (18 + Math.random() * 26), -14 - Math.random() * 12, 1.3, 3 + Math.random() * 2, "dust");
      }
      this.push(foot.x + (Math.random() - 0.5) * 200, foot.y - 30 - Math.random() * 110, (Math.random() - 0.5) * 12, -6, 1.8, 2.2, "dust");
    }
    if (this.mood === "clear" && this.every(0.35)) {
      for (let i = 0; i < 4; i++) {
        this.push(anchor.x + facing * (10 + Math.random() * 70), anchor.y - 14 - Math.random() * 52, 0, -14, 0.8, 2.6, "spark");
      }
    }
    if (this.mood === "heat" && this.every(0.7)) {
      // 汗珠/晒出来的水汽从脑袋上方往上冒
      for (let i = 0; i < 2; i++) this.push(anchor.x + facing * 20, anchor.y - 24, (Math.random() - 0.5) * 16, -34, 1.0, 2.4, "steam");
    }
    if (this.mood === "other" && this.every(0.9)) {
      // 阴天 / 多云：头顶飘一朵小云，不然这一档只有狗自己动，太容易以为没触发
      for (let i = 0; i < 2; i++) this.push(foot.x + (Math.random() - 0.5) * 120, foot.y - 130 - Math.random() * 20, facing * 14, -4, 1.5, 8 + Math.random() * 5, "cloud");
    }
    if (this.mood === "thunder" && this.t < 0.12) {
      for (let i = 0; i < 5; i++) this.push(foot.x, foot.y - 110, (Math.random() - 0.5) * 160, -40 * Math.random(), 0.5, 2, "spark");
    }

    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.tone === "water") p.vy += 320 * dt;
      if (p.tone === "puff" || p.tone === "cloud" || p.tone === "dust") {
        p.vx *= 0.97;
        p.r += 6 * dt;
      }
      if (p.tone === "snow" && p.vy > 0) p.vy = 6;
      if (p.life <= 0) this.parts.splice(i, 1);
    }
  }

  /** 给这一帧的姿态打补丁：只动数字，不碰状态机 */
  pose(p: Pose): void {
    if (this.left <= 0) return;
    const t = this.t;
    switch (this.mood) {
      case "rain": {
        const shake = this.pulse(1.2, 0.42);
        p.lean = Math.max(Math.abs(p.lean), 0) + Math.sin(shake.k * Math.PI * 7) * 0.13 * shake.on;
        p.headTilt = Math.sin(t * Math.PI * 9) * 0.16 * shake.on;
        p.mouth = Math.max(p.mouth, 0.35);
        p.tailLift = Math.max(p.tailLift, 0.5 + shake.on * 0.5);
        p.earPerk = Math.min(p.earPerk, -0.15);
        break;
      }
      case "snow": {
        const shake = this.pulse(1.7, 0.35);
        p.lean = Math.sin(shake.k * Math.PI * 8) * 0.1 * shake.on;
        p.headTilt = Math.sin(shake.k * Math.PI * 8) * 0.16 * shake.on;
        p.earPerk = Math.min(p.earPerk, -0.2);
        p.tailLift = Math.max(p.tailLift, 0.4);
        break;
      }
      case "haze": {
        p.blink = Math.max(p.blink, 0.45); // 眯眼：借用眨眼停在半闭
        const cough = this.pulse(3.2, 0.5);
        p.mouth = Math.max(p.mouth, cough.on * cough.k);
        p.headDip = Math.max(p.headDip, cough.on * cough.k * 0.3);
        break;
      }
      case "wind": {
        const gust = this.pulse(2.2, 0.9);
        p.earPerk = Math.min(p.earPerk, -0.5 - gust.on * 0.4);
        p.lean = Math.min(p.lean, -0.05 - gust.on * 0.1);
        p.tailSwing = Math.sin(t * Math.PI * 4.4) * (0.5 + gust.on * 0.5);
        p.breath = Math.sin(t * Math.PI * 1.6) * (1 + gust.on);
        break;
      }
      case "heat": {
        p.mouth = 1;
        p.tongue = 0.45 + 0.55 * Math.abs(Math.sin(t * Math.PI * 5.2));
        p.breath = Math.sin(t * Math.PI * 3.2);
        p.headLift = Math.min(p.headLift, -2);
        p.tailLift = Math.max(p.tailLift, 0.5);
        break;
      }
      case "cold": {
        p.squash = Math.max(p.squash, 0.25);
        // 发抖幅度要够：0.8 的抖在屏幕上不到一个像素，看着像没动
        p.bob = Math.sin(t * Math.PI * 14) * 2.6;
        p.headTilt = Math.sin(t * Math.PI * 14) * 0.05;
        p.headLift = Math.min(p.headLift, -1);
        p.tailLift = Math.min(p.tailLift, 0.12);
        p.earPerk = Math.min(p.earPerk, -0.25);
        break;
      }
      case "thunder": {
        const jump = t < 0.9 ? 1 - t / 0.9 : 0;
        p.earPerk = Math.max(p.earPerk, jump);
        p.squash = Math.max(p.squash, jump * 0.35);
        p.bob = Math.min(p.bob, -jump * 9);
        p.tailLift = Math.min(p.tailLift, 0.05); // 夹尾巴
        p.headLift = Math.max(p.headLift, jump * 3);
        break;
      }
      case "clear": {
        p.tailLift = Math.max(p.tailLift, 0.9);
        p.tailSwing = Math.sin(t * Math.PI * 7) * 0.95;
        p.earPerk = Math.max(p.earPerk, 0.5);
        p.headLift = Math.max(p.headLift, 2);
        break;
      }
      default: {
        p.headLift = Math.max(p.headLift, 2.5 * Math.sin(Math.min(1, t) * Math.PI));
        p.tailSwing = Math.sin(t * Math.PI * 3) * 0.6;
      }
    }
  }

  /** 雨丝 / 雪 / 风线 / 闪光 / 水洼这些“环境层”，画在狗之后、气泡之前（气泡要压在雨上才读得清） */
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.left <= 0) return;
    const { x, y, w, h } = this.box;
    const t = this.t;
    this.lastDrawn = { ...this.box };

    if (this.mood === "rain") {
      ctx.strokeStyle = "rgba(190,215,240,.5)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 26; i++) {
        const px = x + ((i * 41 + t * 210) % w);
        const py = y + ((i * 67 + t * 430) % h);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - 5, py + 13);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(120,150,180,.3)";
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h - 14, 46, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 2; i++) {
        const p = (t * 1.1 + i / 2) % 1;
        ctx.strokeStyle = `rgba(220,235,250,${(1 - p) * 0.45})`;
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h - 14, 5 + p * 24, (5 + p * 24) * 0.18, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (this.mood === "snow") {
      for (let i = 0; i < 22; i++) {
        const px = x + ((i * 57 + Math.sin(t * 0.9 + i) * 20 + t * 20) % w);
        const py = y + ((i * 43 + t * 52) % h);
        ctx.fillStyle = "rgba(255,255,255,.85)";
        ctx.beginPath();
        ctx.arc(px, py, 1.6 + (i % 3) * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (this.mood === "haze") {
      // 整个框先蒙一层灰黄，再压三条会缓慢游动的浓一点雾带：
      // 只画 10% 的雾带压在桌布上等于没画（实测像素变化不到 1200，是全档最弱）
      ctx.fillStyle = "rgba(198,184,152,.2)";
      ctx.fillRect(x, y, w, h);
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = `rgba(188,170,132,${0.3 - i * 0.05})`;
        ctx.fillRect(x, y + 18 + i * 30 + Math.sin(t * 0.6 + i) * 3, w, 16);
      }
    }
    if (this.mood === "wind") {
      ctx.strokeStyle = "rgba(235,245,255,.5)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 7; i++) {
        const py = y + 24 + i * 20;
        const px = x + ((t * (170 + i * 30) + i * 70) % (w + 90)) - 45;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + 44, py - 2);
        ctx.stroke();
      }
    }
    if (this.mood === "heat") {
      // 一小片阴凉 + 热浪线 + 上半屏晒白
      ctx.fillStyle = "rgba(20,26,38,.28)";
      ctx.fillRect(x + 8, y + h - 26, w - 16, 12);
      ctx.fillStyle = "rgba(255,214,140,.22)";
      ctx.fillRect(x, y, w, h * 0.55);
      ctx.strokeStyle = "rgba(255,246,214,.45)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const py = y + 30 + ((t * 30 + i * 40) % (h - 60));
        ctx.beginPath();
        ctx.moveTo(x + w - 74, py);
        ctx.quadraticCurveTo(x + w - 47, py - 6, x + w - 20, py);
        ctx.stroke();
      }
    }
    if (this.mood === "clear") {
      // 头顶一小团暖光（三层椭圆叠出来，比粒子更像"出太阳了"）
      const gx = x + w / 2 + 40;
      const gy = y + 34;
      const halo: [number, number, string][] = [[46, 46, ".1"], [32, 32, ".16"], [18, 18, ".3"]];
      for (const [r, , tone] of halo) {
        ctx.fillStyle = `rgba(255,226,150,${tone})`;
        ctx.beginPath();
        ctx.arc(gx, gy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (this.mood === "other") {
      // 阴天 / 多云：头顶压一朵灰云，不然这一档只剩狗自己动，很容易被当成「没触发」
      const cx = x + w / 2 + Math.sin(t * 0.8) * 22;
      const cy = y + 30;
      ctx.fillStyle = "rgba(196,202,214,.5)";
      ctx.beginPath();
      ctx.arc(cx - 24, cy, 15, 0, Math.PI * 2);
      ctx.arc(cx, cy - 9, 20, 0, Math.PI * 2);
      ctx.arc(cx + 25, cy - 2, 14, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.mood === "thunder") {
      const cyc = t % 1.6;
      if (cyc < 0.1 || (cyc > 0.24 && cyc < 0.3)) {
        ctx.fillStyle = "rgba(255,255,255,.45)";
        ctx.fillRect(x, y, w, h);
      }
    }

    for (const p of this.parts) {
      const a = Math.max(0, Math.min(1, p.life / p.max));
      if (p.tone === "snow") ctx.fillStyle = `rgba(255,255,255,${0.9 * a})`;
      else if (p.tone === "puff") ctx.fillStyle = `rgba(255,255,255,${0.62 * a})`;
      else if (p.tone === "spark") ctx.fillStyle = `rgba(255,236,180,${0.92 * a})`;
      else if (p.tone === "dust") ctx.fillStyle = `rgba(186,168,126,${0.6 * a})`;
      else if (p.tone === "steam") ctx.fillStyle = `rgba(255,222,170,${0.55 * a})`;
      else if (p.tone === "cloud") ctx.fillStyle = `rgba(200,206,218,${0.55 * a})`;
      else ctx.fillStyle = `rgba(205,228,250,${0.85 * a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * 正在播时要画的范围（无副作用，读多少次都一样）。
   * 命中区用它：窗口形状是 SetWindowRgn 裁的，雨丝雪片飘到狗框外就得先把这块要进来，
   * 否则效果会在狗框边缘被整齐切掉。
   */
  paintBox(): Box | null {
    return this.left > 0 ? this.box : null;
  }

  /**
   * 这一帧要清的范围 = 本帧要画的 ∪ 上一帧实际画过的；刚停就只回上一帧那一块（回一次即清账）。
   * 狗是边走路边演的，只报本帧框会在旧位置留下雨丝雪片 —— 气泡先踩过这个坑。
   */
  dirty(): Box | null {
    const prev = this.lastDrawn;
    const cur = this.paintBox();
    if (!cur) {
      this.lastDrawn = null;
      return prev;
    }
    if (!prev) return cur;
    const x = Math.min(cur.x, prev.x);
    const y = Math.min(cur.y, prev.y);
    return {
      x,
      y,
      w: Math.max(cur.x + cur.w, prev.x + prev.w) - x,
      h: Math.max(cur.y + cur.h, prev.y + prev.h) - y
    };
  }

  /** 每 period 秒打出一个 0..1 的脉冲，用于「甩一下」这种短动作 */
  private pulse(period: number, dur: number): { on: number; k: number } {
    const c = this.t % period;
    return c < dur ? { on: 1, k: c / dur } : { on: 0, k: 0 };
  }

  /** 到点没到点：按周期触发粒子，避免每帧都撒（t0 = 本帧开始前的时间） */
  private every(period: number): boolean {
    return Math.floor(this.t / period) !== Math.floor(this.t0 / period);
  }

  private push(x: number, y: number, vx: number, vy: number, life: number, r: number, tone: Particle["tone"]): void {
    if (this.parts.length > 120) return;
    this.parts.push({ x, y, vx, vy, life, max: life, r, tone });
  }
}
