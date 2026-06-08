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
import { fetchUserEvents, type FetchProgress } from "./nostr/fetch.js";
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
  .option(
    "-r, --relays <urls>",
    "カンマ区切りのリレー URL（未指定ならデフォルト一式）",
  )
  .option(
    "--initial-window <sec>",
    "最初に範囲を区切る粗いウィンドウ幅（秒）",
    "2592000",
  )
  .option(
    "--dense-threshold <n>",
    "この件数以上を返したウィンドウは中点で分割して掘り直す（密判定）",
    "1000",
  )
  .option(
    "--min-window <sec>",
    "これ以下の幅のウィンドウはそれ以上分割しない（秒）",
    "3600",
  )
  .option(
    "--max-windows <n>",
    "1 リレーあたりのウィンドウ処理数の安全上限",
    "5000",
  )
  .option(
    "--max-events <n>",
    "取得イベント総数の上限（0 で無制限）",
    "0",
  )
  .option(
    "--since <unixsec>",
    "この時刻(UNIX秒)より古いイベントは取りに行かない（下限。既定 2021-01-01）",
  )
  .option("-t, --tz <hours>", "時間分布の判定に使う UTC オフセット（時間）", "9")
  .option("--timeout <ms>", "取得全体のタイムアウト（ミリ秒）", "12000")
  .option("--json", "JSON で出力（プログラム連携用）", false)
  .addHelpText(
    "after",
    `
取得方針:
  nostr-fetch を基盤に、authors のみ（全 kind）でリレーへ問い合わせ、
  [since, until] を**適応的なタイムウィンドウ（since/until）**に区切って取得します。
  密なウィンドウ（>= --dense-threshold 件）は中点で再帰分割して掘り直すため、
  1 日に多数投稿しても件数境界で取りこぼしにくくなります。
  --since（既定 2021-01-01）まで全ウィンドウを覆うか、--max-windows / --max-events /
  --timeout の上限まで遡ります。掘り切れたか否かは結果に明示されます。

例:
  $ nostr-haijin-checker npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m
  $ nostr-haijin-checker <npub> --dense-threshold 800 --max-windows 8000 --tz 9 --json
  $ npm run dev -- <npub>            # ビルド不要の開発実行(tsx)
`,
  );

program.parse();

const npubArg = program.args[0];
const opts = program.opts<{
  relays?: string;
  initialWindow: string;
  denseThreshold: string;
  minWindow: string;
  maxWindows: string;
  maxEvents: string;
  since?: string;
  tz: string;
  timeout: string;
  json: boolean;
}>();

/** UNIX 秒を短い日付文字列に（進捗行用）。 */
function fmtShort(sec: number | null): string {
  if (sec == null) return "-";
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/**
 * 取得の途中経過を stderr に 1 行で上書き表示する（--json 時は出さない）。
 * 「リレーいくつが応答/失敗・何件・何ページ・どこまで遡れたか」を数値で見せる。
 */
function renderCliProgress(p: FetchProgress): void {
  const failed = p.relaysFailed > 0 ? ` 失敗 ${p.relaysFailed}` : "";
  const line =
    `\r取得中... リレー ${p.relaysSucceeded}/${p.relaysTotal} 応答${failed}` +
    ` ・ ${p.collectedUnique} 件 ・ ${p.pagesFetched} ウィンドウ` +
    ` ・ 最古 ${fmtShort(p.oldestReached)} ・ ${(p.elapsedMs / 1000).toFixed(
      1,
    )}s   `;
  process.stderr.write(line);
}

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
  };

  const sinceUnix =
    opts.since != null && opts.since !== "" ? Number(opts.since) : undefined;

  if (!opts.json) {
    console.error(
      `リレーへ問い合わせ中... 各リレーを適応的タイムウィンドウで取得（${relays.length} relays, initial-window ${opts.initialWindow}s, dense-threshold ${opts.denseThreshold}）。1 つ落ちても残りで継続します。`,
    );
  }

  const { events, meta } = await fetchUserEvents(pubkeyHex, {
    relays,
    initialWindowSeconds: Number(opts.initialWindow),
    denseThreshold: Number(opts.denseThreshold),
    minWindowSeconds: Number(opts.minWindow),
    maxWindows: Number(opts.maxWindows),
    maxEvents: Number(opts.maxEvents),
    sinceUnix,
    timeoutMs: Number(opts.timeout),
    onProgress: opts.json ? undefined : renderCliProgress,
  });

  if (!opts.json) {
    // 進捗行を確定させる（次の出力と混ざらないよう改行）。
    process.stderr.write("\n");
  }

  const result = scoreEvents(
    npub,
    pubkeyHex,
    events,
    config,
    Math.floor(Date.now() / 1000),
    meta,
  );

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
