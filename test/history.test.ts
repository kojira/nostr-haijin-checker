/**
 * 取得（バックワード・ページング）メタ情報の扱いと、履歴が不完全なときの
 * 注意書き（notes）挙動を、ネットワーク不要で検証する。
 *   実行: npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CONFIG,
  historyNotes,
  scoreEvents,
} from "../src/scoring/index.js";
import type { HistoryMeta, NostrEvent } from "../src/types.js";

const NPUB = "npub1synthetic000000000000000000000000000000000000000000000000";
const HEX = "00".repeat(32);
const BASE = 1_700_000_000;

let idCounter = 0;
function ev(createdAt: number, kind = 1, tags: string[][] = []): NostrEvent {
  return {
    id: `h${idCounter++}`,
    pubkey: HEX,
    created_at: createdAt,
    kind,
    tags,
    content: "x",
  };
}

/** 既定値を上書きして HistoryMeta を作る簡易ヘルパー。 */
function meta(overrides: Partial<HistoryMeta>): HistoryMeta {
  return {
    pagesFetched: 1,
    stopReason: "exhausted",
    reachedOldestAvailable: false,
    historyComplete: false,
    oldestCreatedAt: BASE,
    newestCreatedAt: BASE + 86400,
    relaysQueried: 3,
    elapsedMs: 1234,
    hitEventCap: false,
    hitPageCap: false,
    timedOut: false,
    noProgress: false,
    ...overrides,
  };
}

test("historyNotes: 自然終了は「リレーが返さなくなった＝限界」を断定せず注意喚起", () => {
  const notes = historyNotes(
    meta({ stopReason: "exhausted", reachedOldestAvailable: true, historyComplete: true }),
  );
  assert.ok(notes.some((n) => n.includes("これ以上古いイベントを返しませんでした")));
  // 「本当の最初の投稿とは限らない」という正直な但し書きがある。
  assert.ok(notes.some((n) => n.includes("本当の最初の投稿とは限りません")));
});

test("historyNotes: 上限/タイムアウトで打ち切ったら「掘り切れていない」と明示", () => {
  const capped = historyNotes(meta({ stopReason: "maxPages", hitPageCap: true }));
  assert.ok(capped.some((n) => n.includes("掘り切れていません")));
  assert.ok(capped.some((n) => n.includes("ページ数上限")));

  const timed = historyNotes(meta({ stopReason: "timeout", timedOut: true }));
  assert.ok(timed.some((n) => n.includes("掘り切れていません")));
  assert.ok(timed.some((n) => n.includes("タイムアウト")));
});

test("historyNotes: 下限時刻(--since)まで遡って打ち切った場合はその旨を明示", () => {
  const notes = historyNotes(
    meta({ stopReason: "sinceBound", historyComplete: true }),
  );
  assert.ok(notes.some((n) => n.includes("指定した下限時刻まで遡って打ち切りました")));
  // 下限で止めただけなので「掘り切れていない（理由つき）」の警告は出さない。
  assert.ok(!notes.some((n) => n.includes("掘り切れていません")));
});

test("historyNotes: meta が null なら何も足さない", () => {
  assert.deepEqual(historyNotes(null), []);
});

test("scoreEvents: fetchMeta を渡すと result.history に反映され notes にも出る", () => {
  const events: NostrEvent[] = [];
  for (let d = 0; d < 10; d++) events.push(ev(BASE + d * 86400, 1));
  const m = meta({ stopReason: "maxPages", hitPageCap: true, pagesFetched: 40 });

  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, BASE + 30 * 86400, m);

  // 取得メタが結果に格納される。
  assert.ok(r.history);
  assert.equal(r.history?.stopReason, "maxPages");
  assert.equal(r.history?.hitPageCap, true);
  assert.equal(r.history?.historyComplete, false);
  // 掘り切れていない旨の注意書きが出る。
  assert.ok(r.notes.some((n) => n.includes("掘り切れていません")));
});

test("scoreEvents: 掘り切れた(complete)メタは history に保持され「掘り切れていない」とは言わない", () => {
  const events: NostrEvent[] = [];
  for (let d = 0; d < 10; d++) events.push(ev(BASE + d * 86400, 1));
  const m = meta({
    stopReason: "exhausted",
    reachedOldestAvailable: true,
    historyComplete: true,
  });

  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, BASE + 30 * 86400, m);

  assert.equal(r.history?.historyComplete, true);
  assert.equal(r.history?.stopReason, "exhausted");
  // complete でも「真の初投稿とは限らない」但し書きは出るが、打ち切り警告は出ない。
  assert.ok(!r.notes.some((n) => n.includes("掘り切れていません")));
  assert.ok(r.notes.some((n) => n.includes("本当の最初の投稿とは限りません")));
});

test("scoreEvents: fetchMeta 省略時は history=null・履歴系 notes は出ない", () => {
  const events: NostrEvent[] = [ev(BASE, 1), ev(BASE + 3600, 1)];
  const r = scoreEvents(NPUB, HEX, events);
  assert.equal(r.history, null);
  assert.ok(!r.notes.some((n) => n.includes("掘り切れていません")));
});

test("scoreEvents: 0件でも fetchMeta は history に保持される", () => {
  const m = meta({ stopReason: "timeout", timedOut: true, oldestCreatedAt: null, newestCreatedAt: null });
  const r = scoreEvents(NPUB, HEX, [], DEFAULT_CONFIG, BASE, m);
  assert.equal(r.sampleSize, 0);
  assert.ok(r.history);
  assert.equal(r.history?.timedOut, true);
  assert.ok(r.notes.length > 0);
});

test("全 kind を稼働日・継続に算入: kind1 以外だけの日も実稼働日に数える", () => {
  // 3 日それぞれ別 kind（1=ノート, 7=リアクション, 3=フォロー）でのみ活動。
  const events: NostrEvent[] = [
    ev(BASE + 0 * 86400, 1),
    ev(BASE + 1 * 86400, 7),
    ev(BASE + 2 * 86400, 3),
  ];
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, BASE + 3 * 86400);
  // kind を限定せず全イベントから稼働日を数えるので 3 日。
  assert.equal(r.observation.observedActiveDays, 3);
  assert.equal(r.sampleSize, 3);
});
