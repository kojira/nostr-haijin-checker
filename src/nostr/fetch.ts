/**
 * リレーからイベントを取得するモジュール（Node.js / CLI 用）。
 *
 * Node.js にはグローバル WebSocket が無い環境があるため、`ws` を
 * SimplePool に注入してから共通ロジック（query.ts）へ委譲する。
 * ブラウザ向けには ws を含まない fetch.browser.ts を用意している。
 *
 * 取得とスコアリングを分離しておくことで、Web/LLM 層から
 * 「取得済みイベント配列」を直接スコアリングに渡せるようにしている。
 */
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { queryUserEvents } from "./query.js";

// Node.js には WebSocket がグローバルに無い環境もあるため明示的に注入する。
useWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);

export type { FetchOptions, FetchResult } from "./query.js";

/**
 * 指定 pubkey(hex) の投稿系イベントを複数リレーから取得する（Node 用）。
 * 実体は環境非依存の queryUserEvents（query.ts）。
 */
export const fetchUserEvents = queryUserEvents;
