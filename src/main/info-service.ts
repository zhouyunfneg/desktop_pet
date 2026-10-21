/**
 * 天气与新闻服务：用免费公开 API，无需 API key。
 * 天气：wttr.in 的 j1（结构化 JSON，按网络位置定位，无需城市名与 key）
 * 新闻：60s API（每日热点摘要）
 */

import { briefOf, moodOf, parseWeather, NO_WEATHER, type WeatherReply } from "../shared/weather";

// j1 是完整 JSON（要自己挑字段），换它是因为简本格式串只给文字、拿不到天气代码，
// 而狗的「演哪种动作」必须按代码判定 —— 描述文字随时可能改拼写。
const WEATHER_URL = "https://wttr.in/?format=j1";
const NEWS_URL = "https://60s.viki.moe/v2/60s";

/** 同一个天气看两次不该变，所以留十分钟缓存：连点狗头不会反复打接口 */
const WEATHER_TTL = 10 * 60 * 1000;
/** 失败的只压 30 秒：网络抖一下就锁十分钟的话，她会一直点不出东西还以为功能坏了 */
const WEATHER_FAIL_TTL = 30 * 1000;
let weatherCache: { at: number; reply: WeatherReply } | null = null;

/** 获取实时天气（点击狗头时调用）。
 * 拿不到数据一律回 {@link NO_WEATHER}：text 空串就是「什么都别演」，
 * 渲染层不需要再 catch 异常，也不会因为接口挂了而播一个不相干的动作。
 */
export async function fetchWeather(): Promise<WeatherReply> {
  const now = Date.now();
  if (weatherCache) {
    const ttl = weatherCache.reply.text ? WEATHER_TTL : WEATHER_FAIL_TTL;
    if (now - weatherCache.at < ttl) return weatherCache.reply;
  }
  let reply = NO_WEATHER;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(WEATHER_URL, { signal: controller.signal, headers: { Accept: "application/json" } });
    clearTimeout(timer);
    if (res.ok) {
      const w = parseWeather(await res.json());
      if (w) reply = { text: briefOf(w), mood: moodOf(w) };
    }
  } catch {
    reply = NO_WEATHER;
  }
  // 失败也记时间：不然断网时每点一次狗头都白等 8 秒超时
  weatherCache = { at: now, reply };
  return reply;
}


/** 获取当天新闻批次（失败返回 null）。该源每天只更新一次（早晨 8~9 点出当天内容） */
export interface NewsBatch {
  /** 内容日期，如 2026-10-14；用于判断是否换了新的一天 */
  date: string;
  /** 当天全部新闻条目 */
  items: string[];
}

export async function fetchNewsBatch(): Promise<NewsBatch | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(NEWS_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { date?: string; news?: string[] } };
    const raw = json?.data?.news;
    if (!Array.isArray(raw)) return null;
    const items = raw.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (items.length === 0) return null;
    return { date: typeof json?.data?.date === "string" ? json.data.date : "", items };
  } catch {
    return null;
  }
}
