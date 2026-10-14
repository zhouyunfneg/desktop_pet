/**
 * 天气与新闻服务：用免费公开 API，无需 API key。
 * 天气：wttr.in（支持中文城市名）
 * 新闻：60s API（每日热点摘要）
 */

const WEATHER_URL = "https://wttr.in/?format=%c+%t,+%C,+湿度+%h,+风速+%w";
const NEWS_URL = "https://60s.viki.moe/v2/60s";

/** 获取实时天气简述（失败返回空字符串） */
export async function fetchWeather(): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(WEATHER_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return "";
    const text = (await res.text()).trim();
    // wttr.in 返回格式如 "☀️ +25°C, Sunny, 湿度 40%, 风速 10km/h"
    return text.length > 0 ? text : "";
  } catch {
    return "";
  }
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
