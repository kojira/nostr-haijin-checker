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
    "--page-size <n>",
    "1 ページ（バックワード取得の1回）で取りに行く最大イベント数",
    "500",
  )
  .option(
    "--max-pages <n>",
    "過去へ遡るページの最大回数（深く掘るほど初投稿に近づく）",
    "40",
  )
  .option(
    "--max-events <n>",
    "取得イベント総数の上限（0 で無制限）",
    "0",
  )
  .option(
    "--since <unixsec>",
    "この時刻(UNIX秒)より古いイベントは取りに行かない（下限）",
  )
  .option("-t, --tz <hours>", "時間分布の判定に使う UTC オフセット（時間）", "9")
  .option("--timeout <ms>", "取得全体のタイムアウト（ミリ秒）", "12000")
  .option("--json", "JSON で出力（プログラム連携用）", false)
  .addHelpText(
    "after",
    `
取得方針:
  nostr-fetch を基盤に、authors のみ（全 kind）でリレーへ問い合わせ、
  until を最古イベントの手前へずらしながら**過去へ向かってページング**します。
  リレーがこれ以上古いイベントを返さなくなる（=その人の初投稿に近づく）まで、
  または --max-pages / --max-events / --timeout の上限まで遡ります。
  リレーは保持期間・件数を保証しないため、掘り切れたか否かは結果に明示されます。

例:
  $ nostr-haijin-checker npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m
  $ nostr-haijin-checker <npub> --max-pages 80 --page-size 1000 --tz 9 --json
  $ npm run dev -- <npub>            # ビルド不要の開発実行(tsx)
`,
  );

program.parse();

const npubArg = program.args[0];
const opts = program.opts<{
  relays?: string;
  pageSize: string;
  maxPages: string;
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
    ` ・ ${p.collectedUnique} 件 ・ ${p.pagesFetched} ページ` +
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
      `リレーへ問い合わせ中... 各リレーを過去へページング（${relays.length} relays, page-size ${opts.pageSize}, max-pages ${opts.maxPages}）。1 つ落ちても残りで継続します。`,
    );
  }

  const { events, meta } = await fetchUserEvents(pubkeyHex, {
    relays,
    pageSize: Number(opts.pageSize),
    maxPages: Number(opts.maxPages),
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
