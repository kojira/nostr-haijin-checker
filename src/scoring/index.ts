/**
 * スコアリングのオーケストレーション。
 * 取得済みイベント配列を受け取り、各シグナルを重み付き合算して
 * 総合廃人スコアとランク、根拠（reason）をまとめた ScoreResult を返す。
 *
 * Nostr 取得ロジックには依存しない（純粋にデータ→スコア変換）ので、
 * 将来の Web/LLM 層からもそのまま再利用できる。
 */
import type {
  HistoryMeta,
  NostrEvent,
  ObservationInfo,
  ScoreResult,
  ScoringConfig,
  SignalCategory,
  SignalScore,
  StreakInfo,
  SubScores,
} from "../types.js";
import { isAllowedKind } from "../kinds.js";
import { prepareEvents } from "./prepare.js";
import {
  aggregateEvents,
  burstSignal,
  computeObservation,
  engagementSignal,
  temporalCoverageSignal,
  longTermRetentionSignal,
  shortTermActivitySignal,
  streakRetentionSignal,
} from "./signals.js";
import { rankForScore } from "./rank.js";

/** デフォルトのスコアリング設定（JST）。 */
export const DEFAULT_CONFIG: ScoringConfig = {
  tzOffsetHours: 9,
  timezoneLabel: "JST",
};

/**
 * 各シグナルのベース重み。
 *  - 短期(shortTerm) + パターン(temporalCoverage/bursts/engagement) で 0.80。
 *  - 長期(longTerm) のベース重みは 0.20 だが、総合では観測信頼度で割り引かれる
 *    （confidence が低い＝観測ウィンドウが短いと、長期軸は総合へほぼ寄与しない）。
 *  - streak（連続実稼働ストリーク）は **任意**（別経路の軽量ルックアップがあるときだけ）の
 *    長期系シグナル。控えめな固定重み 0.12 で、短期の活発さを支配しない範囲で総合に効く。
 *    longTerm と違い観測信頼度では割り引かない（連続日を直接プローブで確認済みのため）。
 *    ストリークが無い（null）ときは合算にも正規化にも一切現れない。
 */
export const WEIGHTS = {
  shortTerm: 0.3,
  temporalCoverage: 0.2,
  bursts: 0.15,
  engagement: 0.15,
  longTerm: 0.2,
  streak: 0.12,
} as const;

/**
 * @param now 現在時刻(UNIX秒)。古参度（初観測からの経過）の基準。
 *            既定は実時刻。テストでは固定値を渡して決定的にする。
 * @param fetchMeta 取得（バックワード・ページング）のメタ情報。どこまで遡れたか・
 *            履歴を掘り切れたかを注意書き（notes）に反映する。取得経路を介さない
 *            （直接イベント配列を渡す）場合は null。
 * @param streak ストリーク（連続実稼働日数）の軽量ルックアップ結果。heavy fetch とは
 *            **別経路**で日次の活動有無だけを掘った結果。**渡された場合は**「連続実稼働」
 *            シグナル（長期軸・重み 0.12）として総合スコアに加点し、長期軸サブスコアにも
 *            反映する。連続日数が長いほどスコアが上がる（約 60 日で頭打ちの飽和加点）。
 *            ストリーク経路を介さない（null）場合は合算・正規化・signals のいずれにも現れない。
 */
export function scoreEvents(
  npub: string,
  pubkeyHex: string,
  inputEvents: NostrEvent[],
  config: ScoringConfig = DEFAULT_CONFIG,
  now: number = Math.floor(Date.now() / 1000),
  fetchMeta: HistoryMeta | null = null,
  streak: StreakInfo | null = null,
): ScoreResult {
  const notes: string[] = [];

  // 採点入力も許可リスト（ALLOWED_KINDS）に限定する。取得経路は既に kind を絞って
  // いるが、イベント配列を直接渡された場合に備えた防御的フィルタ（許可外 kind は
  // 密度・稼働日・継続性のいずれにも算入しない）。
  const rawEvents = inputEvents.filter((ev) => isAllowedKind(ev.kind));

  if (rawEvents.length === 0) {
    notes.push(
      "対象リレーから投稿を取得できませんでした。別のリレーを --relays で指定するか、--max-windows / --relay-timeout / --window-timeout を増やす・--since を緩めてみてください。",
    );
    for (const n of historyNotes(fetchMeta)) notes.push(n);
    for (const n of streakNotes(streak)) notes.push(n);
    return emptyResult(npub, pubkeyHex, config, notes, fetchMeta, streak);
  }

  const events = prepareEvents(rawEvents, config);
  // 全シグナルが共有する集計値を **1 パス** で算出する（巨大スプレッド・多重走査を回避）。
  // 195k 件規模でも min/max・稼働日・時刻ヒストグラム・交流件数をここで一度だけ数える。
  const agg = aggregateEvents(events);
  const observation = computeObservation(agg, now);

  const shortTerm = shortTermActivitySignal(agg, WEIGHTS.shortTerm);
  const temporalCoverage = temporalCoverageSignal(
    agg,
    WEIGHTS.temporalCoverage,
  );
  // 連投は時系列の並びが必要なため、唯一イベント配列そのものを使う（集計値では代替不可）。
  const bursts = burstSignal(events, WEIGHTS.bursts);
  const engagement = engagementSignal(agg, WEIGHTS.engagement);
  // 長期軸の表示重みは「ベース重み × 信頼度」（短観測ではほぼ 0）。
  const longTerm = longTermRetentionSignal(
    observation,
    WEIGHTS.longTerm * observation.confidence,
  );

  // 連続実稼働ストリーク（任意・別経路）。渡されたときだけ長期系シグナルとして加点する。
  const streakSignal = streak
    ? streakRetentionSignal(streak, WEIGHTS.streak)
    : null;

  const signals: SignalScore[] = [
    shortTerm,
    temporalCoverage,
    bursts,
    engagement,
    longTerm,
    ...(streakSignal ? [streakSignal] : []),
  ];

  // 総合スコア: 短期＋パターンは満額、長期は信頼度で割り引いた重みで合算し、
  // 「観測できた分」だけで正規化する（confidence-aware contribution）。
  // → 短観測の高密度ユーザーを「長期不明」で不当に減点せず、かつ古参を僭称もしない。
  // ストリークがあるときは固定重み（信頼度割引なし）の項を分子・分母の両方に足す。
  // これにより 0-100 の正規化は保たれ、連続日数が長い（streakSignal.score が高い）ほど
  // 分子だけが増えて総合スコアが上がる（分母はストリーク有無で一意に決まる）。
  const otherWeight =
    WEIGHTS.shortTerm +
    WEIGHTS.temporalCoverage +
    WEIGHTS.bursts +
    WEIGHTS.engagement;
  const effLongWeight = WEIGHTS.longTerm * observation.confidence;
  const streakWeight = streakSignal ? WEIGHTS.streak : 0;
  const numerator =
    shortTerm.score * WEIGHTS.shortTerm +
    temporalCoverage.score * WEIGHTS.temporalCoverage +
    bursts.score * WEIGHTS.bursts +
    engagement.score * WEIGHTS.engagement +
    longTerm.score * WEIGHTS.longTerm +
    (streakSignal ? streakSignal.score * WEIGHTS.streak : 0);
  const denominator = otherWeight + effLongWeight + streakWeight;
  const totalScore = Math.round(denominator > 0 ? numerator / denominator : 0);

  const subScores: SubScores = {
    shortTermActivity: shortTerm.score,
    usagePattern: weightedAverage([temporalCoverage, bursts, engagement]),
    // 長期軸サブスコアは「古参度シグナル」と（あれば）「連続実稼働シグナル」の重み付き平均。
    // ストリークが無いときは従来どおり古参度シグナル単体。
    longTermRetention: streakSignal
      ? weightedAverage([longTerm, streakSignal])
      : longTerm.score,
  };

  const start = agg.minCreatedAt;
  const end = agg.maxCreatedAt;

  if (rawEvents.length < 30) {
    notes.push(
      `サンプル数が ${rawEvents.length} 件のため、スコアは参考値としてご覧ください。`,
    );
  }
  if (!observation.longTermAssessable) {
    notes.push(
      `観測ウィンドウが ${observation.observedWindowDays} 日（実稼働 ${observation.observedActiveDays} 日）のため、短期の活発さを中心に評価しています。`,
    );
  }
  // 取得（ページング）の実情を正直に反映する。掘り切れたか／途中で打ち切ったか。
  for (const n of historyNotes(fetchMeta)) notes.push(n);
  // ストリーク（連続実稼働日数）は heavy fetch とは別経路だが、加点済み（上の streakSignal）。
  // ここでは効き方・限界（truncated 等）を注意書きに反映する。
  for (const n of streakNotes(streak)) notes.push(n);

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
    history: fetchMeta,
    streak,
    notes,
  };
}

/** UNIX 秒を "YYYY-MM-DD HH:mmZ" の短い ISO 文字列にする（注意書き用）。 */
function fmtUnix(sec: number | null): string {
  if (sec == null) return "-";
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** リレー URL を短く（wss:// とパスを落としてホスト名だけ）表示する。 */
function shortRelay(url: string): string {
  return url.replace(/^wss?:\/\//, "").replace(/\/+$/, "");
}

/**
 * 取得メタ情報から「どこまで遡れたか・履歴が不完全かもしれない」を表す注意書きを作る。
 * 取得は適応的タイムウィンドウ（since/until）で行うため、要求範囲を覆い切れた（ok）でも
 * リレーが古いイベントを破棄していれば「真の初投稿」とは断定しない。掘り切れていない
 * （各種上限・タイムアウト）ときは正直にそう言う。
 */
export function historyNotes(meta: HistoryMeta | null): string[] {
  if (!meta) return [];
  const out: string[] = [];
  const oldest = fmtUnix(meta.oldestCreatedAt);

  // 一部リレーが失敗しても全体は止めない（部分継続）。その事実を正直に出す。
  if (meta.relaysFailed > 0) {
    const failed = (meta.relayStats ?? [])
      .filter((r) => r.status === "failed" || r.status === "timeout")
      .map((r) => `${shortRelay(r.url)}(${r.status})`);
    const detail = failed.length ? `: ${failed.join(" / ")}` : "";
    out.push(
      `${meta.relaysFailed} 個のリレーに接続できませんでした${detail}が、残り ${meta.relaysSucceeded} 個のリレーから取得を継続しました。失敗したリレーにしか無い投稿は観測できていない可能性があります。`,
    );
  }

  if (meta.reachedOldestAvailable) {
    out.push(
      `要求した時間範囲（下限まで）を ${meta.pagesFetched} ウィンドウで覆い切りました（観測できた最古 ${oldest}）。これは「これらのリレーが保持・返却した範囲の限界」であり、リレーが古いイベントを破棄している場合、本当の最初の投稿とは限りません。`,
    );
  }

  const truncatedReasons: string[] = [];
  if (meta.hitPageCap) truncatedReasons.push("ウィンドウ数上限");
  if (meta.hitEventCap) truncatedReasons.push("取得件数上限");
  if (meta.timedOut) truncatedReasons.push("タイムアウト");
  if (meta.stopReason === "error") truncatedReasons.push("取得エラー");

  if (truncatedReasons.length > 0) {
    out.push(
      `履歴を掘り切れていません（理由: ${truncatedReasons.join(
        " / ",
      )}）。観測できた最古 ${oldest} より前にも投稿がある可能性が高く、長期継続・古参度は過小評価され得ます。--max-windows / --max-events / --relay-timeout / --window-timeout を増やすか --since を緩めると、より過去まで遡れることがあります。`,
    );
  }

  out.push(
    `取得はリレーの保持期間・件数・接続ポリシーに依存します（応答 ${meta.relaysSucceeded}/${meta.relaysQueried} リレー / ${meta.pagesFetched} ウィンドウ / ${Math.round(
      meta.elapsedMs,
    )}ms）。観測できたのは活動の一部かもしれません。`,
  );
  return out;
}

/**
 * ストリーク（連続実稼働日数）の軽量ルックアップ結果から注意書きを作る。
 *
 * ストリークは heavy fetch（全件取得）とは **別経路（軽量プローブ）**で、日ごとに
 * 「その日に投稿が 1 件でもあるか」だけを遡って数えた連続日数である。**取得経路は
 * 独立**だが、得られた連続日数は「連続実稼働」シグナル（長期軸・重み 12%）として
 * 総合スコアに加点される。全履歴の網羅取得ではないこと・加点の効き方を明示する。
 */
export function streakNotes(streak: StreakInfo | null): string[] {
  if (!streak) return [];
  const out: string[] = [];

  if (streak.currentStreakDays === 0) {
    out.push(
      "連続実稼働日数（ストリーク）は 0 日です（最新の実稼働日が見つからない、または直近に活動がありません）。" +
        "ストリークは全件取得とは別経路で、日ごとに「その日に投稿が 1 件でもあるか」だけを軽量に確認して数えます（全履歴の網羅取得ではありません）。" +
        "連続日数が 0 のため、連続実稼働シグナルからの加点はありません。",
    );
    return out;
  }

  const last = streak.lastActiveDay ?? "-";
  const status = streak.ongoing
    ? "現在も継続中"
    : `${streak.daysSinceLastActive ?? "?"} 日前に途切れています`;
  out.push(
    `連続実稼働日数（ストリーク）: ${streak.currentStreakDays} 日（最新の実稼働日 ${last} / ${status}）。` +
      "これは全件取得（密度・連投・交流などの入力）とは別経路で、日ごとに「その日に投稿が 1 件でもあるか」だけを" +
      "軽量プローブで遡って数えたものです（全履歴の網羅取得ではありません）。" +
      "この連続日数は「連続実稼働」シグナル（長期軸・重み 12%・約 60 日で頭打ちの飽和加点）として総合スコアに反映され、連続日数が長いほどスコアが上がります。",
  );
  if (streak.truncated) {
    out.push(
      `ストリークは安全上限（走査日数 / 時間）またはプローブ失敗で打ち切られました（${streak.daysScanned} 日走査）。` +
        "実際の連続日数はさらに長い可能性があります（表示値・加点はいずれも下限として控えめに扱います）。--streak-max-days を増やすと、より過去まで数えられることがあります。",
    );
  }
  return out;
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
  fetchMeta: HistoryMeta | null = null,
  streak: StreakInfo | null = null,
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
      zero("temporalCoverage", "常時稼働度", "pattern", WEIGHTS.temporalCoverage),
      zero("bursts", "連投傾向", "pattern", WEIGHTS.bursts),
      zero("engagement", "交流密度", "pattern", WEIGHTS.engagement),
      zero("longTermRetention", "長期継続・古参度", "longTerm", WEIGHTS.longTerm),
    ],
    sampleSize: 0,
    windowStart: null,
    windowEnd: null,
    timezone: config.timezoneLabel,
    history: fetchMeta,
    streak,
    notes,
  };
}
