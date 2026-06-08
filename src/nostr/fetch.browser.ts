/**
 * リレーからイベントを取得するモジュール（ブラウザ用）。
 *
 * ブラウザにはネイティブの `WebSocket` があるため、Node 専用の `ws` は
 * import しない（バンドルに巻き込まない）。SimplePool はグローバルの
 * WebSocket をそのまま使う。ロジック本体は環境非依存の query.ts と共通。
 *
 * 注意（ブラウザ直アクセスの制約）:
 *  - リレーが `wss://`（TLS）でない場合、HTTPS ページからは Mixed Content で
 *    ブロックされる。GitHub Pages は HTTPS のため wss:// のみ利用可能。
 *  - リレーの CORS / 接続ポリシーによっては接続が拒否されることがある。
 *  - Node 版より取得が不安定になり得る（観測範囲が狭まる可能性）。
 */
import { queryUserEvents } from "./query.js";

export type { FetchOptions, FetchResult } from "./query.js";

/**
 * 指定 pubkey(hex) の投稿系イベントを複数リレーから取得する（ブラウザ用）。
 * 実体は環境非依存の queryUserEvents（query.ts）。
 */
export const fetchUserEvents = queryUserEvents;
