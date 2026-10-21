/**
 * 天气联动 · 效果对照页（评估用，不进应用）。
 *
 * 狗用的是应用里同一套绘制代码（params / pose / shiba 三个模块原样 import），
 * 所以这里看到的就是将来合进去之后长什么样，不是另画一份示意图。
 *
 * 每张卡片 = 一种天气状态：上半是动画，下面写明「靠哪个字段触发」「多久播一次」「它会说什么」。
 * 右上角的「对照」按钮会把天气层和姿态改动一起关掉，方便看出差别。
 */
import { paramsFor } from "../../src/renderer/pet/params";
import { neutralPose, type Pose } from "../../src/renderer/pet/pose";
import { drawShiba } from "../../src/renderer/pet/shiba";
import type { Stage } from "../../src/shared/ipc";

const TAU = Math.PI * 2;
const W = 300;
const H = 210;
const GROUND = H - 30;

type Kind = "heat" | "rain" | "snow" | "haze" | "wind" | "cold" | "thunder";

interface Card {
  kind: Kind;
  title: string;
  /** 触发条件：写成接口真的有的字段，不靠猜 */
  trigger: string;
  /** 频率与时长：防止变成噪音 */
  cadence: string;
  /** 它在这一格会说什么（第三层：一天最多 2~3 句，只在状态变化时） */
  line: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  particles: { x: number; y: number; vx: number; vy: number; life: number; r: number }[];
  compare: boolean;
}

const CARDS: Omit<Card, "canvas" | "ctx" | "particles" | "compare">[] = [
  {
    kind: "heat",
    title: "暴晒 · 找阴凉",
    trigger: "紫外线 uvIndex ≥ 6，或气温 temp_C ≥ 30",
    cadence: "阴凉位置每 20~40 秒挪一次；喘气是常驻状态，不算动作",
    line: "太阳很毒，我把你这件外套挪到阴凉里了（真的会提醒：晒被子的话该收了）"
  },
  {
    kind: "rain",
    title: "下雨 · 滴水甩毛",
    trigger: "降水量 precipMM > 0，或天气代码属于雨系（353/356/359/302…）",
    cadence: "每 5~8 秒甩一次身（0.4 秒）；水洼涟漪常驻",
    line: "要下雨了，阳台上的衣服收一下"
  },
  {
    kind: "snow",
    title: "下雪 · 落雪抖肩",
    trigger: "totalSnow_cm > 0，或天气代码属于雪系（227/329/338…）",
    cadence: "背上积到 3~5 颗才抖一次，约 6~10 秒",
    line: "下雪了，路滑，晚点走也行"
  },
  {
    kind: "haze",
    title: "霾 / 起雾 · 眯眼咳",
    trigger: "天气代码 143/149/248/260，或描述含 haze / mist / fog",
    cadence: "眯眼常驻；咳一声约 12~20 秒一次",
    line: "外面霾重，开窗不如开净化器"
  },
  {
    kind: "wind",
    title: "大风 · 耳朵压毛摆",
    trigger: "风速 windspeedKmph ≥ 25（阵风看 hourly 的 windspeedKmph）",
    cadence: "阵风每 8~12 秒一次，身体被吹歪一下（0.6 秒）",
    line: "风大，伞别带了，容易翻"
  },
  {
    kind: "cold",
    title: "降温 · 缩身哈白气",
    trigger: "体感 FeelsLikeC ≤ 5，或比昨天最低值低 6°C 以上",
    cadence: "发抖常驻（很轻微）；白气每呼吸一次一口",
    line: "今天比昨天冷 7 度，外套穿上"
  },
  {
    kind: "thunder",
    title: "打雷 · 吓一跳靠过来",
    trigger: "天气代码 200/386/389/392（雷系）",
    cadence: "每声雷靠过来一次，靠过来后 3 秒内不重复触发",
    line: "（不说话，只是离你的鼠标近一点）"
  }
];

let stage: Stage = "adult";
let running = true;
const cards: Card[] = [];

function mount(): void {
  const grid = document.getElementById("grid");
  if (!(grid instanceof HTMLElement)) throw new Error("找不到 #grid");
  for (const c of CARDS) {
    const card = document.createElement("section");
    card.className = "bg-card rounded-lg wf-card";

    const head = document.createElement("div");
    head.className = "wf-head";
    const h = document.createElement("h3");
    h.textContent = c.title;
    const btn = document.createElement("button");
    btn.setAttribute("data-slot", "button");
    btn.setAttribute("data-variant", "ghost");
    btn.className = "wf-cmp";
    btn.textContent = "对照";
    btn.setAttribute("aria-pressed", "false");
    head.append(h, btn);

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;

    const meta = document.createElement("dl");
    meta.className = "wf-meta";
    for (const [k, v] of [
      ["靠什么触发", c.trigger],
      ["多久一次", c.cadence],
      ["它会说", c.line]
    ] as [string, string][]) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      meta.append(dt, dd);
    }

    card.append(head, canvas, meta);
    grid.append(card);

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 Canvas2D");
    const card2: Card = { ...c, canvas, ctx, particles: [], compare: false };
    cards.push(card2);

    btn.addEventListener("click", () => {
      card2.compare = !card2.compare;
      btn.classList.toggle("on", card2.compare);
      btn.setAttribute("aria-pressed", String(card2.compare));
      btn.textContent = card2.compare ? "看天气效果" : "对照";
    });
  }
}

/** 基础呼吸/摆尾，和 Dog.update 里同一套数值，保证观感一致 */
function base(t: number): Pose {
  const p = paramsFor(stage);
  const pose = neutralPose(p, W / 2, GROUND);
  pose.breath = Math.sin(t * TAU * 0.45);
  pose.tailSwing = Math.sin(t * TAU * 0.7) * 0.35;
  pose.tailLift = 0.3;
  return pose;
}

function clear(ctx: CanvasRenderingContext2D, kind: Kind, t: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  const sky: Record<Kind, [string, string]> = {
    heat: ["#8fb6d8", "#d9c48f"],
    rain: ["#4a5a6b", "#2f3b48"],
    snow: ["#8fa3b8", "#c9d6e2"],
    haze: ["#9a8f7c", "#6f665a"],
    wind: ["#6d87a0", "#41536a"],
    cold: ["#7d93ab", "#48586d"],
    thunder: ["#2b3140", "#191d27"]
  };
  g.addColorStop(0, sky[kind][0]);
  g.addColorStop(1, sky[kind][1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 地面
  ctx.fillStyle = "rgba(20,24,32,.35)";
  ctx.fillRect(0, GROUND, W, H - GROUND);
  void t;
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size = 11, color = "rgba(255,255,255,.82)"): void {
  ctx.font = `${size}px "Segoe UI","Microsoft YaHei",sans-serif`;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/** 每种天气：改姿态 + 画它自己的粒子层。off = 对照模式（只画一只普通的狗） */
function draw(c: Card, t: number, off: boolean): void {
  const { ctx, kind } = c;
  clear(ctx, kind, t);
  // 对照模式：同一张背景压暗一层，天气粒子与姿态改动全部不画，差别一眼看得出
  if (off) {
    ctx.fillStyle = "rgba(0,0,0,.25)";
    ctx.fillRect(0, 0, W, H);
  }
  const pose = base(t);
  pose.dir = 1;

  if (kind === "heat") {
    // 阴凉：一块从窗口斜进来的暗区，狗待在里头
    const shadeX = off ? 0 : 40 + Math.sin(t * 0.12) * 26;
    if (!off) {
      ctx.fillStyle = "rgba(20,26,38,.34)";
      ctx.beginPath();
      ctx.moveTo(shadeX, 0);
      ctx.lineTo(shadeX + 150, 0);
      ctx.lineTo(shadeX + 118, GROUND);
      ctx.lineTo(shadeX - 22, GROUND);
      ctx.closePath();
      ctx.fill();
      for (let i = 0; i < 3; i++) {
        const y = 24 + ((t * 26 + i * 40) % (GROUND - 30));
        ctx.strokeStyle = "rgba(255,240,200,.16)";
        ctx.beginPath();
        ctx.moveTo(W - 92 + Math.sin(y * 0.1) * 6, y);
        ctx.lineTo(W - 34, y);
        ctx.stroke();
      }
      text(ctx, "uvIndex 7 · 34°C", 10, 18);
    }
    if (!off) {
      pose.mouth = 1;
      pose.tongue = 0.45 + 0.55 * Math.abs(Math.sin(t * TAU * 2.6));
      pose.breath = Math.sin(t * TAU * 1.6);
      pose.headLift = -2;
      pose.tailLift = 0.5;
    }
  }

  if (kind === "rain") {
    if (!off) {
      // 斜雨丝
      ctx.strokeStyle = "rgba(190,215,240,.5)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 46; i++) {
        const x = (i * 37 + t * 210) % (W + 40);
        const y = (i * 61 + t * 430) % (GROUND + 20);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 5, y + 13);
        ctx.stroke();
      }
      // 水洼 + 涟漪
      ctx.fillStyle = "rgba(120,150,180,.34)";
      ctx.beginPath();
      ctx.ellipse(78, GROUND + 12, 40, 6, 0, 0, TAU);
      ctx.fill();
      for (let i = 0; i < 3; i++) {
        const p = (t * 0.9 + i / 3) % 1;
        ctx.strokeStyle = `rgba(220,235,250,${(1 - p) * 0.5})`;
        ctx.beginPath();
        ctx.ellipse(78, GROUND + 12, 4 + p * 22, (4 + p * 22) * 0.18, 0, 0, TAU);
        ctx.stroke();
      }
      // 每 6 秒甩一次身，甩出水珠
      const cyc = t % 6;
      if (cyc < 0.42) {
        const k = cyc / 0.42;
        pose.lean = Math.sin(k * Math.PI * 7) * 0.13;
        pose.headTilt = Math.sin(k * Math.PI * 7) * 0.2;
        pose.tailSwing = Math.sin(k * Math.PI * 9) * 0.9;
        if (k < 0.35) spawn(c, 6, () => ({ x: W / 2 + 40, y: GROUND - 60, vx: 60 + Math.random() * 90, vy: -60 - Math.random() * 60, life: 0.7, r: 1.6 }));
      }
      pose.mouth = 0.35;
      text(ctx, "precipMM 2.4", 10, 18);
    }
  }

  if (kind === "snow") {
    if (!off) {
      for (let i = 0; i < 40; i++) {
        const x = (i * 53 + Math.sin(t * 0.7 + i) * 22 + t * 18) % W;
        const y = (i * 29 + t * 46) % (GROUND + 10);
        ctx.fillStyle = "rgba(255,255,255,.85)";
        ctx.beginPath();
        ctx.arc(x, y, 1.6 + (i % 3) * 0.5, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.beginPath();
      ctx.ellipse(238, GROUND + 10, 30, 7, 0, 0, TAU);
      ctx.fill();
      // 背上积到几颗就抖一下
      const cyc = t % 8;
      if (cyc < 0.35) {
        const k = cyc / 0.35;
        pose.lean = Math.sin(k * Math.PI * 8) * 0.1;
        pose.headTilt = Math.sin(k * Math.PI * 8) * 0.16;
        spawn(c, 5, () => ({ x: W / 2 - 10 + Math.random() * 50, y: GROUND - 96, vx: (Math.random() - 0.5) * 70, vy: -20 + Math.random() * 30, life: 0.6, r: 1.8 }));
      }
      text(ctx, "totalSnow 1.2cm", 10, 18);
    }
  }

  if (kind === "haze") {
    if (!off) {
      for (let i = 0; i < 5; i++) {
        const y = 30 + i * 26;
        ctx.fillStyle = `rgba(196,182,150,${0.1 + (i % 2) * 0.05})`;
        ctx.fillRect(0, y + Math.sin(t * 0.5 + i) * 3, W, 16);
      }
      pose.blink = 0.45; // 眯眼：借用眨眼参数停在半闭
      const cough = t % 16 < 0.5 ? Math.sin(((t % 16) / 0.5) * Math.PI) : 0;
      pose.mouth = Math.max(pose.mouth, cough);
      pose.headDip = cough * 0.25;
      text(ctx, "code 149 · Smoky haze", 10, 18);
    }
  }

  if (kind === "wind") {
    if (!off) {
      ctx.strokeStyle = "rgba(235,245,255,.35)";
      for (let i = 0; i < 9; i++) {
        const y = 26 + i * 18;
        const x = (t * (150 + i * 26) + i * 90) % (W + 120) - 60;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 46, y - 2);
        ctx.stroke();
      }
      const gust = t % 10 < 0.6 ? Math.sin(((t % 10) / 0.6) * Math.PI) : 0;
      pose.earPerk = -0.5 - gust * 0.4; // 耳朵被吹得往后压
      pose.lean = -0.05 - gust * 0.1;
      pose.tailSwing = Math.sin(t * TAU * 2.2) * (0.5 + gust * 0.5);
      pose.breath = Math.sin(t * TAU * 0.8) * (1 + gust);
      text(ctx, "wind 31km/h", 10, 18);
    }
  }

  if (kind === "cold") {
    if (!off) {
      pose.squash = 0.25; // 缩一点
      pose.bob = Math.sin(t * TAU * 9) * 0.7; // 轻微发抖
      pose.headLift = -1;
      pose.tailLift = 0.1;
      pose.earPerk = -0.25;
      // 呼气白气：跟着呼吸节奏出一口
      const br = (t * 0.55) % 1;
      if (br < 0.5) {
        const k = br / 0.5;
        ctx.fillStyle = `rgba(255,255,255,${(1 - k) * 0.5})`;
        ctx.beginPath();
        ctx.arc(W / 2 + 96 + k * 26, GROUND - 118 - k * 12, 3 + k * 7, 0, TAU);
        ctx.fill();
      }
      text(ctx, "体感 2°C", 10, 18);
    }
  }

  if (kind === "thunder") {
    if (!off) {
      const cyc = t % 7;
      const flash = cyc < 0.12 || (cyc > 0.3 && cyc < 0.36);
      if (flash) {
        ctx.fillStyle = "rgba(255,255,255,.55)";
        ctx.fillRect(0, 0, W, H);
      }
      // 雷响后靠向鼠标（右边画一个指针）
      const startle = cyc > 0.12 ? Math.min(1, (cyc - 0.12) / 0.5) : 0;
      pose.x = W / 2 + startle * 42;
      ctx.strokeStyle = "rgba(255,255,255,.9)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(W - 34, GROUND - 40);
      ctx.lineTo(W - 34, GROUND - 22);
      ctx.lineTo(W - 28, GROUND - 28);
      ctx.stroke();
      if (cyc < 0.5) {
        pose.earPerk = 1;
        pose.tailLift = 0;
        pose.squash = 0.3;
        pose.bob = -3;
      }
      text(ctx, "code 386 · Thundery showers", 10, 18);
    }
  }

  drawShiba(ctx, pose);
  step(c, off);
  if (off) text(ctx, "对照：不带任何天气表现", 10, H - 10, 11, "rgba(255,255,255,.9)");
}

function spawn(c: Card, n: number, make: () => Card["particles"][number]): void {
  if (c.particles.length > 90) return;
  for (let i = 0; i < n; i++) c.particles.push(make());
}

function step(c: Card, off: boolean): void {
  if (off) {
    c.particles.length = 0;
    return;
  }
  const ctx = c.ctx;
  for (let i = c.particles.length - 1; i >= 0; i--) {
    const p = c.particles[i];
    p.life -= 1 / 60;
    p.x += p.vx / 60;
    p.y += p.vy / 60;
    p.vy += 260 / 60;
    if (p.life <= 0 || p.y > GROUND + 16) {
      c.particles.splice(i, 1);
      continue;
    }
    ctx.fillStyle = c.kind === "snow" ? "rgba(255,255,255,.9)" : "rgba(205,228,250,.85)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fill();
  }
}

function boot(): void {
  mount();
  // 给自动化验收留一个手动刷帧的口子（后台标签里 requestAnimationFrame 不跑，只能这样比对帧差）
  (window as unknown as { __wfPaint: (t: number) => void }).__wfPaint = (t: number): void => {
    for (const c of cards) draw(c, t, c.compare);
  };
  const stageSel = document.getElementById("stageSel") as HTMLSelectElement | null;
  stageSel?.addEventListener("change", () => {
    stage = stageSel.value === "puppy" ? "puppy" : "adult";
  });
  const playBtn = document.getElementById("playBtn");
  playBtn?.addEventListener("click", () => {
    running = !running;
    if (playBtn) playBtn.textContent = running ? "暂停" : "继续播放";
  });
  const allCmp = document.getElementById("allCmp");
  allCmp?.addEventListener("click", () => {
    const on = !cards.every((c) => c.compare);
    cards.forEach((c) => (c.compare = on));
    document.querySelectorAll(".wf-cmp").forEach((b) => {
      const el = b as HTMLButtonElement;
      el.textContent = on ? "看天气效果" : "对照";
      el.classList.toggle("on", on);
    });
  });

  let t = 0;
  let prev = performance.now();
  // 先静态画一帧：页面在后台标签里打开时 requestAnimationFrame 根本不跑，
  // 不补这一帧的话她看到的会是七块空板子（以为坏了）
  for (const c of cards) draw(c, 0.6, c.compare);
  const loop = (now: number): void => {
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    if (running) t += dt;
    for (const c of cards) draw(c, t, c.compare);
    const clock = document.getElementById("clock");
    if (clock) clock.textContent = `${t.toFixed(1)} 秒`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot();
