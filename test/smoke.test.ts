/**
 * ネットワーク不要のスモークテスト。
 * 合成イベントを使い、スコアリングのパイプラインが壊れていないことを確認する。
 *   実行: npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreEvents, DEFAULT_CONFIG } from "../src/scoring/index.js";
import type { NostrEvent } from "../src/types.js";

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

/** JST の指定日・指定時刻(秒)に対応する UNIX 秒。 */
function jst(dayIndex: number, hour: number, minute = 0): number {
  const base = 1_700_000_000; // 固定基準（テストの決定性のため）
  return base + dayIndex * 86400 + (hour - 9) * 3600 + minute * 60;
}

test("廃人プロファイル: 毎日・深夜・連投・交流が多いと高スコア", () => {
  const events: NostrEvent[] = [];
  // 30日間、毎日 深夜2時台に8連投 + 昼にリプライ/リアクション
  for (let d = 0; d < 30; d++) {
    for (let b = 0; b < 8; b++) {
      events.push(ev(jst(d, 2, b))); // 1分間隔の連投（深夜）
    }
    events.push(ev(jst(d, 13), 1, [["e", "someid"]])); // リプライ
    events.push(ev(jst(d, 14), 7)); // リアクション
    events.push(ev(jst(d, 15), 6)); // リポスト
  }
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG);
  assert.ok(r.totalScore >= 70, `期待: >=70, 実際: ${r.totalScore}`);
  assert.equal(r.signals.length, 5);
  // 各シグナルに必ず根拠がある
  for (const s of r.signals) assert.ok(s.reason.length > 0);
});

test("ライトユーザー: たまに昼に1件だと低スコア", () => {
  const events: NostrEvent[] = [];
  // 30日のうち5日だけ、昼に1件
  for (const d of [0, 7, 14, 21, 28]) {
    events.push(ev(jst(d, 12)));
  }
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG);
  assert.ok(r.totalScore < 40, `期待: <40, 実際: ${r.totalScore}`);
});

test("廃人 > ライト の順序が保たれる", () => {
  const heavy: NostrEvent[] = [];
  for (let d = 0; d < 20; d++)
    for (let b = 0; b < 10; b++) heavy.push(ev(jst(d, 3, b)));
  const light: NostrEvent[] = [ev(jst(0, 12)), ev(jst(10, 12))];

  const hr = scoreEvents(NPUB, HEX, heavy);
  const lr = scoreEvents(NPUB, HEX, light);
  assert.ok(hr.totalScore > lr.totalScore);
});

test("空データ: スコア0・ランクは休眠・注意書きあり", () => {
  const r = scoreEvents(NPUB, HEX, []);
  assert.equal(r.totalScore, 0);
  assert.equal(r.sampleSize, 0);
  assert.ok(r.notes.length > 0);
});
