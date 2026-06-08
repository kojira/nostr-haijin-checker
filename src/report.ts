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
    `  ${s.label.padEnd(6, "　")} ${c.cyan}${bar(s.score)}${c.reset} ${pct} ` +
    `${c.dim}(重み ${Math.round(s.weight * 100)}%)${c.reset}\n` +
    `         ${c.dim}${s.reason}${c.reset}`
  );
}

export function formatReport(result: ScoreResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`${c.bold}=== Nostr 廃人度チェック ===${c.reset}`);
  lines.push(`${c.dim}npub:${c.reset} ${result.npub}`);
  lines.push(
    `${c.dim}観測:${c.reset} ${result.sampleSize} 件 / ${fmtDate(
      result.windowStart,
    )} 〜 ${fmtDate(result.windowEnd)} (${result.timezone})`,
  );
  lines.push("");
  lines.push(
    `${c.bold}総合スコア:${c.reset} ${c.yellow}${result.totalScore}${c.reset} / 100`,
  );
  lines.push(
    `${c.bold}ランク:${c.reset} ${result.rank.emoji} ${c.magenta}${c.bold}${result.rank.label}${c.reset}`,
  );
  lines.push(`        ${c.dim}${result.rank.description}${c.reset}`);
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
