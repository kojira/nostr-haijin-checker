/**
 * Web フロントエンドのエントリ。
 *
 * 役割は CLI の index.ts と同じく「入力 → 取得 → 採点 → 表示」のつなぎ込み。
 * 取得は **ブラウザ用** の fetch.browser.ts（ネイティブ WebSocket）を使い、
 * 採点・npub 変換・ランクは CLI とまったく同じモジュールを再利用する。
 */
import "./style.css";
import { fetchUserEvents } from "../nostr/fetch.browser.js";
import { DEFAULT_RELAYS } from "../nostr/relays.js";
import { InvalidNpubError, toNpub, toPubkeyHex } from "../nostr/npub.js";
import { DEFAULT_CONFIG, scoreEvents } from "../scoring/index.js";
import type { ScoreResult, ScoringConfig, SignalScore } from "../types.js";

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
const limitInput = $<HTMLInputElement>("limit");
const tzInput = $<HTMLInputElement>("tz");
const timeoutInput = $<HTMLInputElement>("timeout");
const submitBtn = $<HTMLButtonElement>("submit");
const nip07Btn = $<HTMLButtonElement>("nip07");
const statusEl = $<HTMLParagraphElement>("status");
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

  const relays = parseRelays(relaysInput.value);
  if (relays.length === 0) {
    setError("リレーを 1 つ以上指定してください。");
    return;
  }
  const nonWss = relays.filter((r) => !r.startsWith("wss://"));
  if (nonWss.length > 0) {
    setError(
      `wss:// のリレーのみ利用できます（HTTPS 配信のため）。除外: ${nonWss.join(", ")}`,
    );
    return;
  }

  const limit = clampNum(Number(limitInput.value), 1, 2000, 500);
  const timeoutMs = clampNum(Number(timeoutInput.value), 1000, 30000, 8000);
  const tz = clampNum(Number(tzInput.value), -12, 14, 9);

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

  setBusy(true, `リレーへ問い合わせ中... (${relays.length} relays, limit ${limit})`);

  try {
    const { events } = await fetchUserEvents(pubkeyHex, {
      relays,
      limit,
      timeoutMs,
    });
    const result = scoreEvents(npub, pubkeyHex, events, config);
    renderResult(result);
    setBusy(false, `完了: ${result.sampleSize} 件を採点しました。`);
  } catch (err) {
    console.error(err);
    setError(
      `取得中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function clampNum(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function fmtDate(sec: number | null): string {
  if (sec == null) return "-";
  return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
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
        : "観測ウィンドウが短いため評価を保留（low-confidence）。長期継続は主張しません。",
      r.subScores.longTermRetention,
      !obs.longTermAssessable,
    ),
  );
  axesCard.appendChild(
    axisRow("利用パターン", "深夜・連投・交流の複合（生活リズム）", r.subScores.usagePattern),
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
      ${lowConfidence ? '<span class="axis-flag">⚠ 観測不足</span>' : ""}
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
