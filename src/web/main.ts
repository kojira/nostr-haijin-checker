/**
 * Web フロントエンドのエントリ。
 *
 * 役割は CLI の index.ts と同じく「入力 → 取得 → 採点 → 表示」のつなぎ込み。
 * 取得は **ブラウザ用** の fetch.browser.ts（ネイティブ WebSocket）を使い、
 * 採点・npub 変換・ランクは CLI とまったく同じモジュールを再利用する。
 */
import "./style.css";
import {
  fetchUserEvents,
  lookupUserStreak,
  type FetchProgress,
} from "../nostr/fetch.browser.js";
import { DEFAULT_RELAYS } from "../nostr/relays.js";
import { InvalidNpubError, toNpub, toPubkeyHex } from "../nostr/npub.js";
import { DEFAULT_CONFIG, scoreEvents } from "../scoring/index.js";
import {
  ANALYSIS_STAGE_LABELS,
  WORKFLOW_PHASE_LABELS,
  type AnalysisProgress,
  type RelayStat,
  type ScoreResult,
  type ScoringConfig,
  type SignalScore,
  type StreakInfo,
  type WorkflowPhase,
} from "../types.js";

/**
 * NIP-07 で拡張機能が `window.nostr` に注入する API（必要分だけ型付け）。
 * 採点には公開鍵だけ使うので `getPublicKey()` のみ参照する。
 */
interface Nip07 {
  getPublicKey(): Promise<string>;
}
declare global {
  interface Window {
    nostr?: Nip07;
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element not found: #${id}`);
  return el as T;
};

const form = $<HTMLFormElement>("form");
const npubInput = $<HTMLInputElement>("npub");
const relaysInput = $<HTMLTextAreaElement>("relays");
const denseThresholdInput = $<HTMLInputElement>("denseThreshold");
const maxWindowsInput = $<HTMLInputElement>("maxWindows");
const tzInput = $<HTMLInputElement>("tz");
const windowTimeoutInput = $<HTMLInputElement>("windowTimeout");
const relayTimeoutInput = $<HTMLInputElement>("relayTimeout");
const overallTimeoutInput = $<HTMLInputElement>("overallTimeout");
const streakEnabledInput = $<HTMLInputElement>("streakEnabled");
const submitBtn = $<HTMLButtonElement>("submit");
const nip07Btn = $<HTMLButtonElement>("nip07");
const statusEl = $<HTMLParagraphElement>("status");
const progressEl = $<HTMLElement>("progress");
const resultEl = $<HTMLElement>("result");

// 既定リレーを textarea に流し込む（wss:// のみ）。
relaysInput.value = DEFAULT_RELAYS.join("\n");

// URL の ?npub=... があれば初期値に。共有 URL からの再採点に便利。
const params = new URLSearchParams(location.search);
const npubParam = params.get("npub");
if (npubParam) npubInput.value = npubParam.trim();

function setBusy(busy: boolean, message = ""): void {
  submitBtn.disabled = busy;
  nip07Btn.disabled = busy;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", false);
}

function setError(message: string): void {
  submitBtn.disabled = false;
  nip07Btn.disabled = false;
  statusEl.textContent = message;
  statusEl.classList.add("error");
}

function parseRelays(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((r) => r.trim())
    .filter(Boolean);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const npubRaw = npubInput.value.trim();
  if (!npubRaw) {
    setError("npub を入力してください。");
    return;
  }

  let pubkeyHex: string;
  let npub: string;
  try {
    pubkeyHex = toPubkeyHex(npubRaw);
    npub = npubRaw.startsWith("npub1") ? npubRaw : toNpub(pubkeyHex);
  } catch (err) {
    if (err instanceof InvalidNpubError) {
      setError("npub のデコードに失敗しました。npub1... または 64桁 hex を入力してください。");
    } else {
      setError("npub の解析に失敗しました。");
    }
    return;
  }

  await runCheck(pubkeyHex, npub);
});

// NIP-07: ブラウザ拡張（window.nostr）から公開鍵を取得して、手入力なしで採点する。
nip07Btn.addEventListener("click", async () => {
  if (!window.nostr || typeof window.nostr.getPublicKey !== "function") {
    setError(
      "NIP-07 対応の拡張機能（nos2x / Alby など）が見つかりません。導入後に再度お試しいただくか、npub を直接入力してください。",
    );
    return;
  }

  setBusy(true, "拡張機能から公開鍵を取得中...");

  let pubkeyHex: string;
  let npub: string;
  try {
    pubkeyHex = toPubkeyHex(await window.nostr.getPublicKey());
    npub = toNpub(pubkeyHex);
  } catch (err) {
    setError(
      `NIP-07 での公開鍵取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // 取得した npub を入力欄にも反映しておく（再採点・共有 URL のため）。
  npubInput.value = npub;
  await runCheck(pubkeyHex, npub);
});

// 公開鍵が確定したあとの共通フロー（手入力 / NIP-07 の両方から呼ばれる）。
async function runCheck(pubkeyHex: string, npub: string): Promise<void> {
  resultEl.hidden = true;
  resultEl.innerHTML = "";
  progressEl.hidden = true;
  progressEl.innerHTML = "";

  const relays = parseRelays(relaysInput.value);
  if (relays.length === 0) {
    setError("リレーを 1 つ以上指定してください。");
    return;
  }
  const nonWss = relays.filter((r) => !r.startsWith("wss://"));
  if (nonWss.length > 0) {
    setError(
      `wss:// のリレーのみ利用できます。除外: ${nonWss.join(", ")}`,
    );
    return;
  }

  const denseThreshold = clampNum(Number(denseThresholdInput.value), 50, 5000, 1000);
  const maxWindows = clampNum(Number(maxWindowsInput.value), 1, 20000, 5000);
  // タイムアウトは責務ごとに分割（グローバルな一括停止ではない）。
  const windowTimeoutMs = clampNum(Number(windowTimeoutInput.value), 2000, 120000, 30000);
  const relayTimeoutMs = clampNum(Number(relayTimeoutInput.value), 5000, 600000, 120000);
  // 全体安全上限は 0=無効を許す（min を 0 にする）。
  const overallTimeoutMs = clampNum(Number(overallTimeoutInput.value), 0, 1800000, 0);
  const tz = clampNum(Number(tzInput.value), -12, 14, 9);
  // ストリーク（連続実稼働日数）は全件取得とは別経路の軽量ルックアップ。
  const streakEnabled = streakEnabledInput.checked;

  const config: ScoringConfig = {
    ...DEFAULT_CONFIG,
    tzOffsetHours: tz,
    // JST 以外を選んだ場合もラベルだけは offset 表記にしておく。
    timezoneLabel: tz === 9 ? "JST" : `UTC${tz >= 0 ? "+" : ""}${tz}`,
  };

  // 共有しやすいよう URL を更新（履歴は汚さない）。
  const url = new URL(location.href);
  url.searchParams.set("npub", npub);
  history.replaceState(null, "", url.toString());

  // ストリークを実行する場合のみフェーズ・ステッパーに「ストリーク確認中」を出す。
  includeStreakStep = streakEnabled;

  setBusy(
    true,
    `リレーへ問い合わせ中...（${relays.length} relays）`,
  );

  try {
    const { events, meta } = await fetchUserEvents(pubkeyHex, {
      relays,
      denseThreshold,
      maxWindows,
      windowTimeoutMs,
      relayTimeoutMs,
      overallTimeoutMs,
      // 取得の途中経過をライブ表示する（リレー応答数・件数・遡れた最古など）。
      onProgress: (p) => renderProgress(p),
    });

    // ── ストリーク（連続実稼働日数）は全件取得とは別経路の軽量ルックアップ ──
    // 日ごとに最新 1 件だけを遡って「その日に投稿があったか」を数える。取得経路は独立だが、
    // 得られた連続日数は scoreEvents 内で「連続実稼働」シグナル（長期軸・重み 12%）として
    // 総合スコアに加点される。失敗しても採点本体は止めない（streak=null のまま）。
    const nowSec = Math.floor(Date.now() / 1000);
    let streak: StreakInfo | null = null;
    if (streakEnabled) {
      setBusy(true, "連続実稼働日数（ストリーク）を確認中…");
      renderPhasePanel("streak", streakPhaseBodyHtml());
      await nextFrame();
      try {
        streak = await lookupUserStreak(pubkeyHex, {
          relays,
          tzOffsetHours: tz,
          nowUnix: nowSec,
        });
      } catch (err) {
        // ストリークは別経路の任意シグナル。失敗しても採点は継続（streak=null＝加点なしのまま）。
        console.warn("streak lookup failed:", err);
      }
    }

    // ── 解析（採点）フェーズ ──
    // scoreEvents は同期処理なので、まず「解析中」パネルを描画して 1 フレーム譲り、
    // 利用者にフェーズの切り替わりを見せてから重い処理に入る。巨大データセットでも
    // フェーズ・ステッパーの「現フェーズ」ドットが（コンポジタ駆動の CSS アニメで）
    // 脈打ち続けるため、固まって見えない。onProgress 未指定なら従来どおり通知しない。
    setBusy(true, "解析中…（取得後のスコアリング）");
    renderPhasePanel(
      "analyzing",
      analysisPhaseBodyHtml({ stage: "prepare", processed: 0, total: events.length }),
    );
    await nextFrame();
    const result = scoreEvents(
      npub,
      pubkeyHex,
      events,
      config,
      nowSec,
      meta,
      streak,
      (p) => renderPhasePanel("analyzing", analysisPhaseBodyHtml(p)),
    );

    // ── 描画準備フェーズ ── 大きな結果を整形・DOM 構築する直前にフェーズを見せる。
    setBusy(true, "描画準備中…");
    renderPhasePanel("rendering", renderingPhaseBodyHtml(result));
    await nextFrame();
    renderResult(result);
    // 全フェーズ完了をステッパーに反映する（現フェーズの脈動を止める）。
    renderPhasePanel(null, donePhaseBodyHtml(result));
    const dug = meta.historyComplete
      ? "リレーが返す限界まで到達"
      : `掘り切れず（${meta.stopReason}）`;
    const failPart =
      meta.relaysFailed > 0 ? `・失敗 ${meta.relaysFailed} リレー` : "";
    setBusy(
      false,
      `完了: ${result.sampleSize} 件を採点（応答 ${meta.relaysSucceeded}/${meta.relaysQueried} リレー${failPart}・${meta.pagesFetched} ウィンドウ・履歴 ${dug}）。`,
    );
  } catch (err) {
    console.error(err);
    setError(
      `取得中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** リレー状態 → 表示ラベル＆装飾クラス。 */
const RELAY_STATUS_VIEW: Record<RelayStat["status"], { label: string; cls: string }> = {
  pending: { label: "待機", cls: "rs-pending" },
  querying: { label: "取得中…", cls: "rs-active" },
  ok: { label: "完了", cls: "rs-ok" },
  empty: { label: "投稿なし", cls: "rs-empty" },
  maxWindows: { label: "ウィンドウ上限", cls: "rs-ok" },
  failed: { label: "接続失敗", cls: "rs-fail" },
  timeout: { label: "時間切れ", cls: "rs-fail" },
};

/** 次の描画フレームまで待つ（同期処理の前に画面を 1 度更新させるため）。 */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** このフローでストリーク確認フェーズを表示するか（無効時はステッパーから省く）。 */
let includeStreakStep = true;

/** フェーズ・ステッパーに並べるトップレベル・フェーズの順序。 */
const PHASE_ORDER: WorkflowPhase[] = [
  "fetching",
  "streak",
  "analyzing",
  "rendering",
];

/**
 * 4 フェーズ（取得中 / ストリーク確認中 / 解析中 / 描画準備中）のステッパー HTML。
 * active が現フェーズ（null は全完了）。完了済みは ✓、現フェーズはドットが脈打つ。
 * これにより、解析のような同期処理でメインスレッドが詰まっていても、コンポジタ駆動の
 * CSS アニメーションでドットが動き続け、「固まっていない」ことが伝わる。
 */
function phaseStepperHtml(active: WorkflowPhase | null): string {
  const steps = PHASE_ORDER.filter(
    (p) => includeStreakStep || p !== "streak",
  );
  const activeIdx = active ? steps.indexOf(active) : steps.length;
  const items = steps
    .map((p, i) => {
      const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
      return `<li class="phase-step phase-${state}">
        <span class="phase-dot" aria-hidden="true"></span>
        <span class="phase-name">${escapeHtml(WORKFLOW_PHASE_LABELS[p])}</span>
      </li>`;
    })
    .join("");
  return `<ol class="phase-steps">${items}</ol>`;
}

/** フェーズ・ステッパー＋フェーズ固有の本文を進捗パネルに描画する共通関数。 */
function renderPhasePanel(active: WorkflowPhase | null, bodyHtml: string): void {
  progressEl.hidden = false;
  progressEl.innerHTML = phaseStepperHtml(active) + bodyHtml;
}

/**
 * 取得フェーズの本文 HTML。「いま何件・どのリレーがどこまで・どこまで遡れたか」を数値で見せる。
 */
function fetchPhaseBodyHtml(p: FetchProgress): string {
  const done = p.phase === "done";
  const oldest = fmtDate(p.oldestReached);
  const elapsed = (p.elapsedMs / 1000).toFixed(1);

  const relayRows = p.relays
    .map((r) => {
      const view = RELAY_STATUS_VIEW[r.status];
      const meta =
        r.events > 0 ? `${r.events} 件 / ${r.pages} ウィンドウ` : `${r.pages} ウィンドウ`;
      return `<li class="relay-item ${view.cls}">
        <span class="relay-host">${escapeHtml(shortRelay(r.url))}</span>
        <span class="relay-status">${escapeHtml(view.label)}</span>
        <span class="relay-meta">${escapeHtml(meta)}</span>
      </li>`;
    })
    .join("");

  return `
    <h2 class="progress-title">${done ? "取得完了" : "リレーから取得中…"}</h2>
    <div class="progress-grid">
      <div class="pg-cell"><span class="pg-num">${p.collectedUnique}</span><span class="pg-lbl">取得イベント</span></div>
      <div class="pg-cell"><span class="pg-num">${p.relaysSucceeded}/${p.relaysTotal}</span><span class="pg-lbl">応答リレー</span></div>
      <div class="pg-cell"><span class="pg-num${p.relaysFailed > 0 ? " pg-warn" : ""}">${p.relaysFailed}</span><span class="pg-lbl">失敗リレー</span></div>
      <div class="pg-cell"><span class="pg-num">${p.pagesFetched}</span><span class="pg-lbl">取得ウィンドウ</span></div>
    </div>
    <p class="pg-oldest">ここまで遡れた最古: <b>${escapeHtml(oldest)}</b> ・ 経過 ${elapsed}s ・ 完了 ${p.relaysCompleted}/${p.relaysTotal} リレー</p>
    <ul class="relay-list">${relayRows}</ul>
  `;
}

/** ストリーク確認フェーズの本文（別経路の軽量ルックアップ中であることを示す）。 */
function streakPhaseBodyHtml(): string {
  return `
    <h2 class="progress-title">連続実稼働日数（ストリーク）を確認中…</h2>
    <p class="pg-oldest">全件取得とは別経路で、日ごとに「その日に投稿が 1 件でもあるか」だけを軽量に遡っています。</p>
  `;
}

/**
 * 解析（採点）フェーズの本文。件数で測れる prepare/aggregate は processed/total と
 * 進捗バーを、件数で測れない signals/finalize はステージ名（＝そのステージに入った合図）を見せる。
 */
function analysisPhaseBodyHtml(p: AnalysisProgress): string {
  const label = ANALYSIS_STAGE_LABELS[p.stage];
  const counted = p.stage === "prepare" || p.stage === "aggregate";
  const pct =
    counted && p.total > 0
      ? Math.min(100, Math.round((p.processed / p.total) * 100))
      : 100;
  const detail = counted
    ? `${p.processed.toLocaleString()} / ${p.total.toLocaleString()} 件`
    : `${p.total.toLocaleString()} 件`;
  return `
    <h2 class="progress-title">解析中…（${escapeHtml(label)}）</h2>
    <div class="progress-grid">
      <div class="pg-cell"><span class="pg-num">${p.total.toLocaleString()}</span><span class="pg-lbl">解析対象イベント</span></div>
      <div class="pg-cell"><span class="pg-num">${escapeHtml(label)}</span><span class="pg-lbl">現ステージ</span></div>
    </div>
    <p class="pg-oldest">処理済み <b>${escapeHtml(detail)}</b></p>
    <div class="bar analysis-bar"><div class="bar-fill" style="width:${pct}%"></div></div>
  `;
}

/** 描画準備フェーズの本文（採点完了→結果 DOM を構築する直前）。 */
function renderingPhaseBodyHtml(r: ScoreResult): string {
  return `
    <h2 class="progress-title">描画準備中…</h2>
    <p class="pg-oldest">${r.sampleSize.toLocaleString()} 件のスコアと内訳を整形しています。</p>
  `;
}

/** 全フェーズ完了時の本文（ステッパーは全 ✓・脈動なし）。 */
function donePhaseBodyHtml(r: ScoreResult): string {
  return `
    <h2 class="progress-title">完了</h2>
    <p class="pg-oldest">${r.sampleSize.toLocaleString()} 件を採点しました。</p>
  `;
}

/**
 * 取得の途中経過パネルを描画する。取得中も完了後も同じ関数で更新する。
 * フェーズ・ステッパー（取得中…）＋取得詳細を描く。
 */
function renderProgress(p: FetchProgress): void {
  renderPhasePanel("fetching", fetchPhaseBodyHtml(p));
}

/** リレー URL を短く（ホスト名相当）表示する。 */
function shortRelay(url: string): string {
  return url.replace(/^wss?:\/\//, "").replace(/\/+$/, "");
}

function clampNum(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function fmtDate(sec: number | null): string {
  if (sec == null) return "-";
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** 取得（タイムウィンドウ）の到達度を 1 行で表す（履歴が不完全なら警告色）。 */
function historyLineHtml(r: ScoreResult): string {
  const h = r.history;
  if (!h) return "";
  const label = h.historyComplete
    ? "リレーが返す限界まで到達"
    : `掘り切れず（${h.stopReason}）`;
  const cls = h.historyComplete ? "history-line" : "history-line history-warn";
  return `<span class="${cls}">取得 ${h.pagesFetched} ウィンドウ / ${h.relaysQueried} リレー ・ 履歴 ${escapeHtml(
    label,
  )}</span><br />`;
}

/**
 * ストリーク（連続実稼働日数）を 1 行で表す。取得は全件取得とは別経路（日ごとの有無で
 * 判定）であること、および連続日数が「連続実稼働」シグナルとして総合スコアに加点される
 * ことを併記し、利用者が効き方を誤解しないようにする。
 */
function streakLineHtml(s: StreakInfo | null): string {
  if (!s) return "";
  let body: string;
  if (s.currentStreakDays === 0) {
    body = "活動なし（直近に実稼働日が見つかりません）";
  } else {
    const state = s.ongoing
      ? "継続中"
      : `途切れ（${s.daysSinceLastActive ?? "?"}日前）`;
    const more = s.truncated ? " ・ 途中で打ち切り（さらに長い可能性／下限として加点）" : "";
    body = `<b>${s.currentStreakDays}</b> 日（${escapeHtml(state)}）・ 最新実稼働 ${escapeHtml(
      s.lastActiveDay ?? "-",
    )}${escapeHtml(more)} ・ 総合に加点（長期軸・重み12%）`;
  }
  const cls = s.ongoing ? "streak-line streak-on" : "streak-line";
  return `<span class="${cls}">連続実稼働: ${body}</span><br />`;
}

function renderResult(r: ScoreResult): void {
  resultEl.innerHTML = "";

  const obs = r.observation;
  const head = document.createElement("div");
  head.className = "card score-head";
  head.innerHTML = `
    <div class="score-big">
      <span class="score-num">${r.totalScore}</span><span class="score-den">/ 100</span>
    </div>
    <div class="rank">
      <span class="rank-emoji" aria-hidden="true">${r.rank.emoji}</span>
      <span class="rank-label">${escapeHtml(r.rank.label)}</span>
      <span class="rank-desc">${escapeHtml(r.rank.description)}</span>
    </div>
    <p class="observed">
      観測 ${r.sampleSize} 件 / ${fmtDate(r.windowStart)} 〜 ${fmtDate(r.windowEnd)}
      (${escapeHtml(r.timezone)})<br />
      観測ウィンドウ ${obs.observedWindowDays} 日 / 実稼働 ${obs.observedActiveDays} 日 /
      初観測から ${obs.firstSeenAgeDays} 日前 ・ 観測信頼度 ${Math.round(
        obs.confidence * 100,
      )}%<br />
      ${historyLineHtml(r)}
      ${streakLineHtml(r.streak)}
      <span class="npub-line">${escapeHtml(r.npub)}</span>
    </p>
  `;
  resultEl.appendChild(head);

  // ── 3 軸サブスコア（短期 / 長期 / 利用パターン）を分離して提示 ──
  const axesCard = document.createElement("div");
  axesCard.className = "card axes";
  const ah = document.createElement("h2");
  ah.textContent = "3 軸スコア";
  axesCard.appendChild(ah);
  axesCard.appendChild(
    axisRow("短期アクティブ度", "直近の観測ウィンドウ内での活発さ", r.subScores.shortTermActivity),
  );
  axesCard.appendChild(
    axisRow(
      "長期継続・古参度",
      obs.longTermAssessable
        ? "観測ウィンドウが十分にあり、長期の継続として評価できます。"
        : "短期の活発さを中心に評価しています。",
      r.subScores.longTermRetention,
      !obs.longTermAssessable,
    ),
  );
  axesCard.appendChild(
    axisRow("利用パターン", "常時稼働度（時間帯の広さ）・連投・交流の複合", r.subScores.usagePattern),
  );
  resultEl.appendChild(axesCard);

  // ── シグナル内訳（軸ごとにグルーピング） ──
  const groups: { title: string; category: SignalScore["category"] }[] = [
    { title: "短期アクティブ度", category: "shortTerm" },
    { title: "利用パターン", category: "pattern" },
    { title: "長期継続・古参度", category: "longTerm" },
  ];
  const signalsCard = document.createElement("div");
  signalsCard.className = "card signals";
  const h = document.createElement("h2");
  h.textContent = "内訳（根拠）";
  signalsCard.appendChild(h);
  for (const g of groups) {
    const inGroup = r.signals.filter((s) => s.category === g.category);
    if (inGroup.length === 0) continue;
    const gh = document.createElement("h3");
    gh.className = "signal-group";
    gh.textContent = g.title;
    signalsCard.appendChild(gh);
    for (const s of inGroup) signalsCard.appendChild(signalRow(s));
  }
  resultEl.appendChild(signalsCard);

  if (r.notes.length) {
    const notes = document.createElement("div");
    notes.className = "card notes-card";
    const nh = document.createElement("h2");
    nh.textContent = "注意";
    notes.appendChild(nh);
    const ul = document.createElement("ul");
    for (const n of r.notes) {
      const li = document.createElement("li");
      li.textContent = n;
      ul.appendChild(li);
    }
    notes.appendChild(ul);
    resultEl.appendChild(notes);
  }

  resultEl.hidden = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function axisRow(
  label: string,
  desc: string,
  score: number,
  lowConfidence = false,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "axis" + (lowConfidence ? " axis-low" : "");
  const pct = Math.round(score);
  row.innerHTML = `
    <div class="axis-top">
      <span class="axis-label">${escapeHtml(label)}</span>
      ${lowConfidence ? '<span class="axis-flag">短期中心</span>' : ""}
      <span class="axis-score">${pct}</span>
    </div>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    <p class="axis-desc">${escapeHtml(desc)}</p>
  `;
  return row;
}

function signalRow(s: SignalScore): HTMLElement {
  const row = document.createElement("div");
  row.className = "signal";
  const pct = Math.round(s.score);
  row.innerHTML = `
    <div class="signal-top">
      <span class="signal-label">${escapeHtml(s.label)}</span>
      <span class="signal-weight">重み ${Math.round(s.weight * 100)}%</span>
      <span class="signal-score">${pct}</span>
    </div>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    <p class="signal-reason">${escapeHtml(s.reason)}</p>
  `;
  return row;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
