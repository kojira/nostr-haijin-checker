/**
 * 生の Nostr イベントを、スコアリングしやすい AnalyzedEvent に整形する。
 * タイムゾーン補正もここで行う（時間分布の解釈に使用）。
 */
import type { AnalyzedEvent, NostrEvent, ScoringConfig } from "../types.js";

/**
 * 進捗コールバックを呼ぶ間隔（件数）。巨大データセットでも呼び出し過多にならず、
 * かつ「動いている」ことが分かる粒度にする。
 */
const PROGRESS_CHUNK = 5000;

/**
 * created_at(UTC秒) を tzOffset 分ずらした「ローカル時刻」として解釈し、
 * その時/日付を返す。getUTC* を使うことで実行環境の TZ に依存しない。
 */
function toLocalParts(createdAtSec: number, tzOffsetHours: number): {
  hour: number;
  dayKey: string;
} {
  const shifted = new Date((createdAtSec + tzOffsetHours * 3600) * 1000);
  const hour = shifted.getUTCHours();
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return { hour, dayKey: `${y}-${m}-${d}` };
}

/**
 * @param onProgress 任意。整形済み件数を PROGRESS_CHUNK 件ごと（と最後）に通知する。
 *            未指定なら従来どおり一括変換するだけ（挙動・結果は不変）。巨大データセットで
 *            「解析が固まっていない」ことを UI/CLI に見せるために使う。
 */
export function prepareEvents(
  events: NostrEvent[],
  config: ScoringConfig,
  onProgress?: (processed: number) => void,
): AnalyzedEvent[] {
  const out = new Array<AnalyzedEvent>(events.length);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const { hour, dayKey } = toLocalParts(ev.created_at, config.tzOffsetHours);
    const hasETag = ev.tags.some((t) => t[0] === "e");
    out[i] = {
      id: ev.id,
      createdAt: ev.created_at,
      kind: ev.kind,
      isReply: ev.kind === 1 && hasETag,
      isReaction: ev.kind === 7,
      isRepost: ev.kind === 6,
      hourLocal: hour,
      dayKey,
    };
    if (onProgress && (i + 1) % PROGRESS_CHUNK === 0) onProgress(i + 1);
  }
  onProgress?.(events.length);
  return out;
}
