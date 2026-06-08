/**
 * 適応的タイムウィンドウ取得（queryUserEvents）を、ネットワーク不要の
 * 疑似フェッチャ（テストシーム fetcher）で決定的に検証する。
 *   実行: npm test
 *
 * 検証対象:
 *  1) 疎な履歴: 1 ウィンドウで少数 → 分割しない・全件返る・複数リレーで重複排除・complete
 *  2) 密ウィンドウの分割: 粗いウィンドウは閾値以上を返すが取りこぼし、細い子ウィンドウで
 *     その取りこぼし分が回収できること（件数ベースのページングなら欠落していたデータ）。
 *     かつ minWindowSeconds 未満には分割しないこと。
 *  3) グローバル重複排除: 同一 id が複数リレー/ウィンドウから来ても 1 件。
 *  4) 部分失敗: 片方のリレーが例外 → そのリレーは failed/timeout、もう片方の結果は返る。
 *  5) キャップ: maxEvents で早期停止 / maxWindows を尊重。
 *  6) タイムアウトの分離（グローバルではなくリクエスト／リレー単位）:
 *     - 片方のリレーがハング（ウィンドウタイムアウト）しても、他リレーは完走する。
 *     - ウィンドウタイムアウトはグローバル停止ではない（各ウィンドウ独立に計時）。
 *     - リレー総時間タイムアウトは、そのリレーだけを打ち切る。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  queryUserEvents,
  DEFAULT_SINCE,
  type MinimalFetcher,
} from "../src/nostr/query.js";
import { ALLOWED_KINDS } from "../src/kinds.js";
import type { NostrEvent } from "../src/types.js";

const HEX = "00".repeat(32);

function ev(id: string, createdAt: number, kind = 1): NostrEvent {
  return { id, pubkey: HEX, created_at: createdAt, kind, tags: [], content: "x" };
}

/** 指定 ms 後に解決する小さな遅延（タイムアウト系テスト用）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** [since, until) に入るイベントだけを返す素直な疑似フェッチャ。 */
function fixtureFetcher(events: NostrEvent[]): MinimalFetcher & { calls: { since?: number; until?: number }[] } {
  const calls: { since?: number; until?: number }[] = [];
  return {
    calls,
    async fetchAllEvents(_relays, _filter, tr) {
      calls.push({ since: tr.since, until: tr.until });
      const s = tr.since ?? -Infinity;
      const u = tr.until ?? Infinity;
      return events.filter((e) => e.created_at >= s && e.created_at < u);
    },
    shutdown() {},
  };
}

test("疎な履歴: 分割せず全件返る・complete", async () => {
  const until = DEFAULT_SINCE + 2592000; // 30 日 = 初期ウィンドウ 1 個ぶん
  const events = [
    ev("a", DEFAULT_SINCE + 100),
    ev("b", DEFAULT_SINCE + 86400),
    ev("c", DEFAULT_SINCE + 200000),
  ];
  const f = fixtureFetcher(events);
  const { events: out, meta } = await queryUserEvents(HEX, {
    relays: ["wss://r1"],
    untilUnix: until,
    sinceUnix: DEFAULT_SINCE,
    fetcher: f,
  });
  assert.equal(out.length, 3);
  // 30 日範囲をちょうど 1 ウィンドウで覆う＝分割なし。
  assert.equal(f.calls.length, 1);
  assert.equal(meta.historyComplete, true);
  assert.equal(meta.stopReason, "ok");
  assert.equal(meta.reachedOldestAvailable, true);
  assert.equal(meta.pagesFetched, 1);
});

test("既定で許可リスト（ALLOWED_KINDS）の kind だけをリレーへ問い合わせる", async () => {
  const seen: (number[] | undefined)[] = [];
  const f: MinimalFetcher = {
    async fetchAllEvents(_relays, filter) {
      seen.push(filter.kinds as number[] | undefined);
      return [];
    },
    shutdown() {},
  };
  await queryUserEvents(HEX, {
    relays: ["wss://r1"],
    untilUnix: DEFAULT_SINCE + 2592000,
    sinceUnix: DEFAULT_SINCE,
    fetcher: f,
  });
  assert.ok(seen.length >= 1, "問い合わせが発生していない");
  const sortNum = (a: number[]): number[] => [...a].sort((x, y) => x - y);
  for (const kinds of seen) {
    assert.ok(kinds, "kinds 指定なしで問い合わせている（全 kind になってしまう）");
    assert.deepEqual(sortNum(kinds!), sortNum(ALLOWED_KINDS));
    // フォローリスト kind3 など許可外は含まない。
    assert.ok(!kinds!.includes(3), "許可外 kind3 が問い合わせに含まれている");
  }
});

test("kinds を明示指定すれば許可リストより優先される", async () => {
  let seen: number[] | undefined;
  const f: MinimalFetcher = {
    async fetchAllEvents(_relays, filter) {
      seen = filter.kinds as number[] | undefined;
      return [];
    },
    shutdown() {},
  };
  await queryUserEvents(HEX, {
    relays: ["wss://r1"],
    untilUnix: DEFAULT_SINCE + 2592000,
    sinceUnix: DEFAULT_SINCE,
    kinds: [1],
    fetcher: f,
  });
  assert.deepEqual(seen, [1]);
});

test("複数リレーで重複排除: 同一 id は 1 件", async () => {
  const until = DEFAULT_SINCE + 2592000;
  const shared = [ev("dup", DEFAULT_SINCE + 1000), ev("only1", DEFAULT_SINCE + 2000)];
  const f1 = fixtureFetcher(shared);
  const f2 = fixtureFetcher([ev("dup", DEFAULT_SINCE + 1000), ev("only2", DEFAULT_SINCE + 3000)]);
  // 2 リレー分のフェッチャを 1 つに束ねる（relay URL で振り分け）。
  const combined: MinimalFetcher = {
    async fetchAllEvents(relays, filter, tr, o) {
      return relays[0] === "wss://r1"
        ? f1.fetchAllEvents(relays, filter, tr, o)
        : f2.fetchAllEvents(relays, filter, tr, o);
    },
    shutdown() {},
  };
  const { events: out } = await queryUserEvents(HEX, {
    relays: ["wss://r1", "wss://r2"],
    untilUnix: until,
    sinceUnix: DEFAULT_SINCE,
    fetcher: combined,
  });
  const ids = out.map((e) => e.id).sort();
  assert.deepEqual(ids, ["dup", "only1", "only2"]);
});

test("密ウィンドウの分割: 粗いウィンドウの取りこぼしを子ウィンドウで回収する", async () => {
  // 単一の 30 日ウィンドウを使う。リレーは「1 リクエストで先頭 N 件しか返さない」キャップを
  // 模す: 粗いウィンドウ（広い）では一部しか返さず、狭い子ウィンドウなら全件返す。
  const since = DEFAULT_SINCE;
  const until = since + 2592000;
  // 全データ: 50 件を範囲に分散配置。
  const all: NostrEvent[] = [];
  for (let i = 0; i < 50; i++) {
    all.push(ev(`e${i}`, since + i * 50000)); // 50000s 間隔 → 30 日内に収まる
  }
  // denseThreshold=10, minWindow=3600。各ウィンドウ呼び出しで:
  //  - 範囲内イベントを抽出し、先頭 10 件（古い順）だけ返す（リレーキャップ模擬）。
  //    → 範囲が広いと末尾（新しめ）が落ちるが、中点分割で別ウィンドウになり回収される。
  const calls: { since: number; until: number }[] = [];
  const capped: MinimalFetcher = {
    async fetchAllEvents(_relays, _filter, tr) {
      const s = tr.since!;
      const u = tr.until!;
      calls.push({ since: s, until: u });
      const inWin = all
        .filter((e) => e.created_at >= s && e.created_at < u)
        .sort((a, b) => a.created_at - b.created_at);
      return inWin.slice(0, 10); // 先頭 10 件だけ返す（キャップ）。
    },
    shutdown() {},
  };
  const { events: out, meta } = await queryUserEvents(HEX, {
    relays: ["wss://r1"],
    untilUnix: until,
    sinceUnix: since,
    denseThreshold: 10,
    minWindowSeconds: 3600,
    fetcher: capped,
  });
  // 分割によって最終的に全 50 件が回収できる（件数ページングなら欠落していた分）。
  assert.equal(out.length, 50, `回収件数: ${out.length}`);
  // 1 ウィンドウより多く呼ばれている＝実際に分割が起きた。
  assert.ok(calls.length > 1, `分割が起きていない: calls=${calls.length}`);
  // どのウィンドウ幅も minWindowSeconds を下回って分割していない
  //（=分割は最小幅で止まる）。閾値以上を返したウィンドウだけが分割対象。
  assert.equal(meta.historyComplete, true);
});

test("分割は minWindowSeconds 未満では起きない", async () => {
  // 全イベントを 1 つの極小範囲（< minWindow）に詰め、常に閾値以上返るようにする。
  const since = DEFAULT_SINCE;
  const until = since + 1800; // 30 分 < minWindow(3600)
  const all: NostrEvent[] = [];
  for (let i = 0; i < 20; i++) all.push(ev(`x${i}`, since + i));
  const calls: { since: number; until: number }[] = [];
  const f: MinimalFetcher = {
    async fetchAllEvents(_relays, _filter, tr) {
      calls.push({ since: tr.since!, until: tr.until! });
      return all.filter((e) => e.created_at >= tr.since! && e.created_at < tr.until!);
    },
    shutdown() {},
  };
  await queryUserEvents(HEX, {
    relays: ["wss://r1"],
    untilUnix: until,
    sinceUnix: since,
    denseThreshold: 5, // 20 件 >= 5 なので「密」だが、幅が minWindow 未満なので分割しない
    minWindowSeconds: 3600,
    fetcher: f,
  });
  // 初期ウィンドウは 1 個（範囲が initialWindow より狭い）。分割されないので 1 回だけ。
  assert.equal(calls.length, 1, `minWindow 未満で分割した: ${calls.length}`);
});

test("部分失敗: 片方が例外でも他リレーの結果は返る", async () => {
  const until = DEFAULT_SINCE + 2592000;
  const good = fixtureFetcher([ev("g1", DEFAULT_SINCE + 1000), ev("g2", DEFAULT_SINCE + 2000)]);
  const combined: MinimalFetcher = {
    async fetchAllEvents(relays, filter, tr, o) {
      if (relays[0] === "wss://bad") throw new Error("boom");
      return good.fetchAllEvents(relays, filter, tr, o);
    },
    shutdown() {},
  };
  const { events: out, meta } = await queryUserEvents(HEX, {
    relays: ["wss://bad", "wss://good"],
    untilUnix: until,
    sinceUnix: DEFAULT_SINCE,
    fetcher: combined,
  });
  // 健全なリレーのイベントは返る。
  assert.equal(out.length, 2);
  assert.equal(meta.relaysFailed, 1);
  assert.equal(meta.relaysSucceeded, 1);
  const bad = meta.relayStats.find((r) => r.url === "wss://bad")!;
  assert.equal(bad.status, "failed");
  assert.ok(bad.error?.includes("boom"));
  // 仕様: 健全なリレーが範囲を覆い切れていれば（リレーは冗長なので）ok 扱い。
  // 失敗した事実は relaysFailed / relayStats に正直に残る。
  assert.equal(meta.stopReason, "ok");
  assert.equal(meta.historyComplete, true);
});

test("キャップ: maxEvents で早期停止", async () => {
  const since = DEFAULT_SINCE;
  const until = since + 2592000 * 3; // 3 ウィンドウぶん
  const all: NostrEvent[] = [];
  for (let i = 0; i < 100; i++) all.push(ev(`m${i}`, since + i * 60000));
  const f = fixtureFetcher(all);
  const { events: out, meta } = await queryUserEvents(HEX, {
    relays: ["wss://r1"],
    untilUnix: until,
    sinceUnix: since,
    maxEvents: 10,
    fetcher: f,
  });
  // 1 ウィンドウ目で 10 件以上集まり、上限到達で打ち切る。
  assert.ok(out.length >= 10, `件数: ${out.length}`);
  assert.equal(meta.hitEventCap, true);
  assert.equal(meta.stopReason, "maxEvents");
  assert.equal(meta.historyComplete, false);
});

test("キャップ: maxWindows を尊重する", async () => {
  const since = DEFAULT_SINCE;
  const until = since + 2592000 * 10; // 10 個の初期ウィンドウ
  // 各ウィンドウに 1 件ずつ（分割は起きない）。
  const all: NostrEvent[] = [];
  for (let i = 0; i < 10; i++) all.push(ev(`w${i}`, since + i * 2592000 + 100));
  const f = fixtureFetcher(all);
  const { meta } = await queryUserEvents(HEX, {
    relays: ["wss://r1"],
    untilUnix: until,
    sinceUnix: since,
    maxWindows: 3, // 3 ウィンドウで打ち切り
    fetcher: f,
  });
  assert.equal(meta.pagesFetched, 3);
  assert.equal(meta.hitPageCap, true);
  assert.equal(meta.stopReason, "maxWindows");
  assert.equal(meta.historyComplete, false);
});

test("リレー単位タイムアウト: 片方がハングしても他リレーは完走する", async () => {
  // 「ハング」リレーは abort されるまで返さない（ウィンドウタイムアウトで打ち切られる）。
  // signal を尊重してタイマを片付け、ダングリングタイマでプロセスを生かし続けないようにする。
  const until = DEFAULT_SINCE + 2592000; // 1 ウィンドウ
  const goodEvents = [ev("g1", DEFAULT_SINCE + 1000), ev("g2", DEFAULT_SINCE + 2000)];
  const combined: MinimalFetcher = {
    async fetchAllEvents(relays, _filter, tr, o) {
      if (relays[0] === "wss://hang") {
        return new Promise<NostrEvent[]>((resolve, reject) => {
          const t = setTimeout(() => resolve([]), 10_000);
          o?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      }
      const s = tr.since ?? -Infinity;
      const u = tr.until ?? Infinity;
      return goodEvents.filter((e) => e.created_at >= s && e.created_at < u);
    },
    shutdown() {},
  };
  const { events: out, meta } = await queryUserEvents(HEX, {
    relays: ["wss://hang", "wss://good"],
    untilUnix: until,
    sinceUnix: DEFAULT_SINCE,
    windowTimeoutMs: 80, // ハングするリレーのウィンドウはここで時間切れ
    relayTimeoutMs: 60_000,
    fetcher: combined,
  });
  // 健全なリレーのイベントは全部返る（ハングに巻き込まれない）。
  assert.equal(out.length, 2);
  const hang = meta.relayStats.find((r) => r.url === "wss://hang")!;
  const good = meta.relayStats.find((r) => r.url === "wss://good")!;
  assert.equal(hang.status, "timeout");
  assert.equal(good.status, "ok");
  assert.equal(meta.timedOut, true);
  // 健全リレーが範囲を覆い切ったので全体は ok。タイムアウトの事実は relayStats に正直に残る。
  assert.equal(meta.stopReason, "ok");
  assert.equal(meta.historyComplete, true);
});

test("ウィンドウタイムアウトはグローバル停止ではない: 各ウィンドウ独立に計時する", async () => {
  // 健全リレーは 3 ウィンドウ、各 30ms（windowTimeout 60ms 未満）。合計 90ms は
  // windowTimeout を超えるが、ウィンドウごとに計時がリセットされるので途中で止まらない。
  // 旧来の単一グローバル期限（60ms）なら 90ms 到達前に打ち切られ、一部が欠落していた。
  const until = DEFAULT_SINCE + 2592000 * 3; // 3 初期ウィンドウ
  const all = [
    ev("w0", DEFAULT_SINCE + 100),
    ev("w1", DEFAULT_SINCE + 2592000 + 100),
    ev("w2", DEFAULT_SINCE + 2592000 * 2 + 100),
  ];
  const slowButOk: MinimalFetcher = {
    async fetchAllEvents(_relays, _filter, tr) {
      await delay(30); // 各ウィンドウ 30ms（windowTimeout 未満）
      const s = tr.since!;
      const u = tr.until!;
      return all.filter((e) => e.created_at >= s && e.created_at < u);
    },
    shutdown() {},
  };
  const { events: out, meta } = await queryUserEvents(HEX, {
    relays: ["wss://r1"],
    untilUnix: until,
    sinceUnix: DEFAULT_SINCE,
    windowTimeoutMs: 60, // 各ウィンドウには十分。グローバルなら合計 90ms で打ち切られるはず。
    relayTimeoutMs: 60_000, // リレー総時間は余裕。
    fetcher: slowButOk,
  });
  // 3 ウィンドウすべて処理され、全イベントが返る（グローバル停止なら一部欠落していた）。
  assert.equal(out.length, 3, `件数: ${out.length}`);
  assert.equal(meta.pagesFetched, 3);
  assert.equal(meta.stopReason, "ok");
  assert.equal(meta.historyComplete, true);
  assert.equal(meta.timedOut, false);
});

test("リレー総時間タイムアウト: 速いウィンドウでもリレー上限で打ち切る", async () => {
  // 各ウィンドウは速い（10ms）が数が多く、relayTimeout を超える。
  // ウィンドウ個別には時間切れにならないが、リレー総時間の上限で timeout になる。
  const until = DEFAULT_SINCE + 2592000 * 20; // 20 初期ウィンドウ
  const all: NostrEvent[] = [];
  for (let i = 0; i < 20; i++) {
    all.push(ev(`r${i}`, DEFAULT_SINCE + i * 2592000 + 50));
  }
  const slow: MinimalFetcher = {
    async fetchAllEvents(_relays, _filter, tr) {
      await delay(10);
      return all.filter((e) => e.created_at >= tr.since! && e.created_at < tr.until!);
    },
    shutdown() {},
  };
  const { meta } = await queryUserEvents(HEX, {
    relays: ["wss://r1"],
    untilUnix: until,
    sinceUnix: DEFAULT_SINCE,
    windowTimeoutMs: 1000, // ウィンドウ個別には十分。
    relayTimeoutMs: 50, // リレー総時間は短い → 数ウィンドウで打ち切る。
    fetcher: slow,
  });
  const r1 = meta.relayStats.find((r) => r.url === "wss://r1")!;
  assert.equal(r1.status, "timeout");
  assert.equal(meta.timedOut, true);
  // 全 20 ウィンドウは処理できず途中で打ち切られている。
  assert.ok(meta.pagesFetched < 20, `pages: ${meta.pagesFetched}`);
  // 健全に覆い切れていないので ok ではない。
  assert.equal(meta.stopReason, "timeout");
  assert.equal(meta.historyComplete, false);
});
