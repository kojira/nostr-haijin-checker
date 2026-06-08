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

const BASE = 1_700_000_000; // 固定基準（テストの決定性のため）

/** JST の指定日・指定時刻(秒)に対応する UNIX 秒。 */
function jst(dayIndex: number, hour: number, minute = 0): number {
  return BASE + dayIndex * 86400 + (hour - 9) * 3600 + minute * 60;
}

test("廃人プロファイル: 毎日・一日中まんべんなく・連投・交流が多いと高スコア", () => {
  const events: NostrEvent[] = [];
  // 昼夜にまたがる時間帯（常時稼働度を高くする）。
  const spreadHours = [0, 2, 5, 7, 9, 11, 13, 15, 17, 19, 21, 22];
  for (let d = 0; d < 30; d++) {
    // 深夜帯に 8 連投（バースト）
    for (let b = 0; b < 8; b++) events.push(ev(jst(d, 3, b)));
    // 一日中まんべんなく単発投稿（時間帯カバレッジ）
    for (const h of spreadHours) events.push(ev(jst(d, h)));
    // 交流（リプライ/リアクション/リポスト）
    events.push(ev(jst(d, 14), 1, [["e", "someid"]]));
    events.push(ev(jst(d, 16), 7));
    events.push(ev(jst(d, 20), 6));
  }
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG);
  assert.ok(r.totalScore >= 70, `期待: >=70, 実際: ${r.totalScore}`);
  assert.equal(r.signals.length, 5);
  // 各シグナルに必ず根拠がある
  for (const s of r.signals) assert.ok(s.reason.length > 0);
  // 常時稼働度（時間帯の広さ）が高く出る。
  const tc = r.signals.find((s) => s.key === "temporalCoverage");
  assert.ok(tc && tc.score >= 60, `常時稼働度が低すぎ: ${tc?.score}`);
});

test("常時稼働度: 同じ件数でも『一日中』が『特定時間帯に集中』を上回る", () => {
  // A) 24 時間にまんべんなく（毎日、各時刻 1 件ずつ）。
  const allDay: NostrEvent[] = [];
  for (let d = 0; d < 10; d++)
    for (let h = 0; h < 24; h++) allDay.push(ev(jst(d, h)));
  // B) 同じ総数だが深夜 0-3 時だけに集中。
  const nightOnly: NostrEvent[] = [];
  for (let d = 0; d < 10; d++)
    for (let i = 0; i < 24; i++) nightOnly.push(ev(jst(d, i % 4, i)));

  const a = scoreEvents(NPUB, HEX, allDay, DEFAULT_CONFIG);
  const b = scoreEvents(NPUB, HEX, nightOnly, DEFAULT_CONFIG);
  const ta = a.signals.find((s) => s.key === "temporalCoverage")!.score;
  const tb = b.signals.find((s) => s.key === "temporalCoverage")!.score;

  // 旧「深夜が多い＝廃人」とは逆: 終日まんべんなく投稿する方を高く評価する。
  assert.ok(ta > tb, `常時稼働度が逆転: allDay=${ta} nightOnly=${tb}`);
  assert.ok(ta >= 90, `終日投稿の常時稼働度が低い: ${ta}`);
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

test("許可外 kind（フォロー kind3 など）は採点入力から除外される", () => {
  // kind3 だけの日々は実稼働日に数えない（許可リスト外なので空データ相当になる）。
  const onlyKind3: NostrEvent[] = [];
  for (let d = 0; d < 10; d++) onlyKind3.push(ev(jst(d, 12), 3));
  const r = scoreEvents(NPUB, HEX, onlyKind3, DEFAULT_CONFIG, jst(10, 12));
  assert.equal(r.sampleSize, 0, "kind3 が採点に算入されている");
  assert.equal(r.totalScore, 0);

  // 許可 kind を混ぜれば許可分だけ算入される（kind3 は捨てられる）。
  const mixed: NostrEvent[] = [
    ev(jst(0, 12), 1), // 算入
    ev(jst(0, 13), 3), // 除外
    ev(jst(1, 12), 7), // 算入
    ev(jst(1, 13), 3), // 除外
  ];
  const rm = scoreEvents(NPUB, HEX, mixed, DEFAULT_CONFIG, jst(2, 12));
  assert.equal(rm.sampleSize, 2, "許可外 kind3 が採点に混ざっている");
  assert.equal(rm.observation.observedActiveDays, 2);
});

test("空データ: スコア0・ランクは休眠・注意書きあり", () => {
  const r = scoreEvents(NPUB, HEX, []);
  assert.equal(r.totalScore, 0);
  assert.equal(r.sampleSize, 0);
  assert.ok(r.notes.length > 0);
  assert.equal(r.observation.longTermAssessable, false);
  assert.equal(r.subScores.longTermRetention, 0);
});

test("短観測の高密度ユーザー: 短期は高いが長期継続は主張しない", () => {
  // 7日間だけ・毎日40件の集中投稿（短い観測ウィンドウ）。
  const events: NostrEvent[] = [];
  for (let d = 0; d < 7; d++) {
    for (let n = 0; n < 40; n++) {
      events.push(ev(jst(d, 10 + (n % 12), n % 60)));
    }
  }
  // now は最終投稿の少し後（観測ウィンドウは依然 7 日のまま）。
  const now = jst(7, 12);
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now);

  // 短期は十分高い。
  assert.ok(
    r.subScores.shortTermActivity >= 60,
    `短期が低すぎ: ${r.subScores.shortTermActivity}`,
  );
  // 長期継続は「観測不足」で評価不能、スコアも低い（古参を僭称しない）。
  assert.equal(r.observation.longTermAssessable, false);
  assert.ok(
    r.subScores.longTermRetention < 25,
    `長期が高すぎ（短観測なのに継続を主張）: ${r.subScores.longTermRetention}`,
  );
  // 観測ウィンドウ不足の注意書きが出る。
  assert.ok(r.notes.some((n) => n.includes("low-confidence")));
});

test("長期にわたり活動: 長期継続が高く・評価可能になる", () => {
  // 約400日にわたり3日おきに投稿（観測ウィンドウが長い）。
  const events: NostrEvent[] = [];
  for (let d = 0; d < 400; d += 3) {
    events.push(ev(jst(d, 12)));
  }
  const now = jst(400, 12);
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now);

  assert.equal(r.observation.longTermAssessable, true);
  assert.ok(
    r.subScores.longTermRetention >= 60,
    `長期が低すぎ: ${r.subScores.longTermRetention}`,
  );
  assert.ok(r.observation.observedWindowDays >= 45);
});

test("短観測の高密度 < 長期活動 で長期継続スコアが逆転する", () => {
  const shortHeavy: NostrEvent[] = [];
  for (let d = 0; d < 7; d++)
    for (let n = 0; n < 40; n++) shortHeavy.push(ev(jst(d, 10 + (n % 12), n)));
  const longSpan: NostrEvent[] = [];
  for (let d = 0; d < 400; d += 3) longSpan.push(ev(jst(d, 12)));

  const sr = scoreEvents(NPUB, HEX, shortHeavy, DEFAULT_CONFIG, jst(7, 12));
  const lr = scoreEvents(NPUB, HEX, longSpan, DEFAULT_CONFIG, jst(400, 12));

  // 短観測の高密度ユーザーは「短期」では勝つが「長期継続」では負ける。
  assert.ok(sr.subScores.shortTermActivity > lr.subScores.shortTermActivity);
  assert.ok(
    lr.subScores.longTermRetention > sr.subScores.longTermRetention,
    `長期逆転せず: short=${sr.subScores.longTermRetention} long=${lr.subScores.longTermRetention}`,
  );
});
