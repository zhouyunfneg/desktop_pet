import type { DogParams } from "./params";

/** 一帧里所有可变的部分，绘制函数只读它，不自己算时间 */
export interface Pose {
  params: DogParams;
  /** 画布坐标：脚底中心 */
  x: number;
  groundY: number;
  dir: 1 | -1;
  /** 呼吸起伏 -1..1 */
  breath: number;
  /** 躯干上下位移（局部单位） */
  bob: number;
  /** 躯干垂直挤压，跳跃落地用 */
  squash: number;
  /** 奔跑前倾（弧度），正值 = 向面朝方向压过去 */
  lean: number;
  /** 摆尾 -1..1 */
  tailSwing: number;
  /** 尾巴上抬 0..1 */
  tailLift: number;
  /** 耳朵抖动 0..1 */
  earTwitch: number;
  /** 耳朵额外立起量 0..1（开心时竖耳） */
  earPerk: number;
  headTilt: number;
  headLift: number;
  /** 低头进盆 0..1，吃饭动画用 */
  headDip: number;
  /** 走路相位与幅度 */
  legPhase: number;
  legAmp: number;
  /** 0 睁眼 1 闭眼 */
  blink: number;
  /** 0 闭嘴 1 张嘴 */
  mouth: number;
  tongue: number;
}

export function neutralPose(params: DogParams, x: number, groundY: number): Pose {
  return {
    params,
    x,
    groundY,
    dir: 1,
    breath: 0,
    bob: 0,
    squash: 0,
    lean: 0,
    tailSwing: 0,
    tailLift: 0,
    earTwitch: 0,
    earPerk: 0,
    headTilt: 0,
    headLift: 0,
    headDip: 0,
    legPhase: 0,
    legAmp: 0,
    blink: 0,
    mouth: 0,
    tongue: 0
  };
}
