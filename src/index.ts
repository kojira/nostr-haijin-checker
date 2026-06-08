#!/usr/bin/env node
/**
 * CLI エントリポイント。
 *
 * 使い方:
 *   nostr-haijin-checker <npub> [options]
 *
 * 役割は「引数解釈 → 取得 → スコアリング → 出力」のつなぎ込みのみ。
 * 取得(nostr/)・採点(scoring/) のロジックは独立モジュールに分離している。
 */
import { Command } from "commander";
import { fetchUserEvents } from "./nostr/fetch.js";
import { DEFAULT_RELAYS } from "./nostr/relays.js";
import { InvalidNpubError, toNpub, toPubkeyHex } from "./nostr/npub.js";
import { DEFAULT_CONFIG, scoreEvents } from "./scoring/index.js";
import { formatReport } from "./report.js";
import type { ScoringConfig } from "./types.js";

const program = new Command();

program
  .name("nostr-haijin-checker")
  .description(
    "Nostr の投稿パターンから「廃人度（Haijin score）」を説明可能なロジックで採点します。",
  )
  .version("0.1.0")
  .argument("<npub>", "対象ユーザーの npub（または 64桁 hex 公開鍵）")
  .option("-l, --limit <n>", "リレーから取得する最大イベント数", "500")
  .option(
    "-r, --relays <urls>",
    "カンマ区切りのリレー URL（未指定ならデフォルト一式）",
  )
  .option("-t, --tz <hours>", "深夜判定に使う UTC オフセット（時間）", "9")
  .option("--late-start <hour>", "深夜帯の開始時刻(0-23)", "0")
  .option("--late-end <hour>", "深夜帯の終了時刻(0-24, 含まない)", "5")
  .option("--timeout <ms>", "取得タイムアウト（ミリ秒）", "8000")
  .option("--json", "JSON で出力（プログラム連携用）", false)
  .addHelpText(
    "after",
    `
例:
  $ nostr-haijin-checker npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m
  $ nostr-haijin-checker <npub> --limit 1000 --tz 9 --json
  $ npm run dev -- <npub>            # ビルド不要の開発実行(tsx)
`,
  );

program.parse();

const npubArg = program.args[0];
const opts = program.opts<{
  limit: string;
  relays?: string;
  tz: string;
  lateStart: string;
  lateEnd: string;
  timeout: string;
  json: boolean;
}>();

async function main(): Promise<void> {
  let pubkeyHex: string;
  let npub: string;
  try {
    pubkeyHex = toPubkeyHex(npubArg);
    npub = npubArg.startsWith("npub1") ? npubArg.trim() : toNpub(pubkeyHex);
  } catch (err) {
    if (err instanceof InvalidNpubError) {
      console.error(`エラー: ${err.message}`);
      console.error("npub1... 形式、または 64桁の hex 公開鍵を渡してください。");
      process.exit(2);
    }
    throw err;
  }

  const relays = opts.relays
    ? opts.relays.split(",").map((r) => r.trim()).filter(Boolean)
    : DEFAULT_RELAYS;

  const config: ScoringConfig = {
    ...DEFAULT_CONFIG,
    tzOffsetHours: Number(opts.tz),
    lateNightStart: Number(opts.lateStart),
    lateNightEnd: Number(opts.lateEnd),
  };

  if (!opts.json) {
    console.error(
      `リレーへ問い合わせ中... (${relays.length} relays, limit ${opts.limit})`,
    );
  }

  const { events } = await fetchUserEvents(pubkeyHex, {
    relays,
    limit: Number(opts.limit),
    timeoutMs: Number(opts.timeout),
  });

  const result = scoreEvents(npub, pubkeyHex, events, config);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(result));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("予期しないエラー:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
