/**
 * 共通型定義。
 * Nostr のイベント表現や、スコアリングの入出力をここに集約する。
 * 将来的に Web / LLM 層から再利用しやすいよう、ドメイン型は UI/CLI に依存させない。
 */

/** Nostr の生イベント（必要な範囲だけ持つ簡易表現）。 */
export interface NostrEvent {
  id: string;
  pubkey: string;
  /** UNIX 秒。 */
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** スコアリングに使うために整形した投稿データ。 */
export interface AnalyzedEvent {
  id: string;
  createdAt: number;
  kind: number;
  /** kind1 で 'e' タグを持つ（=リプライ）か。 */
  isReply: boolean;
  /** kind7（リアクション）か。 */
  isReaction: boolean;
  /** kind6（リポスト）か。 */
  isRepost: boolean;
  /** 表示用タイムゾーンでの 0-23 時。 */
  hourLocal: number;
  /** 表示用タイムゾーンでの YYYY-MM-DD（日次集計キー）。 */
  dayKey: string;
}

/** 個別シグナルの採点結果。説明可能性のため理由を必ず持つ。 */
export interface SignalScore {
  /** シグナルの内部キー。 */
  key: string;
  /** 人間向けのラベル。 */
  label: string;
  /** 0-100 に正規化したスコア。 */
  score: number;
  /** 合計への重み（0-1）。 */
  weight: number;
  /** なぜそのスコアになったかの根拠（日本語の短文）。 */
  reason: string;
  /** UI/デバッグ用の補助数値。 */
  detail: Record<string, number | string>;
}

/** ランク（廃人度の段階）。 */
export interface Rank {
  label: string;
  emoji: string;
  /** このランクに入る下限スコア（含む）。 */
  min: number;
  description: string;
}

/** スコアリング全体の最終結果。 */
export interface ScoreResult {
  npub: string;
  pubkeyHex: string;
  /** 0-100 の総合廃人スコア。 */
  totalScore: number;
  rank: Rank;
  signals: SignalScore[];
  /** 分析に使ったイベント総数。 */
  sampleSize: number;
  /** 観測できた最古/最新の投稿時刻（UNIX 秒）。null は該当なし。 */
  windowStart: number | null;
  windowEnd: number | null;
  /** 表示タイムゾーン（時間分布の解釈に使用）。 */
  timezone: string;
  /** 観測の限界に関する注意書き。 */
  notes: string[];
}

/** スコアリング設定。 */
export interface ScoringConfig {
  /** 時間分布の判定に使う UTC オフセット（時間）。例: JST = 9。 */
  tzOffsetHours: number;
  /** タイムゾーン表示名。 */
  timezoneLabel: string;
  /** 深夜帯とみなす開始時刻（含む）。 */
  lateNightStart: number;
  /** 深夜帯とみなす終了時刻（含まない）。 */
  lateNightEnd: number;
}
