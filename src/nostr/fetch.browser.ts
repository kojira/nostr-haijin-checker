/**
 * リレーからイベントを取得するモジュール（ブラウザ用）。
 *
 * ブラウザにはネイティブの WebSocket があるため、Node 専用の ws は import せず、
 * nostr-fetch にもグローバルの WebSocket をそのまま使わせる（注入しない）。
 * 取得ロジック本体は環境非依存の query.ts と共通（nostr-fetch ベースの
 * 適応的タイムウィンドウ取得）。
 *
 * ストリーク（連続実稼働日数）はこの取得結果のイベントから導出する（scoring/streak.ts の
 * deriveStreak）。専用のネットワーク経路は持たない（別経路の二重取得を廃止した）。
 *
 * 注意（ブラウザ直アクセスの制約）:
 *  - リレーが wss://（TLS）でない場合、HTTPS ページからは Mixed Content で
 *    ブロックされる。GitHub Pages は HTTPS のため wss:// のみ利用可能。
 *  - リレーの CORS / 接続ポリシーによっては接続が拒否されることがある。
 *  - 1 リクエストの取得が不安定なリレーでは、遡れる過去が浅くなり得る
 *    （HistoryMeta に「掘り切れていない」旨が反映される）。
 */
import { queryUserEvents } from "./query.js";

export type {
  FetchOptions,
  FetchResult,
  FetchProgress,
  ProgressCallback,
} from "./query.js";

/**
 * 指定 pubkey(hex) のイベントを複数リレーから取得する（ブラウザ用）。
 * 実体は環境非依存の queryUserEvents（query.ts）。WebSocket 注入は不要。
 */
export const fetchUserEvents = queryUserEvents;
