/**
 * 観測期間モード（PeriodMode）のユーティリティ。
 *
 * 「全期間 / 1ヶ月 / 1週間 / 1日」を、取得の時間下限（since, UNIX秒）に変換する純関数群。
 * CLI（index.ts）と Web（web/main.ts）の両方から再利用し、入力 → since の決め方を一元化する。
 * 採点ロジック（scoring/）は期間モードでアルゴリズムを変えない。期間は「どの範囲のデータを
 * 観測したか」を決めるだけで、範囲が変われば観測ウィンドウ・密度・長期評価可否が自然に変わる。
 */
import type { PeriodMode } from "./types.js";

const SECONDS_PER_DAY = 86400;

/** 既定の観測期間モード（全期間。従来挙動を維持）。 */
export const DEFAULT_PERIOD: PeriodMode = "all";

/**
 * 各モードの観測日数。all は下限を絞らない（=null）。
 * 1ヶ月は実務上わかりやすい固定 30 日とする（暦月ではない）。
 */
export const PERIOD_DAYS: Record<PeriodMode, number | null> = {
  all: null,
  month: 30,
  week: 7,
  day: 1,
};

/** 各モードの日本語ラベル（UI / 出力で表記を揃える）。 */
export const PERIOD_LABELS: Record<PeriodMode, string> = {
  all: "全期間",
  month: "1ヶ月",
  week: "1週間",
  day: "1日",
};

/** UI/CLI に並べる順序（既定の全期間を先頭に）。 */
export const PERIOD_ORDER: PeriodMode[] = ["all", "month", "week", "day"];

/**
 * 入力文字列を PeriodMode に正規化する。未指定・不正値は既定（all）に丸める。
 * CLI フラグ・フォーム値のどちらからでも安全に受けられるよう、別名も少し許す。
 */
export function parsePeriod(value: string | undefined | null): PeriodMode {
  switch ((value ?? "").trim().toLowerCase()) {
    case "day":
    case "1d":
    case "d":
      return "day";
    case "week":
    case "1w":
    case "w":
      return "week";
    case "month":
    case "1m":
    case "m":
      return "month";
    case "all":
    case "":
      return "all";
    default:
      return DEFAULT_PERIOD;
  }
}

/**
 * 観測期間モードから取得の時間下限（since, UNIX秒）を求める。
 * all は下限を絞らない（undefined を返し、呼び出し側の既定 since を使わせる）。
 *
 * @param nowSec 現在時刻(UNIX秒)。直近 N 日の起点。
 */
export function sinceUnixForPeriod(
  period: PeriodMode,
  nowSec: number,
): number | undefined {
  const days = PERIOD_DAYS[period];
  if (days == null) return undefined;
  return nowSec - days * SECONDS_PER_DAY;
}
