/**
 * リレー取得の中核ロジック（環境非依存）。
 *
 * nostr-tools の SimplePool は「グローバルの WebSocket 実装」を使う。
 * - ブラウザ: ネイティブの `WebSocket` がそのまま使える。
 * - Node.js: グローバルに WebSocket が無い場合があるため、呼び出し側で
 *   `useWebSocketImplementation()` により `ws` を注入する（fetch.ts 参照）。
 *
 * このモジュール自体は `ws` を import しないので、ブラウザバンドルに
 * Node 専用依存を巻き込まない。CLI / Web 双方の fetch から再利用する。
 */
import { SimplePool } from "nostr-tools/pool";
import type { Filter } from "nostr-tools";
import type { NostrEvent } from "../types.js";

export interface FetchOptions {
  relays: string[];
  /** 取得する最大イベント数（1リレーあたりの limit）。 */
  limit: number;
  /** 取得対象 kind。デフォルトは note/repost/reaction。 */
  kinds?: number[];
  /** 全体のタイムアウト（ms）。 */
  timeoutMs?: number;
}

export interface FetchResult {
  events: NostrEvent[];
  /** 実際に問い合わせたリレー数（接続失敗を除く概算）。 */
  relaysQueried: number;
}

/**
 * 指定 pubkey(hex) の投稿系イベントを複数リレーから取得する。
 * 取得後は id で重複排除し、新しい順にソートして返す。
 *
 * 取得とスコアリングを分離しているため、戻り値の events 配列を
 * そのまま scoreEvents() に渡せる（CLI / Web で共通）。
 */
export async function queryUserEvents(
  pubkeyHex: string,
  opts: FetchOptions,
): Promise<FetchResult> {
  const kinds = opts.kinds ?? [1, 6, 7];
  const timeoutMs = opts.timeoutMs ?? 8000;

  const pool = new SimplePool();
  const filter: Filter = {
    authors: [pubkeyHex],
    kinds,
    limit: opts.limit,
  };

  try {
    const events = await querySyncWithTimeout(
      pool,
      opts.relays,
      filter,
      timeoutMs,
    );

    const deduped = dedupeById(events);
    deduped.sort((a, b) => b.created_at - a.created_at);

    return {
      events: deduped,
      relaysQueried: opts.relays.length,
    };
  } finally {
    // 接続を閉じる（Node ではプロセスがハングしないように）。
    pool.close(opts.relays);
  }
}

/**
 * SimplePool.subscribeMany を全体タイムアウト付きでラップする。
 * 一部リレーが無応答でもタイムアウト時点で集まった分を返す。
 */
function querySyncWithTimeout(
  pool: SimplePool,
  relays: string[],
  filter: Filter,
  timeoutMs: number,
): Promise<NostrEvent[]> {
  return new Promise<NostrEvent[]>((resolve) => {
    const collected = new Map<string, NostrEvent>();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve([...collected.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    const sub = pool.subscribeMany(relays, filter, {
      onevent(ev) {
        collected.set(ev.id, ev as NostrEvent);
      },
      oneose() {
        // 全リレーが EOSE を返したら早期終了。
        clearTimeout(timer);
        try {
          sub.close();
        } catch {
          /* noop */
        }
        finish();
      },
    });
  });
}

function dedupeById(events: NostrEvent[]): NostrEvent[] {
  const map = new Map<string, NostrEvent>();
  for (const ev of events) {
    if (!map.has(ev.id)) map.set(ev.id, ev);
  }
  return [...map.values()];
}
