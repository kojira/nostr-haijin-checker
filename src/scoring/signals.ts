/**
 * 個別シグナルの算出ロジック。
 *
 * すべてのシグナルは 0-100 に正規化され、必ず「reason（根拠）」を返す。
 * これにより総合スコアが説明可能（explainable）になる。
 *
 * 設計方針:
 *  - 各シグナルは独立した純粋関数。テスト・差し替えが容易。
 *  - 飽和カーブ saturating() で「ヘビーユーザーほど 100 に漸近」させる。
 */
import type { AnalyzedEvent, ScoringConfig, SignalScore } from "../types.js";

const SECONDS_PER_DAY = 86400;

/**
 * 飽和スコア: value が full に達するとほぼ 100、それ以上は緩やかに頭打ち。
 * log10 ベースなので「1件目の重み」が大きく、廃人帯での差も残る。
 */
export function saturating(value: number, full: number): number {
  if (value <= 0) return 0;
  const s = (100 * Math.log10(1 + value)) / Math.log10(1 + full);
  return clamp(s);
}

export function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 観測ウィンドウ（秒）と日数を求める。 */
export function observedWindow(events: AnalyzedEvent[]): {
  start: number;
  end: number;
  days: number;
} {
  const times = events.map((e) => e.createdAt);
  const start = Math.min(...times);
  const end = Math.max(...times);
  const days = Math.max(1, (end - start) / SECONDS_PER_DAY);
  return { start, end, days };
}

/** 1) 投稿頻度: 1日あたり何件投稿しているか。 */
export function frequencySignal(
  events: AnalyzedEvent[],
  weight: number,
): SignalScore {
  const { days } = observedWindow(events);
  const perDay = events.length / days;
  // 25件/日 で「フル廃人」とみなす飽和カーブ。
  const score = saturating(perDay, 25);
  return {
    key: "frequency",
    label: "投稿頻度",
    score: round1(score),
    weight,
    reason: `観測 ${round1(days)} 日で ${events.length} 件 → 約 ${round1(
      perDay,
    )} 件/日。`,
    detail: { perDay: round1(perDay), totalEvents: events.length, days: round1(days) },
  };
}

/** 2) 深夜投稿率: 深夜帯の投稿割合。 */
export function lateNightSignal(
  events: AnalyzedEvent[],
  config: ScoringConfig,
  weight: number,
): SignalScore {
  const { lateNightStart, lateNightEnd } = config;
  const lateCount = events.filter(
    (e) => e.hourLocal >= lateNightStart && e.hourLocal < lateNightEnd,
  ).length;
  const ratio = events.length ? lateCount / events.length : 0;
  // 投稿の 30% が深夜帯なら 100 点。
  const score = clamp((ratio / 0.3) * 100);
  return {
    key: "lateNight",
    label: "深夜投稿率",
    score: round1(score),
    weight,
    reason: `${config.timezoneLabel} ${lateNightStart}-${lateNightEnd}時の投稿が ${lateCount} 件（全体の ${Math.round(
      ratio * 100,
    )}%）。`,
    detail: {
      lateCount,
      ratioPct: Math.round(ratio * 100),
      window: `${lateNightStart}-${lateNightEnd}`,
    },
  };
}

/** 3) 連投（バースト）: 短時間に連続投稿しているか。 */
export function burstSignal(
  events: AnalyzedEvent[],
  weight: number,
  gapSeconds = 120,
  minBurst = 5,
): SignalScore {
  const asc = [...events].sort((a, b) => a.createdAt - b.createdAt);
  let burstCount = 0;
  let postsInBursts = 0;
  let runStart = 0;

  for (let i = 1; i <= asc.length; i++) {
    const broke =
      i === asc.length || asc[i].createdAt - asc[i - 1].createdAt > gapSeconds;
    if (broke) {
      const runLen = i - runStart;
      if (runLen >= minBurst) {
        burstCount++;
        postsInBursts += runLen;
      }
      runStart = i;
    }
  }

  const ratio = events.length ? postsInBursts / events.length : 0;
  // 全投稿の 40% が連投の一部なら 100 点。
  const score = clamp((ratio / 0.4) * 100);
  return {
    key: "bursts",
    label: "連投傾向",
    score: round1(score),
    weight,
    reason: `${minBurst}件以上を${gapSeconds}秒以内に投稿した「連投」が ${burstCount} 回（連投に含まれる投稿 ${postsInBursts} 件 / ${Math.round(
      ratio * 100,
    )}%）。`,
    detail: { burstCount, postsInBursts, ratioPct: Math.round(ratio * 100) },
  };
}

/** 4) 交流密度: リプライ・リアクション・リポストの割合。 */
export function engagementSignal(
  events: AnalyzedEvent[],
  weight: number,
): SignalScore {
  const replies = events.filter((e) => e.isReply).length;
  const reactions = events.filter((e) => e.isReaction).length;
  const reposts = events.filter((e) => e.isRepost).length;
  const interactions = replies + reactions + reposts;
  const ratio = events.length ? interactions / events.length : 0;
  // 投稿の 60% が他者への反応なら 100 点。
  const score = clamp((ratio / 0.6) * 100);
  return {
    key: "engagement",
    label: "交流密度",
    score: round1(score),
    weight,
    reason: `リプライ ${replies} / リアクション ${reactions} / リポスト ${reposts}（全体の ${Math.round(
      ratio * 100,
    )}% が他者への反応）。`,
    detail: { replies, reactions, reposts, ratioPct: Math.round(ratio * 100) },
  };
}

/** 5) 継続性: 観測期間中どれだけ毎日投稿しているか（＋最長連続日数）。 */
export function consistencySignal(
  events: AnalyzedEvent[],
  weight: number,
): SignalScore {
  const dayKeys = [...new Set(events.map((e) => e.dayKey))].sort();
  const activeDays = dayKeys.length;

  const { start, end } = observedWindow(events);
  const spanDays = Math.max(
    1,
    Math.round((end - start) / SECONDS_PER_DAY) + 1,
  );
  const activeRatio = clamp((activeDays / spanDays) * 100) / 100;
  const longestStreak = longestConsecutiveDays(dayKeys);

  // 稼働日率をベースに、最長連続日数で軽くブースト。
  const streakBoost = clamp(longestStreak * 5); // 20日連続で +100 上限
  const score = clamp(activeRatio * 100 * 0.8 + streakBoost * 0.2);

  return {
    key: "consistency",
    label: "継続性",
    score: round1(score),
    weight,
    reason: `観測 ${spanDays} 日中 ${activeDays} 日投稿（稼働率 ${Math.round(
      activeRatio * 100,
    )}%、最長 ${longestStreak} 日連続）。`,
    detail: {
      activeDays,
      spanDays,
      activeRatioPct: Math.round(activeRatio * 100),
      longestStreak,
    },
  };
}

/** ソート済み YYYY-MM-DD 配列から最長の連続日数を求める。 */
function longestConsecutiveDays(sortedDayKeys: string[]): number {
  if (sortedDayKeys.length === 0) return 0;
  let longest = 1;
  let cur = 1;
  for (let i = 1; i < sortedDayKeys.length; i++) {
    const prev = Date.parse(sortedDayKeys[i - 1] + "T00:00:00Z");
    const now = Date.parse(sortedDayKeys[i] + "T00:00:00Z");
    const diffDays = Math.round((now - prev) / (SECONDS_PER_DAY * 1000));
    if (diffDays === 1) {
      cur++;
      longest = Math.max(longest, cur);
    } else {
      cur = 1;
    }
  }
  return longest;
}
