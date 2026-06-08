/**
 * npub <-> hex 変換のユーティリティ。
 * nostr-tools の nip19 を薄くラップし、エラーメッセージを分かりやすくする。
 */
import { nip19 } from "nostr-tools";

export class InvalidNpubError extends Error {
  constructor(input: string, cause?: unknown) {
    super(`npub のデコードに失敗しました: "${input}"`);
    this.name = "InvalidNpubError";
    if (cause instanceof Error) this.cause = cause;
  }
}

/**
 * npub1... または 64桁の hex 公開鍵を受け取り、hex に正規化して返す。
 */
export function toPubkeyHex(input: string): string {
  const value = input.trim();

  // 既に hex 公開鍵ならそのまま使う。
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return value.toLowerCase();
  }

  if (!value.startsWith("npub1")) {
    throw new InvalidNpubError(input);
  }

  try {
    const decoded = nip19.decode(value);
    if (decoded.type !== "npub" || typeof decoded.data !== "string") {
      throw new InvalidNpubError(input);
    }
    return decoded.data;
  } catch (err) {
    if (err instanceof InvalidNpubError) throw err;
    throw new InvalidNpubError(input, err);
  }
}

/** hex 公開鍵を npub に変換（表示用）。 */
export function toNpub(pubkeyHex: string): string {
  return nip19.npubEncode(pubkeyHex);
}
