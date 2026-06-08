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

/**
 * シグナルの所属軸。
 *  - shortTerm : 短期アクティブ度（観測ウィンドウ内の密度・稼働日率）。
 *  - pattern   : 生活・利用パターン（深夜・連投・交流）。
 *  - longTerm  : 長期継続・古参度（観測ウィンドウが十分なときのみ高くなる）。
 */
export type SignalCategory = "shortTerm" | "pattern" | "longTerm";

/** 個別シグナルの採点結果。説明可能性のため理由を必ず持つ。 */
export interface SignalScore {
  /** シグナルの内部キー。 */
  key: string;
  /** 人間向けのラベル。 */
  label: string;
  /** 所属軸（短期 / パターン / 長期）。 */
  category: SignalCategory;
  /** 0-100 に正規化したスコア。 */
  score: number;
  /** 合計への重み（0-1）。長期軸は観測信頼度で割り引かれることがある。 */
  weight: number;
  /** なぜそのスコアになったかの根拠（日本語の短文）。 */
  reason: string;
  /** UI/デバッグ用の補助数値。 */
  detail: Record<string, number | string>;
}

/**
 * 観測の限界に関するメタ情報。
 * 「短い観測ウィンドウを長期継続と取り違えない」ための中核データ。
 */
export interface ObservationInfo {
  /** 観測ウィンドウの長さ（日）。windowEnd - windowStart。 */
  observedWindowDays: number;
  /** 最古の観測投稿が「現在」から何日前か（古参度の材料）。 */
  firstSeenAgeDays: number;
  /** 投稿があった実日数（distinct な日付の数）。 */
  observedActiveDays: number;
  /** 観測の信頼度 0-1（ウィンドウ長 × 実稼働日数から算出）。 */
  confidence: number;
  /** 長期継続を評価できるだけの観測ウィンドウがあるか。 */
  longTermAssessable: boolean;
}

/**
 * 3 軸に分離した表示用サブスコア（0-100）。
 * 「短期の活発さ」と「長期の継続」を**別軸**として提示する。
 */
export interface SubScores {
  /** 短期アクティブ度：観測ウィンドウ内の密度・稼働日率（直近の活発さ）。 */
  shortTermActivity: number;
  /** 生活・利用パターン：深夜・連投・交流の複合。 */
  usagePattern: number;
  /** 長期継続・古参度：信頼度で割引済み（低信頼なら低く出る）。 */
  longTermRetention: number;
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
  /** 0-100 の総合廃人スコア（短期・パターン・長期の信頼度加重合算）。 */
  totalScore: number;
  rank: Rank;
  /** 3 軸に分離した表示用サブスコア。 */
  subScores: SubScores;
  /** 観測の限界メタ情報（信頼度・長期評価可否など）。 */
  observation: ObservationInfo;
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
