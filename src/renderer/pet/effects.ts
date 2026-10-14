interface Heart {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  spin: number;
}

interface Crumb {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
}

interface Pkg {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: string;
  spin: number;
}

/**
 * 爱心粒子和气泡都画在画布坐标里（不跟着狗的翻转坐标系），
 * 所以文字不会被 mirror。
 */
export class Effects {
  private hearts: Heart[] = [];
  private crumbs: Crumb[] = [];
  private pkgs: Pkg[] = [];
  private bubble: { text: string; age: number; life: number } | null = null;
  /** 上一帧气泡实际占的框（含小尾巴）：帧循环用它做脏区，气泡移动/消失后旧位置才能清干净 */
  private bubbleDrawn: { x: number; y: number; w: number; h: number } | null = null;

  burstHearts(x: number, y: number, count = 7): void {
    for (let i = 0; i < count; i++) {
      this.hearts.push({
        // 左右开，别全挤在气泡背后
        x: x + (Math.random() - 0.5) * 52,
        y: y + (Math.random() - 0.5) * 10,
        vx: (Math.random() - 0.5) * 26,
        vy: -46 - Math.random() * 34,
        age: 0,
        life: 0.9 + Math.random() * 0.7,
        size: 5 + Math.random() * 4,
        spin: (Math.random() - 0.5) * 1.6
      });
    }
  }

  say(text: string, seconds = 1.8): void {
    this.bubble = { text, age: 0, life: seconds };
  }

  /** 吃饭掉渣 */
  spillCrumbs(x: number, y: number, count = 5): void {
    for (let i = 0; i < count; i++) {
      this.crumbs.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 70,
        vy: -40 - Math.random() * 50,
        age: 0,
        life: 0.55 + Math.random() * 0.35,
        size: 1.6 + Math.random() * 2
      });
    }
  }

  /** 搬运落点：吐一个带色的小包裹，弹一下再落地消失 */
  dropPackage(x: number, y: number, color: string): void {
    this.pkgs.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 40,
      vy: -150 - Math.random() * 40,
      age: 0,
      life: 0.9 + Math.random() * 0.3,
      size: 10 + Math.random() * 4,
      color,
      spin: (Math.random() - 0.5) * 3
    });
  }

  update(dt: number): void {
    for (const h of this.hearts) {
      h.age += dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.vy += 12 * dt; // 轻微上浮衰减
    }
    this.hearts = this.hearts.filter((h) => h.age < h.life);

    for (const c of this.crumbs) {
      c.age += dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.vy += 320 * dt; // 受重力掉回盆里
    }
    this.crumbs = this.crumbs.filter((c) => c.age < c.life);

    for (const k of this.pkgs) {
      k.age += dt;
      k.x += k.vx * dt;
      k.y += k.vy * dt;
      k.vy += 460 * dt; // 抛物线落地
    }
    this.pkgs = this.pkgs.filter((k) => k.age < k.life);

    if (this.bubble) {
      this.bubble.age += dt;
      if (this.bubble.age >= this.bubble.life) this.bubble = null;
    }
  }

  /**
   * 本帧粒子占的外接框，全屏画布靠它做脏矩形重绘 ——
   * 每帧 clearRect 整块 1920x1080 会把合成开销拉满。
   */
  dirty(): { x: number; y: number; w: number; h: number } | null {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const eat = (x: number, y: number, pad: number): void => {
      left = Math.min(left, x - pad);
      top = Math.min(top, y - pad);
      right = Math.max(right, x + pad);
      bottom = Math.max(bottom, y + pad);
    };
    for (const h of this.hearts) eat(h.x, h.y, h.size * 2);
    for (const c of this.crumbs) eat(c.x, c.y, c.size * 3);
    for (const k of this.pkgs) eat(k.x, k.y, k.size * 1.6);
    if (left === Infinity) return null;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  drawHearts(ctx: CanvasRenderingContext2D): void {
    for (const h of this.hearts) {
      const k = 1 - h.age / h.life;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, k * 1.4));
      ctx.translate(h.x, h.y);
      ctx.rotate(h.spin * (1 - k));
      ctx.fillStyle = "#F1646B";
      heartPath(ctx, h.size);
      ctx.fill();
      ctx.restore();
    }
  }

  /** 气泡锚点：狗头顶上方 */
  drawBubble(ctx: CanvasRenderingContext2D, ax: number, ay: number): void {
    // 注意：气泡消失时不清 bubbleDrawn —— 下一帧还要靠它把残留的白色擦干净
    if (!this.bubble) return;
    const { text, age, life } = this.bubble;
    const k = age < 0.12 ? age / 0.12 : age > life - 0.25 ? (life - age) / 0.25 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, k);
    ctx.font = "600 13px 'Microsoft YaHei', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width + 20;
    const h = 26;
    const x = Math.round(ax - w / 2);
    const y = Math.round(ay - h);
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.strokeStyle = "rgba(51,36,29,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 12);
    ctx.fill();
    ctx.stroke();
    // 小尾巴指向狗头
    ctx.beginPath();
    ctx.moveTo(ax - 6, y + h);
    ctx.lineTo(ax + 6, y + h);
    ctx.lineTo(ax, y + h + 7);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.fill();
    ctx.fillStyle = "#33241D";
    ctx.fillText(text, ax, y + h / 2 + 0.5);
    // 记录本帧实际绘制的区域（含尾巴和圆角外扩）：帧循环拿它当脏区，
    // 否则宽气泡横向溢出狗框的部分永远清不掉，会形成盖住狗的白色残影
    this.bubbleDrawn = { x: x - 1, y: y - 1, w: w + 2, h: h + 7 + 2 };
    ctx.restore();
  }

  /** 上一帧气泡实际画的区域（帧循环做脏区用） */
  bubbleDirty(): { x: number; y: number; w: number; h: number } | null {
    return this.bubbleDrawn;
  }

  /** 气泡的边界框（用于加入命中区，避免被 setShape 裁剪掉） */
  bubbleRect(ax: number, ay: number): { x: number; y: number; w: number; h: number } | null {
    if (!this.bubble) return null;
    const text = this.bubble.text;
    // 估算宽度：中文约 14px/字，英文约 7px/字，加 padding；宁宽勿窄
    const estW = text.length * 14 + 26;
    const h = 34; // 包含小尾巴
    return { x: ax - estW / 2, y: ay - h, w: estW, h };
  }

  drawCrumbs(ctx: CanvasRenderingContext2D): void {
    if (this.crumbs.length === 0) return;
    ctx.save();
    ctx.fillStyle = "#8A5A34";
    for (const c of this.crumbs) {
      ctx.globalAlpha = Math.max(0, 1 - c.age / c.life);
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawPackages(ctx: CanvasRenderingContext2D): void {
    if (this.pkgs.length === 0) return;
    for (const k of this.pkgs) {
      const fade = k.age > k.life - 0.25 ? (k.life - k.age) / 0.25 : 1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, fade);
      ctx.translate(k.x, k.y);
      ctx.rotate(k.spin * (k.age / k.life));
      ctx.fillStyle = k.color;
      ctx.beginPath();
      ctx.roundRect(-k.size / 2, -k.size / 2, k.size, k.size, 2);
      ctx.fill();
      // 十字胶带，一眼能看出是个打包好的东西
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -k.size / 2);
      ctx.lineTo(0, k.size / 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function heartPath(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.beginPath();
  ctx.moveTo(0, s * 0.35);
  ctx.bezierCurveTo(-s, -s * 0.45, -s * 0.45, -s, 0, -s * 0.4);
  ctx.bezierCurveTo(s * 0.45, -s, s, -s * 0.45, 0, s * 0.35);
  ctx.closePath();
}
