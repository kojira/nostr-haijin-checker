/**
 * リレー取得の中核ロジック（環境非依存）。
 *
 * 取得基盤は **nostr-fetch**。`fetchLatestEvents` を「1 ページ」のプリミティブとして
 * 使い、`asOf`(=until) を最古イベントの 1 秒手前へずらしながら **過去へ向かって
 * バックワード・ページング**する。これにより、リレーが返す限り「その人の最初の
 * 投稿」へ向けて遡れる。
 *
 * 重要な設計方針:
 *  - フィルタは **authors のみ**（kinds 指定なし）。kind1/6/7 に限定せず、
 *    すべての kind を取得する。継続性・稼働日の判定を全 kind で行うため。
 *  - リレーは保持期間・件数を保証しない。掘り切れたか否か（HistoryMeta）を
 *    正直に持ち帰り、上位（採点・表示）で「履歴が不完全かもしれない」と明示する。
 *
 * WebSocket 実装は環境ごとに異なる:
 *  - ブラウザ / Node 22+: ネイティブの WebSocket をそのまま使う。
 *  - Node 18-21: グローバルに WebSocket が無いので、呼び出し側（fetch.ts）が
 *    webSocketConstructor に ws を注入する。
 * このモジュール自体は ws を import しないので、ブラウザバンドルに Node 専用
 * 依存を巻き込まない。
 */
import { NostrFetcher, type FetchFilter } from "nostr-fetch";
import type { HistoryMeta, NostrEvent } from "../types.js";

/** nostr-fetch に渡す WebSocket コンストラクタ（環境ごとに注入）。 */
export type WebSocketCtor = NonNullable<
  Parameters<typeof NostrFetcher.init>[0]
>["webSocketConstructor"];

export interface FetchOptions {
  relays: string[];
  /** 1 ページ（1 リレーあたり）で取得する最大イベント数。 */
  pageSize?: number;
  /** バックワード・ページの最大回数（過去を掘る深さの上限）。 */
  maxPages?: number;
  /** 取得イベント数の上限（0/未指定で無制限）。 */
  maxEvents?: number;
  /** 下限時刻（UNIX 秒）。これより古いイベントは取りに行かない。 */
  sinceUnix?: number;
  /** 取得開始の上限時刻（UNIX 秒）。未指定なら「現在」。 */
  untilUnix?: number;
  /** 全体のタイムアウト（ms）。 */
  timeoutMs?: number;
  /** kind を絞りたいとき（既定は未指定＝全 kind）。 */
  kinds?: number[];
  /** Node 環境用の WebSocket 実装注入（ブラウザでは不要）。 */
  webSocketConstructor?: WebSocketCtor;
}

export interface FetchResult {
  events: NostrEvent[];
  /** 実際に問い合わせたリレー数（接続失敗を除く概算）。 */
  relaysQueried: number;
  /** 取得（ページング）のメタ情報。 */
  meta: HistoryMeta;
}

const DEFAULTS = {
  pageSize: 500,
  maxPages: 40,
  maxEvents: 0, // 0 = 無制限
  timeoutMs: 12000,
} as const;

/**
 * 指定 pubkey(hex) のイベントを、過去へ向かってページングしながら取得する。
 *
 * 取得とスコアリングを分離しているため、戻り値の events 配列を
 * そのまま scoreEvents() に渡せる（CLI / Web で共通）。
 */
export async function queryUserEvents(
  pubkeyHex: string,
  opts: FetchOptions,
): Promise<FetchResult> {
  const pageSize = clampPositive(opts.pageSize, DEFAULTS.pageSize);
  const maxPages = clampPositive(opts.maxPages, DEFAULTS.maxPages);
  const maxEvents = Math.max(0, opts.maxEvents ?? DEFAULTS.maxEvents);
  const timeoutMs = clampPositive(opts.timeoutMs, DEFAULTS.timeoutMs);
  const nowSec = Math.floor(Date.now() / 1000);
  const untilInit = opts.untilUnix ?? nowSec;
  const sinceUnix = opts.sinceUnix;

  const filter: FetchFilter = opts.kinds
    ? { authors: [pubkeyHex], kinds: opts.kinds }
    : { authors: [pubkeyHex] };

  const fetcher = NostrFetcher.init(
    opts.webSocketConstructor
      ? { webSocketConstructor: opts.webSocketConstructor }
      : undefined,
  );

  const startedAt = Date.now();
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), timeoutMs);

  const collected = new Map<string, NostrEvent>();
  let cursor = untilInit; // 次ページの until（これより古い分を取りに行く）
  let prevOldest = Number.POSITIVE_INFINITY;
  let pagesFetched = 0;

  // メタ用フラグ。
  let stopReason: HistoryMeta["stopReason"] = "exhausted";
  let reachedOldestAvailable = false;
  let hitEventCap = false;
  let hitPageCap = false;
  let timedOut = false;
  let noProgress = false;

  try {
    for (;;) {
      if (Date.now() - startedAt >= timeoutMs || ac.signal.aborted) {
        stopReason = "timeout";
        timedOut = true;
        break;
      }
      if (pagesFetched >= maxPages) {
        stopReason = "maxPages";
        hitPageCap = true;
        break;
      }

      let page: NostrEvent[];
      try {
        // fetchLatestEvents は asOf(=until) より古い「最新 pageSize 件」を返す。
        page = (await fetcher.fetchLatestEvents(opts.relays, filter, pageSize, {
          asOf: cursor,
          signal: ac.signal,
          connectTimeoutMs: Math.min(timeoutMs, 5000),
        })) as NostrEvent[];
      } catch {
        if (ac.signal.aborted) {
          stopReason = "timeout";
          timedOut = true;
        } else {
          stopReason = "error";
        }
        break;
      }
      pagesFetched++;

      if (page.length === 0) {
        // リレーがこれ以上古いイベントを返さない＝（リレーが保持する限り）掘り切った。
        stopReason = "exhausted";
        reachedOldestAvailable = true;
        break;
      }

      let oldestInPage = Number.POSITIVE_INFINITY;
      for (const ev of page) {
        if (!collected.has(ev.id)) collected.set(ev.id, ev);
        if (ev.created_at < oldestInPage) oldestInPage = ev.created_at;
      }

      // 最古が過去へ進まない＝リレーが until を無視している等。これ以上掘れない。
      if (oldestInPage >= prevOldest) {
        stopReason = "noProgress";
        noProgress = true;
        break;
      }
      prevOldest = oldestInPage;

      if (maxEvents > 0 && collected.size >= maxEvents) {
        stopReason = "maxEvents";
        hitEventCap = true;
        break;
      }
      if (sinceUnix != null && oldestInPage <= sinceUnix) {
        stopReason = "sinceBound";
        break;
      }
      // ページが満杯でない＝リレーにこれ以上古いイベントが無い見込み。
      if (page.length < pageSize) {
        stopReason = "exhausted";
        reachedOldestAvailable = true;
        break;
      }

      cursor = oldestInPage - 1; // 次は厳密に 1 秒手前から（重複と無限ループ防止）。
    }
  } finally {
    clearTimeout(deadline);
    fetcher.shutdown();
  }

  const events = [...collected.values()].sort(
    (a, b) => b.created_at - a.created_at,
  );

  const newestCreatedAt = events.length ? events[0].created_at : null;
  const oldestCreatedAt = events.length
    ? events[events.length - 1].created_at
    : null;

  const meta: HistoryMeta = {
    pagesFetched,
    stopReason,
    reachedOldestAvailable,
    // 「掘り切れた見込み」: 自然終了（exhausted）または下限時刻まで到達したとき。
    historyComplete: stopReason === "exhausted" || stopReason === "sinceBound",
    oldestCreatedAt,
    newestCreatedAt,
    relaysQueried: opts.relays.length,
    elapsedMs: Date.now() - startedAt,
    hitEventCap,
    hitPageCap,
    timedOut,
    noProgress,
  };

  return { events, relaysQueried: opts.relays.length, meta };
}

function clampPositive(v: number | undefined, fallback: number): number {
  if (v == null || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
}
