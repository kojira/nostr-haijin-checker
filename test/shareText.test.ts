/**
 * 投稿用テキスト整形（buildShareText）の単体テスト。
 * 実際の scoreEvents の出力を入力に使い、純関数の整形ロジックを検証する。
 *   実行: npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreEvents, DEFAULT_CONFIG } from "../src/scoring/index.js";
import { buildShareText } from "../src/scoring/shareText.js";
import type { NostrEvent, StreakInfo } from "../src/types.js";

const NPUB = "npub1synthetic000000000000000000000000000000000000000000000000";
const HEX = "00".repeat(32);

let idCounter = 0;
function ev(createdAt: number, kind = 1, tags: string[][] = []): NostrEvent {
  return {
    id: `id${idCounter++}`,
    pubkey: HEX,
    created_at: createdAt,
    kind,
    tags,
    content: "x",
  };
}

const BASE = 1_700_000_000;
function jst(dayIndex: number, hour: number, minute = 0): number {
  return BASE + dayIndex * 86400 + (hour - 9) * 3600 + minute * 60;
}

/** 中程度〜高めのプロファイル（複数シグナルが立つ）。 */
function activeProfile(): { events: NostrEvent[]; now: number } {
  const events: NostrEvent[] = [];
  const spreadHours = [0, 3, 6, 9, 12, 15, 18, 21];
  for (let d = 0; d < 20; d++) {
    for (const h of spreadHours) events.push(ev(jst(d, h)));
    events.push(ev(jst(d, 14), 1, [["e", "someid"]]));
    events.push(ev(jst(d, 16), 7));
  }
  return { events, now: jst(20, 12) };
}

function mkStreak(days: number, opts: Partial<StreakInfo> = {}): StreakInfo {
  return {
    currentStreakDays: days,
    lastActiveDay: days > 0 ? "2024-01-01" : null,
    daysSinceLastActive: days > 0 ? 0 : null,
    ongoing: days > 0,
    observedActiveDays: days,
    truncated: false,
    ...opts,
  };
}

test("buildShareText: スコア・ランク・根拠・ハッシュタグを含む", () => {
  const { events, now } = activeProfile();
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now);
  const text = buildShareText(r);

  // 見出しに総合スコア（/100）とランク（絵文字 + ラベル）が入る。
  assert.ok(
    text.includes(`${r.totalScore}/100`),
    `スコアが無い: ${text}`,
  );
  assert.ok(text.includes(r.rank.emoji), `ランク絵文字が無い: ${text}`);
  assert.ok(text.includes(r.rank.label), `ランクラベルが無い: ${text}`);
  // 主な根拠の見出しがある。
  assert.ok(text.includes("主な根拠:"), `根拠が無い: ${text}`);
  // 既定ハッシュタグが末尾に付く。
  assert.ok(text.includes("#Nostr廃人度チェッカー"), `ハッシュタグが無い: ${text}`);
});

test("buildShareText: ストリークがあれば連続実稼働の行が入る", () => {
  const { events, now } = activeProfile();
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now, null, mkStreak(30));
  const text = buildShareText(r);
  assert.ok(text.includes("連続実稼働 30日"), `ストリーク行が無い: ${text}`);
  assert.ok(text.includes("継続中"), `継続中の表記が無い: ${text}`);
});

test("buildShareText: ストリークが無くても壊れず、連続実稼働の行は出ない", () => {
  const { events, now } = activeProfile();
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now);
  const text = buildShareText(r);
  assert.ok(!text.includes("連続実稼働"), `不要なストリーク行: ${text}`);
  // 中核情報（スコア・根拠）は依然として出る。
  assert.ok(text.includes("/100"));
  assert.ok(text.includes("主な根拠:"));
});

test("buildShareText: ストリーク 0 日は行を省く", () => {
  const { events, now } = activeProfile();
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now, null, mkStreak(0));
  const text = buildShareText(r);
  assert.ok(!text.includes("連続実稼働"), `0日でストリーク行が出た: ${text}`);
});

test("buildShareText: 掘り切れていないストリークは下限（≥）で示す", () => {
  const { events, now } = activeProfile();
  const r = scoreEvents(
    NPUB,
    HEX,
    events,
    DEFAULT_CONFIG,
    now,
    null,
    mkStreak(1000, { truncated: true, observedActiveDays: 1000 }),
  );
  const text = buildShareText(r);
  assert.ok(text.includes("≥1000日"), `下限表記が無い: ${text}`);
});

test("buildShareText: 連続実稼働シグナルは『主な根拠』に重複して出ない", () => {
  const { events, now } = activeProfile();
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now, null, mkStreak(30));
  const text = buildShareText(r);
  const evidenceLine = text
    .split("\n")
    .find((l) => l.startsWith("主な根拠:"))!;
  // ストリークは専用行で出るため、根拠の要約には現れない。
  assert.ok(
    !evidenceLine.includes("連続実稼働"),
    `根拠にストリークが重複: ${evidenceLine}`,
  );
});

test("buildShareText: maxSignals で根拠の件数を絞れる", () => {
  const { events, now } = activeProfile();
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now);
  const text = buildShareText(r, { maxSignals: 2 });
  const evidenceLine = text
    .split("\n")
    .find((l) => l.startsWith("主な根拠:"))!;
  const items = evidenceLine.replace("主な根拠:", "").split(" ・ ");
  assert.ok(items.length <= 2, `根拠が絞られていない: ${evidenceLine}`);
});

test("buildShareText: ハッシュタグを空にすると付かない / 任意指定もできる", () => {
  const { events, now } = activeProfile();
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now);
  assert.ok(!buildShareText(r, { hashtag: "" }).includes("#"));
  assert.ok(buildShareText(r, { hashtag: "テスト" }).includes("#テスト"));
  // 先頭 # 付きでも二重にならない。
  assert.ok(buildShareText(r, { hashtag: "#タグ" }).includes("#タグ"));
});

test("buildShareText: 空データでも壊れず最低限の情報を返す", () => {
  const r = scoreEvents(NPUB, HEX, []);
  const text = buildShareText(r);
  assert.ok(text.includes("0/100"), `空データのスコアが無い: ${text}`);
  assert.ok(text.includes(r.rank.label));
});
