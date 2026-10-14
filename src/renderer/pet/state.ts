import type { RoamMode, Stage } from "../../shared/ipc";
import { paramsFor, type DogParams } from "./params";
import { neutralPose, type Pose } from "./pose";

const TAU = Math.PI * 2;

export type Behavior = "idle" | "walk" | "run" | "pant" | "happy" | "drag" | "goto" | "eat" | "carry" | "stretch" | "roll" | "scratch" | "spin" | "yawn";

export interface Room {
  /** 画布可用宽度（= 工作区宽度） */
  width: number;
  /** 底边基准线（画布 y），狗默认在这附近 */
  groundY: number;
  /** 食盆中心 x，狗站在它左边低头吃 */
  bowlX: number;
}

/** 一个搬运路点：(x,y)=狗要走的脚底坐标；(fx,fy)=粒子出现处；drop=true 表示这是放下 */
export interface CarryPoint {
  x: number;
  y: number;
  fx: number;
  fy: number;
  color: string;
  drop: boolean;
  index: number;
  name: string;
}

/** 吃一口的时长；多份文件按口数累加，最多排 4 口，免得用户等半天 */
const BITE_SECONDS = 1.15;
const MAX_BITES = 4;
/** 狗站在食盆左边多远（离盆远一点，往左偏移） */
const BOWL_STANDOFF = 120;
const WALK_SPEED = 90;
const RUN_SPEED = 460;

/**
 * 行为机。狗现在是「全屏二维」的：脚底位置 (x, y) 可以走到画布任意处，
 * 这样整理时能准确走到目标图标旁边。step() 是唯一的「这一帧谁说了算」入口：
 * 开饭/被拎着/搬运/开心/喘气优先，其余时间交给漫游策略（追/躲鼠标或自己闲逛）。
 */
export class Dog {
  room: Room = { width: 1920, groundY: 1050, bowlX: 1800 };
  behavior: Behavior = "idle";

  private stage: Stage = "puppy";
  private clock = 0;
  private left = 3;
  private dir: 1 | -1 = 1;
  private x = 400;
  /** 脚底的画布 y（全屏可移动，不再固定贴底边） */
  private y = 1050;
  private nextBlink = 2.5;
  private blinkAt = -1;
  /** 走路相位：必须跨帧累加（不能每帧从 0 开始，否则腿卡在固定角度不迈步） */
  private legPhase = 0;
  private bites = 0;
  private mouse = { x: 0, y: 0, seen: false };
  /** 闲逛目的地（二维）；null 表示没有目标 */
  private target: { x: number; y: number } | null = null;
  private roam: RoamMode = "chase";
  private keepDistance = 380;
  /** 搬运路点队列：每个图标两个点（走到图标 grab → 走到区域 drop） */
  private carryQ: CarryPoint[] = [];
  private onCarryArrive: ((p: CarryPoint) => void) | null = null;
  /** 到达一个路点后的停留时间（抓/放的动作时长） */
  private dwell = 0;

  get params(): DogParams {
    return paramsFor(this.stage);
  }

  get canvasX(): number {
    return this.x;
  }

  /** 脚底锚点（画布 y） */
  get anchorY(): number {
    return this.y;
  }

  get facing(): 1 | -1 {
    return this.dir;
  }

  /** 拖动中按移动方向翻朝向（渲染层带迟滞调用）；点击微抖不会走到这里 */
  setFacing(dir: 1 | -1): void {
    this.dir = dir;
  }

  get isEating(): boolean {
    return this.behavior === "goto" || this.behavior === "eat";
  }

  /**
   * 整理搬运动画：points 是展平的路点（每个图标 grab+drop 两个，含二维坐标）。
   * 狗依次走到每个路点，到点回调 onArrive（抓/放）；队列走空回待机。
   */
  startCarry(points: CarryPoint[], onArrive: (p: CarryPoint) => void): void {
    this.carryQ = points.slice(0, 60);
    this.onCarryArrive = onArrive;
    this.dwell = 0;
    if (this.carryQ.length > 0) this.enter("carry", 9999);
  }

  /** 体型档位（成长系统已取消，只给 dev 预览钩子用） */
  setSize(stage: Stage): void {
    this.stage = stage;
  }

  setRoam(mode: RoamMode, keepDistance: number): void {
    this.roam = mode;
    this.keepDistance = Math.max(60, keepDistance);
    this.target = null;
    if (this.behavior === "walk" || this.behavior === "run") this.enter("idle", 0.6);
  }

  setCursor(x: number, y: number): void {
    this.mouse = { x, y, seen: true };
  }

  /** 左键抚摸 */
  pet(): void {
    if (this.isEating) return;
    this.enter("happy", 1.15);
  }

  /** 菜单「回到食盆旁」与不跟随模式共用：走回右下角蹲着 */
  recall(): void {
    this.startMeal(0);
  }

  /**
   * 开饭：bites = 这次吃掉的份数。
   * 已经在碗边就继续低头，否则先走过去 —— 「狗跑过去吃」是这功能的灵魂。
   */
  startMeal(bites: number): void {
    this.bites = Math.min(this.bites + bites, MAX_BITES);
    if (this.behavior === "eat" || Math.abs(this.x - this.eatSpot()) < 16) {
      this.arriveAtBowl();
      this.enter("eat", BITE_SECONDS * Math.max(1, this.bites));
    } else {
      this.enter("goto", 9999);
    }
  }

  beginDrag(): void {
    this.target = null;
    this.carryQ = [];
    this.enter("drag", 9999);
  }

  /**
   * 拎着狗走：脚底位置直接跟手，全屏任意处。
   * 这里不改朝向 —— 点击（mousedown→mouseup）时的 1~2px 微抖也会调到这里，
   * 若强制翻朝向，就会出现「点一下狗头，狗头就甩到另一侧」的 bug。
   * 拖动中翻朝向由渲染层按移动方向调 setFacing()（带迟滞）。
   */
  dragTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.clampPos();
  }

  endDrag(): void {
    if (this.isEating) {
      this.enter("goto", 9999);
      return;
    }
    this.enter("idle", 0.4);
  }

  private eatSpot(): number {
    return this.room.bowlX - BOWL_STANDOFF;
  }

  private arriveAtBowl(): void {
    this.x = this.eatSpot();
    this.y = this.room.groundY;
    // 盆在右边，所以低头吃的时候脸朝右
    this.dir = 1;
  }

  private enter(next: Behavior, seconds: number): void {
    this.behavior = next;
    this.left = seconds;
  }

  update(dt: number): Pose {
    this.clock += dt;
    // eat 状态也要减 left，否则进食动画永远不会结束
    if (
      this.behavior !== "goto" &&
      this.behavior !== "drag" &&
      this.behavior !== "carry"
    ) {
      this.left -= dt;
    }

    const p = this.params;
    const pose = neutralPose(p, this.x, this.y);
    pose.dir = this.dir;
    pose.breath = Math.sin(this.clock * TAU * 0.45);
    pose.tailSwing = Math.sin(this.clock * TAU * 0.7) * 0.35;
    pose.tailLift = 0.3;
    this.blink(pose, dt);

    this.step(dt, pose, p);

    // 非移动状态下，狗脸朝着鼠标（能看到你）；但鼠标进入狗身体范围时冻结朝向，
    // 否则头/屁股会跟着鼠标转、永远点不准（无法交互）。
    const mp = this.params;
    const bodyHalf = (Math.abs(mp.bodyBack) + mp.headX + mp.headR) * mp.scale;
    const mouseOnDog = Math.abs(this.mouse.x - this.x) < bodyHalf;
    if (
      this.mouse.seen &&
      !mouseOnDog &&
      this.behavior !== "goto" &&
      this.behavior !== "carry" &&
      this.behavior !== "drag" &&
      this.behavior !== "run" &&
      this.behavior !== "walk" &&
      this.behavior !== "spin" && // 转圈动作自己要翻面，别被「脸朝鼠标」抢走
      this.behavior !== "eat" // 吃饭要一直朝碗，不能跟着鼠标转
    ) {
      this.dir = this.mouse.x > this.x ? 1 : -1;
    }

    return pose;
  }

  private step(dt: number, pose: Pose, p: DogParams): void {
    switch (this.behavior) {
      case "goto":
        this.gotoStep(dt, pose, p);
        return;
      case "eat":
        this.eatStep(pose);
        return;
      case "drag":
        this.dragPose(pose);
        return;
      case "carry":
        this.carryStep(dt, pose, p);
        return;
      case "happy":
        this.happyPose(pose);
        // 摸完必须回 idle，否则永远卡在 happy：不再追鼠标、也不再播随机动作
        if (this.left <= 0) this.enter("idle", rand(1.5, 3));
        return;
      case "pant":
        this.pantPose(pose);
        if (this.left <= 0) this.enter("idle", rand(2, 5));
        return;
      case "stretch":
        this.stretchPose(pose);
        if (this.left <= 0) this.enter("idle", rand(2, 5));
        return;
      case "roll":
        this.rollPose(pose);
        if (this.left <= 0) this.enter("idle", rand(2, 5));
        return;
      case "scratch":
        this.scratchPose(pose);
        if (this.left <= 0) this.enter("idle", rand(2, 5));
        return;
      case "spin":
        this.spinPose(dt, pose);
        if (this.left <= 0) this.enter("idle", rand(2, 5));
        return;
      case "yawn":
        this.yawnPose(pose);
        if (this.left <= 0) this.enter("idle", rand(2, 5));
        return;
      default:
        break;
    }

    if (this.roamStep(dt, pose, p)) return;
    this.wanderStep(dt, pose, p);
  }

  private gotoStep(dt: number, pose: Pose, p: DogParams): void {
    const arrived = this.seek(dt, pose, p, this.eatSpot(), this.room.groundY, true);
    this.behavior = "goto"; // seek 内部的 animateMove 不改 behavior，这里显式保持
    if (arrived) {
      this.arriveAtBowl();
      this.enter("eat", BITE_SECONDS * Math.max(1, this.bites));
    }
  }

  /** 搬运：走到当前路点 (x,y)，停下做抓/放动作，再追下一个 */
  private carryStep(dt: number, pose: Pose, p: DogParams): void {
    if (this.dwell > 0) {
      this.dwell -= dt;
      this.behavior = "carry";
      // 抓/放的姿态：张嘴、竖耳、猛摇尾
      pose.mouth = 1;
      pose.tongue = 0.3;
      pose.earPerk = 0.6;
      pose.tailLift = 1;
      pose.tailSwing = Math.sin(this.clock * TAU * 6) * 0.8;
      return;
    }
    const t = this.carryQ[0];
    if (!t) {
      this.onCarryArrive = null;
      this.enter("idle", rand(1.5, 3));
      return;
    }
    // 到位目标 x 先夹到狗可达范围：靠右边缘的落点/图标可能超出 maxX（再走头会顶出屏幕），
    // 不夹的话狗走到头也判不到位、卡在这个路点，导致后面所有文件都不落位。
    const tx = Math.max(this.minX(), Math.min(this.maxX(), t.x));
    const dx = tx - this.x;
    const dy = t.y - this.y;
    // 到位只看横向：狗是地面精灵，脚底 y 有下限（身体高度），靠顶行的图标 / 区域顶部落点
    // 的 y 狗根本到不了；若要求二维到位会永远卡在这个路点上，导致后面的文件全不落位。
    if (Math.abs(dx) <= 16) {
      this.onCarryArrive?.(t);
      this.carryQ.shift();
      this.dwell = 0.32;
      this.behavior = "carry";
      return;
    }
    const dist = Math.hypot(dx, dy) || 1;
    const step = Math.min(RUN_SPEED * p.scale * dt, dist);
    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;
    this.clampPos();
    if (Math.abs(dx) > 2) this.dir = dx > 0 ? 1 : -1;
    this.animateMove(pose, dt, true);
    this.behavior = "carry";
  }

  private eatStep(pose: Pose): void {
    const chew = Math.sin(this.clock * TAU * 3.4);
    pose.headDip = 0.62 + 0.3 * Math.sin(this.clock * TAU * 0.85);
    pose.mouth = 1;
    pose.tongue = 0.25 + 0.2 * Math.max(0, chew);
    pose.breath = Math.sin(this.clock * TAU * 1.3) * 0.6;
    pose.tailLift = 1;
    pose.tailSwing = Math.sin(this.clock * TAU * 4.2) * 0.85;
    pose.earPerk = 0.35;
    if (this.left <= 0) {
      this.bites = Math.max(0, this.bites - 1);
      if (this.bites > 0) this.enter("eat", BITE_SECONDS);
      else this.enter("idle", rand(2, 4));
    }
  }

  private dragPose(pose: Pose): void {
    pose.earPerk = 0.7;
    pose.headTilt = -0.12;
    pose.tailSwing = Math.sin(this.clock * TAU * 3.4) * 0.5;
    pose.tailLift = 0.6;
    pose.legAmp = 0.14;
    pose.legPhase += 0.016 * TAU * 1.4;
  }

  private happyPose(pose: Pose): void {
    const hop = Math.sin(Math.PI * clamp01(1 - this.left / 1.15));
    pose.bob = -hop * 10;
    pose.squash = hop * 0.5;
    pose.mouth = 1;
    pose.tongue = 0.35;
    pose.earPerk = 1;
    pose.tailSwing = Math.sin(this.clock * TAU * 6.5) * 0.9;
    pose.tailLift = 1;
    pose.headTilt = 0.14 * Math.sin(this.clock * TAU * 3);
  }

  private pantPose(pose: Pose): void {
    pose.mouth = 1;
    pose.tongue = 0.45 + 0.55 * Math.abs(Math.sin(this.clock * TAU * 2.1));
    pose.breath = Math.sin(this.clock * TAU * 1.1);
    pose.headLift = -2;
  }

  /** 伸懒腰：前腿向前伸，屁股抬高，尾巴翘起 */
  private stretchPose(pose: Pose): void {
    const t = 1 - clamp01(this.left / 2.0); // 0→1 进度
    const peak = Math.sin(t * Math.PI); // 先升后降
    pose.headDip = peak * 0.5;
    pose.lean = peak * 0.12;
    pose.tailLift = 0.5 + peak * 0.5;
    pose.legAmp = peak * 0.2;
    pose.legPhase = this.clock * TAU * 0.5;
    pose.earPerk = peak * 0.6;
  }

  /** 打滚：整个身体左右摇摆 */
  private rollPose(pose: Pose): void {
    const t = 1 - clamp01(this.left / 2.5);
    const swing = Math.sin(t * Math.PI * 4) * (1 - t); // 逐渐衰减的摇摆
    pose.lean = swing * 0.3;
    pose.bob = Math.abs(swing) * -8;
    pose.tailLift = 0.8;
    pose.tailSwing = swing * 1.2;
    pose.mouth = 0.5;
    pose.earPerk = 0.3;
  }

  /** 抓痒：后腿快速抖动，头偏一侧 */
  private scratchPose(pose: Pose): void {
    const t = 1 - clamp01(this.left / 1.8);
    const shake = Math.sin(t * Math.PI * 12) * (1 - t * 0.5);
    pose.legAmp = 0.15;
    pose.legPhase = this.clock * TAU * 8;
    pose.headTilt = shake * 0.2;
    pose.earTwitch = Math.abs(shake) * 4;
    pose.tailSwing = shake * 0.5;
    pose.tailLift = 0.6;
  }

  /** 追尾巴转圈：朝向快速翻面模拟原地打转（先慢→快→慢） */
  private spinPose(_dt: number, pose: Pose): void {
    const t = 1 - clamp01(this.left / 2.2);
    const speed = Math.sin(t * Math.PI); // 0→1→0，控制翻面频率
    this.dir = Math.sin(this.clock * TAU * (0.8 + speed * 1.6)) > 0 ? 1 : -1;
    pose.lean = 0.1;
    pose.bob = Math.sin(this.clock * TAU * 6) * 3;
    pose.tailLift = 1;
    pose.tailSwing = Math.sin(this.clock * TAU * 8) * 1;
    pose.mouth = 0.6;
    pose.earPerk = 0.8;
  }

  /** 打哈欠：嘴张大，头后仰，眼睛眯起 */
  private yawnPose(pose: Pose): void {
    const t = 1 - clamp01(this.left / 1.6);
    const open = Math.sin(t * Math.PI); // 先张后合
    pose.mouth = open;
    pose.headLift = -open * 6;
    pose.headTilt = -open * 0.15;
    pose.blink = open * 0.7;
    pose.earPerk = -open * 0.3;
    pose.tailLift = 0.3;
  }

  /**
   * 追/躲/蹲点。返回 true 表示这一帧已被漫游接管。
   * 「反向奔跑」就在这里：鼠标换边/换上下，狗掉头（改 dir）再跑。
   */
  private roamStep(dt: number, pose: Pose, p: DogParams): boolean {
    if (this.roam === "wander") return false;

    if (this.roam === "stay") {
      // 不跟随：自己走回右下角食盆旁蹲着。不依赖鼠标位置，刚启动也能去蹲点
      const arrived = this.seek(dt, pose, p, this.eatSpot(), this.room.groundY, true);
      this.behavior = "run";
      if (arrived) {
        this.behavior = "idle";
        // 蹲点也会无聊：待机计时到点原地播个随机小动作
        if (this.left <= 0) this.idleDecision(false);
        this.idlePose(pose);
      }
      return true;
    }

    if (!this.mouse.seen) return false;
    const dx = this.mouse.x - this.x;
    const dy = this.mouse.y - this.y;
    const dist = Math.hypot(dx, dy);
    const edge = this.keepDistance * (this.roam === "chase" ? 1 : 1.7);
    const shouldMove = this.roam === "chase" ? dist > edge : dist < edge;

    if (!shouldMove) {
      // 追到附近停下：先站一会儿喘口气（不能每次重置计时），待机计时到点再随机播个小动作
      if (this.behavior !== "idle") this.enter("idle", rand(1.5, 4));
      if (this.left <= 0) this.idleDecision(false);
      this.idlePose(pose);
      return true;
    }
    // chase 朝鼠标走，flee 朝鼠标反方向走
    const tx = this.roam === "chase" ? this.mouse.x : this.x - dx;
    const ty = this.roam === "chase" ? this.mouse.y : this.y - dy;
    this.seek(dt, pose, p, tx, ty, true);
    this.behavior = "run";
    return true;
  }

  /** 随机闲逛：挑一个二维目的地走过去，到了喘一会儿 */
  private wanderStep(dt: number, pose: Pose, p: DogParams): void {
    if (this.behavior === "walk") {
      if (!this.target) {
        this.target = { x: rand(this.minX(), this.maxX()), y: rand(this.minY(), this.maxY()) };
      }
      const arrived = this.seek(dt, pose, p, this.target.x, this.target.y, false);
      this.behavior = "walk";
      if (arrived) {
        this.target = null;
        this.enter("pant", rand(1.2, 2.4));
        this.pantPose(pose);
      }
      return;
    }
    // idle：计时到了就决定下一步（wander 模式允许闲逛，其余也随机播小动作）
    if (this.left <= 0) this.idleDecision(true);
    this.idlePose(pose);
  }

  /**
   * 待机计时到点：随机挑下一个动作，播完各自回 idle 续计时，
   * 形成「待机 → 小动作 → 待机」的循环。
   * allowWalk=false（追/躲/蹲点模式）时不挑闲逛 —— 走开会打断那几种模式的语义；
   * 原地动作（伸懒腰/打滚/抓痒/追尾/哈欠/喘气）任何模式都能播。
   */
  private idleDecision(allowWalk: boolean): void {
    const roll = Math.random();
    if (allowWalk && roll < 0.25) this.enter("walk", 9999);
    else if (roll < 0.33) this.enter("pant", rand(1.6, 3));
    else if (roll < 0.47) this.enter("stretch", 2.0);
    else if (roll < 0.61) this.enter("roll", 2.5);
    else if (roll < 0.75) this.enter("scratch", 1.8);
    else if (roll < 0.88) this.enter("spin", 2.2);
    else this.enter("yawn", 1.6);
  }

  private idlePose(pose: Pose): void {
    pose.bob = Math.sin(this.clock * TAU * 0.45) * 0.8;
    pose.earTwitch = Math.max(0, Math.sin(this.clock * TAU * 0.21) - 0.96) * 12;
  }

  /**
   * 朝 (tx,ty) 走一步，返回是否已到达。只负责位移 + 姿态动画，
   * 不改 behavior —— 由调用方维持自己的状态，避免「多帧状态只跑一帧」的老 bug。
   */
  private seek(dt: number, pose: Pose, p: DogParams, tx: number, ty: number, run: boolean): boolean {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dist = Math.hypot(dx, dy);
    const arriveAt = run ? 12 : 6;
    if (dist <= arriveAt) {
      this.x = tx;
      this.y = ty;
      this.clampPos();
      return true;
    }
    const speed = (run ? RUN_SPEED : WALK_SPEED) * p.scale;
    const move = Math.min(speed * dt, dist);
    this.x += (dx / dist) * move;
    this.y += (dy / dist) * move;
    this.clampPos();
    if (Math.abs(dx) > 2) this.dir = dx > 0 ? 1 : -1;
    this.animateMove(pose, dt, run);
    return false;
  }

  /** 走动姿态（腿/身/尾），不改 behavior */
  private animateMove(pose: Pose, dt: number, run: boolean): void {
    this.legPhase += dt * TAU * (run ? 5.4 : 2.2);
    pose.legPhase = this.legPhase;
    pose.legAmp = run ? 0.62 : 0.34;
    pose.lean = run ? 0.08 : 0.02;
    pose.bob = Math.sin(this.legPhase * 2) * (run ? 3 : 1.8) - (run ? 1.5 : 1);
    pose.tailLift = run ? 1 : 0.75;
    pose.tailSwing = Math.sin(this.clock * TAU * (run ? 7 : 1.6)) * (run ? 0.9 : 0.6);
    pose.earPerk = run ? 0.5 : 0;
    pose.headTilt = run ? -0.05 : 0.06;
  }

  /** 单眼眨一下 0.16s，间隔 2.2~6.5s 随机 */
  private blink(pose: Pose, dt: number): void {
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blinkAt = this.clock;
      this.nextBlink = rand(2.2, 6.5);
    }
    if (this.blinkAt < 0) return;
    const DUR = 0.16;
    const t = this.clock - this.blinkAt;
    if (t >= DUR) this.blinkAt = -1;
    else pose.blink = Math.sin((t / DUR) * Math.PI);
  }

  /** 身体高度（脚底到耳尖），决定脚底最低能到哪（不让身体顶出上边界） */
  private bodyH(): number {
    const p = this.params;
    return (p.headY + p.headR + p.earLen) * p.scale;
  }

  private minX(): number {
    return -this.params.bodyBack * this.params.scale + 12;
  }

  private maxX(): number {
    const p = this.params;
    return this.room.width - (p.headX + p.headR * 1.7 + p.muzzle) * p.scale - 12;
  }

  private minY(): number {
    return this.bodyH() + 6;
  }

  private maxY(): number {
    return this.room.groundY;
  }

  private clampPos(): void {
    this.x = Math.max(this.minX(), Math.min(this.maxX(), this.x));
    this.y = Math.max(this.minY(), Math.min(this.maxY(), this.y));
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
