/**
 * リレーからイベントを取得するモジュール（Node.js / CLI 用）。
 *
 * 取得本体は環境非依存の queryUserEvents（query.ts）＝ nostr-fetch ベースの
 * 適応的タイムウィンドウ取得。Node 18-21 にはグローバル WebSocket が無いため、
 * ws を webSocketConstructor として注入してから委譲する。
 * （Node 22+ はネイティブ WebSocket があるが、互換のため常に注入しておく。）
 *
 * ブラウザ向けには ws を含まない fetch.browser.ts を用意している。
 */
import WebSocket from "ws";
import { queryUserEvents, type FetchOptions, type FetchResult } from "./query.js";
import { lookupStreak, type StreakLookupOptions } from "./streak.js";
import type { StreakInfo } from "../types.js";

export type {
  FetchOptions,
  FetchResult,
  FetchProgress,
  ProgressCallback,
} from "./query.js";
export type { StreakLookupOptions } from "./streak.js";

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

/**
 * 連続実稼働日数（ストリーク）を軽量プローブで数える（Node 用）。
 *
 * heavy fetch（fetchUserEvents）とは **別経路**。日ごとに最新 1 件だけを遡って
 * 「その日に投稿があったか」を安く確認する。実体は環境非依存の lookupStreak。
 * Node では ws を webSocketConstructor として注入してから委譲する。
 */
export function lookupUserStreak(
  pubkeyHex: string,
  opts: StreakLookupOptions,
): Promise<StreakInfo> {
  return lookupStreak(pubkeyHex, {
    ...opts,
    webSocketConstructor:
      opts.webSocketConstructor ??
      (WebSocket as unknown as NonNullable<StreakLookupOptions["webSocketConstructor"]>),
  });
}
