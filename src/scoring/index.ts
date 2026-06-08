/**
 * スコアリングのオーケストレーション。
 * 取得済みイベント配列を受け取り、各シグナルを重み付き合算して
 * 総合廃人スコアとランク、根拠（reason）をまとめた ScoreResult を返す。
 *
 * Nostr 取得ロジックには依存しない（純粋にデータ→スコア変換）ので、
 * 将来の Web/LLM 層からもそのまま再利用できる。
 */
import type {
  NostrEvent,
  ObservationInfo,
  ScoreResult,
  ScoringConfig,
  SignalCategory,
  SignalScore,
  SubScores,
} from "../types.js";
import { prepareEvents } from "./prepare.js";
import {
  burstSignal,
  computeObservation,
  engagementSignal,
  lateNightSignal,
  longTermRetentionSignal,
  observedWindow,
  shortTermActivitySignal,
} from "./signals.js";
import { rankForScore } from "./rank.js";

/** デフォルトのスコアリング設定（JST・深夜0-5時）。 */
export const DEFAULT_CONFIG: ScoringConfig = {
  tzOffsetHours: 9,
  timezoneLabel: "JST",
  lateNightStart: 0,
  lateNightEnd: 5,
};

/**
 * 各シグナルのベース重み。
 *  - 短期(shortTerm) + パターン(lateNight/bursts/engagement) で 0.80。
 *  - 長期(longTerm) のベース重みは 0.20 だが、総合では観測信頼度で割り引かれる
 *    （confidence が低い＝観測ウィンドウが短いと、長期軸は総合へほぼ寄与しない）。
 */
export const WEIGHTS = {
  shortTerm: 0.3,
  lateNight: 0.2,
  bursts: 0.15,
  engagement: 0.15,
  longTerm: 0.2,
} as const;

/**
 * @param now 現在時刻(UNIX秒)。古参度（初観測からの経過）の基準。
 *            既定は実時刻。テストでは固定値を渡して決定的にする。
 */
export function scoreEvents(
  npub: string,
  pubkeyHex: string,
  rawEvents: NostrEvent[],
  config: ScoringConfig = DEFAULT_CONFIG,
  now: number = Math.floor(Date.now() / 1000),
): ScoreResult {
  const notes: string[] = [];

  if (rawEvents.length === 0) {
    notes.push(
      "対象リレーから投稿を取得できませんでした。別のリレーを --relays で指定するか、--limit を増やしてください。",
    );
    return emptyResult(npub, pubkeyHex, config, notes);
  }

  const events = prepareEvents(rawEvents, config);
  const observation = computeObservation(events, now);

  const shortTerm = shortTermActivitySignal(events, WEIGHTS.shortTerm);
  const lateNight = lateNightSignal(events, config, WEIGHTS.lateNight);
  const bursts = burstSignal(events, WEIGHTS.bursts);
  const engagement = engagementSignal(events, WEIGHTS.engagement);
  // 長期軸の表示重みは「ベース重み × 信頼度」（短観測ではほぼ 0）。
  const longTerm = longTermRetentionSignal(
    observation,
    WEIGHTS.longTerm * observation.confidence,
  );

  const signals: SignalScore[] = [
    shortTerm,
    lateNight,
    bursts,
    engagement,
    longTerm,
  ];

  // 総合スコア: 短期＋パターンは満額、長期は信頼度で割り引いた重みで合算し、
  // 「観測できた分」だけで正規化する（confidence-aware contribution）。
  // → 短観測の高密度ユーザーを「長期不明」で不当に減点せず、かつ古参を僭称もしない。
  const otherWeight =
    WEIGHTS.shortTerm + WEIGHTS.lateNight + WEIGHTS.bursts + WEIGHTS.engagement;
  const effLongWeight = WEIGHTS.longTerm * observation.confidence;
  const numerator =
    shortTerm.score * WEIGHTS.shortTerm +
    lateNight.score * WEIGHTS.lateNight +
    bursts.score * WEIGHTS.bursts +
    engagement.score * WEIGHTS.engagement +
    longTerm.score * WEIGHTS.longTerm;
  const denominator = otherWeight + effLongWeight;
  const totalScore = Math.round(denominator > 0 ? numerator / denominator : 0);

  const subScores: SubScores = {
    shortTermActivity: shortTerm.score,
    usagePattern: weightedAverage([lateNight, bursts, engagement]),
    longTermRetention: longTerm.score,
  };

  const { start, end } = observedWindow(events);

  if (rawEvents.length < 30) {
    notes.push(
      `サンプル数が ${rawEvents.length} 件と少なく、スコアの信頼度は低めです。`,
    );
  }
  if (!observation.longTermAssessable) {
    notes.push(
      `観測ウィンドウが ${observation.observedWindowDays} 日（実稼働 ${observation.observedActiveDays} 日）と短いため、長期継続・古参度は評価を保留しています（low-confidence）。表示は短期の活発さが中心です。`,
    );
  }
  notes.push(
    "取得はリレー側の保持期間・件数制限に依存します。実際の活動の一部しか観測できていない可能性があります。",
  );

  return {
    npub,
    pubkeyHex,
    totalScore,
    rank: rankForScore(totalScore),
    subScores,
    observation,
    signals,
    sampleSize: rawEvents.length,
    windowStart: start,
    windowEnd: end,
    timezone: config.timezoneLabel,
    notes,
  };
}

/** シグナル群の重み付き平均（表示用サブスコア）。 */
function weightedAverage(signals: SignalScore[]): number {
  const w = signals.reduce((s, x) => s + x.weight, 0);
  if (w <= 0) return 0;
  const v = signals.reduce((s, x) => s + x.score * x.weight, 0) / w;
  return Math.round(v * 10) / 10;
}

function emptyResult(
  npub: string,
  pubkeyHex: string,
  config: ScoringConfig,
  notes: string[],
): ScoreResult {
  const zero = (
    key: string,
    label: string,
    category: SignalCategory,
    weight: number,
  ): SignalScore => ({
    key,
    label,
    category,
    score: 0,
    weight,
    reason: "データなし。",
    detail: {},
  });
  const observation: ObservationInfo = {
    observedWindowDays: 0,
    firstSeenAgeDays: 0,
    observedActiveDays: 0,
    confidence: 0,
    longTermAssessable: false,
  };
  return {
    npub,
    pubkeyHex,
    totalScore: 0,
    rank: rankForScore(0),
    subScores: {
      shortTermActivity: 0,
      usagePattern: 0,
      longTermRetention: 0,
    },
    observation,
    signals: [
      zero("shortTermActivity", "短期アクティブ度", "shortTerm", WEIGHTS.shortTerm),
      zero("lateNight", "深夜投稿率", "pattern", WEIGHTS.lateNight),
      zero("bursts", "連投傾向", "pattern", WEIGHTS.bursts),
      zero("engagement", "交流密度", "pattern", WEIGHTS.engagement),
      zero("longTermRetention", "長期継続・古参度", "longTerm", WEIGHTS.longTerm),
    ],
    sampleSize: 0,
    windowStart: null,
    windowEnd: null,
    timezone: config.timezoneLabel,
    notes,
  };
}
