/**
 * 新闻轮播的纯逻辑：一天那批条目里，每条只播一次，全播完自动开下一轮。
 *
 * 抽出来放这儿是因为它以前长在 ipc.ts 的定时器里，没法单测；
 * 现在改成「点狗胸口才播」，一次点击要走一遍这个挑选，更需要它有测试。
 */

/** 当天这一轮已播过什么 */
export interface NewsRound {
  /** 内容日期（如 2026-10-21），换天就重开一轮 */
  date: string;
  /** 本轮已播过的原文（就存整句，条目本身不长） */
  played: string[];
}

/** 一次点击挑出来的那条 */
export interface NewsPick {
  text: string;
  /** 挑完之后的轮播状态，交给调用方存着 */
  round: NewsRound;
  /** 这批一共多少条 */
  total: number;
  /** 这一轮还剩多少条没播 */
  left: number;
  /** 这次是不是把上一轮播完、开了新一轮（可以顺口提一句「今天的都播完了」） */
  wrapped: boolean;
}

/**
 * 挑一条还没播过的。items 为空返回 null（接口挂了，什么都别播）。
 * 随机挑而不是从头按序：按序播用户能感觉出「永远那条排第一」，随机更像在跟你聊天。
 */
export function pickNews(items: string[], date: string, prev: NewsRound | null): NewsPick | null {
  const pool = items.filter((s) => typeof s === "string" && s.length > 0);
  if (pool.length === 0) return null;
  // 换天了（或第一次）：旧记录作废，否则永远播不完
  const same = prev && prev.date === date ? prev : { date, played: [] };
  const played = same.played.filter((s) => pool.includes(s));
  const fresh = pool.filter((s) => !played.includes(s));
  const wrapped = fresh.length === 0;
  const candidates = wrapped ? pool : fresh;
  const text = candidates[Math.floor(Math.random() * candidates.length)];
  const next = wrapped ? [text] : [...played, text];
  return {
    text,
    round: { date: same.date, played: next },
    total: pool.length,
    left: Math.max(0, pool.length - next.length),
    wrapped
  };
}

/** 点狗胸口 → 渲染层拿到的那一句话 */
export interface NewsReply {
  /** 空串 = 没拿到新闻（网络或接口挂了） */
  text: string;
  /** 这批一共几条；0 表示没数据 */
  total: number;
  /** 这一轮还剩几条没播 */
  left: number;
  /** 刚把今天这批播完，这一条是新一轮的第一条 */
  wrapped: boolean;
}

export const NO_NEWS: NewsReply = { text: "", total: 0, left: 0, wrapped: false };
