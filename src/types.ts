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

/**
 * 適応的タイムウィンドウ取得がどう止まったか。
 * 全範囲を覆い切れた/上限到達/時間切れ など、観測の「限界の理由」を表す。
 */
export type FetchStopReason =
  /** 要求した [since, until] の全範囲を覆い切れた（正常終了）。 */
  | "ok"
  /** 1 リレーあたりのウィンドウ処理数の上限に達した（まだ過去が残っている可能性）。 */
  | "maxWindows"
  /** 取得イベント数の上限に達した。 */
  | "maxEvents"
  /** タイムアウト／中断。 */
  | "timeout"
  /** 取得中にエラーが発生した（全リレー失敗など）。 */
  | "error";

/**
 * 個別リレーの取得状態。
 * 取得は **リレーごとに独立して時間ウィンドウ**を処理し、グローバルに重複排除する。
 * 1 つのリレーが失敗・タイムアウトしても全体は止めず、応答するリレーから
 * 取得を継続する。その「どのリレーがどこまで返したか」をここに正直に持つ。
 */
export type RelayStatus =
  /** まだ問い合わせていない。 */
  | "pending"
  /** 問い合わせ中（非終端）。 */
  | "querying"
  /** 全ウィンドウを処理し終えた（正常終了。件数上限での丁寧な打ち切りも含む）。 */
  | "ok"
  /** このリレーには対象の投稿が 1 件も無かった（全ウィンドウで 0 件）。 */
  | "empty"
  /** 接続・取得エラー（このリレーは使えなかった）。 */
  | "failed"
  /** タイムアウト／中断。 */
  | "timeout"
  /** ウィンドウ処理数の上限に達した。 */
  | "maxWindows";

export interface RelayStat {
  /** リレー URL。 */
  url: string;
  /** 取得状態。 */
  status: RelayStatus;
  /** このリレーが返したイベント件数（グローバル重複排除の前）。 */
  events: number;
  /** このリレーが処理した時間ウィンドウ数（旧称 pages のまま。意味はウィンドウ数）。 */
  pages: number;
  /** このリレーで観測できた最古 created_at（UNIX 秒）。null は未取得。 */
  oldestReached: number | null;
  /** 失敗時のエラー内容（任意）。 */
  error?: string;
}

/**
 * 取得（適応的タイムウィンドウ）のメタ情報。
 * 「どこまで遡れたか」「履歴を掘り切れたか」を正直に表現するための中核データ。
 * リレーは保持期間・件数を保証しないため、reachedOldestAvailable でも
 * それが本当の初投稿とは限らない（あくまで“リレーが返す限界”）。
 */
export interface HistoryMeta {
  /** 実際に処理した時間ウィンドウの総数（全リレー合計。旧称 pagesFetched のまま）。 */
  pagesFetched: number;
  /** 取得が止まった理由。 */
  stopReason: FetchStopReason;
  /**
   * 要求した [since, until] の全範囲を覆い切れたか。
   * これは「リレーが保持する範囲の限界」であり、since より前の真の初投稿の保証はない。
   * 本実装では historyComplete と同義（明示的に since まで全ウィンドウを覆うため）。
   */
  reachedOldestAvailable: boolean;
  /**
   * 履歴を掘り切れた“見込み”か。タイムアウト・各種上限・全リレー失敗で false。
   * = 要求範囲 [since, until] を全ウィンドウ正常に覆えた（stopReason==="ok"）こと。
   * リレーは完全性を保証できないため、true でも絶対の保証ではない（best-effort）。
   */
  historyComplete: boolean;
  /** 観測できた最古/最新の created_at（UNIX 秒）。null は該当なし。 */
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  /** 問い合わせたリレー数（概算）。 */
  relaysQueried: number;
  /** データを返した（接続できた）リレー数。 */
  relaysSucceeded: number;
  /** 失敗／タイムアウトしたリレー数。1 つ以上でも残りで取得は継続する。 */
  relaysFailed: number;
  /** リレー個別の取得結果（部分継続の可視化用）。 */
  relayStats: RelayStat[];
  /** 取得に要した時間（ms）。 */
  elapsedMs: number;
  /** 件数上限（maxEvents）に当たったか。 */
  hitEventCap: boolean;
  /** ウィンドウ数上限（maxWindows）に当たったか（旧称 hitPageCap のまま）。 */
  hitPageCap: boolean;
  /** タイムアウト／中断したか。 */
  timedOut: boolean;
  /** 旧フィールド。適応的ウィンドウ方式では無進捗の概念が無いため常に false。 */
  noProgress: boolean;
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
 *  - pattern   : 生活・利用パターン（常時稼働度・連投・交流）。
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
  /** 生活・利用パターン：常時稼働度・連投・交流の複合。 */
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

/**
 * ストリーク（連続実稼働日数）の軽量ルックアップ結果。
 *
 * heavy fetch（HistoryMeta＝全件取得）とは **別経路**で、日単位に「その日に投稿が
 * 1 件でもあるか」だけを安く・深く確認して数えた結果を表す。全件取得には依存せず、
 * heavy fetch が遡れる範囲より遠くまで（cheap に）遡れることがある。
 * **取得経路は独立だが**、得られた連続日数は「連続実稼働」シグナル（長期軸・重み 0.12）
 * として総合スコア（totalScore）に加点される（連続日数が長いほどスコアが上がる）。
 */
export interface StreakInfo {
  /** 連続実稼働日数（最新の実稼働日から、途切れずに遡れた日数）。 */
  currentStreakDays: number;
  /** 最新の実稼働日（ローカル日）の "YYYY-MM-DD"。活動が無ければ null。 */
  lastActiveDay: string | null;
  /** 最新実稼働日が「今日」から何日前か（0=今日, 1=昨日…）。活動が無ければ null。 */
  daysSinceLastActive: number | null;
  /** ストリークが今も継続中か（最新実稼働日が今日 or 昨日なら true）。 */
  ongoing: boolean;
  /** 走査した日数（= 軽量プローブの往復回数の目安）。 */
  daysScanned: number;
  /**
   * 上限（maxDays）・期限（overallTimeout）・プローブ失敗で打ち切ったか。
   * true のときは実際の連続日数はさらに長い可能性がある（掘り切れていない）。
   */
  truncated: boolean;
  /** 問い合わせたリレー数（概算）。 */
  relaysQueried: number;
  /** ルックアップに要した時間（ms）。 */
  elapsedMs: number;
}

/** スコアリング全体の最終結果。 */
export interface ScoreResult {
  npub: string;
  pubkeyHex: string;
  /**
   * 0-100 の総合廃人スコア（短期・パターン・長期の信頼度加重合算）。
   * ストリーク（連続実稼働）の軽量ルックアップが渡された場合は、その連続日数を
   * 「連続実稼働」シグナル（長期軸・重み 0.12）として加点した値になる。
   */
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
  /**
   * 取得（適応的タイムウィンドウ）のメタ情報。
   * どこまで遡れたか・履歴を掘り切れたかを表す。取得経路を介さない場合は null。
   */
  history: HistoryMeta | null;
  /**
   * ストリーク（連続実稼働日数）の軽量ルックアップ結果。heavy fetch とは別経路で
   * 日次の活動有無だけを掘る。渡された場合は「連続実稼働」シグナルとして totalScore に
   * 加点され、signals にも現れる。ストリーク経路を介さない場合は null。
   */
  streak: StreakInfo | null;
  /** 観測の限界に関する注意書き。 */
  notes: string[];
}

/** スコアリング設定。 */
export interface ScoringConfig {
  /** 時間分布の判定に使う UTC オフセット（時間）。例: JST = 9。 */
  tzOffsetHours: number;
  /** タイムゾーン表示名。 */
  timezoneLabel: string;
}
