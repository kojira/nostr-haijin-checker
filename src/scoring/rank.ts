/**
 * 総合スコア(0-100)をランク（廃人度の段階）にマッピングする。
 */
import type { Rank } from "../types.js";

/**
 * 下限スコアの降順に並べる（先頭から最初に min を満たすものを採用）。
 * 説明文は Nostr ネイティブな語彙（リレー・イベント・kind・zap・分散）で記述する。
 */
export const RANKS: Rank[] = [
  {
    label: "完全体廃人",
    emoji: "💀",
    min: 85,
    description:
      "複数リレーへ絶え間なくイベントを刻み続ける分散の体現者。睡眠もまた kind1 の合間。",
  },
  {
    label: "廃人",
    emoji: "🔥",
    min: 70,
    description:
      "生活がリレーと同期している。新着ノートには即リプライ、流れてくる投稿には即 zap。",
  },
  {
    label: "ヘビーユーザー",
    emoji: "⚡",
    min: 55,
    description:
      "毎日欠かさずリレーに足跡を残す常連。フォロー先の会話にもしっかり混ざる。",
  },
  {
    label: "アクティブ",
    emoji: "🌱",
    min: 40,
    description:
      "気が向いたときにノートを流す健全なリレー住民。タイムラインとは良い距離感。",
  },
  {
    label: "ライトユーザー",
    emoji: "🍵",
    min: 20,
    description:
      "ときどきクライアントを開いてタイムラインを覗く程度。リレーには静かに在る。",
  },
  {
    label: "サイレント・休眠",
    emoji: "😴",
    min: 0,
    description:
      "ほとんどイベントを発行していない、または購読したリレーからは観測できず。",
  },
];

export function rankForScore(score: number): Rank {
  return RANKS.find((r) => score >= r.min) ?? RANKS[RANKS.length - 1];
}
