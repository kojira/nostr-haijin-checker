/**
 * 大規模入力（“廃人スケール”）の回帰テスト。
 *
 * 旧実装は `observedWindow()` の `Math.min(...times)` / `Math.max(...times)` で
 * イベント配列を巨大スプレッドしており、~195k 件規模で引数上限による
 * スタックオーバーフロー（"Maximum call stack size exceeded"）で診断表示ごと
 * クラッシュしていた。本テストは **20 万件規模でも**:
 *   1) scoreEvents が例外を投げず最後まで採点できること
 *   2) formatReport が結果をレンダリングし切れること（＝診断表示が完了する）
 *   3) 1 パス集計 aggregateEvents が正しい min/max・稼働日・時刻分布・交流件数を返すこと
 * を保証し、巨大スプレッド／多重走査の再混入を防ぐ。
 *   実行: npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreEvents, DEFAULT_CONFIG } from "../src/scoring/index.js";
import { formatReport } from "../src/report.js";
import { prepareEvents } from "../src/scoring/prepare.js";
import { aggregateEvents } from "../src/scoring/signals.js";
import type { NostrEvent } from "../src/types.js";

const NPUB = "npub1synthetic000000000000000000000000000000000000000000000000";
const HEX = "00".repeat(32);
// 86400 の倍数に揃えた基準（jst() の +9h シフト後にちょうど JST 深夜 0:00 になる）。
// これにより各日の 24 時間分の投稿が JST 同日内に収まり、稼働日数が厳密に数えられる。
const BASE = 1_699_920_000; // = 19675 * 86400

let idCounter = 0;
function ev(createdAt: number, kind = 1, tags: string[][] = []): NostrEvent {
  return {
    id: `s${idCounter++}`,
    pubkey: HEX,
    created_at: createdAt,
    kind,
    tags,
    content: "x",
  };
}

/** JST の指定日・指定時刻(秒)に対応する UNIX 秒。 */
function jst(dayIndex: number, hour: number, minute = 0): number {
  return BASE + dayIndex * 86400 + (hour - 9) * 3600 + minute * 60;
}

/**
 * “廃人スケール”の合成データ。365 日 × 各日約 548 件 ≒ 20 万件。
 * 旧実装の巨大スプレッド上限（~12 万 / エンジン依存）を確実に超える規模にする。
 * 日数・時刻・交流種別を決定的に割り当て、集計値を厳密に検証できるようにする。
 */
const DAYS = 365;
const PER_DAY = 548;
const TOTAL = DAYS * PER_DAY; // 200,020

function buildHaijinScaleEvents(): NostrEvent[] {
  const events: NostrEvent[] = [];
  for (let d = 0; d < DAYS; d++) {
    for (let n = 0; n < PER_DAY; n++) {
      // 時刻は 0-23 を巡回（時刻ヒストグラムが 24 時間に広がる）。
      const hour = n % 24;
      // 交流種別を決定的に混ぜる（10 件ごとにリプライ/リアクション/リポスト）。
      let kind = 1;
      let tags: string[][] = [];
      const r = n % 10;
      if (r === 0) {
        kind = 1;
        tags = [["e", "someid"]]; // リプライ
      } else if (r === 1) {
        kind = 7; // リアクション
      } else if (r === 2) {
        kind = 6; // リポスト
      }
      events.push(ev(jst(d, hour, n % 60), kind, tags));
    }
  }
  return events;
}

test("廃人スケール: 20万件でも scoreEvents がクラッシュせず採点を完了する", () => {
  idCounter = 0;
  const events = buildHaijinScaleEvents();
  assert.equal(events.length, TOTAL);

  const now = jst(DAYS, 12);
  // 旧実装はこの行で "Maximum call stack size exceeded" を投げていた。
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now);

  // 採点が最後まで走り、妥当な総合スコアになる。
  assert.equal(r.sampleSize, TOTAL);
  assert.ok(Number.isFinite(r.totalScore));
  assert.ok(r.totalScore >= 0 && r.totalScore <= 100);
  assert.ok(r.rank && r.rank.label.length > 0);
  // 稼働日・観測ウィンドウが正しく数えられている。
  assert.equal(r.observation.observedActiveDays, DAYS);
  assert.ok(r.observation.observedWindowDays >= DAYS - 2);
  // 各シグナルに根拠が付く。
  for (const s of r.signals) assert.ok(s.reason.length > 0);
});

test("廃人スケール: 診断表示（formatReport）が最後までレンダリングできる", () => {
  idCounter = 0;
  const events = buildHaijinScaleEvents();
  const now = jst(DAYS, 12);
  const r = scoreEvents(NPUB, HEX, events, DEFAULT_CONFIG, now);

  // これがクラッシュしていた「診断結果のレンダリング」。完了して文字列を返すこと。
  const out = formatReport(r);
  assert.ok(typeof out === "string" && out.length > 0);
  assert.ok(out.includes("総合廃人スコア"));
  assert.ok(out.includes("内訳（根拠）"));
});

test("aggregateEvents: 1 パス集計が min/max・稼働日・時刻分布・交流を正しく数える", () => {
  idCounter = 0;
  const events = buildHaijinScaleEvents();
  const analyzed = prepareEvents(events, DEFAULT_CONFIG);
  const agg = aggregateEvents(analyzed);

  // 件数。
  assert.equal(agg.total, TOTAL);
  // min/max は巨大スプレッドではなくループで求める（結果は等価）。
  let expectedMin = Infinity;
  let expectedMax = -Infinity;
  for (const a of analyzed) {
    if (a.createdAt < expectedMin) expectedMin = a.createdAt;
    if (a.createdAt > expectedMax) expectedMax = a.createdAt;
  }
  assert.equal(agg.minCreatedAt, expectedMin);
  assert.equal(agg.maxCreatedAt, expectedMax);

  // 稼働日数は distinct な日数 = DAYS。
  assert.equal(agg.activeDays, DAYS);

  // 時刻ヒストグラムの合計は総件数に一致し、24 時間に分散している。
  assert.equal(agg.hourCounts.length, 24);
  assert.equal(
    agg.hourCounts.reduce((a, b) => a + b, 0),
    TOTAL,
  );
  assert.ok(agg.hourCounts.every((c) => c > 0), "24 時間すべてに投稿があるはず");

  // 交流件数: 各日 PER_DAY 件のうち n%10===0/1/2 がリプライ/リアクション/リポスト。
  const repliesPerDay = Math.floor((PER_DAY + 9) / 10); // n%10===0 の個数
  const reactionsPerDay = Math.floor((PER_DAY + 8) / 10); // n%10===1
  const repostsPerDay = Math.floor((PER_DAY + 7) / 10); // n%10===2
  assert.equal(agg.replies, repliesPerDay * DAYS);
  assert.equal(agg.reactions, reactionsPerDay * DAYS);
  assert.equal(agg.reposts, repostsPerDay * DAYS);
});

test("aggregateEvents: 空入力でも破綻しない（min/max=0・稼働日0）", () => {
  const agg = aggregateEvents([]);
  assert.equal(agg.total, 0);
  assert.equal(agg.minCreatedAt, 0);
  assert.equal(agg.maxCreatedAt, 0);
  assert.equal(agg.activeDays, 0);
  assert.equal(
    agg.hourCounts.reduce((a, b) => a + b, 0),
    0,
  );
  assert.equal(agg.replies + agg.reactions + agg.reposts, 0);
});
