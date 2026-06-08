/**
 * デフォルトのリレー一覧。
 * 日本語ユーザーが多いリレーと、汎用の大規模リレーを混ぜている。
 * --relays フラグで上書き可能。
 */
export const DEFAULT_RELAYS: string[] = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://yabu.me", // 日本語ユーザーが多いリレー
  "wss://relay.nostr.wirednet.jp",
  "wss://r.kojira.io",
  "wss://x.kojira.io",
  "wss://relay-jp.nostr.wirednet.jp",
];
