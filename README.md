# nostr-haijin-checker 💀

Nostr の公開投稿パターンから、その人の **「廃人度（Haijin score）」** を
**説明可能（explainable）なロジック**で 0〜100 点で採点する CLI ツールです。

> 「廃人（はいじん）」＝ ここでは *Nostr に時間を溶かしているヘビーユーザー* を
> 面白がるためのネットスラング。本ツールは娯楽・自己診断目的の MVP であり、
> 医学的・心理学的な依存度判定ではありません。

`npub` を 1 つ渡すと、複数リレーから投稿を取得し、

- 投稿頻度
- 深夜投稿率
- 連投（バースト）傾向
- 交流密度（リプライ・リアクション・リポスト）
- 継続性（毎日投稿しているか・連続日数）

の 5 シグナルを採点し、**総合スコア・ランク・各スコアの根拠** を出力します。

---

## 特徴

- **説明可能**: すべてのスコアに「なぜその点数なのか」の根拠（reason）が付きます。
- **ローカル完結**: リレーへ直接 WebSocket 接続。API キーやサーバー不要。
- **モジュール分離**: 取得（`src/nostr/`）と採点（`src/scoring/`）が独立。
  将来の Web / LLM 連携で採点ロジックをそのまま再利用できます。
- **JSON 出力**: `--json` でプログラム連携可能。

---

## 必要環境

- Node.js **18 以上**（開発・動作確認は Node 22 / npm 10）
- インターネット接続（Nostr リレーへの WebSocket 接続）

---

## セットアップ

```bash
# 依存をインストール
npm install

# ビルド（dist/ に出力）
npm run build
```

開発時はビルド不要で `tsx` から直接実行できます:

```bash
npm run dev -- <npub>
```

---

## 使い方

### 基本

```bash
# ビルド後（推奨）
node dist/index.js <npub>

# もしくは開発実行
npm run dev -- <npub>
```

`<npub>` は `npub1...` 形式、または 64 桁の hex 公開鍵を受け付けます。

### オプション

| オプション | 説明 | デフォルト |
| --- | --- | --- |
| `-l, --limit <n>` | リレーから取得する最大イベント数（リレーごとの上限） | `500` |
| `-r, --relays <urls>` | カンマ区切りのリレー URL。未指定ならデフォルト一式 | （内蔵5リレー） |
| `-t, --tz <hours>` | 深夜判定に使う UTC オフセット（時間） | `9`（JST） |
| `--late-start <hour>` | 深夜帯の開始時刻 (0-23) | `0` |
| `--late-end <hour>` | 深夜帯の終了時刻 (0-24, 含まない) | `5` |
| `--timeout <ms>` | 取得タイムアウト（ミリ秒） | `8000` |
| `--json` | JSON で出力 | off |
| `-h, --help` | ヘルプ表示 | |
| `-V, --version` | バージョン表示 | |

### デフォルトのリレー

`src/nostr/relays.ts` で定義。`--relays` で上書き可能です。

```
wss://relay.damus.io
wss://nos.lol
wss://yabu.me               (日本語ユーザーが多い)
wss://relay.nostr.wirednet.jp
wss://r.kojira.io
wss://x.kojira.io
wss://relay-jp.nostr.wirednet.jp
```

---

## 採点ロジック（スコアリング）

総合スコアは 5 シグナルの **重み付き合計**（0〜100）です。

| シグナル | 重み | 何を見るか | 100点の目安 |
| --- | --- | --- | --- |
| 投稿頻度 (`frequency`) | 30% | 観測期間あたりの 1 日平均投稿数 | 約 25 件/日 |
| 継続性 (`consistency`) | 20% | 稼働日率（×0.8）＋最長連続日数（×0.2） | ほぼ毎日＋20日連続 |
| 深夜投稿率 (`lateNight`) | 20% | 深夜帯（既定 0–5 時 JST）の投稿割合 | 全体の 30% 以上 |
| 連投傾向 (`bursts`) | 15% | 連投（5 件以上を 120 秒以内）に含まれる投稿割合 | 全体の 40% 以上 |
| 交流密度 (`engagement`) | 15% | リプライ＋リアクション＋リポストの割合 | 全体の 60% 以上 |

### 各シグナルの正規化

- **投稿頻度** は飽和カーブ
  `score = 100 · log10(1 + 件/日) / log10(1 + 25)` を使用。
  1 件目のインパクトが大きく、廃人帯（高頻度）でも差が残ります。
- **深夜・連投・交流** は「目安割合に対する比率 × 100」を 0〜100 にクランプ。
- **継続性** は `稼働日率 × 100 × 0.8 + min(100, 最長連続日数 × 5) × 0.2`。

> 飽和・クランプの実装は `src/scoring/signals.ts`、重みと合算は
> `src/scoring/index.ts`（`WEIGHTS`）にあります。閾値はすべてコード上の定数で、
> 調整しやすいようにしています。

### ランク

総合スコアを以下の段階にマッピングします（`src/scoring/rank.ts`）。

| スコア | ランク |
| --- | --- |
| 85–100 | 💀 完全体廃人 |
| 70–84 | 🔥 廃人 |
| 55–69 | ⚡ ヘビーユーザー |
| 40–54 | 🌱 アクティブ |
| 20–39 | 🍵 ライトユーザー |
| 0–19 | 😴 ROM専・休眠 |

### 取得するイベント種別 (kind)

- `kind 1` … テキスト投稿（`e` タグ付きはリプライ扱い）
- `kind 6` … リポスト
- `kind 7` … リアクション

---

## サンプル実行

実在ユーザー（fiatjaf）を採点した例:

```bash
$ node dist/index.js npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6 --limit 300
```

```
=== Nostr 廃人度チェック ===
npub: npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6
観測: 787 件 / 2023-05-22 23:27Z 〜 2026-06-06 22:50Z (JST)

総合スコア: 48 / 100
ランク: 🌱 アクティブ
        そこそこ活発。健全な距離感。

内訳（根拠）:
  投稿頻度　　 ███░░░░░░░░░░░░░░░░░  16 (重み 30%)
         観測 1111 日で 787 件 → 約 0.7 件/日。
  継続性　　　 ████████░░░░░░░░░░░░  40 (重み 20%)
         観測 1112 日中 312 日投稿（稼働率 28%、最長 18 日連続）。
  深夜投稿率　 ████████████████████ 100 (重み 20%)
         JST 0-5時の投稿が 236 件（全体の 30%）。
  連投傾向　　 ░░░░░░░░░░░░░░░░░░░░   0 (重み 15%)
         5件以上を120秒以内に投稿した「連投」が 0 回（連投に含まれる投稿 0 件 / 0%）。
  交流密度　　 ████████████████████ 100 (重み 15%)
         リプライ 425 / リアクション 57 / リポスト 47（全体の 67% が他者への反応）。

注意:
  - 取得はリレー側の保持期間・件数制限に依存します。実際の活動の一部しか観測できていない可能性があります。
```

> 注: `--limit` は **リレーごと** の上限です。複数リレーから取得して id で
> 重複排除するため、実際の取得件数は limit を超えることがあります。

### JSON 出力

```bash
$ node dist/index.js <npub> --json
```

```json
{
  "npub": "npub1...",
  "pubkeyHex": "3bf0c63f...",
  "totalScore": 47,
  "rank": { "label": "アクティブ", "emoji": "🌱", "min": 40, "description": "..." },
  "signals": [
    {
      "key": "frequency",
      "label": "投稿頻度",
      "score": 14.6,
      "weight": 0.3,
      "reason": "観測 969.1 日で 589 件 → 約 0.6 件/日。",
      "detail": { "perDay": 0.6, "totalEvents": 589, "days": 969.1 }
    }
  ],
  "sampleSize": 589,
  "windowStart": 1684787220,
  "windowEnd": 1749211800,
  "timezone": "JST",
  "notes": ["..."]
}
```

---

## Web 版（ブラウザ / GitHub Pages）

CLI と **同じ採点ロジック**（`src/scoring/`）をそのまま使う静的フロントエンドを
同梱しています。ブラウザで `npub` を入力すると、リレーへ直接接続して
総合スコア・ランク・各シグナルの根拠を表示します。**サーバー不要・完全静的**で、
GitHub Pages にそのままデプロイできます。

> 取得は CLI と同じ `src/nostr/` を再利用しますが、WebSocket 実装だけを
> 環境ごとに差し替えています（Node は `ws`、ブラウザはネイティブ `WebSocket`）。
> 共通の取得ロジックは `src/nostr/query.ts` に集約し、
> `fetch.ts`（Node）/ `fetch.browser.ts`（ブラウザ）が薄くラップしています。

### ローカルで起動

```bash
npm install
npm run web:dev      # Vite 開発サーバー（http://localhost:5173）
```

本番ビルドの確認:

```bash
npm run web:build    # dist-web/ に静的ファイルを出力
npm run web:preview  # ビルド結果をローカル配信して確認
```

### GitHub Pages へデプロイ

#### 方法 A: GitHub Actions（推奨・自動）

本リポジトリには `.github/workflows/deploy-pages.yml` を同梱しています。

1. GitHub でリポジトリの **Settings → Pages** を開く。
2. **Build and deployment → Source** を **「GitHub Actions」** に設定する。
3. `main` ブランチに push する（または Actions タブから手動実行）。
4. ワークフローが `npm run web:build` を実行し、`dist-web/` を Pages に公開します。
   公開 URL は `https://<ユーザー名>.github.io/<リポジトリ名>/` です。

> アセットは相対パス（`vite.config.ts` の `base: "./"`）で出力するため、
> リポジトリ名やサブパスに依存せずそのまま動作します。

#### 方法 B: 手動デプロイ

```bash
npm run web:build
# dist-web/ の中身を gh-pages ブランチや任意の静的ホスティングへ配置
```

### ブラウザ直アクセスの制約（重要）

ブラウザから直接リレーへ接続するため、CLI には無い制約があります
（UI 内にも明記しています）。

- **`wss://` のみ利用可**。GitHub Pages は HTTPS 配信のため、`ws://`（非暗号）の
  リレーは Mixed Content ポリシーでブロックされます。UI 側でも `wss://` 以外は弾きます。
- **リレーの接続ポリシー次第で接続不可**。一部リレーが拒否・無応答だと観測範囲が
  狭まり、CLI より取得件数が少なくなることがあります（スコアは観測範囲の近似値）。
- **取得件数・保持期間はリレー依存**。古い投稿は取得できないことがあります。
- 採点ロジック自体は CLI と完全に同一です。差が出るのは「取得できた範囲」だけです。

---

## プロジェクト構成

```
nostr-haijin-checker/
├── index.html              # Web 版エントリ（Vite）
├── src/
│   ├── index.ts            # CLI エントリ（引数→取得→採点→出力のつなぎ込み）
│   ├── report.ts           # 人間向けテキスト整形（ANSI色・CLI用）
│   ├── types.ts            # 共通ドメイン型
│   ├── nostr/              # ── データ取得層 ──
│   │   ├── query.ts        #   取得の中核ロジック（環境非依存・ws非依存）
│   │   ├── fetch.ts        #   Node 用ラッパ（ws を注入）
│   │   ├── fetch.browser.ts#   ブラウザ用ラッパ（ネイティブ WebSocket）
│   │   ├── npub.ts         #   npub <-> hex 変換
│   │   └── relays.ts       #   デフォルトリレー（CLI/Web 共通）
│   ├── scoring/            # ── 採点層（取得に非依存・CLI/Web で再利用） ──
│   │   ├── index.ts        #   オーケストレーション・重み・総合スコア
│   │   ├── prepare.ts      #   生イベント→分析用イベント（TZ補正）
│   │   ├── signals.ts      #   5 シグナルの算出ロジック
│   │   └── rank.ts         #   スコア→ランク
│   └── web/               # ── Web フロント ──
│       ├── main.ts         #   入力→取得→採点→DOM 描画
│       └── style.css       #   スタイル
├── test/
│   └── smoke.test.ts       # ネットワーク不要のスモークテスト（合成データ）
├── .github/workflows/
│   └── deploy-pages.yml    # GitHub Pages 自動デプロイ
├── vite.config.ts          # Web ビルド設定（出力 dist-web/、base "./"）
├── tsconfig.json           # CLI 用（src/web を除外）
├── tsconfig.web.json       # Web 用（DOM lib 込み・型チェック）
├── package.json
└── README.md
```

### npm スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | CLI を TypeScript から `dist/` にビルド |
| `npm run dev -- <npub>` | `tsx` でビルド不要の直接実行（CLI） |
| `npm start -- <npub>` | ビルド済み `dist/index.js` を実行（CLI） |
| `npm run typecheck` | CLI の型チェックのみ（出力なし） |
| `npm test` | スモークテスト（`node --test` + `tsx`） |
| `npm run web:dev` | Web 開発サーバー（Vite） |
| `npm run web:build` | Web を `dist-web/` に静的ビルド |
| `npm run web:preview` | ビルド済み Web をローカル配信 |
| `npm run web:typecheck` | Web の型チェックのみ（DOM lib 込み） |
| `npm run clean` | `dist/` と `dist-web/` を削除 |

---

## 制約・限界 (Limitations)

- **観測できるのは公開イベントの一部だけ**。リレーごとの保持期間・件数制限に
  依存し、古い投稿や別リレーの投稿は取得できないことがあります。
  → スコアは「観測できた範囲」に対する近似値です。
- **頻度は観測ウィンドウ全体の平均**。直近で活発でも、過去に長い空白があると
  1 日平均は下がります（`frequency` が低めに出る要因）。
- **タイムゾーンは固定オフセット**（既定 JST=UTC+9）。ユーザーの実際の生活時間帯や
  サマータイムは考慮しません。`--tz` で調整してください。
- **リアクション/リポストの取得網羅性はリレー依存**。交流密度は過小評価され得ます。
- **「リプライ」判定は `e` タグの有無のみ**（NIP-10 のマーカー種別までは見ない簡易版）。
- **サンプルが少ない（<30件）と信頼度が低い**旨を `notes` で警告します。
- 娯楽・自己診断向けの MVP です。**精度より「動くこと・説明できること」を優先**しています。

---

## 今後の拡張余地（設計意図）

採点層（`src/scoring/`）は Nostr 取得に依存しない純粋なデータ→スコア変換として
切り出してあります。これにより:

- **Web フロント**: ✅ 実装済み（`src/web/`）。同じ採点層をブラウザでそのまま再利用し、
  GitHub Pages に静的デプロイできます。
- **LLM 連携**: `reason` 群を要約・コメント生成のプロンプト材料に利用可能。
- **シグナル追加**: `signals.ts` に関数を足し `WEIGHTS` に重みを追加するだけ。
  → CLI・Web の両方に自動で反映されます。

---

## ライセンス

MIT
