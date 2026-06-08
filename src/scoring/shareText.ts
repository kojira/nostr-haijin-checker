/**
 * 診断結果（ScoreResult）から、そのまま投稿できる共有テキストを組み立てる。
 *
 * Nostr / SNS にコピペして貼り付けられる、短く自然な日本語のテキストを返す。
 * UI へ文字列組み立てを埋め込まず、CLI・Web の双方から再利用できる純関数として置く。
 *
 * 含める情報:
 *  - 総合スコア + ランク（絵文字 + ラベル）
 *  - 連続実稼働日数（ストリーク。無ければ省略）
 *  - 主要な根拠シグナルの要約（影響度＝score×weight の高い順に抜粋・重複排除）
 *  - ハッシュタグ
 */
import type { ScoreResult, SignalScore, StreakInfo } from "../types.js";

/** 既定のハッシュタグ（先頭の # は付けない）。 */
export const DEFAULT_SHARE_HASHTAG = "Nostr廃人度チェッカー";

export interface ShareTextOptions {
  /** 末尾に付けるハッシュタグ（先頭の `#` は任意・空文字で無効化）。 */
  hashtag?: string;
  /** 「主な根拠」に並べるシグナル数の上限（既定 3）。 */
  maxSignals?: number;
}

/**
 * 診断結果を投稿用テキストに整形する。
 *
 * ストリークが無い（null / 0 日）場合でも壊れず、その行を省いた有用なテキストを返す。
 */
export function buildShareText(
  result: ScoreResult,
  opts: ShareTextOptions = {},
): string {
  const hashtag = opts.hashtag ?? DEFAULT_SHARE_HASHTAG;
  const maxSignals = opts.maxSignals ?? 3;

  const lines: string[] = [];

  // 見出し: 総合スコア + ランク。
  lines.push(
    `Nostr廃人度 ${Math.round(result.totalScore)}/100 ${result.rank.emoji} ${result.rank.label}`,
  );

  // 連続実稼働（ストリーク）。無ければ行ごと省略。
  const streakLine = formatStreakLine(result.streak);
  if (streakLine) lines.push(streakLine);

  // 主な根拠（影響度の高いシグナルから抜粋）。
  const evidence = formatEvidence(result.signals, maxSignals);
  if (evidence) lines.push(`主な根拠: ${evidence}`);

  // ハッシュタグ。
  const tag = normalizeHashtag(hashtag);
  if (tag) lines.push(tag);

  return lines.join("\n");
}

/**
 * ストリーク行を組み立てる。連続日数が無い（null / 0 日）場合は null。
 * 掘り切れていない（truncated）場合は下限であることを「≥」で示す。
 */
function formatStreakLine(streak: StreakInfo | null): string | null {
  if (!streak || streak.currentStreakDays <= 0) return null;
  const prefix = streak.truncated ? "≥" : "";
  const state = streak.ongoing ? "（継続中）" : "";
  return `🔥 連続実稼働 ${prefix}${streak.currentStreakDays}日${state}`;
}

/**
 * 主要な根拠シグナルを「ラベル スコア」の並びで要約する。
 *
 * 影響度（score × weight）の高い順に並べ、ラベル重複を排除して上位 max 件を抜粋する。
 * ストリークは専用行で出すため、ここでは除外する（重複防止）。スコア 0 のシグナルも除く。
 */
function formatEvidence(signals: SignalScore[], max: number): string {
  const ranked = signals
    .filter((s) => s.key !== "streakRetention" && s.score > 0)
    .slice()
    .sort((a, b) => b.score * b.weight - a.score * a.weight);

  const seen = new Set<string>();
  const picked: string[] = [];
  for (const s of ranked) {
    if (seen.has(s.label)) continue;
    seen.add(s.label);
    picked.push(`${s.label} ${Math.round(s.score)}`);
    if (picked.length >= max) break;
  }
  return picked.join(" ・ ");
}

/** 先頭の `#` を正規化する。空なら空文字を返す（＝ハッシュタグ無効）。 */
function normalizeHashtag(tag: string): string {
  const t = tag.trim().replace(/^#+/, "").trim();
  return t ? `#${t}` : "";
}
