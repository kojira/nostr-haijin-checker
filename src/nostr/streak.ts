/**
 * ストリーク（連続実稼働日数）専用の軽量ルックアップ（環境非依存）。
 *
 * なぜ heavy fetch（query.ts の適応的タイムウィンドウ取得）と経路を分けるのか:
 *  - 総合スコアの採点には「全イベント」が要る（密度・連投・交流・時間帯分布など、
 *    1 件単位の特徴を全部使う）。そのため query.ts は許可リスト（ALLOWED_KINDS）の
 *    全イベントを掘る **重い取得**を行う。
 *  - 一方ストリークの判定に必要なのは **「その日に投稿が 1 件でもあるか」** だけ。
 *    全件を取る必要はない。日ごとに最新 1 件を確認できれば「実稼働日」は判定できる。
 *  - そこで本モジュールは **最新 1 件取得（fetchLastEvent, limit 1）を asOf カーソルで
 *    日単位に遡る**軽量プローブで、連続実稼働日数だけを安く・深く（heavy fetch より
 *    遠くまで）数える。1 実稼働日あたり往復はたかだか 1 回。混雑日でも全件は取らない。
 *
 * 設計:
 *  - ローカル日（tzOffset 補正後の暦日）単位で「実稼働日 = 1 件以上イベントがある日」。
 *  - now を起点に最新イベントを取り、その日（最新実稼働日）を起点に 1 日ずつ過去へ。
 *    「期待する連続日」と取得イベントの日が一致する限りカウントし、ズレた瞬間に
 *    ストリークの終端（ギャップ）と判定する。
 *  - heavy fetch とは完全に独立（別経路・別フェッチャ・別タイムアウト・別上限）。
 *    ただし得られた連続日数は採点側（scoring/）で「連続実稼働」シグナル（長期軸・重み 0.12）
 *    として総合スコアに加点される。取得経路の独立とスコアへの寄与は別の話である。
 *
 * WebSocket 実装は query.ts と同じ方針（ブラウザ/Node 22+ はネイティブ、Node 18-21 は
 * 呼び出し側が webSocketConstructor に ws を注入）。本モジュールは ws を import しない。
 */
import { NostrFetcher, type FetchFilter } from "nostr-fetch";
import { ALLOWED_KINDS } from "../kinds.js";
import type { NostrEvent, StreakInfo } from "../types.js";
import type { WebSocketCtor } from "./query.js";

/**
 * テストシーム用の最小フェッチャ・インターフェイス（ストリーク用）。
 * 本番では NostrFetcher がこれを満たす。テストではネットワークに触れない疑似実装を
 * 注入して、日単位の遡り・ギャップ判定・上限などを決定的に検証する。
 *
 * fetchLastEvent は「asOf 時点で最新の 1 件」だけを返す（limit 1 相当）。
 */
export interface StreakFetcher {
  fetchLastEvent(
    relayUrls: string[],
    filter: FetchFilter,
    options?: {
      /** この時刻（UNIX秒）以前で最新の 1 件を返す（遡りカーソル）。 */
      asOf?: number;
      signal?: AbortSignal;
      connectTimeoutMs?: number;
      limitPerReq?: number;
      /** 署名検証を省く（relay-trusted）。 */
      skipVerification?: boolean;
    },
  ): Promise<NostrEvent | undefined>;
  shutdown?: () => void;
}

export interface StreakLookupOptions {
  relays: string[];
  /** ローカル日（実稼働日）判定の UTC オフセット（時間）。既定 9（JST）。 */
  tzOffsetHours?: number;
  /**
   * 遡る最大日数の内部安全上限（=プローブ往復の上限・暴走防止）。既定 1000。
   * ユーザー向けには公開されない内部/テスト専用のノブ。通常は既定のまま辿れるだけ辿る。
   */
  maxDays?: number;
  /** 基準時刻（UNIX秒）。「今日」の判定とカーソル起点。既定は実時刻。テストで固定可。 */
  nowUnix?: number;
  /** 1 プローブ（最新 1 件取得）のタイムアウト（ms）。既定 10000。 */
  probeTimeoutMs?: number;
  /** 走査全体の安全上限（ms）。0 で無効。既定 60000。 */
  overallTimeoutMs?: number;
  /** 実稼働日の判定に使う kind を上書きしたいとき（既定は `ALLOWED_KINDS`）。 */
  kinds?: number[];
  /** Node 環境用の WebSocket 実装注入（ブラウザでは不要）。 */
  webSocketConstructor?: WebSocketCtor;
  /**
   * テストシーム。指定すると NostrFetcher.init の代わりにこのフェッチャを使う。
   * 本番（CLI/ブラウザ）では渡さない。
   */
  fetcher?: StreakFetcher;
}

const DEFAULTS = {
  maxDays: 1000,
  probeTimeoutMs: 10000,
  overallTimeoutMs: 60000,
} as const;

/**
 * 指定 pubkey(hex) の「連続実稼働日数（ストリーク）」を軽量プローブで数える。
 *
 * 全件は取得せず、日ごとに最新 1 件だけを asOf カーソルで遡って「その日に投稿が
 * あったか」を確認する。最新実稼働日から連続が途切れるまでを数えて持ち帰る。
 */
export async function lookupStreak(
  pubkeyHex: string,
  opts: StreakLookupOptions,
): Promise<StreakInfo> {
  const tz = Number.isFinite(opts.tzOffsetHours) ? (opts.tzOffsetHours as number) : 9;
  const maxDays = clampPositive(opts.maxDays, DEFAULTS.maxDays);
  const probeTimeoutMs = clampPositive(opts.probeTimeoutMs, DEFAULTS.probeTimeoutMs);
  const overallTimeoutMs = Math.max(
    0,
    Math.floor(opts.overallTimeoutMs ?? DEFAULTS.overallTimeoutMs),
  );
  const now = opts.nowUnix ?? Math.floor(Date.now() / 1000);

  // 実稼働日は許可リスト（ALLOWED_KINDS）の kind があった日だけを数える。
  const filter: FetchFilter = {
    authors: [pubkeyHex],
    kinds: opts.kinds ?? ALLOWED_KINDS,
  };

  const fetcher: StreakFetcher =
    opts.fetcher ??
    NostrFetcher.init(
      opts.webSocketConstructor
        ? { webSocketConstructor: opts.webSocketConstructor }
        : undefined,
    );

  const startedAt = Date.now();
  const deadline = overallTimeoutMs > 0 ? startedAt + overallTimeoutMs : Infinity;

  // ローカル日インデックス（tz 補正後の暦日番号）。同じ番号 = 同じローカル日。
  const dayIndexOf = (sec: number): number => Math.floor((sec + tz * 3600) / 86400);
  // そのローカル日の開始 UNIX 秒。
  const dayStartUnix = (di: number): number => di * 86400 - tz * 3600;

  const todayIndex = dayIndexOf(now);

  let cursor = now;
  let expected: number | null = null; // 次に期待する連続ローカル日インデックス。
  let lastActiveDi: number | null = null;
  let streak = 0;
  let scanned = 0;
  let endedNaturally = false; // ギャップ or これ以上過去なし＝自然終端（途切れが確定）。

  try {
    while (scanned < maxDays) {
      if (Date.now() >= deadline) break; // 安全上限。endedNaturally のまま false → truncated。
      scanned++;

      let ev: NostrEvent | undefined;
      try {
        ev = await probeLastEvent(fetcher, opts.relays, filter, cursor, probeTimeoutMs, deadline);
      } catch {
        // プローブ失敗/タイムアウト。これ以上は不明なので打ち切り（truncated 扱い）。
        break;
      }

      if (!ev) {
        // これ以上過去に 1 件も無い＝ストリークはここで自然に終端。
        endedNaturally = true;
        break;
      }

      const di = dayIndexOf(ev.created_at);
      if (expected === null) {
        lastActiveDi = di;
        expected = di;
      }
      if (di !== expected) {
        // 期待する連続日より古い日が返った＝間に実稼働の無い日があった（ギャップ）。
        endedNaturally = true;
        break;
      }

      streak++;
      expected = di - 1;
      // 次は「この日より前」で最新の 1 件を探す（混雑日でもこの 1 回で 1 日ぶん進む）。
      cursor = dayStartUnix(di) - 1;
    }
  } finally {
    fetcher.shutdown?.();
  }

  // 自然終端でなく上限/期限/エラーで止めたなら、実際の連続日数はもっと長い可能性がある。
  const truncated = !endedNaturally && streak > 0;

  const daysSinceLastActive = lastActiveDi == null ? null : todayIndex - lastActiveDi;
  // 「継続中」= 最新実稼働日が今日 or 昨日（0/1 日前）。それより古ければ途切れている。
  const ongoing =
    streak > 0 && daysSinceLastActive != null && daysSinceLastActive <= 1;

  return {
    currentStreakDays: streak,
    lastActiveDay: lastActiveDi == null ? null : dayKeyFromIndex(lastActiveDi),
    daysSinceLastActive,
    ongoing,
    daysScanned: scanned,
    truncated,
    relaysQueried: opts.relays.length,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 1 プローブ（asOf 以前で最新の 1 件）を、専用 AbortController で時間制限つきに実行する。
 * タイムアウトはこの 1 リクエストにのみ閉じ、Promise.race で wall-clock を必ず縛る。
 */
async function probeLastEvent(
  fetcher: StreakFetcher,
  relays: string[],
  filter: FetchFilter,
  asOf: number,
  timeoutMs: number,
  deadline: number,
): Promise<NostrEvent | undefined> {
  const eff = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`streak probe timed out after ${eff}ms`));
    }, eff);
  });
  try {
    return await Promise.race([
      fetcher.fetchLastEvent(relays, filter, {
        asOf,
        signal: ac.signal,
        connectTimeoutMs: Math.min(eff, 5000),
        limitPerReq: 1,
        // 署名検証は行わない（リレーが返したイベントをそのまま信頼する）。
        skipVerification: true,
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** ローカル日インデックスを "YYYY-MM-DD" に（実行環境 TZ に依存しない）。 */
function dayKeyFromIndex(di: number): string {
  // dayStart + tz*3600 = di*86400。getUTC* で表示日を確定する（prepare.ts と同じ流儀）。
  const d = new Date(di * 86400 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function clampPositive(v: number | undefined, fallback: number): number {
  if (v == null || !Number.isFinite(v) || v <= 0) return fallback;
  return Math.floor(v);
}
