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
import { PERIOD_LABELS, parsePeriod, sinceUnixForPeriod } from "./period.js";
import { DEFAULT_CONFIG, deriveStreak, scoreEvents } from "./scoring/index.js";
import { formatReport } from "./report.js";
import {
  ANALYSIS_STAGE_LABELS,
  type AnalysisProgress,
  type ScoringConfig,
  type StreakInfo,
} from "./types.js";

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
    "--period <mode>",
    "観測期間モード（all|month|week|day）。直近の範囲に絞って取得・採点する。all=全期間（既定）/ month=1ヶ月 / week=1週間 / day=1日",
    "all",
  )
  .option(
    "--since <unixsec>",
    "この時刻(UNIX秒)より古いイベントは取りに行かない（下限。既定 2021-01-01。--period が all 以外のときはそちらが優先）",
  )
  .option("-t, --tz <hours>", "時間分布の判定に使う UTC オフセット（時間）", "9")
  .option(
    "--window-timeout <ms>",
    "1 リクエスト（1 リレー × 1 ウィンドウ）のタイムアウト（ミリ秒）。超えたウィンドウだけ中断し他リレーに影響しない",
    "30000",
  )
  .option(
    "--relay-timeout <ms>",
    "1 リレーの総取得時間の上限（ミリ秒）。超えたリレーだけ打ち切り、他リレーは継続する",
    "120000",
  )
  .option(
    "--overall-timeout <ms>",
    "任意の全体安全上限（ミリ秒・0 で無効）。主たる打ち切りではなく暴走防止の保険",
    "0",
  )
  .option(
    "--timeout <ms>",
    "[非推奨] 旧グローバルタイムアウト。--overall-timeout（安全上限）の別名として解釈される",
  )
  .option(
    "--no-streak",
    "連続実稼働日数（ストリーク）を計測しない（取得済みイベントからの導出を行わない）",
  )
  .option("--json", "JSON で出力（プログラム連携用）", false)
  .addHelpText(
    "after",
    `
取得方針:
  nostr-fetch を基盤に、authors と許可した kind（プロフィール・投稿・リポスト・
  リアクション・公開チャンネル・DM 関連: 0,1,4,6,7,40,41,42,43,44,13,14,1059）で
  リレーへ問い合わせ、[since, until] を**適応的なタイムウィンドウ（since/until）**に
  区切って取得します。署名検証は行わず、リレーが返したイベントを信頼します。
  密なウィンドウ（>= --dense-threshold 件）は中点で再帰分割して掘り直すため、
  1 日に多数投稿しても件数境界で取りこぼしにくくなります。
  --since（既定 2021-01-01）まで全ウィンドウを覆うか、--max-windows / --max-events /
  リレー単位のタイムアウト上限まで遡ります。掘り切れたか否かは結果に明示されます。

ストリーク（連続実稼働日数）— 取得済みイベントから導出:
  ストリーク（連続実稼働日数）の判定に必要なのは「その日に投稿が 1 件でもあるか」だけです。
  これは上の適応的タイムウィンドウ取得で集めたイベントから導けるため、**別経路の追加取得は
  行いません**（旧実装の「日ごとに最新 1 件を遡る軽量プローブ」を廃止し、二重取得と結果ズレを
  なくしました）。取得済みイベントをローカル日単位に集計し、最新の実稼働日から連続が途切れる
  まで数えます。連続日数は「連続実稼働」シグナル（長期軸・重み 12%・約 60 日で頭打ち）として
  総合スコアに加点され、連続日数が長いほどスコアが上がります。
  取得が要求範囲を覆い切れていれば、観測したギャップは確定なので連続日数は確定値です。
  取得が掘り切れていない（各種上限・タイムアウト）場合のみ下限（truncated）として控えめに
  扱います。--no-streak で計測を無効化できます。

タイムアウト設計（グローバルではなくリクエスト／リレー単位）:
  取得は各リレーを独立に処理します。タイムアウトは責務ごとに分割され、
  あるリレー／ウィンドウのタイムアウトが**他リレーを止めることはありません**。
  - --window-timeout（既定 30000ms）… 1 リクエスト（1 リレー × 1 ウィンドウ）の上限。
  - --relay-timeout （既定 120000ms）… 1 リレーの総取得時間の上限。超えてもそのリレーだけ打ち切り。
  - --overall-timeout（既定 0=無効）… 任意の全体安全上限。暴走防止の二次的な保険にすぎません。
  失敗・タイムアウトしたリレーは history.relayStats / notes に正直に残ります。

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
  period: string;
  since?: string;
  tz: string;
  windowTimeout: string;
  relayTimeout: string;
  overallTimeout: string;
  timeout?: string;
  streak: boolean;
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

/**
 * 採点（解析）の途中経過を stderr に 1 行で上書き表示する（--json 時は出さない）。
 * 取得後に「いまどのステージを・何件まで処理したか」を数値で見せ、巨大データセットでも
 * 固まっていないことを伝える。件数で測れる prepare/aggregate は processed/total を、
 * 件数で測れない signals/finalize はステージ名だけを示す。
 */
function renderCliAnalysisProgress(p: AnalysisProgress): void {
  const label = ANALYSIS_STAGE_LABELS[p.stage];
  const counted = p.stage === "prepare" || p.stage === "aggregate";
  const detail = counted
    ? `${p.processed.toLocaleString()}/${p.total.toLocaleString()} 件`
    : `${p.total.toLocaleString()} 件`;
  process.stderr.write(`\r解析中... [${label}] ${detail}            `);
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

  // 「いま」は取得・採点・ストリーク導出で一貫させるため一度だけ確定する。
  const nowSec = Math.floor(Date.now() / 1000);

  // 観測期間モード（直近 N 日に絞る）。範囲を絞れば観測データが変わり、採点の解釈も従う。
  const period = parsePeriod(opts.period);

  const config: ScoringConfig = {
    ...DEFAULT_CONFIG,
    tzOffsetHours: Number(opts.tz),
    observationPeriod: period,
  };

  // 期間モードが範囲を絞る（all 以外）なら、その下限を since として優先する。
  // all のときは従来どおり --since（未指定なら query.ts の既定 2021-01-01）を使う。
  const explicitSince =
    opts.since != null && opts.since !== "" ? Number(opts.since) : undefined;
  const sinceUnix = sinceUnixForPeriod(period, nowSec) ?? explicitSince;

  if (!opts.json) {
    const periodPart =
      period === "all" ? "全期間" : `直近 ${PERIOD_LABELS[period]}`;
    console.error(
      `リレーへ問い合わせ中... 各リレーを適応的タイムウィンドウで取得（${relays.length} relays, 期間 ${periodPart}, initial-window ${opts.initialWindow}s, dense-threshold ${opts.denseThreshold}）。`,
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
    windowTimeoutMs: Number(opts.windowTimeout),
    relayTimeoutMs: Number(opts.relayTimeout),
    // --overall-timeout を優先。後方互換で旧 --timeout があれば安全上限として読む。
    overallTimeoutMs: Number(opts.overallTimeout) || (opts.timeout ? Number(opts.timeout) : 0),
    onProgress: opts.json ? undefined : renderCliProgress,
  });

  if (!opts.json) {
    // 進捗行を確定させる（次の出力と混ざらないよう改行）。
    process.stderr.write("\n");
  }

  // ── ストリーク（連続実稼働日数）は取得済みイベントから導出する（別経路の取得はしない） ──
  // メイン取得で集めたイベントをローカル日単位に集計し、最新の実稼働日から連続が途切れる
  // まで数える。連続日数は scoreEvents 内で「連続実稼働」シグナル（長期軸・重み 12%）として
  // 総合スコアに加点される。取得が掘り切れていなければ下限（truncated）扱い。--no-streak で無効化。
  let streak: StreakInfo | null = null;
  if (opts.streak) {
    streak = deriveStreak(events, {
      tzOffsetHours: config.tzOffsetHours,
      nowUnix: nowSec,
      historyComplete: meta.historyComplete,
    });
  }

  // ── 解析（採点）フェーズ。巨大データセットでも「取得後に固まっていない」ことを
  // ステージ単位の数値進捗で見せる。--json 時は機械出力を汚さないよう通知しない。
  if (!opts.json) {
    process.stderr.write(`解析中... ${events.length.toLocaleString()} 件を採点します。\n`);
  }
  const result = scoreEvents(
    npub,
    pubkeyHex,
    events,
    config,
    nowSec,
    meta,
    streak,
    opts.json ? undefined : renderCliAnalysisProgress,
  );
  if (!opts.json) {
    // 解析の進捗行を確定させる（次の出力と混ざらないよう改行）。
    process.stderr.write("\n");
  }

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
