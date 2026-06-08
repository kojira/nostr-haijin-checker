/**
 * ScoreResult を人間向けのテキスト出力に整形する。
 * 色付けは ANSI エスケープを直接使い、依存を増やさない。
 */
import type { ScoreResult, SignalScore } from "./types.js";

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
    `${c.dim}観測:${c.reset} ${result.sampleSize} 件 / ${fmtDate(
      result.windowStart,
    )} 〜 ${fmtDate(result.windowEnd)} (${result.timezone})`,
  );
  lines.push(
    `${c.dim}観測ウィンドウ:${c.reset} ${obs.observedWindowDays} 日 / 実稼働 ${obs.observedActiveDays} 日 / 初観測から ${obs.firstSeenAgeDays} 日前` +
      `  ${c.dim}観測信頼度 ${Math.round(obs.confidence * 100)}%${c.reset}`,
  );
  lines.push("");

  // ── 3 軸を分離して提示（短期 / 長期 / 総合） ──
  lines.push(`${c.bold}スコア（3 軸）:${c.reset}`);
  lines.push(axisLine("短期アクティブ度", result.subScores.shortTermActivity));
  const longSuffix = obs.longTermAssessable
    ? ""
    : `  ${c.yellow}⚠ 観測ウィンドウ不足（low-confidence）${c.reset}`;
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
      `        ${c.yellow}※ 短い観測ウィンドウのため「長期継続」は主張していません（短期の活発さが中心）。${c.reset}`,
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
