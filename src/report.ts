/**
 * ScoreResult を人間向けのテキスト出力に整形する。
 * 色付けは ANSI エスケープを直接使い、依存を増やさない。
 */
import type { ScoreResult, SignalScore } from "./types.js";
import { PERIOD_LABELS } from "./period.js";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
};

function bar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function fmtDate(sec: number | null): string {
  if (sec == null) return "-";
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function signalLine(s: SignalScore): string {
  const pct = String(Math.round(s.score)).padStart(3, " ");
  return (
    `  ${s.label.padEnd(8, "　")} ${c.cyan}${bar(s.score)}${c.reset} ${pct} ` +
    `${c.dim}(重み ${Math.round(s.weight * 100)}%)${c.reset}\n` +
    `             ${c.dim}${s.reason}${c.reset}`
  );
}

/** 3 軸サブスコアの 1 行（ヘッドライン用）。 */
function axisLine(label: string, score: number, suffix = ""): string {
  const pct = String(Math.round(score)).padStart(3, " ");
  return (
    `  ${c.bold}${label.padEnd(10, "　")}${c.reset} ${c.green}${bar(
      score,
    )}${c.reset} ${pct}${suffix}`
  );
}

export function formatReport(result: ScoreResult): string {
  const lines: string[] = [];
  const obs = result.observation;
  lines.push("");
  lines.push(`${c.bold}=== Nostr 廃人度チェック ===${c.reset}`);
  lines.push(`${c.dim}npub:${c.reset} ${result.npub}`);
  lines.push(
    `${c.dim}期間モード:${c.reset} ${c.bold}${
      PERIOD_LABELS[result.observationPeriod]
    }${c.reset}`,
  );
  lines.push(
    `${c.dim}観測:${c.reset} ${result.sampleSize} 件 / ${fmtDate(
      result.windowStart,
    )} 〜 ${fmtDate(result.windowEnd)} (${result.timezone})`,
  );
  lines.push(
    `${c.dim}観測ウィンドウ:${c.reset} ${obs.observedWindowDays} 日 / 実稼働 ${obs.observedActiveDays} 日 / 初観測から ${obs.firstSeenAgeDays} 日前` +
      `  ${c.dim}観測信頼度 ${Math.round(obs.confidence * 100)}%${c.reset}`,
  );
  if (result.history) {
    const h = result.history;
    const dug = h.historyComplete
      ? `${c.green}リレーが返す限界まで到達${c.reset}`
      : `${c.yellow}掘り切れず（${h.stopReason}）${c.reset}`;
    const relayPart =
      h.relaysFailed > 0
        ? `リレー ${h.relaysSucceeded}/${h.relaysQueried} 応答 ${c.yellow}(失敗 ${h.relaysFailed})${c.reset}`
        : `リレー ${h.relaysSucceeded}/${h.relaysQueried} 応答`;
    lines.push(
      `${c.dim}取得:${c.reset} ${h.pagesFetched} ページ / ${relayPart} / ${h.elapsedMs}ms ・ 履歴 ${dug}`,
    );
  }
  // ストリーク（連続実稼働日数）は取得済みイベントから導出した結果。
  // 連続日数は「連続実稼働」シグナル（長期軸・重み 12%）として総合へ加点される。
  if (result.streak) {
    const s = result.streak;
    let body: string;
    if (s.currentStreakDays === 0) {
      body = `${c.dim}活動なし（直近に実稼働日が見つかりません）${c.reset}`;
    } else {
      const state = s.ongoing
        ? `${c.green}継続中${c.reset}`
        : `${c.yellow}途切れ（${s.daysSinceLastActive ?? "?"}日前）${c.reset}`;
      const more = s.truncated ? `${c.yellow}（取得が掘り切れず下限: さらに長い可能性）${c.reset}` : "";
      body =
        `${c.bold}${s.currentStreakDays}${c.reset} 日 ${state}` +
        ` ・ 最新実稼働 ${s.lastActiveDay ?? "-"}${more ? " " + more : ""}`;
    }
    lines.push(
      `${c.dim}連続実稼働:${c.reset} ${body} ${c.dim}※取得済みイベントから日ごとに1件以上の有無で判定。連続日数は「連続実稼働」シグナルとして総合に加点（長期軸・重み12%・約60日で頭打ち）${c.reset}`,
    );
  }
  lines.push("");

  // ── 3 軸を分離して提示（短期 / 長期 / 総合） ──
  lines.push(`${c.bold}スコア（3 軸）:${c.reset}`);
  lines.push(axisLine("短期アクティブ度", result.subScores.shortTermActivity));
  const longSuffix = obs.longTermAssessable
    ? ""
    : `  ${c.yellow}短期中心で評価${c.reset}`;
  lines.push(
    axisLine("長期継続・古参度", result.subScores.longTermRetention, longSuffix),
  );
  lines.push(axisLine("利用パターン", result.subScores.usagePattern));
  lines.push("");
  lines.push(
    `${c.bold}総合廃人スコア:${c.reset} ${c.yellow}${result.totalScore}${c.reset} / 100`,
  );
  lines.push(
    `${c.bold}ランク:${c.reset} ${result.rank.emoji} ${c.magenta}${c.bold}${result.rank.label}${c.reset}`,
  );
  lines.push(`        ${c.dim}${result.rank.description}${c.reset}`);
  if (!obs.longTermAssessable) {
    lines.push(
      `        ${c.yellow}※ 長期継続よりも短期の活発さを中心に評価しています。${c.reset}`,
    );
  }
  lines.push("");

  lines.push(`${c.bold}内訳（根拠）:${c.reset}`);
  for (const s of result.signals) {
    lines.push(signalLine(s));
  }
  lines.push("");
  if (result.notes.length) {
    lines.push(`${c.bold}注意:${c.reset}`);
    for (const n of result.notes) {
      lines.push(`  ${c.dim}- ${n}${c.reset}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
