/**
 * ストリーク（連続実稼働日数）を **取得済みイベントから導出**する純関数（環境非依存）。
 *
 * なぜ別経路の取得をやめたか:
 *  - 旧実装はストリーク専用に「日ごとに最新 1 件だけを遡る軽量プローブ（fetchLastEvent）」を
 *    リレーへ投げていた。総合スコアの採点に使う **メインの全件取得**（query.ts の適応的
 *    タイムウィンドウ取得）とは別経路だったため、二重取得になり、両者の観測範囲がずれると
 *    結果が食い違う余地があった。
 *  - ストリークの判定に必要なのは「その日に投稿が 1 件でもあるか（実稼働日）」だけで、これは
 *    **メイン取得で集めたイベント配列から導ける**。そこで本モジュールは追加のネットワークを
 *    一切使わず、取得済みイベント（＝唯一の真実）からローカル日単位の活動有無を集計して
 *    連続実稼働日数を数える。二重取得と結果ズレの両方を取り除く。
 *
 * 設計:
 *  - ローカル日（tzOffset 補正後の暦日）単位で「実稼働日 = 1 件以上イベントがある日」。
 *  - 最新の実稼働日を起点に 1 日ずつ過去へ。実稼働日が連続する限りカウントし、活動の無い日
 *    （ギャップ）に当たった瞬間に終端する。
 *  - 取得が要求範囲を覆い切れた（HistoryMeta.historyComplete===true）なら、観測したギャップは
 *    確定なので truncated=false。掘り切れていない（false）なら、観測できた連続日数は実際の
 *    下限にとどまる可能性があるため truncated=true（表示・加点は「≥」の下限として控えめに扱う）。
 *
 * 得られた連続日数は採点側（scoring/index.ts → signals.ts）で「連続実稼働」シグナル
 * （長期軸・重み 0.12）として総合スコアに加点される。
 */
import { isAllowedKind } from "../kinds.js";
import type { NostrEvent, StreakInfo } from "../types.js";

export interface DeriveStreakOptions {
  /** ローカル日（実稼働日）判定の UTC オフセット（時間）。既定 9（JST）。 */
  tzOffsetHours?: number;
  /** 基準時刻（UNIX秒）。「今日」の判定に使う。既定は実時刻。テストで固定可。 */
  nowUnix?: number;
  /**
   * メイン取得が要求範囲を覆い切れたか（HistoryMeta.historyComplete）。
   * 掘り切れていない取得から導いた連続日数は下限として扱う（truncated=true）。既定 true。
   */
  historyComplete?: boolean;
}

/**
 * 取得済みイベント配列から「連続実稼働日数（ストリーク）」を導出する。
 *
 * 追加のネットワーク取得は行わない。許可 kind（ALLOWED_KINDS）のイベントだけを実稼働日の
 * 判定対象とし（許可外の防御的フィルタ）、最新の実稼働日から連続が途切れるまでを数える。
 */
export function deriveStreak(
  events: NostrEvent[],
  opts: DeriveStreakOptions = {},
): StreakInfo {
  const tz = Number.isFinite(opts.tzOffsetHours) ? (opts.tzOffsetHours as number) : 9;
  const now = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const historyComplete = opts.historyComplete ?? true;

  // ローカル日インデックス（tz 補正後の暦日番号）。同じ番号 = 同じローカル日。
  const dayIndexOf = (sec: number): number => Math.floor((sec + tz * 3600) / 86400);
  const todayIndex = dayIndexOf(now);

  // 実稼働日は許可リスト（ALLOWED_KINDS）の kind があった日だけを数える。
  const active = new Set<number>();
  let newestActiveDi = -Infinity;
  for (const ev of events) {
    if (!isAllowedKind(ev.kind)) continue;
    const di = dayIndexOf(ev.created_at);
    active.add(di);
    if (di > newestActiveDi) newestActiveDi = di;
  }

  if (active.size === 0) {
    return {
      currentStreakDays: 0,
      lastActiveDay: null,
      daysSinceLastActive: null,
      ongoing: false,
      observedActiveDays: 0,
      truncated: false,
    };
  }

  // 最新の実稼働日から 1 日ずつ過去へ、実稼働日が連続する限り数える。
  const lastActiveDi = newestActiveDi;
  let di = lastActiveDi;
  let streak = 0;
  while (active.has(di)) {
    streak++;
    di--;
  }

  // historyComplete なら観測したギャップは確定 → 自然終端（truncated=false）。
  // 掘り切れていなければ、観測できた連続日数は下限にとどまる可能性がある（truncated=true）。
  const truncated = !historyComplete;

  const daysSinceLastActive = todayIndex - lastActiveDi;
  // 「継続中」= 最新実稼働日が今日 or 昨日（0/1 日前）。それより古ければ途切れている。
  const ongoing = streak > 0 && daysSinceLastActive <= 1;

  return {
    currentStreakDays: streak,
    lastActiveDay: dayKeyFromIndex(lastActiveDi),
    daysSinceLastActive,
    ongoing,
    observedActiveDays: active.size,
    truncated,
  };
}

/** ローカル日インデックスを "YYYY-MM-DD" に（実行環境 TZ に依存しない）。 */
function dayKeyFromIndex(di: number): string {
  // dayStart + tz*3600 = di*86400。getUTC* で表示日を確定する（prepare.ts と同じ流儀）。
  const d = new Date(di * 86400 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
