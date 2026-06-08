/**
 * 連続実稼働日数（ストリーク）の軽量ルックアップ（lookupStreak）を、
 * ネットワーク不要の疑似フェッチャ（テストシーム fetcher）で決定的に検証する。
 *   実行: npm test
 *
 * ストリークは heavy fetch（全件取得）とは **別経路**で、日ごとに最新 1 件だけを
 * asOf カーソルで遡り「その日に投稿が 1 件でもあるか」で実稼働日を判定する。
 *
 * 検証対象:
 *  1) 連続する実稼働日を数える（最新実稼働日が今日 → ongoing=true）。
 *  2) ギャップ（実稼働の無い日）でストリークが終端する。
 *  3) 最新実稼働日が古ければ ongoing=false（途切れ済み）。
 *  4) maxDays の安全上限で打ち切ると truncated=true（実際はもっと長い可能性）。
 *  5) 活動が一切無ければ streak=0・lastActiveDay=null。
 *  6) 1 実稼働日あたりプローブ往復はちょうど 1 回（混雑日でも全件は取らない）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupStreak, type StreakFetcher } from "../src/nostr/streak.js";
import type { NostrEvent } from "../src/types.js";

const HEX = "00".repeat(32);
const TZ = 9; // JST。lookupStreak の既定と一致させる。

/** ローカル日インデックス di の開始 UNIX 秒（tz=9）。 */
function dayStart(di: number): number {
  return di * 86400 - TZ * 3600;
}
/** ローカル日 di の「正午」あたりの UNIX 秒（その日に確実に収まる時刻）。 */
function noonOf(di: number): number {
  return dayStart(di) + 43200;
}

let idCounter = 0;
function ev(createdAt: number, kind = 1): NostrEvent {
  return {
    id: `s${idCounter++}`,
    pubkey: HEX,
    created_at: createdAt,
    kind,
    tags: [],
    content: "x",
  };
}

/**
 * 疑似ストリークフェッチャ。asOf 以前で最新の 1 件を返す（limit 1 相当）。
 * 呼び出しごとの asOf を calls に記録し、プローブ往復回数を検証できるようにする。
 */
function fakeFetcher(
  events: NostrEvent[],
): StreakFetcher & { calls: number[] } {
  const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
  const calls: number[] = [];
  return {
    calls,
    async fetchLastEvent(_relays, _filter, options) {
      const asOf = options?.asOf ?? Number.POSITIVE_INFINITY;
      calls.push(asOf);
      return sorted.find((e) => e.created_at <= asOf);
    },
    shutdown() {},
  };
}

// 「今日」のローカル日インデックスを固定して決定的にする。
const TODAY = 20000;
const NOW = noonOf(TODAY) + 5000; // 今日の昼すぎ。

test("連続する実稼働日を数える（最新が今日 → ongoing）", async () => {
  // 今日・昨日・一昨日に活動。1 日に複数イベントがあっても 1 日として数える。
  const f = fakeFetcher([
    ev(noonOf(TODAY)),
    ev(noonOf(TODAY) + 60), // 同日 2 件目（全件は取らない＝この日も 1 往復で済む）
    ev(noonOf(TODAY - 1)),
    ev(noonOf(TODAY - 2)),
  ]);
  const s = await lookupStreak(HEX, { relays: ["wss://r1"], nowUnix: NOW, fetcher: f });
  assert.equal(s.currentStreakDays, 3);
  assert.equal(s.daysSinceLastActive, 0);
  assert.equal(s.ongoing, true);
  assert.equal(s.truncated, false);
  assert.match(s.lastActiveDay ?? "", /^\d{4}-\d{2}-\d{2}$/);
  // 3 実稼働日 + 終端確認の 1 プローブ（過去に無し）＝ 4 往復。1 日あたり 1 往復。
  assert.equal(f.calls.length, 4);
});

test("ギャップ（実稼働の無い日）でストリークが終端する", async () => {
  // 今日・昨日は活動、一昨日は無し、その前に活動 → ストリークは 2。
  const f = fakeFetcher([
    ev(noonOf(TODAY)),
    ev(noonOf(TODAY - 1)),
    ev(noonOf(TODAY - 3)), // 一昨日(TODAY-2)は空き → ここでギャップ
    ev(noonOf(TODAY - 4)),
  ]);
  const s = await lookupStreak(HEX, { relays: ["wss://r1"], nowUnix: NOW, fetcher: f });
  assert.equal(s.currentStreakDays, 2);
  assert.equal(s.ongoing, true); // 最新実稼働は今日
  assert.equal(s.truncated, false); // ギャップで自然終端
});

test("最新実稼働日が古ければ ongoing=false（途切れ済み）", async () => {
  // 2 日前・3 日前に活動（今日・昨日は無し）。ストリークは 2 だが継続はしていない。
  const f = fakeFetcher([ev(noonOf(TODAY - 2)), ev(noonOf(TODAY - 3))]);
  const s = await lookupStreak(HEX, { relays: ["wss://r1"], nowUnix: NOW, fetcher: f });
  assert.equal(s.currentStreakDays, 2);
  assert.equal(s.daysSinceLastActive, 2);
  assert.equal(s.ongoing, false);
});

test("maxDays の安全上限で打ち切ると truncated=true", async () => {
  // 11 日連続で活動。maxDays=3 で 3 日ぶんだけ数えて打ち切る。
  const events: NostrEvent[] = [];
  for (let i = 0; i <= 10; i++) events.push(ev(noonOf(TODAY - i)));
  const f = fakeFetcher(events);
  const s = await lookupStreak(HEX, {
    relays: ["wss://r1"],
    nowUnix: NOW,
    maxDays: 3,
    fetcher: f,
  });
  assert.equal(s.currentStreakDays, 3);
  assert.equal(s.daysScanned, 3);
  assert.equal(s.truncated, true); // 自然終端ではないので「もっと長い可能性」
  assert.equal(s.ongoing, true);
});

test("活動が一切無ければ streak=0・lastActiveDay=null", async () => {
  const f = fakeFetcher([]);
  const s = await lookupStreak(HEX, { relays: ["wss://r1"], nowUnix: NOW, fetcher: f });
  assert.equal(s.currentStreakDays, 0);
  assert.equal(s.lastActiveDay, null);
  assert.equal(s.daysSinceLastActive, null);
  assert.equal(s.ongoing, false);
  assert.equal(s.truncated, false);
  // 1 回プローブして「過去に無し」を確認したら終わり。
  assert.equal(f.calls.length, 1);
});

test("relaysQueried はリレー数を反映する", async () => {
  const f = fakeFetcher([ev(noonOf(TODAY))]);
  const s = await lookupStreak(HEX, {
    relays: ["wss://r1", "wss://r2", "wss://r3"],
    nowUnix: NOW,
    fetcher: f,
  });
  assert.equal(s.relaysQueried, 3);
});
