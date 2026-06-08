/**
 * デフォルトのリレー一覧。
 * 日本語ユーザーが多いリレーを採用している。
 * --relays フラグで上書き可能。
 */
export const DEFAULT_RELAYS: string[] = [
  "wss://yabu.me", // 日本語ユーザーが多いリレー
  "wss://r.kojira.io",
  "wss://x.kojira.io",
];
