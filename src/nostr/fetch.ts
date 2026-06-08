/**
 * リレーからイベントを取得するモジュール（Node.js / CLI 用）。
 *
 * 取得本体は環境非依存の queryUserEvents（query.ts）＝ nostr-fetch ベースの
 * バックワード・ページング。Node 18-21 にはグローバル WebSocket が無いため、
 * ws を webSocketConstructor として注入してから委譲する。
 * （Node 22+ はネイティブ WebSocket があるが、互換のため常に注入しておく。）
 *
 * ブラウザ向けには ws を含まない fetch.browser.ts を用意している。
 */
import WebSocket from "ws";
import { queryUserEvents, type FetchOptions, type FetchResult } from "./query.js";

export type { FetchOptions, FetchResult } from "./query.js";

/**
 * 指定 pubkey(hex) のイベントを複数リレーから取得する（Node 用）。
 * 実体は環境非依存の queryUserEvents（query.ts）。ws を注入する。
 */
export function fetchUserEvents(
  pubkeyHex: string,
  opts: FetchOptions,
): Promise<FetchResult> {
  return queryUserEvents(pubkeyHex, {
    ...opts,
    webSocketConstructor:
      opts.webSocketConstructor ??
      (WebSocket as unknown as NonNullable<FetchOptions["webSocketConstructor"]>),
  });
}
