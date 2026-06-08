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
  ScoreResult,
  ScoringConfig,
  SignalScore,
} from "../types.js";
import { prepareEvents } from "./prepare.js";
import {
  burstSignal,
  consistencySignal,
  engagementSignal,
  frequencySignal,
  lateNightSignal,
  observedWindow,
} from "./signals.js";
import { rankForScore } from "./rank.js";

/** デフォルトのスコアリング設定（JST・深夜0-5時）。 */
export const DEFAULT_CONFIG: ScoringConfig = {
  tzOffsetHours: 9,
  timezoneLabel: "JST",
  lateNightStart: 0,
  lateNightEnd: 5,
};

/** 各シグナルの重み（合計 1.0）。 */
export const WEIGHTS = {
  frequency: 0.3,
  consistency: 0.2,
  lateNight: 0.2,
  bursts: 0.15,
  engagement: 0.15,
} as const;

export function scoreEvents(
  npub: string,
  pubkeyHex: string,
  rawEvents: NostrEvent[],
  config: ScoringConfig = DEFAULT_CONFIG,
): ScoreResult {
  const notes: string[] = [];

  if (rawEvents.length === 0) {
    notes.push(
      "対象リレーから投稿を取得できませんでした。別のリレーを --relays で指定するか、--limit を増やしてください。",
    );
    return emptyResult(npub, pubkeyHex, config, notes);
  }

  const events = prepareEvents(rawEvents, config);

  const signals: SignalScore[] = [
    frequencySignal(events, WEIGHTS.frequency),
    consistencySignal(events, WEIGHTS.consistency),
    lateNightSignal(events, config, WEIGHTS.lateNight),
    burstSignal(events, WEIGHTS.bursts),
    engagementSignal(events, WEIGHTS.engagement),
  ];

  const totalScore = Math.round(
    signals.reduce((sum, s) => sum + s.score * s.weight, 0),
  );

  const { start, end } = observedWindow(events);

  if (rawEvents.length < 30) {
    notes.push(
      `サンプル数が ${rawEvents.length} 件と少なく、スコアの信頼度は低めです。`,
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
    signals,
    sampleSize: rawEvents.length,
    windowStart: start,
    windowEnd: end,
    timezone: config.timezoneLabel,
    notes,
  };
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
    weight: number,
  ): SignalScore => ({
    key,
    label,
    score: 0,
    weight,
    reason: "データなし。",
    detail: {},
  });
  return {
    npub,
    pubkeyHex,
    totalScore: 0,
    rank: rankForScore(0),
    signals: [
      zero("frequency", "投稿頻度", WEIGHTS.frequency),
      zero("consistency", "継続性", WEIGHTS.consistency),
      zero("lateNight", "深夜投稿率", WEIGHTS.lateNight),
      zero("bursts", "連投傾向", WEIGHTS.bursts),
      zero("engagement", "交流密度", WEIGHTS.engagement),
    ],
    sampleSize: 0,
    windowStart: null,
    windowEnd: null,
    timezone: config.timezoneLabel,
    notes,
  };
}
