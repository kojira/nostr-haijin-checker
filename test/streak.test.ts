/**
 * 連続実稼働日数（ストリーク）の **取得済みイベントからの導出**（deriveStreak）を、
 * ネットワーク不要の合成イベントで決定的に検証する。
 *   実行: npm test
 *
 * ストリークは別経路の追加取得を行わず、メインの取得（適応的タイムウィンドウ取得）で
 * 集めたイベントをローカル日単位に集計し、最新の実稼働日から連続が途切れるまで数える。
 *
 * 検証対象:
 *  1) 連続する実稼働日を数える（最新実稼働日が今日 → ongoing=true）。1 日複数件でも 1 日。
 *  2) ギャップ（実稼働の無い日）でストリークが終端する。取得完全なら truncated=false。
 *  3) 最新実稼働日が古ければ ongoing=false（途切れ済み）。
 *  4) 取得が掘り切れていない（historyComplete=false）なら truncated=true（下限扱い）。
 *  5) 活動が一切無ければ streak=0・lastActiveDay=null。
 *  6) 許可リスト（ALLOWED_KINDS）の kind だけを実稼働日の判定に使う。
 *  7) observedActiveDays は distinct な実稼働日数を反映する。
 *  8) 内部の日数上限は無い（3 年超の長いストリークも全部数え切る）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveStreak } from "../src/scoring/streak.js";
import type { NostrEvent } from "../src/types.js";

const HEX = "00".repeat(32);
const TZ = 9; // JST。deriveStreak の既定と一致させる。

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

// 「今日」のローカル日インデックスを固定して決定的にする。
const TODAY = 20000;
const NOW = noonOf(TODAY) + 5000; // 今日の昼すぎ。

test("連続する実稼働日を数える（最新が今日 → ongoing）", () => {
  // 今日・昨日・一昨日に活動。1 日に複数イベントがあっても 1 日として数える。
  const events = [
    ev(noonOf(TODAY)),
    ev(noonOf(TODAY) + 60), // 同日 2 件目（1 日として数える）
    ev(noonOf(TODAY - 1)),
    ev(noonOf(TODAY - 2)),
  ];
  const s = deriveStreak(events, { nowUnix: NOW });
  assert.equal(s.currentStreakDays, 3);
  assert.equal(s.daysSinceLastActive, 0);
  assert.equal(s.ongoing, true);
  assert.equal(s.truncated, false);
  assert.equal(s.observedActiveDays, 3);
  assert.match(s.lastActiveDay ?? "", /^\d{4}-\d{2}-\d{2}$/);
});

test("ギャップ（実稼働の無い日）でストリークが終端する（取得完全 → truncated=false）", () => {
  // 今日・昨日は活動、一昨日は無し、その前に活動 → ストリークは 2。
  const events = [
    ev(noonOf(TODAY)),
    ev(noonOf(TODAY - 1)),
    ev(noonOf(TODAY - 3)), // 一昨日(TODAY-2)は空き → ここでギャップ
    ev(noonOf(TODAY - 4)),
  ];
  const s = deriveStreak(events, { nowUnix: NOW, historyComplete: true });
  assert.equal(s.currentStreakDays, 2);
  assert.equal(s.ongoing, true); // 最新実稼働は今日
  assert.equal(s.truncated, false); // 取得が範囲を覆い切れていればギャップは確定
  assert.equal(s.observedActiveDays, 4);
});

test("最新実稼働日が古ければ ongoing=false（途切れ済み）", () => {
  // 2 日前・3 日前に活動（今日・昨日は無し）。ストリークは 2 だが継続はしていない。
  const events = [ev(noonOf(TODAY - 2)), ev(noonOf(TODAY - 3))];
  const s = deriveStreak(events, { nowUnix: NOW });
  assert.equal(s.currentStreakDays, 2);
  assert.equal(s.daysSinceLastActive, 2);
  assert.equal(s.ongoing, false);
});

test("取得が掘り切れていない（historyComplete=false）なら truncated=true（下限扱い）", () => {
  // 今日まで 5 日連続だが、取得が掘り切れていないので実際はさらに長い可能性がある。
  const events: NostrEvent[] = [];
  for (let i = 0; i < 5; i++) events.push(ev(noonOf(TODAY - i)));
  const s = deriveStreak(events, { nowUnix: NOW, historyComplete: false });
  assert.equal(s.currentStreakDays, 5);
  assert.equal(s.truncated, true); // 取得が範囲を覆い切れていない → 下限
  assert.equal(s.ongoing, true);
});

test("取得が完全（historyComplete=true）なら最新だけの活動でも truncated=false", () => {
  // 今日だけ活動。取得が [since, now] を覆い切っているなら、昨日以前の不活動は確定。
  const s = deriveStreak([ev(noonOf(TODAY))], { nowUnix: NOW, historyComplete: true });
  assert.equal(s.currentStreakDays, 1);
  assert.equal(s.truncated, false);
  assert.equal(s.ongoing, true);
});

test("活動が一切無ければ streak=0・lastActiveDay=null", () => {
  const s = deriveStreak([], { nowUnix: NOW });
  assert.equal(s.currentStreakDays, 0);
  assert.equal(s.lastActiveDay, null);
  assert.equal(s.daysSinceLastActive, null);
  assert.equal(s.ongoing, false);
  assert.equal(s.truncated, false);
  assert.equal(s.observedActiveDays, 0);
});

test("許可リスト（ALLOWED_KINDS）の kind だけで実稼働日を判定する", () => {
  // 今日は許可外 kind3（フォローリスト）だけ、昨日・一昨日は許可 kind。
  // kind3 は実稼働日に数えないので、最新実稼働日は昨日、ストリークは 2、今日は不活動扱い。
  const events = [
    ev(noonOf(TODAY), 3), // 許可外 → 無視
    ev(noonOf(TODAY - 1), 1),
    ev(noonOf(TODAY - 2), 7),
  ];
  const s = deriveStreak(events, { nowUnix: NOW });
  assert.equal(s.currentStreakDays, 2);
  assert.equal(s.daysSinceLastActive, 1); // 最新実稼働は昨日（今日の kind3 は無視）
  assert.equal(s.ongoing, true); // 昨日なので継続中扱い
  assert.equal(s.observedActiveDays, 2);
});

test("内部の日数上限は無い: 3 年超（1000 日超）の連続も全部数え切る", () => {
  // 1234 日（≈3.4 年）連続で活動し、その先は一切無し。取得完全なら truncated=false。
  const STREAK_LEN = 1234;
  const events: NostrEvent[] = [];
  for (let i = 0; i < STREAK_LEN; i++) events.push(ev(noonOf(TODAY - i)));
  const s = deriveStreak(events, { nowUnix: NOW, historyComplete: true });
  assert.equal(s.currentStreakDays, STREAK_LEN);
  assert.ok(s.currentStreakDays > 1000, "1000 日の内部上限が残っていると失敗する");
  assert.equal(s.truncated, false);
  assert.equal(s.ongoing, true);
});
