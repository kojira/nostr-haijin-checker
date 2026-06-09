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
 * 採点（解析）フェーズの内部ステージ。取得（FetchProgress）とは別軸で、
 * 「取得後にどこまで解析が進んだか」を表す。巨大データセットでも UI が
 * 「固まっていない／いま何をしているか」を見せるために使う。
 *  - prepare   : 生イベントの整形（TZ 補正・種別判定）。件数で進捗を測れる。
 *  - aggregate : 1 パス集計（時刻ヒストグラム・稼働日・交流件数）。件数で測れる。
 *  - signals   : 各シグナルの算出（連投の時系列ソート・走査を含む）。
 *  - finalize  : 総合スコア・サブスコア・注意書きの確定。
 */
export type AnalysisStage = "prepare" | "aggregate" | "signals" | "finalize";

/**
 * 採点（解析）の途中経過スナップショット。scoreEvents の onProgress に渡る。
 * FetchProgress（取得の途中経過）と対になる、解析フェーズ用の進捗型。
 */
export interface AnalysisProgress {
  /** いま処理中のステージ。 */
  stage: AnalysisStage;
  /**
   * 現ステージで処理済みのイベント件数。件数で測れないステージ（signals/finalize）
   * では total と同じ値（=ステージ完了の合図）にする。
   */
  processed: number;
  /** 解析対象（許可 kind に絞ったあと）のイベント総数。 */
  total: number;
}

/** 採点（解析）の途中経過を受け取るコールバック。 */
export type AnalysisProgressCallback = (progress: AnalysisProgress) => void;

/**
 * 採点フローのトップレベル・フェーズ。取得→解析→描画準備の 3 段階で、
 * 「いま全体のどこにいるか」を CLI/Web に一貫した語彙で見せるための軸。
 * 解析フェーズ（analyzing）の内訳は AnalysisStage（prepare/aggregate/signals/finalize）。
 * ストリーク（連続実稼働日数）は取得済みイベントから導出するため独立フェーズを持たない
 * （別経路の追加取得が無くなった）。
 */
export type WorkflowPhase = "fetching" | "analyzing" | "rendering";

/** WorkflowPhase の日本語ラベル（CLI/Web で表記を揃える）。 */
export const WORKFLOW_PHASE_LABELS: Record<WorkflowPhase, string> = {
  fetching: "取得中",
  analyzing: "解析中",
  rendering: "描画準備中",
};

/** AnalysisStage の日本語ラベル（解析フェーズの内訳表示で CLI/Web を揃える）。 */
export const ANALYSIS_STAGE_LABELS: Record<AnalysisStage, string> = {
  prepare: "整形",
  aggregate: "集計",
  signals: "シグナル算出",
  finalize: "仕上げ",
};

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
 * ストリーク（連続実稼働日数）。
 *
 * **取得（適応的タイムウィンドウ）で集めた許可 kind イベントから導出する**。日次の活動有無
 * だけを別経路で確認する追加取得は行わず、メインの取得結果（同じイベント配列）を唯一の
 * 真実とする。ローカル日単位に「その日に投稿が 1 件でもあるか（実稼働日）」を集計し、最新の
 * 実稼働日から途切れずに遡れた連続日数を数える。得られた連続日数は「連続実稼働」シグナル
 * （長期軸・重み 0.12）として総合スコア（totalScore）に加点される（連続日数が長いほど上がる）。
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
  /** ストリーク算出の母数となった観測実稼働日数（取得イベントから導いた distinct な実稼働日数）。 */
  observedActiveDays: number;
  /**
   * 取得が掘り切れていない（HistoryMeta.historyComplete===false）ために、観測できた
   * 連続日数が実際の連続日数の **下限**にとどまる可能性があるか。取得を全範囲覆い切れた
   * （historyComplete===true）なら、ギャップは確定なので false。true のときは表示・加点とも
   * 「≥」の下限として控えめに扱う（実際の連続日数はさらに長い可能性がある）。
   */
  truncated: boolean;
}

/** スコアリング全体の最終結果。 */
export interface ScoreResult {
  npub: string;
  pubkeyHex: string;
  /**
   * 0-100 の総合廃人スコア（短期・パターン・長期の信頼度加重合算）。
   * ストリーク（連続実稼働）が渡された場合は、その連続日数を「連続実稼働」シグナル
   * （長期軸・重み 0.12）として加点した値になる。連続日数は取得済みイベントから導出する。
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
   * ストリーク（連続実稼働日数）。取得済みイベント（メインの取得結果）から導出する。
   * 渡された場合は「連続実稼働」シグナルとして totalScore に加点され、signals にも現れる。
   * ストリークを計測しない場合は null。
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
