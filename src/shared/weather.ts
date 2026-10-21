/**
 * 天气 → 狗的表现：这一层只负责「把接口给的数字翻译成一个档位 + 一句人话」。
 *
 * 纯函数、不碰网络也不碰画布，所以能在 node 下直接单测；
 * 取数据在 src/main/info-service.ts，播效果在 src/renderer/pet/weather.ts。
 *
 * 档位判定用的是 wttr.in 的 weatherCode（世界气象组织编码，稳定），
 * 描述文字（"Smoky haze" 这类）只做兜底 —— 它随时可能改拼写、大小写、带尾空格。
 */

/** 狗能演的档位。clear / other 是「没什么特别的」 */
export type WeatherMood = "thunder" | "snow" | "rain" | "haze" | "wind" | "heat" | "cold" | "clear" | "other";

export interface WeatherNow {
  /** 气温 ℃ */
  tempC: number;
  /** 体感 ℃ */
  feelsC: number;
  /** 紫外线指数 0..11+ */
  uv: number;
  /** 风速 km/h */
  windKmh: number;
  /** 近一小时降水量 mm */
  precipMM: number;
  /** 相对湿度 % */
  humidity: number;
  /** 天气代码（WWO） */
  code: number;
  /** 英文描述，只做兜底 */
  desc: string;
  /** 今天的最低温（现在的气泡文案只用不上，留给以后「比昨天冷」这类话） */
  minC: number;
  /** 今天的最高温（同上） */
  maxC: number;
}

const THUNDER = [200, 386, 389, 392];
const SNOW = [179, 182, 185, 227, 230, 329, 332, 335, 338, 350, 395];
const RAIN = [176, 263, 266, 269, 281, 284, 293, 296, 299, 302, 308, 311, 314, 353, 356, 359, 362, 365, 368, 371, 374, 377];
const HAZE = [143, 149, 248, 260];

/** 档位判定用的阈值全部来自这里，改观感不用翻绘制代码 */
export const THRESHOLD = {
  windKmh: 25,
  heatUv: 6,
  heatTemp: 30,
  coldFeels: 5
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
};
const flt = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * 清洗 wttr.in 的 j1 响应。结构不对、字段缺失一律返回 null（宁可什么都不演），
 * 只认 current_condition[0] 和 weather[0] 的最低/最高温。
 */
export function parseWeather(raw: unknown): WeatherNow | null {
  const o = raw as { current_condition?: unknown[]; weather?: unknown[] } | null;
  const c = Array.isArray(o?.current_condition) ? o.current_condition[0] : null;
  if (!c || typeof c !== "object") return null;
  const cur = c as Record<string, unknown>;
  const descList = Array.isArray(cur.weatherDesc) ? cur.weatherDesc : [];
  const desc = typeof descList[0]?.value === "string" ? descList[0].value.trim() : "";
  const day = (Array.isArray(o?.weather) ? o.weather[0] : null) as { mintempC?: unknown; maxtempC?: unknown } | null;
  const tempC = num(cur.temp_C);
  return {
    tempC,
    feelsC: num(cur.FeelsLikeC) || tempC,
    uv: num(cur.uvIndex),
    windKmh: num(cur.windspeedKmph),
    precipMM: flt(cur.precipMM),
    humidity: num(cur.humidity),
    code: num(cur.weatherCode),
    desc,
    minC: num(day?.mintempC) || tempC,
    maxC: num(day?.maxtempC) || tempC
  };
}

/**
 * 一个数字档位 → 狗该演什么。顺序有意义：雷 > 雪 > 雨 > 雾霾 > 大风 > 暴晒 > 降温 > 晴。
 * 下大雨同时打雷时演雷（更值得注意），下雪时降水量也是 >0 所以雪要排在雨前面。
 */
export function moodOf(w: WeatherNow | null): WeatherMood {
  if (!w) return "other";
  if (THUNDER.includes(w.code)) return "thunder";
  if (SNOW.includes(w.code)) return "snow";
  if (RAIN.includes(w.code) || w.precipMM > 0) return "rain";
  if (HAZE.includes(w.code) || /haze|mist|fog|smoke|dust|sand/i.test(w.desc)) return "haze";
  if (w.windKmh >= THRESHOLD.windKmh) return "wind";
  if (w.uv >= THRESHOLD.heatUv || w.tempC >= THRESHOLD.heatTemp) return "heat";
  if (w.feelsC <= THRESHOLD.coldFeels) return "cold";
  if (w.code === 113 || /sunny|clear/i.test(w.desc)) return "clear";
  return "other";
}

const ICON: Record<WeatherMood, string> = {
  thunder: "⛈",
  snow: "❄️",
  rain: "🌧",
  haze: "🌫",
  wind: "💨",
  heat: "☀️",
  cold: "🥶",
  clear: "🌤",
  other: "☁️"
};

/**
 * 天气代码 → 普通人每天看的那一个词。wttr.in 的描述是英文（"Smoky haze"），
 * 直接甩给同事看等于没报，所以这里翻成常用的说法。
 * 只收有把握的常用码，没收录的走下面 moodOf 的档位词兜底，绝不会出现 "undefined"。
 */
const CONDITION_CN: Record<number, string> = {
  113: "晴",
  116: "多云",
  119: "阴",
  122: "阴",
  143: "薄雾",
  176: "有雨",
  179: "有雪",
  182: "雨夹雪",
  185: "冻毛毛雨",
  200: "雷阵雨",
  215: "大风",
  227: "吹雪",
  230: "暴雪",
  248: "雾",
  260: "冻雾",
  263: "毛毛雨",
  266: "毛毛雨",
  271: "冻毛毛雨",
  281: "冻毛毛雨",
  284: "小雨",
  293: "小雨",
  296: "小雨",
  299: "中雨",
  302: "中雨",
  305: "大雨",
  308: "大雨",
  311: "冻雨",
  314: "冻雨",
  317: "雨夹雪",
  320: "雨夹雪",
  323: "小雪",
  326: "中雪",
  329: "大雪",
  332: "小雪",
  335: "中雪",
  338: "大雪",
  350: "阵雨",
  353: "阵雨",
  356: "强阵雨",
  359: "雷阵雨",
  362: "雷阵雨",
  365: "雷阵雨",
  368: "阵雪",
  371: "阵雪",
  374: "阵雪",
  377: "阵雪",
  386: "雷阵雨",
  389: "雷阵雨",
  392: "雷阵雨",
  395: "雷阵雪"
};

/** 档位词：码没收录时用它，保证永远有一个中文说法 */
const MOOD_CN: Record<WeatherMood, string> = {
  thunder: "雷阵雨",
  snow: "下雪",
  rain: "下雨",
  haze: "雾霾",
  wind: "大风",
  heat: "暴晒",
  cold: "严寒",
  clear: "晴",
  other: "多云"
};

/**
 * 天气码查不到时，从英文描述里嗅一个中文说法。
 * 描述是第三方随时可能改的东西，所以只当兜底、不当主路径；但比直接报「多云」诚实。
 */
function cnFromDesc(desc: string): string | null {
  const d = desc.toLowerCase();
  if (!d) return null;
  if (/thunder|lightning/.test(d)) return /snow/.test(d) ? "雷阵雪" : "雷阵雨";
  if (/blizzard/.test(d)) return "暴雪";
  if (/sleet/.test(d)) return "雨夹雪";
  if (/snow/.test(d)) return /heavy|moderate/.test(d) ? "大雪" : /light/.test(d) ? "小雪" : "下雪";
  if (/drizzle/.test(d)) return "毛毛雨";
  if (/shower/.test(d)) return "阵雨";
  if (/rain/.test(d)) return /heavy/.test(d) ? "大雨" : /moderate/.test(d) ? "中雨" : /light/.test(d) ? "小雨" : "下雨";
  if (/haze|smoke|dust|sand/.test(d)) return "雾霾";
  if (/fog|ice/.test(d)) return "雾";
  if (/mist/.test(d)) return "薄雾";
  if (/sunny|clear/.test(d)) return "晴";
  if (/overcast/.test(d)) return "阴";
  if (/cloud/.test(d)) return "多云";
  if (/wind|gale/.test(d)) return "大风";
  return null;
}

/** 一句「天气状况」的中文，只一个词，不带数字 */
export function condOf(w: WeatherNow): string {
  return CONDITION_CN[w.code] ?? cnFromDesc(w.desc) ?? MOOD_CN[moodOf(w)];
}

/**
 * 气泡上那一行字：只报「现在几度 + 什么天气」。
 * 湿度、风速、紫外线那些普通人每天不看，堆在一句里反而把狗挡住。
 */
export function briefOf(w: WeatherNow): string {
  return `${ICON[moodOf(w)]} 现在 ${w.tempC}℃ · ${condOf(w)}`;
}


/** 每种档位演多久（点一下狗头才播一次，所以刻意短） */
export const MOOD_SECONDS: Record<WeatherMood, number> = {
  thunder: 2.6,
  snow: 3.4,
  rain: 3.6,
  haze: 3.2,
  wind: 3.0,
  heat: 3.6,
  cold: 3.4,
  clear: 2.4,
  other: 2.2
};

/**
 * 点狗头 → 主进程回给渲染层的那一份结果。
 * text 为空串 = 没查到（网络/接口挂了），此时渲染层什么都不演，只说「查不到」。
 */
export interface WeatherReply {
  /** 气泡上的一行字；查不到时为空串 */
  text: string;
  /** 该演哪个天气动作 */
  mood: WeatherMood;
}

/** 查不到时的统一回执 */
export const NO_WEATHER: WeatherReply = { text: "", mood: "other" };

