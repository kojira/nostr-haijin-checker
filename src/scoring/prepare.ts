/**
 * 生の Nostr イベントを、スコアリングしやすい AnalyzedEvent に整形する。
 * タイムゾーン補正もここで行う（時間分布の解釈に使用）。
 */
import type { AnalyzedEvent, NostrEvent, ScoringConfig } from "../types.js";

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

export function prepareEvents(
  events: NostrEvent[],
  config: ScoringConfig,
): AnalyzedEvent[] {
  return events.map((ev) => {
    const { hour, dayKey } = toLocalParts(ev.created_at, config.tzOffsetHours);
    const hasETag = ev.tags.some((t) => t[0] === "e");
    return {
      id: ev.id,
      createdAt: ev.created_at,
      kind: ev.kind,
      isReply: ev.kind === 1 && hasETag,
      isReaction: ev.kind === 7,
      isRepost: ev.kind === 6,
      hourLocal: hour,
      dayKey,
    };
  });
}
