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

/** 狗嘴里叼着的「假图标」：真图标已被主进程挪到屏幕外，画面上由这一个代替 */
interface Held {
  /** 页面上画哪种小图形（按分类名挑的，见 glyphOf） */
  glyph: HeldGlyph;
  /** 页眉与图形用的颜色 = 这次整理落点区域的颜色 */
  color: string;
  /** 出现后累计秒数：pop-in 用它 */
  age: number;
  /** 松口后累计秒数；null = 还叼着 */
  outAge: number | null;
}

type HeldGlyph = "img" | "vid" | "aud" | "file";

/**
 * 分类名 → 画哪种小图形。分类标签是用户可以自己改的（最长 12 字），所以只能按关键字猜，
 * 猜不中就画最通用的「文档」。认错了也不影响整理，只是嘴上那张纸的小图案换了个样子。
 */
function glyphOf(category: string): HeldGlyph {
  const c = (category || "").toLowerCase();
  if (/图|照片|image|photo|psd|画/.test(c)) return "img";
  if (/视频|影音|影片|video|mp4/.test(c)) return "vid";
  if (/音频|音乐|音效|audio|mp3|wav/.test(c)) return "aud";
  return "file";
}

/** 叼起时弹一下的时长 / 放下时缩没的时长（秒） */
const HELD_IN = 0.13;
const HELD_OUT = 0.14;

const BUBBLE_FONT = "600 13px 'Microsoft YaHei', system-ui, sans-serif";
/** 气泡的颜色跟设置窗那块玻璃同源：奶油底 + 蜂蜜棕描边（画布上没有 CSS 变量，只能写死） */
const BUBBLE_FILL = "rgba(255,250,242,0.95)";
const BUBBLE_RIM = "rgba(150,111,62,0.5)";
const BUBBLE_RADIUS = 14;
/**
 * 两种摆法各自的宽/行数上限。
 * 嘴前方（报天气）要短：那一句本来就只有「现在几度 + 天气词」，宽了会顶到屏幕外。
 * 头顶（新闻、提示）要装得下一整条新闻，所以更宽、最多三行 —— 只给两行会把新闻截成半句。
 */
const BUBBLE_FRONT_MAX_W = 236;
const BUBBLE_FRONT_LINES = 2;
const BUBBLE_ABOVE_MAX_W = 320;
const BUBBLE_ABOVE_LINES = 3;
const BUBBLE_LINE_H = 26;
/** 下一行往下压这么多（行距） */
const BUBBLE_LINE_GAP = 18;

/** 一行装不下就截掉尾巴加省略号：字画出圆角框外比少几个字难看多了 */
function clipLine(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let out = s;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/** 句子里没有可断的标点时，按「每行尽量等宽」硬切，别让前几行塞满、最后一行只剩四个字 */
function splitEven(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const per = Math.max(1, Math.min(maxW, ctx.measureText(text).width / maxLines));
  const lines: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (cur && ctx.measureText(cur + ch).width > per) {
      lines.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * 把一长句折成最多 maxLines 行。优先在「能断的地方」（空格、·、中文标点）切；
 * 行数超上限就把多出来的并进最后一行，最后一行还超宽就省略号截断 ——
 * 宁可少几个字，也不要越折越高把狗和动画盖掉。
 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  if (ctx.measureText(text).width <= maxW) return [text];
  const parts = text.split(/(?<=[ ·，、；：,;:!?])/);
  const lines: string[] = [];
  let cur = "";
  for (const p of parts) {
    const next = cur + p;
    if (cur && ctx.measureText(next).width > maxW) {
      lines.push(cur);
      cur = p;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  // 贪心装完还是不行（行数超了，或某一段本身就没标点、一行塞不下），
  // 就丢掉标点边界、按「每行尽量等宽」整体重排一次：这样三行的额度能真正用满，
  // 不会因为第一行只占了三分之一就把后半条新闻截掉
  const overflow = lines.some((l) => ctx.measureText(l).width > maxW) || lines.length > maxLines;
  const final = overflow ? splitEven(ctx, text, maxW, maxLines) : lines;
  return fold(final, maxLines, ctx, maxW);
}

/** 收进 maxLines 行以内，并逐行截断 */
function fold(lines: string[], maxLines: number, ctx: CanvasRenderingContext2D, maxW: number): string[] {
  if (lines.length === 0) return [];
  if (lines.length === 1) return [clipLine(ctx, lines[0], maxW)];
  const kept =
    lines.length <= maxLines
      ? lines
      : [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join("")];
  return kept.map((l) => clipLine(ctx, l.trim(), maxW));
}

/** 气泡离嘴多远 / 小尾巴多长（像素） */
const BUBBLE_GAP = 16;
const BUBBLE_TAIL = 7;

type BubblePlace = "above" | "front";

/**
 * 气泡的框。side = 0 挂在锚点正上方（尾巴朝下，指着狗头）；
 * side = ±1 挂在锚点的左侧 / 右侧（尾巴朝内，指着狗嘴）—— 天气那句就走这条，
 * 压在狗头上会把表情和雨丝一起挡掉。
 */
function bubbleBox(ax: number, ay: number, side: -1 | 0 | 1, w: number, h: number): { x: number; y: number } {
  if (side === 0) return { x: Math.round(ax - w / 2), y: Math.round(ay - h) };
  const x = side > 0 ? Math.round(ax + BUBBLE_GAP) : Math.round(ax - BUBBLE_GAP - w);
  // 竖直方向居中在锚点上，但别高过框本身（两行时框比锚点高）
  return { x, y: Math.round(ay - h / 2) };
}

/**
 * 不用画布时估算一行文字的宽度：中日韩和 emoji 按 14px，其他按 8px（13px 雅黑的实际比例），
 * 再补 padding。宁可略宽也不要偏窄 —— 这个数用来决定气泡放不放得下、命中区要多大。
 */
function estimateTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp > 0xffff || /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 14 : 8;
  }
  return w + 26;
}

/**
 * 爱心粒子和气泡都画在画布坐标里（不跟着狗的翻转坐标系），
 * 所以文字不会被 mirror。
 */
export class Effects {
  private hearts: Heart[] = [];
  private crumbs: Crumb[] = [];
  private bubble: { text: string; age: number; life: number; place: BubblePlace } | null = null;
  /** 上一帧气泡实际占的框（含小尾巴）：帧循环用它做脏区，气泡移动/消失后旧位置才能清干净 */
  private bubbleDrawn: { x: number; y: number; w: number; h: number } | null = null;
  /** 狗嘴里那份假图标；null = 嘴里没东西 */
  private held: Held | null = null;
  /** 上一帧假图标实际占的框：脏区靠它，图标跟着嘴挪走之后旧位置才擦得干净 */
  private heldDrawn: { x: number; y: number; w: number; h: number } | null = null;

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

  /**
   * 说一句气泡。place = "front" 表示这句话要画在嘴前方（报天气用），
   * 渲染层靠 {@link bubblePlace} 决定把锚点放在头顶还是嘴边。
   */
  say(text: string, seconds = 1.8, place: BubblePlace = "above"): void {
    this.bubble = { text, age: 0, life: seconds, place };
  }

  /** 当前气泡该画在哪儿；没有气泡时按默认（头顶）报，免得调用方各自兜底 */
  get bubblePlace(): BubblePlace {
    return this.bubble?.place ?? "above";
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

  /**
   * 叼起 / 换一份假图标。传 null 等价于 {@link releaseHeld}。
   * 只在主进程确认「真图标已经藏到屏幕外」之后调用，否则画面上会同时出现两份。
   */
  setHeld(icon: { category: string; color: string } | null): void {
    if (!icon) {
      this.releaseHeld();
      return;
    }
    // 换一份就重新弹一次：连续叼两个文件时，第二个也该有「咬住了」的那一下
    this.held = { glyph: glyphOf(icon.category), color: icon.color, age: 0, outAge: null };
  }

  /** 放下：假图标缩没（真图标同一时刻在落点出现），不是「啪」地消失 */
  releaseHeld(): void {
    if (this.held && this.held.outAge === null) this.held.outAge = 0;
  }

  /** 当前是否还画着假图标（含正在缩没的那一小段） */
  get holding(): boolean {
    return this.held !== null;
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

    if (this.bubble) {
      this.bubble.age += dt;
      if (this.bubble.age >= this.bubble.life) this.bubble = null;
    }

    if (this.held) {
      this.held.age += dt;
      if (this.held.outAge !== null) {
        this.held.outAge += dt;
        // 缩没结束才真正扔掉：这一帧之前 drawHeld 还要靠它把旧位置画干净
        if (this.held.outAge >= HELD_OUT) this.held = null;
      }
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

  /**
   * 气泡。(ax,ay) = 尾巴尖指的位置（头顶上方或嘴边）。
   * side 只有 place = "front" 时才生效：+1 画在锚点右边、-1 画在左边，尾巴朝内指着狗嘴；
   * 传 0 就退回「画在锚点上方」。长句子按摆法折行：嘴前方最多两行 236px，头顶最多三行 320px。
   */
  drawBubble(ctx: CanvasRenderingContext2D, ax: number, ay: number, side: -1 | 0 | 1 = 0): void {
    // 注意：气泡消失时不清 bubbleDrawn —— 下一帧还要靠它把残留的白色擦干净
    if (!this.bubble) return;
    const { text, age, life } = this.bubble;
    const front = this.bubble.place === "front";
    const maxW = front ? BUBBLE_FRONT_MAX_W : BUBBLE_ABOVE_MAX_W;
    const k = age < 0.12 ? age / 0.12 : age > life - 0.25 ? (life - age) / 0.25 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, k);
    ctx.font = BUBBLE_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lines = wrapText(ctx, text, maxW, front ? BUBBLE_FRONT_LINES : BUBBLE_ABOVE_LINES);
    const w = Math.min(maxW, Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + 20);
    const h = BUBBLE_LINE_H + (lines.length - 1) * BUBBLE_LINE_GAP;
    // 只有「嘴前方」那种气泡才用 side；头顶那种永远居中挂在锚点上方
    const dir: -1 | 0 | 1 = front ? side : 0;
    const { x, y } = bubbleBox(ax, ay, dir, w, h);
    ctx.fillStyle = BUBBLE_FILL;
    ctx.strokeStyle = BUBBLE_RIM;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, BUBBLE_RADIUS);
    ctx.fill();
    ctx.stroke();
    // 小尾巴：朝下的那种指着狗头，朝左 / 朝右的那种指着狗嘴
    ctx.beginPath();
    ctx.fillStyle = BUBBLE_FILL;
    if (dir === 0) {
      ctx.moveTo(ax - 6, y + h);
      ctx.lineTo(ax + 6, y + h);
      ctx.lineTo(ax, y + h + BUBBLE_TAIL);
    } else if (dir > 0) {
      const cy = Math.max(y + 10, Math.min(y + h - 10, ay));
      ctx.moveTo(x, cy - 6);
      ctx.lineTo(x, cy + 6);
      ctx.lineTo(x - BUBBLE_TAIL, cy);
    } else {
      const cy = Math.max(y + 10, Math.min(y + h - 10, ay));
      ctx.moveTo(x + w, cy - 6);
      ctx.lineTo(x + w, cy + 6);
      ctx.lineTo(x + w + BUBBLE_TAIL, cy);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#33241D";
    const tx = dir === 0 ? ax : x + w / 2;
    lines.forEach((line, i) => {
      ctx.fillText(line, tx, y + BUBBLE_LINE_H / 2 + i * BUBBLE_LINE_GAP);
    });
    // 记录本帧实际绘制的区域（含尾巴和圆角外扩）：帧循环拿它当脏区，
    // 否则宽气泡横向溢出狗框的部分永远清不掉，会形成盖住狗的白色残影
    const padX = dir === 0 ? 1 : BUBBLE_TAIL + 1;
    const left = dir < 0 ? x - 1 : x - padX;
    this.bubbleDrawn = {
      x: Math.round(left),
      y: y - 1,
      w: w + (dir === 0 ? 2 : padX + 1),
      h: h + (dir === 0 ? BUBBLE_TAIL + 2 : 2)
    };
    ctx.restore();
  }

  /** 上一帧气泡实际画的区域（帧循环做脏区用） */
  bubbleDirty(): { x: number; y: number; w: number; h: number } | null {
    return this.bubbleDrawn;
  }

  /** 气泡的边界框（用于加入命中区，避免被 setShape 裁剪掉）。side 要和 drawBubble 传同一个 */
  bubbleRect(ax: number, ay: number, side: -1 | 0 | 1 = 0): { x: number; y: number; w: number; h: number } | null {
    if (!this.bubble) return null;
    const text = this.bubble.text;
    // 估算宽度：中文约 14px/字，英文约 7px/字，加 padding；宁宽勿窄。
    // 上限就是折行宽度（真实最宽也就这么宽），高度按会不会折成两行给
    const front = this.bubble.place === "front";
    const maxW = front ? BUBBLE_FRONT_MAX_W : BUBBLE_ABOVE_MAX_W;
    const wide = estimateTextWidth(text);
    // 估算宁宽勿窄：宽度取上限内的大者，行数按同口径推出来（和 drawBubble 的折行上限一致）
    const estW = Math.min(maxW + 8, wide);
    const lines = Math.max(1, Math.min(front ? BUBBLE_FRONT_LINES : BUBBLE_ABOVE_LINES, Math.ceil(wide / maxW)));
    const h = BUBBLE_LINE_H + (lines - 1) * BUBBLE_LINE_GAP;
    const dir: -1 | 0 | 1 = front ? side : 0;
    const b = bubbleBox(ax, ay, dir, estW, h);
    if (dir === 0) return { x: b.x - 1, y: b.y - 1, w: estW + 2, h: h + BUBBLE_TAIL + 2 };
    const grow = BUBBLE_TAIL + 2;
    // 尾巴朝内（指着狗嘴），所以多包的一边跟着方向变：dir>0 在左、dir<0 在右
    return dir > 0
      ? { x: b.x - grow, y: b.y - 1, w: estW + grow + 1, h: h + 2 }
      : { x: b.x - 1, y: b.y - 1, w: estW + grow + 1, h: h + 2 };
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

  /** 上一帧假图标实际画的区域（帧循环拿它做脏区，图标消失后旧位置靠它擦干净） */
  heldDirty(): { x: number; y: number; w: number; h: number } | null {
    return this.heldDrawn;
  }

  /**
   * 画狗嘴里那份「假图标」：一张带分类色头的文件，正被门牙咬住、略微后仰。
   * (ax,ay) = 嘴锚点（画布坐标，不随狗的翻转坐标系走，所以这里自己按 dir 倾斜）。
   */
  drawHeld(ctx: CanvasRenderingContext2D, ax: number, ay: number, dir: 1 | -1, size: number): void {
    const h = this.held;
    if (!h) {
      // 嘴里空了必须把这个字段清掉：留着的话狗走远了还在原地每帧擦一块，脏矩形白做
      this.heldDrawn = null;
      return;
    }
    const inK = Math.min(1, h.age / HELD_IN);
    // 叼起来时弹一下（冲过头再收回），比直接显形更像「咬住了」
    const pop = 0.55 + 0.45 * inK + Math.sin(inK * Math.PI) * 0.08;
    const outK = h.outAge === null ? 0 : Math.min(1, h.outAge / HELD_OUT);
    const w = size * pop * (1 - 0.32 * outK);
    const hh = w * 1.24;
    const r = Math.max(2.5, w * 0.16);
    const left = -w / 2;
    const top = -hh / 2;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - outK);
    ctx.translate(ax, ay);
    ctx.rotate(-0.13 * dir);
    // 纸面
    ctx.beginPath();
    ctx.roundRect(left, top, w, hh, r);
    ctx.fillStyle = "#FDFBF6";
    ctx.fill();
    // 分类色页眉：剪进圆角里，一眼看出这是哪一类
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(left, top, w, hh, r);
    ctx.clip();
    ctx.fillStyle = h.color;
    ctx.fillRect(left, top, w, hh * 0.28);
    ctx.restore();
    // 页面上的小图形按分类变一下：图片是山和太阳、视频是播放键、音频是音符，
    // 其余就画两行字 —— 狗叼着「一张图」和叼着「一个文档」应该看得出来不一样
    ctx.fillStyle = h.color;
    ctx.strokeStyle = h.color;
    const cx = 0;
    const cy = top + hh * 0.62;
    if (h.glyph === "img") {
      ctx.beginPath();
      ctx.arc(left + w * 0.3, cy - hh * 0.16, Math.max(1.2, w * 0.08), 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(left + w * 0.16, cy + hh * 0.16);
      ctx.lineTo(left + w * 0.45, cy - hh * 0.06);
      ctx.lineTo(left + w * 0.74, cy + hh * 0.16);
      ctx.closePath();
      ctx.fill();
    } else if (h.glyph === "vid") {
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.16, cy - hh * 0.17);
      ctx.lineTo(cx + w * 0.2, cy);
      ctx.lineTo(cx - w * 0.16, cy + hh * 0.17);
      ctx.closePath();
      ctx.fill();
    } else if (h.glyph === "aud") {
      ctx.lineWidth = Math.max(1.2, w * 0.07);
      ctx.beginPath();
      ctx.moveTo(cx + w * 0.14, cy + hh * 0.1);
      ctx.lineTo(cx + w * 0.14, cy - hh * 0.17);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + w * 0.06, cy + hh * 0.11, Math.max(1.4, w * 0.1), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.globalAlpha *= 0.75;
      ctx.lineWidth = Math.max(1.2, w * 0.07);
      ctx.lineCap = "round";
      for (let i = 0; i < 2; i++) {
        const y = top + hh * (0.55 + i * 0.22);
        ctx.beginPath();
        ctx.moveTo(left + w * 0.18, y);
        ctx.lineTo(left + w * (i === 0 ? 0.82 : 0.58), y);
        ctx.stroke();
      }
    }
    // 描边最后画，压在剪出来的色块上才利落
    ctx.beginPath();
    ctx.roundRect(left, top, w, hh, r);
    ctx.lineWidth = Math.max(1, w * 0.06);
    ctx.strokeStyle = "rgba(51,36,29,0.62)";
    ctx.stroke();
    ctx.restore();

    // 倾斜 + 弹跳都让外接框比纸面大一圈，脏区按大的算才擦得掉
    const pad = Math.max(4, size * 0.45);
    this.heldDrawn = { x: ax - w / 2 - pad, y: ay - hh / 2 - pad, w: w + pad * 2, h: hh + pad * 2 };
  }
}

function heartPath(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.beginPath();
  ctx.moveTo(0, s * 0.35);
  ctx.bezierCurveTo(-s, -s * 0.45, -s * 0.45, -s, 0, -s * 0.4);
  ctx.bezierCurveTo(s * 0.45, -s, s, -s * 0.45, 0, s * 0.35);
  ctx.closePath();
}
