import { defineConfig } from "vite";

/**
 * Web フロント（GitHub Pages 配信用）のビルド設定。
 *
 * - root はプロジェクト直下（index.html がエントリ）。
 * - CLI の `dist/` と衝突しないよう、出力は `dist-web/` に分離。
 * - base: "./" で **相対パス** のアセット参照にする。これにより
 *   GitHub Pages のプロジェクトページ（https://user.github.io/<repo>/）でも
 *   リポジトリ名に依存せずそのまま動く。
 */
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
  },
});
