import { describe, expect, it } from "vitest";
import {
  briefOf,
  condOf,
  moodOf,
  NO_WEATHER,
  parseWeather,
  THRESHOLD,
  MOOD_SECONDS,
  type WeatherMood,
  type WeatherNow
} from "../src/shared/weather";
import { WeatherFx } from "../src/renderer/pet/weather";
import { neutralPose } from "../src/renderer/pet/pose";
import { paramsFor } from "../src/renderer/pet/params";

/** 一个「什么都不特殊」的晴天底版，各分支只改需要改的那一项 */
function w(over: Partial<WeatherNow> = {}): WeatherNow {
  return {
    tempC: 20,
    feelsC: 20,
    uv: 3,
    windKmh: 10,
    precipMM: 0,
    humidity: 50,
    code: 113,
    desc: "Sunny",
    minC: 15,
    maxC: 25,
    ...over
  };
}

describe("parseWeather：只认接口真给的形状", () => {
  /** wttr.in 的 j1 里数字全是字符串，weatherDesc 是数组 —— 照真响应写 */
  const j1 = {
    current_condition: [
      {
        temp_C: "7",
        FeelsLikeC: "3",
        uvIndex: "1",
        windspeedKmph: "28",
        precipMM: "0.8",
        humidity: "86",
        weatherCode: "266",
        weatherDesc: [{ value: "Light drizzle " }]
      }
    ],
    weather: [{ mintempC: "-2", maxtempC: "8" }]
  };

  it("把字符串数字洗成数字，描述去掉首尾空格", () => {
    const r = parseWeather(j1);
    expect(r).not.toBeNull();
    expect(r?.tempC).toBe(7);
    expect(r?.feelsC).toBe(3);
    expect(r?.precipMM).toBe(0.8);
    expect(r?.humidity).toBe(86);
    expect(r?.code).toBe(266);
    expect(r?.desc).toBe("Light drizzle");
    expect(r?.minC).toBe(-2);
    expect(r?.maxC).toBe(8);
  });

  it("缺 body 一律返回 null，不硬凑一个 0℃ 晴天", () => {
    expect(parseWeather(null)).toBeNull();
    expect(parseWeather({})).toBeNull();
    expect(parseWeather({ current_condition: [] })).toBeNull();
    expect(parseWeather("Sunny, +20°C")).toBeNull();
  });

  it("体感/当日气温缺失时退回当前气温，不会出现 0℃ 假数据", () => {
    const r = parseWeather({ current_condition: [{ temp_C: "22", weatherCode: "116", weatherDesc: [{ value: "Partly cloudy" }] }], weather: [{}] });
    expect(r?.feelsC).toBe(22);
    expect(r?.minC).toBe(22);
    expect(r?.maxC).toBe(22);
  });
});

describe("moodOf：档位按优先级判定", () => {
  const cases: [WeatherNow, WeatherMood][] = [
    [w(), "clear"],
    // 打雷时也在下雨，但雷更值得注意
    [w({ code: 200, precipMM: 4, desc: "Thundery outbreaks" }), "thunder"],
    // 下雪的降水量也 >0，所以雪必须排在雨前面
    [w({ code: 338, precipMM: 1.2, desc: "Heavy snow" }), "snow"],
    [w({ code: 353, desc: "Light rain" }), "rain"],
    [w({ code: 113, precipMM: 0.4 }), "rain"],
    [w({ code: 143, desc: "Haze" }), "haze"],
    // 代码没命中时描述兜底
    [w({ code: 113, desc: "Smoky haze" }), "haze"],
    [w({ code: 113, windKmh: THRESHOLD.windKmh }), "wind"],
    [w({ code: 116, desc: "Partly cloudy", uv: THRESHOLD.heatUv }), "heat"],
    [w({ code: 116, desc: "Partly cloudy", tempC: THRESHOLD.heatTemp }), "heat"],
    [w({ code: 116, desc: "Partly cloudy", feelsC: THRESHOLD.coldFeels }), "cold"],
    [w({ code: 116, desc: "Partly cloudy" }), "other"],
    // 取不到数据时不许乱演
    [null as unknown as WeatherNow, "other"]
  ];
  it.each(cases)("%o → %s", (input, want) => {
    expect(moodOf(input)).toBe(want);
  });
});

describe("briefOf：只报「现在几度 + 什么天气」", () => {
  it("温度和中文状况，不带湿度风速紫外线那些", () => {
    const text = briefOf(w({ tempC: 18, code: 149, desc: "Smoky haze", humidity: 86, windKmh: 28 }));
    expect(text).toContain("现在 18℃");
    expect(text).toContain("雾霾");
    expect(text).not.toContain("湿度");
    expect(text).not.toContain("km/h");
    expect(text).not.toContain("Smoky");
    expect(text).not.toContain("NaN");
    // 一句话能一眼看完（气泡要放在嘴前方，太长就顶到屏幕外）
    expect(text.length).toBeLessThanOrEqual(18);
  });

  it("天气码翻成常用的中文说法", () => {
    expect(condOf(w({ code: 113 }))).toBe("晴");
    expect(condOf(w({ code: 116 }))).toBe("多云");
    expect(condOf(w({ code: 308 }))).toBe("大雨");
    expect(condOf(w({ code: 338 }))).toBe("大雪");
    expect(condOf(w({ code: 200 }))).toBe("雷阵雨");
    expect(condOf(w({ code: 248 }))).toBe("雾");
  });

  it("没收录的天气码退回英文描述里的关键词，再退档位词，不会出现 undefined 或空", () => {
    expect(condOf(w({ code: 999, desc: "Moderate rain" }))).toBe("中雨");
    expect(condOf(w({ code: 999, desc: "Light snow" }))).toBe("小雪");
    expect(condOf(w({ code: 999, desc: "Partly cloudy" }))).toBe("多云");
    // 连描述都没有时用最保守的档位词
    expect(condOf(w({ code: 999, desc: "" }))).toBe("多云");
    expect(briefOf(w({ code: 999, desc: "" }))).toContain("℃");
  });
});

describe("档位时长：每种都要有，而且短（点一下才播一次）", () => {
  const moods: WeatherMood[] = ["thunder", "snow", "rain", "haze", "wind", "heat", "cold", "clear", "other"];
  it.each(moods)("%s 演 1~5 秒", (m) => {
    expect(MOOD_SECONDS[m]).toBeGreaterThan(1);
    expect(MOOD_SECONDS[m]).toBeLessThan(5);
  });

  it("查不到天气的回执是空串，渲染层据此什么都不演", () => {
    expect(NO_WEATHER.text).toBe("");
  });
});

/** 画布上下文只用来记录「画没画」，测试不校验像素 */
const ctx = {
  strokeStyle: "",
  fillStyle: "",
  lineWidth: 1,
  beginPath: () => undefined,
  closePath: () => undefined,
  moveTo: () => undefined,
  lineTo: () => undefined,
  quadraticCurveTo: () => undefined,
  stroke: () => undefined,
  fill: () => undefined,
  arc: () => undefined,
  ellipse: () => undefined,
  fillRect: () => undefined
} as unknown as CanvasRenderingContext2D;

const FOOT = { x: 500, y: 400 };
const HEAD = { x: 560, y: 300 };
const DT = 1 / 60;

/** 走一帧，顺序和 src/renderer/main.ts 的 frame() 一致：update → dirty → draw */
function frame(fx: WeatherFx, dt = DT, foot = FOOT) {
  fx.update(dt, HEAD, foot, 1);
  const dirty = fx.dirty();
  if (fx.active) fx.draw(ctx);
  return dirty;
}

function pose(over: Partial<ReturnType<typeof neutralPose>> = {}) {
  return { ...neutralPose(paramsFor("adult"), FOOT.x, FOOT.y), tailLift: 0.3, ...over };
}

describe("WeatherFx：一次性的天气那一下", () => {
  it("没开始就什么都不干：不报框、不改姿态", () => {
    const fx = new WeatherFx();
    expect(fx.active).toBe(false);
    expect(fx.paintBox()).toBeNull();
    expect(frame(fx)).toBeNull();
    const p = pose();
    fx.pose(p);
    // 每个数字都得原样留着，否则待机动画会被这层悄悄改掉
    expect(p).toEqual(pose());
  });

  it("播完自己停；停的那一帧再报一次最后画过的位置（擦残影），之后不再占脏区", () => {
    const fx = new WeatherFx();
    fx.start("rain");
    expect(fx.active).toBe(true);
    const boxes: NonNullable<ReturnType<typeof fx.dirty>>[] = [];
    for (let i = 0; i < 400 && fx.active; i++) {
      const d = frame(fx);
      if (d) boxes.push(d);
    }
    expect(fx.active).toBe(false);
    // 雨演 3.6 秒 ≈ 216 帧，不该拖到半分钟
    expect(boxes.length).toBeGreaterThan(150);
    expect(boxes.length).toBeLessThan(260);
    expect(boxes[boxes.length - 1]).toEqual({ x: FOOT.x - 120, y: FOOT.y - 150, w: 240, h: 174 });
    expect(fx.dirty()).toBeNull();
  });

  it("狗边走边演时脏区 = 本帧 ∪ 上一帧，否则旧位置的雨丝留在屏幕上", () => {
    const fx = new WeatherFx();
    fx.start("snow");
    const a = frame(fx, DT, { x: 500, y: 400 });
    const b = frame(fx, DT, { x: 700, y: 400 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.x).toBeLessThanOrEqual(500 - 120);
    expect(b!.x + b!.w).toBeGreaterThanOrEqual(700 + 120);
  });

  it("重复点击只是重开一次，不会把两段叠起来", () => {
    const fx = new WeatherFx();
    fx.start("rain");
    for (let i = 0; i < 10; i++) frame(fx);
    fx.start("thunder");
    expect(fx.active).toBe(true);
    //  thunder 只演 2.6 秒：重开之后剩余时间应该等于新的时长
    let left = 0;
    while (fx.active && left++ < 600) frame(fx);
    expect(left).toBeLessThan(220);
  });

  it("每种档位都会改到对应的姿态数字", () => {
    const check: [WeatherMood, (p: ReturnType<typeof pose>) => boolean][] = [
      ["rain", (p) => p.mouth > 0 && p.earPerk <= -0.15],
      ["snow", (p) => p.earPerk <= -0.2],
      ["haze", (p) => p.blink >= 0.45],
      ["wind", (p) => p.earPerk <= -0.5],
      ["heat", (p) => p.mouth === 1 && p.tongue > 0.4],
      ["cold", (p) => p.squash >= 0.25 && p.tailLift <= 0.12],
      ["thunder", (p) => p.tailLift <= 0.05 && p.earPerk >= 0.9],
      ["clear", (p) => p.tailLift >= 0.9],
      ["other", (p) => p.headLift > 0]
    ];
    for (const [mood, ok] of check) {
      const fx = new WeatherFx();
      fx.start(mood);
      fx.update(DT, HEAD, FOOT, 1);
      const p = pose();
      fx.pose(p);
      expect(ok(p), `${mood} 该改到的数字没改`).toBe(true);
    }
  });
});
