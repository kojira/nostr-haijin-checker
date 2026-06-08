/**
 * 個別シグナルの算出ロジック。
 *
 * すべてのシグナルは 0-100 に正規化され、必ず「reason（根拠）」を返す。
 * これにより総合スコアが説明可能（explainable）になる。
 *
 * 設計方針:
 *  - 各シグナルは独立した純粋関数。テスト・差し替えが容易。
 *  - 飽和カーブ saturating() で「ヘビーユーザーほど 100 に漸近」させる。
 */
import type {
  AnalyzedEvent,
  ObservationInfo,
  SignalScore,
  StreakInfo,
} from "../types.js";

const SECONDS_PER_DAY = 86400;

/**
 * 長期評価のパラメータ（しきい値）。
 * すべて「観測ウィンドウ・実稼働日数・初観測からの経過」に基づく。
 * ここを境に「短い観測ウィンドウ＝長期継続」と取り違えないよう設計している。
 */
const LONGTERM = {
  /** これ未満のウィンドウでは長期継続を「評価不能」とみなす（日）。 */
  minWindowDays: 45,
  /** これ未満の実稼働日数では長期継続を「評価不能」とみなす。 */
  minActiveDays: 8,
  /** 信頼度が満点(=1)に達する観測ウィンドウ長（日）。 */
  fullWindowDays: 180,
  /** 信頼度が満点(=1)に達する実稼働日数。 */
  fullActiveDays: 30,
  /** 古参度: 初観測からの経過がこの日数で頭打ち。 */
  veteranFullAgeDays: 730,
  /** 古参度: 観測ウィンドウ長がこの日数で頭打ち。 */
  veteranFullSpanDays: 365,
  /** 古参度: 実稼働日数がこの日数で頭打ち。 */
  veteranFullActiveDays: 200,
} as const;

/** 短期アクティブ度のサンプル信頼度が満点になるイベント数。 */
const SHORTTERM_FULL_EVENTS = 30;

/**
 * 連続実稼働ストリークが「ほぼフル加点」に達する連続日数（飽和カーブの基準）。
 * 早い段階で強く伸び、約 60 日でほぼ頭打ちになるよう選んでいる:
 *   7日 → 約 51 / 14日 → 約 66 / 30日 → 約 84 / 60日 → 100。
 */
export const STREAK_FULL_DAYS = 60;

/**
 * 飽和スコア: value が full に達するとほぼ 100、それ以上は緩やかに頭打ち。
 * log10 ベースなので「1件目の重み」が大きく、廃人帯での差も残る。
 */
export function saturating(value: number, full: number): number {
  if (value <= 0) return 0;
  const s = (100 * Math.log10(1 + value)) / Math.log10(1 + full);
  return clamp(s);
}

export function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

/** 0-1 にクランプ（信頼度・比率用）。 */
export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 全シグナルが共有する集計値。イベント配列を **1 回だけ** 走査して作る。
 *
 * 195k 件規模（“廃人スケール”）でも安全に処理できるよう、以下を増分集計する:
 *  - min/max createdAt（最古/最新。`Math.min(...arr)` のような巨大スプレッドは
 *    引数上限でスタックオーバーフローを起こすため使わない）
 *  - 実稼働日数（distinct な dayKey の数）
 *  - 時刻ヒストグラム（0-23 時の件数）
 *  - 交流件数（リプライ/リアクション/リポスト）
 *
 * 各シグナルはこの集計値を消費するだけなので、配列の多重走査（map/filter/Set の
 * 繰り返し）や巨大スプレッドが発生しない。
 */
export interface EventAggregate {
  /** イベント総数。 */
  total: number;
  /** 最古の createdAt（UNIX 秒）。空のときは 0。 */
  minCreatedAt: number;
  /** 最新の createdAt（UNIX 秒）。空のときは 0。 */
  maxCreatedAt: number;
  /** 投稿があった実日数（distinct な dayKey の数）。 */
  activeDays: number;
  /** 0-23 時の投稿件数ヒストグラム（長さ 24）。 */
  hourCounts: number[];
  /** リプライ件数（kind1 + 'e' タグ）。 */
  replies: number;
  /** リアクション件数（kind7）。 */
  reactions: number;
  /** リポスト件数（kind6）。 */
  reposts: number;
}

/**
 * 進捗コールバックを呼ぶ間隔（件数）。prepareEvents と揃える。
 */
const AGGREGATE_PROGRESS_CHUNK = 5000;

/**
 * イベント配列を 1 パスで集計する。O(n) / 追加メモリは O(distinct days) のみ。
 * 巨大配列でもスタックや一時配列を爆発させない（giant spread / 多重 map・filter を避ける）。
 *
 * @param onProgress 任意。集計済み件数を AGGREGATE_PROGRESS_CHUNK 件ごと（と最後）に通知する。
 *            未指定なら通知しないだけで、集計結果は不変。
 */
export function aggregateEvents(
  events: AnalyzedEvent[],
  onProgress?: (processed: number) => void,
): EventAggregate {
  const hourCounts = new Array<number>(24).fill(0);
  const dayKeys = new Set<string>();
  let minCreatedAt = Infinity;
  let maxCreatedAt = -Infinity;
  let replies = 0;
  let reactions = 0;
  let reposts = 0;

  let i = 0;
  for (const e of events) {
    if (e.createdAt < minCreatedAt) minCreatedAt = e.createdAt;
    if (e.createdAt > maxCreatedAt) maxCreatedAt = e.createdAt;
    dayKeys.add(e.dayKey);
    hourCounts[e.hourLocal]++;
    if (e.isReply) replies++;
    if (e.isReaction) reactions++;
    if (e.isRepost) reposts++;
    i++;
    if (onProgress && i % AGGREGATE_PROGRESS_CHUNK === 0) onProgress(i);
  }
  onProgress?.(events.length);

  return {
    total: events.length,
    minCreatedAt: events.length ? minCreatedAt : 0,
    maxCreatedAt: events.length ? maxCreatedAt : 0,
    activeDays: dayKeys.size,
    hourCounts,
    replies,
    reactions,
    reposts,
  };
}

/**
 * 1) 短期アクティブ度: 観測ウィンドウ「内」の密度・稼働日率。
 *
 * 「いま活発か」を表す軸。投稿/日（飽和カーブ）と稼働日率を合成し、
 * サンプルが極端に少ないときだけサンプル信頼度で割り引く。
 * ウィンドウが短くても密度が高ければ高く出る（短期は短期として評価する）が、
 * これを長期継続と取り違えないため、長期は別軸（longTermRetentionSignal）に分離する。
 */
export function shortTermActivitySignal(
  agg: EventAggregate,
  weight: number,
): SignalScore {
  const start = agg.minCreatedAt;
  const end = agg.maxCreatedAt;
  const windowDaysFrac = Math.max(1, (end - start) / SECONDS_PER_DAY);
  const spanDaysCal = Math.max(1, Math.round((end - start) / SECONDS_PER_DAY) + 1);
  const activeDays = agg.activeDays;

  const perDay = agg.total / windowDaysFrac;
  // 25件/日 で「フル廃人」とみなす飽和カーブ。
  const densityScore = saturating(perDay, 25);
  const activeRatio = clamp01(activeDays / spanDaysCal);
  const ratioScore = activeRatio * 100;

  // 密度 6 : 稼働日率 4 で合成。
  const raw = densityScore * 0.6 + ratioScore * 0.4;

  // サンプルが少ないと観測の確からしさが下がるので割り引く。
  const sampleConfidence = clamp01(
    Math.log10(1 + agg.total) / Math.log10(1 + SHORTTERM_FULL_EVENTS),
  );
  const score = raw * sampleConfidence;

  return {
    key: "shortTermActivity",
    label: "短期アクティブ度",
    category: "shortTerm",
    score: round1(score),
    weight,
    reason: `観測ウィンドウ ${round1(windowDaysFrac)}日・稼働 ${activeDays}日で ${
      agg.total
    }件（約 ${round1(perDay)}件/日, 稼働日率 ${Math.round(
      activeRatio * 100,
    )}%, サンプル信頼度 ${Math.round(
      sampleConfidence * 100,
    )}%）。直近の活発さを表します。`,
    detail: {
      perDay: round1(perDay),
      totalEvents: agg.total,
      activeDays,
      spanDays: spanDaysCal,
      activeRatioPct: Math.round(activeRatio * 100),
      sampleConfidencePct: Math.round(sampleConfidence * 100),
    },
  };
}

/**
 * 2) 常時稼働度（稼働時間帯の広さ）: 1 日 24 時間のうち、どれだけ広い時間帯に
 *    投稿しているか＝「いつ見ても居る」度合い。
 *
 * 旧版は「深夜が多い＝廃人」という粗い基準だったが、夜型/朝型といった単なる
 * 生活リズムの違いを廃人度と取り違えやすかった。本シグナルはこれを作り直し、
 * **時間帯の広さ（breadth）・昼夜の分散（day/night distribution）・時刻分布の
 * 均一さ（always-on-ness）** を測る。深夜だけ・夕方だけに偏っているユーザーより、
 * 一日中まんべんなく投稿しているユーザーを高く評価する。
 *
 * 3 つの観点を合成する（いずれも 0-1）:
 *  - coverage : 投稿のあった distinct な時間帯数 / 24（時間帯の広さ）。
 *  - quadrant : 6 時間ごと 4 区分（深夜/午前/午後/夜）のうち活動した区分数 / 4
 *               （昼夜まんべんなく＝always-on の近似）。
 *  - evenness : 時刻ヒストグラムの正規化シャノンエントロピー（分布の均一さ）。
 */
export function temporalCoverageSignal(
  agg: EventAggregate,
  weight: number,
): SignalScore {
  const total = agg.total;
  const counts = agg.hourCounts;

  const distinctHours = counts.filter((c) => c > 0).length;
  const coverage = distinctHours / 24;

  // 6 時間ごと 4 区分（0-5 深夜 / 6-11 午前 / 12-17 午後 / 18-23 夜）。
  const quadrants = [0, 0, 0, 0];
  counts.forEach((c, h) => {
    if (c > 0) quadrants[Math.floor(h / 6)] = 1;
  });
  const quadrantCoverage = quadrants.reduce((a, b) => a + b, 0) / 4;

  // 正規化シャノンエントロピー（0=1 時間帯に集中, 1=24 時間帯に完全均一）。
  let entropy = 0;
  if (total > 0) {
    for (const c of counts) {
      if (c <= 0) continue;
      const p = c / total;
      entropy -= p * Math.log2(p);
    }
  }
  const evenness = entropy / Math.log2(24);

  // 広さ重視で合成（深夜偏重を優遇しない）。広い時間帯＋昼夜分散＋均一さ。
  const score = clamp(
    100 * (0.5 * coverage + 0.3 * quadrantCoverage + 0.2 * evenness),
  );

  return {
    key: "temporalCoverage",
    label: "常時稼働度",
    category: "pattern",
    score: round1(score),
    weight,
    reason: `24 時間中 ${distinctHours} 時間帯に投稿（カバレッジ ${Math.round(
      coverage * 100,
    )}%）、昼夜 4 区分のうち ${quadrants.reduce(
      (a, b) => a + b,
      0,
    )} 区分で活動、時刻分布の均一さ ${Math.round(
      evenness * 100,
    )}%。特定の時間帯に偏らず「いつ見ても居る」ほど高くなります。`,
    detail: {
      distinctHours,
      coveragePct: Math.round(coverage * 100),
      quadrantsActive: quadrants.reduce((a, b) => a + b, 0),
      evennessPct: Math.round(evenness * 100),
    },
  };
}

/** 3) 連投（バースト）: 短時間に連続投稿しているか。 */
export function burstSignal(
  events: AnalyzedEvent[],
  weight: number,
  gapSeconds = 120,
  minBurst = 5,
): SignalScore {
  const asc = [...events].sort((a, b) => a.createdAt - b.createdAt);
  let burstCount = 0;
  let postsInBursts = 0;
  let runStart = 0;

  for (let i = 1; i <= asc.length; i++) {
    const broke =
      i === asc.length || asc[i].createdAt - asc[i - 1].createdAt > gapSeconds;
    if (broke) {
      const runLen = i - runStart;
      if (runLen >= minBurst) {
        burstCount++;
        postsInBursts += runLen;
      }
      runStart = i;
    }
  }

  const ratio = events.length ? postsInBursts / events.length : 0;
  // 全投稿の 40% が連投の一部なら 100 点。
  const score = clamp((ratio / 0.4) * 100);
  return {
    key: "bursts",
    label: "連投傾向",
    category: "pattern",
    score: round1(score),
    weight,
    reason: `${minBurst}件以上を${gapSeconds}秒以内に投稿した「連投」が ${burstCount} 回（連投に含まれる投稿 ${postsInBursts} 件 / ${Math.round(
      ratio * 100,
    )}%）。`,
    detail: { burstCount, postsInBursts, ratioPct: Math.round(ratio * 100) },
  };
}

/** 4) 交流密度: リプライ・リアクション・リポストの割合。 */
export function engagementSignal(
  agg: EventAggregate,
  weight: number,
): SignalScore {
  const { replies, reactions, reposts } = agg;
  const interactions = replies + reactions + reposts;
  const ratio = agg.total ? interactions / agg.total : 0;
  // 投稿の 60% が他者への反応なら 100 点。
  const score = clamp((ratio / 0.6) * 100);
  return {
    key: "engagement",
    label: "交流密度",
    category: "pattern",
    score: round1(score),
    weight,
    reason: `リプライ ${replies} / リアクション ${reactions} / リポスト ${reposts}（全体の ${Math.round(
      ratio * 100,
    )}% が他者への反応）。`,
    detail: { replies, reactions, reposts, ratioPct: Math.round(ratio * 100) },
  };
}

/**
 * 観測メタ情報（ウィンドウ長・初観測からの経過・実稼働日数・信頼度）を求める。
 *
 * 信頼度 confidence は「観測ウィンドウ長 × 実稼働日数」の積で 0-1。
 * どちらかが乏しいと 0 に近づくため、短い観測では長期評価が自然に効かなくなる。
 * longTermAssessable は人間向けメッセージ用のハードな真偽（しきい値判定）。
 *
 * @param nowSec 現在時刻(UNIX秒)。古参度（初観測からの経過）の基準。
 */
export function computeObservation(
  agg: EventAggregate,
  nowSec: number,
): ObservationInfo {
  if (agg.total === 0) {
    return {
      observedWindowDays: 0,
      firstSeenAgeDays: 0,
      observedActiveDays: 0,
      confidence: 0,
      longTermAssessable: false,
    };
  }

  const start = agg.minCreatedAt;
  const end = agg.maxCreatedAt;
  const observedWindowDays = Math.max(0, (end - start) / SECONDS_PER_DAY);
  // 初観測からの経過。最低でも観測ウィンドウ長は確保（now がズレても破綻しない）。
  const firstSeenAgeDays = Math.max(
    observedWindowDays,
    (nowSec - start) / SECONDS_PER_DAY,
  );
  const observedActiveDays = agg.activeDays;

  const windowConf = clamp01(observedWindowDays / LONGTERM.fullWindowDays);
  const activityConf = clamp01(observedActiveDays / LONGTERM.fullActiveDays);
  const confidence = round2(windowConf * activityConf);

  const longTermAssessable =
    observedWindowDays >= LONGTERM.minWindowDays &&
    observedActiveDays >= LONGTERM.minActiveDays;

  return {
    observedWindowDays: round1(observedWindowDays),
    firstSeenAgeDays: round1(firstSeenAgeDays),
    observedActiveDays,
    confidence,
    longTermAssessable,
  };
}

/**
 * 5) 長期継続・古参度: 長く・継続的に観測できているか。
 *
 * 「初観測からの経過 × 観測ウィンドウ長 × 実稼働日数」で“素の古参度”を作り、
 * これを観測信頼度 confidence で割り引く。短い観測ウィンドウでは confidence が
 * 0 に近づくため、**7日の観測から 3年の継続を主張することは構造的に起きない**。
 * 評価不能（longTermAssessable=false）のときは reason で短期中心の評価である旨を明示する。
 */
export function longTermRetentionSignal(
  obs: ObservationInfo,
  weight: number,
): SignalScore {
  const ageScore = saturating(obs.firstSeenAgeDays, LONGTERM.veteranFullAgeDays);
  const spanScore = saturating(
    obs.observedWindowDays,
    LONGTERM.veteranFullSpanDays,
  );
  const activeDaysScore = saturating(
    obs.observedActiveDays,
    LONGTERM.veteranFullActiveDays,
  );

  // 素の古参度（信頼度割引前）。古参度 0.35 / 観測幅 0.30 / 実稼働 0.35。
  const rawVeteran = ageScore * 0.35 + spanScore * 0.3 + activeDaysScore * 0.35;
  // 信頼度で割り引いた「主張してよい長期スコア」。
  const score = rawVeteran * obs.confidence;

  const reason = obs.longTermAssessable
    ? `初観測から ${round1(obs.firstSeenAgeDays)}日・観測ウィンドウ ${round1(
        obs.observedWindowDays,
      )}日・実稼働 ${obs.observedActiveDays}日 → 古参度 ${round1(
        rawVeteran,
      )}（信頼度 ${Math.round(obs.confidence * 100)}% で割引後 ${round1(
        score,
      )}）。`
    : `観測ウィンドウが ${round1(
        obs.observedWindowDays,
      )}日（実稼働 ${obs.observedActiveDays}日）のため、短期の活発さを中心に評価しています（信頼度 ${Math.round(
        obs.confidence * 100,
      )}%）。`;

  return {
    key: "longTermRetention",
    label: "長期継続・古参度",
    category: "longTerm",
    score: round1(score),
    weight,
    reason,
    detail: {
      rawVeteran: round1(rawVeteran),
      confidencePct: Math.round(obs.confidence * 100),
      assessable: obs.longTermAssessable ? 1 : 0,
      firstSeenAgeDays: obs.firstSeenAgeDays,
      observedWindowDays: obs.observedWindowDays,
      observedActiveDays: obs.observedActiveDays,
    },
  };
}

/**
 * 6) 連続実稼働ストリーク（長期軸）: 連続して実稼働日（その日に 1 件以上投稿）が
 *    続いた日数を、総合スコアに加点する独立シグナル。
 *
 * 入力 `streak.currentStreakDays` は heavy fetch とは別経路の軽量プローブ
 * （streak.ts）で **日ごとに活動有無だけを直接確認**して数えた連続日数。これを
 * 飽和カーブ `saturating(days, STREAK_FULL_DAYS)` で 0-100 に写す。早い段階で強く
 * 伸び、約 60 日で頭打ちになる（短期の活発さを過度に支配しないよう重みは控えめ）。
 *
 * 信頼度割引はしない（観測ウィンドウの長短ではなく、ストリーク経路が連続日を
 * **直接プローブで確認済み**だから）。総合スコアでは modest な固定重み（WEIGHTS.streak）
 * で重み付き平均に参加する。
 *
 * truncated（期限/プローブ失敗/任意の上限で途中打ち切り）のとき、`currentStreakDays` は
 * 「実際の連続日数の下限」である。saturating は単調増加なので、この下限から得た
 * スコアは過大主張ではなく **控えめな下限**として扱える（真の値はこれ以上）。
 * したがって既知の長いストリークは高く出つつ、正確な天井は断定しない（reason に「≥」と明示）。
 */
export function streakRetentionSignal(
  streak: StreakInfo,
  weight: number,
): SignalScore {
  const days = Math.max(0, streak.currentStreakDays);
  const score = saturating(days, STREAK_FULL_DAYS);

  // truncated のときは下限であることを「≥」で明示し、正確な連続日数を主張しない。
  const ge = streak.truncated ? "≥" : "";
  const state =
    streak.daysSinceLastActive == null
      ? ""
      : streak.ongoing
        ? "継続中"
        : `${streak.daysSinceLastActive}日前に途切れ`;
  const trunc = streak.truncated
    ? "（途中打ち切り: 実際の連続日数はこれ以上＝下限として控えめに加点）"
    : "";
  const reason =
    days === 0
      ? "連続実稼働日数 0 日（直近に連続した実稼働がありません）。連続日数が伸びるほど総合スコアに加点されます。"
      : `連続実稼働 ${ge}${days}日${state ? `（${state}）` : ""}。` +
        `約 ${STREAK_FULL_DAYS} 日で頭打ちの飽和加点として総合スコアに反映します。${trunc}`;

  return {
    key: "streakRetention",
    label: "連続実稼働",
    category: "longTerm",
    score: round1(score),
    weight,
    reason,
    detail: {
      currentStreakDays: days,
      fullDays: STREAK_FULL_DAYS,
      ongoing: streak.ongoing ? 1 : 0,
      truncated: streak.truncated ? 1 : 0,
      daysSinceLastActive: streak.daysSinceLastActive ?? -1,
    },
  };
}

