/**
 * 総合スコア(0-100)をランク（廃人度の段階）にマッピングする。
 */
import type { Rank } from "../types.js";

/** 下限スコアの降順に並べる（先頭から最初に min を満たすものを採用）。 */
export const RANKS: Rank[] = [
  {
    label: "完全体廃人",
    emoji: "💀",
    min: 85,
    description: "Nostr と一体化している。睡眠と投稿の境界が消失。",
  },
  {
    label: "廃人",
    emoji: "🔥",
    min: 70,
    description: "生活の中心が Nostr。通知が鳴れば即反応。",
  },
  {
    label: "ヘビーユーザー",
    emoji: "⚡",
    min: 55,
    description: "毎日しっかり投稿。立派な常連。",
  },
  {
    label: "アクティブ",
    emoji: "🌱",
    min: 40,
    description: "そこそこ活発。健全な距離感。",
  },
  {
    label: "ライトユーザー",
    emoji: "🍵",
    min: 20,
    description: "ときどき覗く程度。社会性を保っている。",
  },
  {
    label: "ROM専・休眠",
    emoji: "😴",
    min: 0,
    description: "ほとんど投稿していない、または観測できず。",
  },
];

export function rankForScore(score: number): Rank {
  return RANKS.find((r) => score >= r.min) ?? RANKS[RANKS.length - 1];
}
