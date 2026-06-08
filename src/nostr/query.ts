/**
 * リレー取得の中核ロジック（環境非依存）。
 *
 * 取得基盤は **nostr-fetch**。`fetchLatestEvents` を「1 ページ」のプリミティブとして
 * 使い、`asOf`(=until) を最古イベントの 1 秒手前へずらしながら **過去へ向かって
 * バックワード・ページング**する。これにより、リレーが返す限り「その人の最初の
 * 投稿」へ向けて遡れる。
 *
 * 取得戦略（部分継続・フォールトトレラント）:
 *  - **リレーごとに独立してページング**し、グローバルに id で重複排除する。
 *    1 つのリレーが失敗・タイムアウトしても全体は止めず、応答するリレーから
 *    取得を継続する（「少なくとも 1 つのリレーがデータを返せる限り続ける」）。
 *  - リレー個別の状態（応答/失敗/遡れた最古/ページ数）を RelayStat として持ち帰り、
 *    HistoryMeta に格納する。UI/README で「どのリレーがどこまで返したか」を可視化する。
 *  - 取得の途中経過は onProgress コールバックで逐次通知する（Web UI のライブ表示・
 *    CLI の進捗行に使う）。
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
import type { HistoryMeta, NostrEvent, RelayStat } from "../types.js";

/** nostr-fetch に渡す WebSocket コンストラクタ（環境ごとに注入）。 */
export type WebSocketCtor = NonNullable<
  Parameters<typeof NostrFetcher.init>[0]
>["webSocketConstructor"];

/**
 * 取得の途中経過スナップショット。onProgress に渡る。
 * 数値で「いまどれだけ進んでいるか」を表し、Web UI のライブ表示・CLI の進捗行に使う。
 */
export interface FetchProgress {
  /** 全リレーが終端に達したら "done"、それ以外は "fetching"。 */
  phase: "fetching" | "done";
  /** 問い合わせ対象のリレー総数。 */
  relaysTotal: number;
  /** 終端に達したリレー数（成功・失敗を含む）。 */
  relaysCompleted: number;
  /** データを返した（接続できた）リレー数。 */
  relaysSucceeded: number;
  /** 失敗／タイムアウトしたリレー数。 */
  relaysFailed: number;
  /** これまでに集めたユニークなイベント数（重複排除後）。 */
  collectedUnique: number;
  /** ここまで遡れたグローバル最古 created_at（UNIX 秒）。null は未到達。 */
  oldestReached: number | null;
  /** 観測できたグローバル最新 created_at（UNIX 秒）。 */
  newestReached: number | null;
  /** これまでに投げた総ページ数（全リレー合計）。 */
  pagesFetched: number;
  /** 取得開始からの経過時間（ms）。 */
  elapsedMs: number;
  /** リレー個別の状態スナップショット。 */
  relays: RelayStat[];
}

/** 取得の途中経過を受け取るコールバック。 */
export type ProgressCallback = (progress: FetchProgress) => void;

export interface FetchOptions {
  relays: string[];
  /** 1 ページ（1 リレーあたり）で取得する最大イベント数。 */
  pageSize?: number;
  /** バックワード・ページの最大回数（過去を掘る深さの上限・リレーごと）。 */
  maxPages?: number;
  /** 取得イベント数の上限（0/未指定で無制限・グローバル）。 */
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
  /** 取得の途中経過を受け取るコールバック（任意）。 */
  onProgress?: ProgressCallback;
}

export interface FetchResult {
  events: NostrEvent[];
  /** 実際に問い合わせたリレー数（概算）。 */
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

/** 終端（これ以上ページしない）状態か。 */
function isTerminal(status: RelayStat["status"]): boolean {
  return status !== "pending" && status !== "querying";
}

/** 失敗扱い（接続できなかった）か。 */
function isFailure(status: RelayStat["status"]): boolean {
  return status === "failed" || status === "timeout";
}

/**
 * 指定 pubkey(hex) のイベントを、過去へ向かってページングしながら取得する。
 *
 * 各リレーを独立にページングし、グローバルに重複排除する。1 つのリレーが
 * 失敗しても全体は止めない（部分継続）。取得とスコアリングを分離しているため、
 * 戻り値の events 配列をそのまま scoreEvents() に渡せる（CLI / Web で共通）。
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
  const onProgress = opts.onProgress;

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

  // グローバル状態（全リレーで共有）。
  const collected = new Map<string, NostrEvent>();
  let newestGlobal: number | null = null;
  let globalCapHit = false; // maxEvents に到達
  let sinceBoundHit = false; // --since の下限まで遡った

  // リレー個別の状態（そのまま FetchProgress / HistoryMeta に出す）。
  const runtimes: RelayStat[] = opts.relays.map((url) => ({
    url,
    status: "pending",
    events: 0,
    pages: 0,
    oldestReached: null,
  }));

  // 進捗通知（軽くスロットリング。ネットワーク律速なので 120ms で十分）。
  let lastEmit = 0;
  function emit(force = false): void {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < 120) return;
    lastEmit = now;
    onProgress(snapshot());
  }
  function snapshot(): FetchProgress {
    let oldest: number | null = null;
    let succeeded = 0;
    let failed = 0;
    let completed = 0;
    let pages = 0;
    for (const r of runtimes) {
      pages += r.pages;
      if (r.oldestReached != null) {
        oldest = oldest == null ? r.oldestReached : Math.min(oldest, r.oldestReached);
      }
      if (isTerminal(r.status)) {
        completed++;
        if (isFailure(r.status)) failed++;
        else succeeded++;
      }
    }
    return {
      phase: completed === runtimes.length ? "done" : "fetching",
      relaysTotal: runtimes.length,
      relaysCompleted: completed,
      relaysSucceeded: succeeded,
      relaysFailed: failed,
      collectedUnique: collected.size,
      oldestReached: oldest,
      newestReached: newestGlobal,
      pagesFetched: pages,
      elapsedMs: Date.now() - startedAt,
      relays: runtimes.map((r) => ({ ...r })),
    };
  }

  /** 1 リレーを独立にバックワード・ページングする。例外は内部で握りつぶす。 */
  async function runRelay(rt: RelayStat): Promise<void> {
    rt.status = "querying";
    emit();
    let cursor = untilInit; // 次ページの until（これより古い分を取りに行く）
    let prevOldest = Number.POSITIVE_INFINITY;

    for (;;) {
      if (ac.signal.aborted || Date.now() - startedAt >= timeoutMs) {
        rt.status = "timeout";
        break;
      }
      // 別リレーが件数上限に到達したら、このリレーも丁寧に止める。
      if (globalCapHit) {
        rt.status = rt.status === "querying" ? "ok" : rt.status;
        break;
      }
      if (rt.pages >= maxPages) {
        rt.status = "maxPages";
        break;
      }

      let page: NostrEvent[];
      try {
        page = (await fetcher.fetchLatestEvents([rt.url], filter, pageSize, {
          asOf: cursor,
          signal: ac.signal,
          connectTimeoutMs: Math.min(timeoutMs, 5000),
        })) as NostrEvent[];
      } catch (err) {
        if (ac.signal.aborted || Date.now() - startedAt >= timeoutMs) {
          rt.status = "timeout";
        } else {
          rt.status = "failed";
          rt.error = err instanceof Error ? err.message : String(err);
        }
        break;
      }
      rt.pages++;

      if (page.length === 0) {
        // 1 ページ目で 0 件＝このリレーには対象の投稿が無い。
        // 2 ページ目以降の 0 件＝これ以上古いイベントを返さない（遡り切り）。
        rt.status = rt.pages === 1 ? "empty" : "exhausted";
        break;
      }
      rt.events += page.length;

      let oldestInPage = Number.POSITIVE_INFINITY;
      for (const ev of page) {
        if (!collected.has(ev.id)) collected.set(ev.id, ev);
        if (ev.created_at < oldestInPage) oldestInPage = ev.created_at;
        if (newestGlobal == null || ev.created_at > newestGlobal) {
          newestGlobal = ev.created_at;
        }
      }
      rt.oldestReached =
        rt.oldestReached == null
          ? oldestInPage
          : Math.min(rt.oldestReached, oldestInPage);

      // 最古が過去へ進まない＝リレーが until を無視している等。これ以上掘れない。
      if (oldestInPage >= prevOldest) {
        rt.status = "noProgress";
        break;
      }
      prevOldest = oldestInPage;

      if (maxEvents > 0 && collected.size >= maxEvents) {
        globalCapHit = true;
        rt.status = "ok";
        emit(true);
        break;
      }
      if (sinceUnix != null && oldestInPage <= sinceUnix) {
        sinceBoundHit = true;
        rt.status = "exhausted";
        break;
      }
      // ページが満杯でない＝リレーにこれ以上古いイベントが無い見込み。
      if (page.length < pageSize) {
        rt.status = "exhausted";
        break;
      }

      cursor = oldestInPage - 1; // 次は厳密に 1 秒手前から（重複と無限ループ防止）。
      emit();
    }
    emit(true);
  }

  try {
    // すべてのリレーを並行にページング。1 つが失敗しても他は続く。
    await Promise.allSettled(runtimes.map((rt) => runRelay(rt)));
  } finally {
    clearTimeout(deadline);
    fetcher.shutdown();
  }
  emit(true);

  const events = [...collected.values()].sort(
    (a, b) => b.created_at - a.created_at,
  );

  const newestCreatedAt = events.length ? events[0].created_at : null;
  const oldestCreatedAt = events.length
    ? events[events.length - 1].created_at
    : null;

  // ── グローバルな停止理由・到達度をリレー個別状態から集計する ──
  const relaysFailed = runtimes.filter((r) => isFailure(r.status)).length;
  const relaysSucceeded = runtimes.length - relaysFailed;
  const timedOut = runtimes.some((r) => r.status === "timeout");
  const hitPageCap = runtimes.some((r) => r.status === "maxPages");
  const hitEventCap = globalCapHit;
  const noProgress = runtimes.some((r) => r.status === "noProgress");
  const reachedOldestAvailable = runtimes.some((r) => r.status === "exhausted");

  // 最も「掘り切れていない」理由を優先して 1 つ選ぶ（表示用の単一 enum）。
  let stopReason: HistoryMeta["stopReason"];
  if (collected.size === 0 && relaysFailed === runtimes.length) {
    stopReason = "error";
  } else if (timedOut) {
    stopReason = "timeout";
  } else if (hitEventCap) {
    stopReason = "maxEvents";
  } else if (hitPageCap) {
    stopReason = "maxPages";
  } else if (sinceBoundHit) {
    stopReason = "sinceBound";
  } else if (reachedOldestAvailable) {
    stopReason = "exhausted";
  } else if (noProgress) {
    stopReason = "noProgress";
  } else {
    stopReason = "exhausted";
  }

  const meta: HistoryMeta = {
    pagesFetched: runtimes.reduce((s, r) => s + r.pages, 0),
    stopReason,
    reachedOldestAvailable,
    // 「掘り切れた見込み」: 応答したリレーを自然終了まで遡れた／下限時刻まで到達。
    historyComplete: stopReason === "exhausted" || stopReason === "sinceBound",
    oldestCreatedAt,
    newestCreatedAt,
    relaysQueried: opts.relays.length,
    relaysSucceeded,
    relaysFailed,
    relayStats: runtimes.map((r) => ({ ...r })),
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
