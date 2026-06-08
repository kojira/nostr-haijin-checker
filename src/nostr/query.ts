/**
 * リレー取得の中核ロジック（環境非依存）。
 *
 * 取得基盤は **nostr-fetch**。`fetchAllEvents(relays, filter, {since, until}, opts)`
 * を「1 つの時間ウィンドウ」のプリミティブとして使い、過去〜現在を **適応的な
 * タイムウィンドウ（since/until）** に区切って取得する。
 *
 * なぜタイムウィンドウか:
 *  - 旧実装は固定件数のバックワード・ページング（until を最古イベントの 1 秒手前へ
 *    ずらす）だったが、同一タイムスタンプを境界で共有するイベントが多いと **取りこぼし**
 *    が起きうる（1 日に 500 件超など）。`since/until` で範囲を明示し、密な期間は
 *    ウィンドウを分割して掘り直すことで、件数ベースの境界バグを避ける。
 *  - `fetchAllEvents` 自体が内部で limitPerReq 単位にページングし、ウィンドウ内では
 *    id で重複排除するので、1 ウィンドウの取得は境界安全。ここでのウィンドウ分割は
 *    「単一リレーが 1 リクエストで全部返せない（リレー側のキャップ）」場合の保険・
 *    精緻化レイヤーである。
 *  - NostrActivity の「日次ウィンドウで遡る」発想を参考に、固定日次ではなく
 *    **密度に応じて再帰分割する適応ウィンドウ**にした（疎な期間は粗いまま、密な期間
 *    だけ細かく掘るのでリクエスト数を抑えられる）。
 *
 * 取得戦略（部分継続・フォールトトレラント）:
 *  - **リレーごとに独立してウィンドウを処理**し、グローバルに id で重複排除する。
 *    1 つのリレーが失敗・タイムアウトしても全体は止めず、応答するリレーから
 *    取得を継続する（「少なくとも 1 つのリレーがデータを返せる限り続ける」）。
 *  - リレー個別の状態（応答/失敗/遡れた最古/ウィンドウ数）を RelayStat として持ち帰り、
 *    HistoryMeta に格納する。UI/README で「どのリレーがどこまで返したか」を可視化する。
 *  - 取得の途中経過は onProgress コールバックで逐次通知する（Web UI のライブ表示・
 *    CLI の進捗行に使う）。
 *
 * 重要な設計方針:
 *  - フィルタは **authors のみ**（kinds 指定なし）。kind1/6/7 に限定せず、
 *    すべての kind を取得する。継続性・稼働日の判定を全 kind で行うため。
 *  - リレーは保持期間・件数を保証しない。掘り切れたか否か（HistoryMeta）を
 *    正直に持ち帰り、上位（採点・表示）で「履歴が不完全かもしれない」と明示する。
 *  - **リレーの役割分割（長期用/短期用など）は行わない**。全リレーを同条件で扱う。
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
 * テストシーム用の最小フェッチャ・インターフェイス。
 * 本番では NostrFetcher がこれを満たす。テストではネットワークに触れない疑似実装を
 * 注入して、ウィンドウ分割・重複排除・部分失敗などを決定的に検証する。
 */
export interface MinimalFetcher {
  fetchAllEvents(
    relayUrls: string[],
    filter: FetchFilter,
    timeRangeFilter: { since?: number; until?: number },
    options?: {
      sort?: boolean;
      signal?: AbortSignal;
      connectTimeoutMs?: number;
      limitPerReq?: number;
    },
  ): Promise<NostrEvent[]>;
  shutdown?: () => void;
}

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
  /** これまでに処理した時間ウィンドウの総数（全リレー合計。旧称 pagesFetched のまま）。 */
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
  /** 最初に範囲を区切る粗いウィンドウ幅（秒）。既定 30 日。 */
  initialWindowSeconds?: number;
  /** このイベント数以上を返したウィンドウは中点で分割して掘り直す（密判定）。既定 1000。 */
  denseThreshold?: number;
  /** これ以下の幅のウィンドウはそれ以上分割しない（秒）。既定 1 時間。 */
  minWindowSeconds?: number;
  /** 1 リレーあたりのウィンドウ処理数の安全上限。既定 5000。 */
  maxWindows?: number;
  /** 取得イベント数の上限（0/未指定で無制限・グローバル）。 */
  maxEvents?: number;
  /** 下限時刻（UNIX 秒）。これより古いイベントは取りに行かない。未指定なら DEFAULT_SINCE。 */
  sinceUnix?: number;
  /** 取得の上限時刻（UNIX 秒）。未指定なら「現在」。 */
  untilUnix?: number;
  /** 全体のタイムアウト（ms）。 */
  timeoutMs?: number;
  /** kind を絞りたいとき（既定は未指定＝全 kind）。 */
  kinds?: number[];
  /** Node 環境用の WebSocket 実装注入（ブラウザでは不要）。 */
  webSocketConstructor?: WebSocketCtor;
  /** 取得の途中経過を受け取るコールバック（任意）。 */
  onProgress?: ProgressCallback;
  /**
   * テストシーム。指定すると NostrFetcher.init の代わりにこのフェッチャを使う。
   * 本番（CLI/ブラウザ）では渡さない。未指定時の挙動は一切変わらない。
   */
  fetcher?: MinimalFetcher;
}

export interface FetchResult {
  events: NostrEvent[];
  /** 実際に問い合わせたリレー数（概算）。 */
  relaysQueried: number;
  /** 取得（タイムウィンドウ）のメタ情報。 */
  meta: HistoryMeta;
}

/**
 * 下限時刻の既定値。2021-01-01 00:00:00 UTC = 1609459200。
 * Nostr の実用上ほぼ全履歴をカバーする床（旧実装は実質「リレーが返す限界＝初投稿」
 * まで遡っていた）。これ以前のイベントは取りに行かない。
 */
export const DEFAULT_SINCE = 1609459200;

const DEFAULTS = {
  initialWindowSeconds: 2592000, // 30 日
  denseThreshold: 1000,
  minWindowSeconds: 3600, // 1 時間
  maxWindows: 5000,
  maxEvents: 0, // 0 = 無制限
  timeoutMs: 12000,
} as const;

/** 終端（これ以上ウィンドウを処理しない）状態か。 */
function isTerminal(status: RelayStat["status"]): boolean {
  return status !== "pending" && status !== "querying";
}

/** 失敗扱い（接続できなかった）か。 */
function isFailure(status: RelayStat["status"]): boolean {
  return status === "failed" || status === "timeout";
}

/** 1 つの時間ウィンドウ（[since, until)）。 */
interface Window {
  since: number;
  until: number;
}

/**
 * 指定 pubkey(hex) のイベントを、適応的タイムウィンドウで取得する。
 *
 * 各リレーを独立にウィンドウ処理し、グローバルに重複排除する。1 つのリレーが
 * 失敗しても全体は止めない（部分継続）。取得とスコアリングを分離しているため、
 * 戻り値の events 配列をそのまま scoreEvents() に渡せる（CLI / Web で共通）。
 */
export async function queryUserEvents(
  pubkeyHex: string,
  opts: FetchOptions,
): Promise<FetchResult> {
  const initialWindow = clampPositive(
    opts.initialWindowSeconds,
    DEFAULTS.initialWindowSeconds,
  );
  const denseThreshold = clampPositive(
    opts.denseThreshold,
    DEFAULTS.denseThreshold,
  );
  const minWindow = clampPositive(opts.minWindowSeconds, DEFAULTS.minWindowSeconds);
  const maxWindows = clampPositive(opts.maxWindows, DEFAULTS.maxWindows);
  const maxEvents = Math.max(0, opts.maxEvents ?? DEFAULTS.maxEvents);
  const timeoutMs = clampPositive(opts.timeoutMs, DEFAULTS.timeoutMs);
  const nowSec = Math.floor(Date.now() / 1000);
  const until = opts.untilUnix ?? nowSec;
  const since = opts.sinceUnix ?? DEFAULT_SINCE;
  const onProgress = opts.onProgress;

  const filter: FetchFilter = opts.kinds
    ? { authors: [pubkeyHex], kinds: opts.kinds }
    : { authors: [pubkeyHex] };

  const fetcher: MinimalFetcher =
    opts.fetcher ??
    NostrFetcher.init(
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

  // リレー個別の状態（そのまま FetchProgress / HistoryMeta に出す）。
  const runtimes: RelayStat[] = opts.relays.map((url) => ({
    url,
    status: "pending",
    events: 0,
    pages: 0, // ウィンドウ処理数として使う（フィールド名は互換のため維持）。
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
    let windows = 0;
    for (const r of runtimes) {
      windows += r.pages;
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
      pagesFetched: windows,
      elapsedMs: Date.now() - startedAt,
      relays: runtimes.map((r) => ({ ...r })),
    };
  }

  /**
   * [since, until] を initialWindow 幅で粗くタイル分割した初期ウィンドウ列を作る。
   * 新しい側を先に処理すると oldestReached が進んで進捗が直感的なので、新しい順に積む
   * （スタック＝末尾から取り出すので、末尾に最も新しいウィンドウが来るよう並べる）。
   */
  function seedWindows(): Window[] {
    const wins: Window[] = [];
    for (let s = since; s < until; s += initialWindow) {
      const u = Math.min(s + initialWindow, until);
      wins.push({ since: s, until: u });
    }
    if (wins.length === 0) wins.push({ since, until }); // since>=until の保険。
    return wins; // 末尾が最新ウィンドウ＝スタックで最初に処理される。
  }

  /** 1 リレーを独立に、適応的タイムウィンドウで処理する。例外は内部で握りつぶす。 */
  async function runRelay(rt: RelayStat): Promise<void> {
    rt.status = "querying";
    emit();
    const stack: Window[] = seedWindows();

    while (stack.length > 0) {
      if (ac.signal.aborted || Date.now() - startedAt >= timeoutMs) {
        rt.status = "timeout";
        break;
      }
      // 別リレーが件数上限に到達したら、このリレーも丁寧に止める。
      if (globalCapHit) {
        rt.status = rt.status === "querying" ? "ok" : rt.status;
        break;
      }
      if (rt.pages >= maxWindows) {
        rt.status = "maxWindows";
        break;
      }

      const w = stack.pop() as Window;

      let evs: NostrEvent[];
      try {
        evs = await fetcher.fetchAllEvents(
          [rt.url],
          filter,
          { since: w.since, until: w.until },
          {
            sort: false,
            signal: ac.signal,
            connectTimeoutMs: Math.min(timeoutMs, 5000),
            limitPerReq: 5000,
          },
        );
      } catch (err) {
        if (ac.signal.aborted || Date.now() - startedAt >= timeoutMs) {
          rt.status = "timeout";
        } else {
          rt.status = "failed";
          rt.error = err instanceof Error ? err.message : String(err);
        }
        // 既に集めた分は捨てない（部分成功）。他リレーは別途継続する。
        break;
      }
      rt.pages++;

      let oldestInWin = Number.POSITIVE_INFINITY;
      for (const ev of evs) {
        if (!collected.has(ev.id)) collected.set(ev.id, ev);
        if (ev.created_at < oldestInWin) oldestInWin = ev.created_at;
        if (newestGlobal == null || ev.created_at > newestGlobal) {
          newestGlobal = ev.created_at;
        }
      }
      rt.events += evs.length;
      if (evs.length > 0) {
        rt.oldestReached =
          rt.oldestReached == null
            ? oldestInWin
            : Math.min(rt.oldestReached, oldestInWin);
      }

      // 件数上限に到達したら、このリレーは正常打ち切り（グローバルにも伝播）。
      if (maxEvents > 0 && collected.size >= maxEvents) {
        globalCapHit = true;
        rt.status = "ok";
        emit(true);
        break;
      }

      // ── 適応分割 ──
      // ウィンドウが密（>= 閾値）かつ最小幅より広いなら、中点で 2 分割して掘り直す。
      // リレーが 1 リクエストで返し切れていない可能性に備える保険。重複は dedupe が吸収。
      if (evs.length >= denseThreshold && w.until - w.since > minWindow) {
        const mid = w.since + Math.floor((w.until - w.since) / 2);
        // 新しい側（[mid, until)）を後に積み、先に処理されるようにする。
        stack.push({ since: w.since, until: mid });
        stack.push({ since: mid, until: w.until });
        emit(); // 分割が起きたことを進捗に反映（任意）。
      }

      emit();
    }
    // 正常に全ウィンドウを処理し終えた場合。
    if (rt.status === "querying") {
      rt.status = stack.length === 0 ? (rt.events === 0 ? "empty" : "ok") : rt.status;
    }
    emit(true);
  }

  try {
    // すべてのリレーを並行に処理。1 つが失敗しても他は続く。
    await Promise.allSettled(runtimes.map((rt) => runRelay(rt)));
  } finally {
    clearTimeout(deadline);
    fetcher.shutdown?.();
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
  const hitWindowCap = runtimes.some((r) => r.status === "maxWindows");
  const hitEventCap = globalCapHit;
  // 少なくとも 1 つのリレーが「正常終了（ok/empty）」なら、要求範囲 [since, until] は
  // 覆い切れたとみなす（リレーは冗長で、グローバル重複排除で結果は統合されるため）。
  const anyCovered = runtimes.some(
    (r) => r.status === "ok" || r.status === "empty",
  );

  // 最も「掘り切れていない」理由を優先して 1 つ選ぶ（表示用の単一 enum）。
  // 件数上限・タイムアウト・ウィンドウ上限は「範囲を覆い切れていない」打ち切りなので、
  // anyCovered（健全リレーが覆い切った）より優先する。
  let stopReason: HistoryMeta["stopReason"];
  if (collected.size === 0 && relaysFailed === runtimes.length) {
    stopReason = "error";
  } else if (hitEventCap) {
    stopReason = "maxEvents";
  } else if (timedOut && !anyCovered) {
    stopReason = "timeout";
  } else if (hitWindowCap && !anyCovered) {
    stopReason = "maxWindows";
  } else if (anyCovered) {
    // 健全なリレーが範囲を覆い切れたなら正常終了。失敗の事実は relayStats / relaysFailed へ。
    stopReason = "ok";
  } else {
    // どのリレーも覆い切れず、明確な打ち切り理由も特定できない場合の保険。
    stopReason = "error";
  }

  // 範囲を覆い切れたリレーが 1 つでもあり、件数上限で切っていなければ完全とみなす。
  const historyComplete = stopReason === "ok";

  const meta: HistoryMeta = {
    pagesFetched: runtimes.reduce((s, r) => s + r.pages, 0),
    stopReason,
    // 明示的に since までウィンドウで覆うので、到達度 = 履歴完全性と同義に定義する。
    reachedOldestAvailable: historyComplete,
    historyComplete,
    oldestCreatedAt,
    newestCreatedAt,
    relaysQueried: opts.relays.length,
    relaysSucceeded,
    relaysFailed,
    relayStats: runtimes.map((r) => ({ ...r })),
    elapsedMs: Date.now() - startedAt,
    hitEventCap,
    hitPageCap: hitWindowCap, // フィールド名は互換維持。意味は「ウィンドウ上限」。
    timedOut,
    noProgress: false, // 適応ウィンドウ方式では無進捗の概念が無い。
  };

  return { events, relaysQueried: opts.relays.length, meta };
}

function clampPositive(v: number | undefined, fallback: number): number {
  if (v == null || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
}
