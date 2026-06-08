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
import type {
  AnalyzedEvent,
  ObservationInfo,
  ScoringConfig,
  SignalScore,
} from "../types.js";

const SECONDS_PER_DAY = 86400;

/**
 * 長期評価のパラメータ（しきい値）。
 * すべて「観測ウィンドウ・実稼働日数・初観測からの経過」に基づく。
 * ここを境に「短い観測ウィンドウ＝長期継続」と取り違えないよう設計している。
 */
const LONGTERM = {
  /** これ未満のウィンドウでは長期継続を「評価不能」とみなす（日）。 */
  minWindowDays: 45,
  /** これ未満の実稼働日数では長期継続を「評価不能」とみなす。 */
  minActiveDays: 8,
  /** 信頼度が満点(=1)に達する観測ウィンドウ長（日）。 */
  fullWindowDays: 180,
  /** 信頼度が満点(=1)に達する実稼働日数。 */
  fullActiveDays: 30,
  /** 古参度: 初観測からの経過がこの日数で頭打ち。 */
  veteranFullAgeDays: 730,
  /** 古参度: 観測ウィンドウ長がこの日数で頭打ち。 */
  veteranFullSpanDays: 365,
  /** 古参度: 実稼働日数がこの日数で頭打ち。 */
  veteranFullActiveDays: 200,
} as const;

/** 短期アクティブ度のサンプル信頼度が満点になるイベント数。 */
const SHORTTERM_FULL_EVENTS = 30;

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

/** 0-1 にクランプ（信頼度・比率用）。 */
export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

/**
 * 1) 短期アクティブ度: 観測ウィンドウ「内」の密度・稼働日率。
 *
 * 「いま活発か」を表す軸。投稿/日（飽和カーブ）と稼働日率を合成し、
 * サンプルが極端に少ないときだけサンプル信頼度で割り引く。
 * ウィンドウが短くても密度が高ければ高く出る（短期は短期として評価する）が、
 * これを長期継続と取り違えないため、長期は別軸（longTermRetentionSignal）に分離する。
 */
export function shortTermActivitySignal(
  events: AnalyzedEvent[],
  weight: number,
): SignalScore {
  const { start, end } = observedWindow(events);
  const windowDaysFrac = Math.max(1, (end - start) / SECONDS_PER_DAY);
  const spanDaysCal = Math.max(1, Math.round((end - start) / SECONDS_PER_DAY) + 1);
  const activeDays = new Set(events.map((e) => e.dayKey)).size;

  const perDay = events.length / windowDaysFrac;
  // 25件/日 で「フル廃人」とみなす飽和カーブ。
  const densityScore = saturating(perDay, 25);
  const activeRatio = clamp01(activeDays / spanDaysCal);
  const ratioScore = activeRatio * 100;

  // 密度 6 : 稼働日率 4 で合成。
  const raw = densityScore * 0.6 + ratioScore * 0.4;

  // サンプルが少ないと観測の確からしさが下がるので割り引く。
  const sampleConfidence = clamp01(
    Math.log10(1 + events.length) / Math.log10(1 + SHORTTERM_FULL_EVENTS),
  );
  const score = raw * sampleConfidence;

  return {
    key: "shortTermActivity",
    label: "短期アクティブ度",
    category: "shortTerm",
    score: round1(score),
    weight,
    reason: `観測ウィンドウ ${round1(windowDaysFrac)}日・稼働 ${activeDays}日で ${
      events.length
    }件（約 ${round1(perDay)}件/日, 稼働日率 ${Math.round(
      activeRatio * 100,
    )}%, サンプル信頼度 ${Math.round(
      sampleConfidence * 100,
    )}%）。直近の活発さを表します。`,
    detail: {
      perDay: round1(perDay),
      totalEvents: events.length,
      activeDays,
      spanDays: spanDaysCal,
      activeRatioPct: Math.round(activeRatio * 100),
      sampleConfidencePct: Math.round(sampleConfidence * 100),
    },
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
    category: "pattern",
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
    category: "pattern",
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
    category: "pattern",
    score: round1(score),
    weight,
    reason: `リプライ ${replies} / リアクション ${reactions} / リポスト ${reposts}（全体の ${Math.round(
      ratio * 100,
    )}% が他者への反応）。`,
    detail: { replies, reactions, reposts, ratioPct: Math.round(ratio * 100) },
  };
}

/**
 * 観測メタ情報（ウィンドウ長・初観測からの経過・実稼働日数・信頼度）を求める。
 *
 * 信頼度 confidence は「観測ウィンドウ長 × 実稼働日数」の積で 0-1。
 * どちらかが乏しいと 0 に近づくため、短い観測では長期評価が自然に効かなくなる。
 * longTermAssessable は人間向けメッセージ用のハードな真偽（しきい値判定）。
 *
 * @param nowSec 現在時刻(UNIX秒)。古参度（初観測からの経過）の基準。
 */
export function computeObservation(
  events: AnalyzedEvent[],
  nowSec: number,
): ObservationInfo {
  if (events.length === 0) {
    return {
      observedWindowDays: 0,
      firstSeenAgeDays: 0,
      observedActiveDays: 0,
      confidence: 0,
      longTermAssessable: false,
    };
  }

  const { start, end } = observedWindow(events);
  const observedWindowDays = Math.max(0, (end - start) / SECONDS_PER_DAY);
  // 初観測からの経過。最低でも観測ウィンドウ長は確保（now がズレても破綻しない）。
  const firstSeenAgeDays = Math.max(
    observedWindowDays,
    (nowSec - start) / SECONDS_PER_DAY,
  );
  const observedActiveDays = new Set(events.map((e) => e.dayKey)).size;

  const windowConf = clamp01(observedWindowDays / LONGTERM.fullWindowDays);
  const activityConf = clamp01(observedActiveDays / LONGTERM.fullActiveDays);
  const confidence = round2(windowConf * activityConf);

  const longTermAssessable =
    observedWindowDays >= LONGTERM.minWindowDays &&
    observedActiveDays >= LONGTERM.minActiveDays;

  return {
    observedWindowDays: round1(observedWindowDays),
    firstSeenAgeDays: round1(firstSeenAgeDays),
    observedActiveDays,
    confidence,
    longTermAssessable,
  };
}

/**
 * 5) 長期継続・古参度: 長く・継続的に観測できているか。
 *
 * 「初観測からの経過 × 観測ウィンドウ長 × 実稼働日数」で“素の古参度”を作り、
 * これを観測信頼度 confidence で割り引く。短い観測ウィンドウでは confidence が
 * 0 に近づくため、**7日の観測から 3年の継続を主張することは構造的に起きない**。
 * 評価不能（longTermAssessable=false）のときは reason で low-confidence を明示する。
 */
export function longTermRetentionSignal(
  obs: ObservationInfo,
  weight: number,
): SignalScore {
  const ageScore = saturating(obs.firstSeenAgeDays, LONGTERM.veteranFullAgeDays);
  const spanScore = saturating(
    obs.observedWindowDays,
    LONGTERM.veteranFullSpanDays,
  );
  const activeDaysScore = saturating(
    obs.observedActiveDays,
    LONGTERM.veteranFullActiveDays,
  );

  // 素の古参度（信頼度割引前）。古参度 0.35 / 観測幅 0.30 / 実稼働 0.35。
  const rawVeteran = ageScore * 0.35 + spanScore * 0.3 + activeDaysScore * 0.35;
  // 信頼度で割り引いた「主張してよい長期スコア」。
  const score = rawVeteran * obs.confidence;

  const reason = obs.longTermAssessable
    ? `初観測から ${round1(obs.firstSeenAgeDays)}日・観測ウィンドウ ${round1(
        obs.observedWindowDays,
      )}日・実稼働 ${obs.observedActiveDays}日 → 古参度 ${round1(
        rawVeteran,
      )}（信頼度 ${Math.round(obs.confidence * 100)}% で割引後 ${round1(
        score,
      )}）。`
    : `観測ウィンドウが ${round1(
        obs.observedWindowDays,
      )}日と短く（実稼働 ${obs.observedActiveDays}日）、長期継続・古参度は十分に評価できません（low-confidence, 信頼度 ${Math.round(
        obs.confidence * 100,
      )}%）。短期の活発さとは別軸で見ています。`;

  return {
    key: "longTermRetention",
    label: "長期継続・古参度",
    category: "longTerm",
    score: round1(score),
    weight,
    reason,
    detail: {
      rawVeteran: round1(rawVeteran),
      confidencePct: Math.round(obs.confidence * 100),
      assessable: obs.longTermAssessable ? 1 : 0,
      firstSeenAgeDays: obs.firstSeenAgeDays,
      observedWindowDays: obs.observedWindowDays,
      observedActiveDays: obs.observedActiveDays,
    },
  };
}

