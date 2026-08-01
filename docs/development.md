# 開発体制・テスト・オーケストレーション

**この文書は製品の差別化が何であれ必要なので、[review-2.md](review-2.md) の
差別化再定義と独立に今すぐ着手できます。**

方針: **エージェントが書いたコードは検証手段が無いと検証不能。
だから最初の機能コミットより前にテストハーネスと検証コマンドを立てる。**
（ご指摘の通りで、これは製品自身が解こうとしている「40個の fix tests コミット」問題と同じ構造です。）

---

## 0. 一番重要な発見: 参照製品は期待した形でテストしていない

**`eclipse-theia/theia-ide`（Theia IDE / Blueprint 製品）には `@theia/playwright` への参照が1つもありません。**
E2E は `applications/electron/test/app.spec.js` の**1ファイルだけ**で、
**WebdriverIO + mocha + chai を electron-builder でパッケージ済みのバイナリに対して**走らせ、
CI の4 OS レグで実行しています。
一方 `@theia/playwright` はフレームワーク側の**example パッケージ**（`examples/playwright`）で、
**どの Theia CI ワークフローも `USE_ELECTRON` を設定していない** —
つまり Playwright の Electron 経路は上流で一度も動いていません。

**帰結: Playwright は browser ターゲットに使う。Electron ターゲットで実証されている経路は
WDIO をパッケージ済みバイナリに当てること。両方用意し、
`@theia/playwright` の Electron モードが動く前提を置かない。**

---

## 1. Theia の4つのテスト層

独立に走らせられる層が4つあるのが構造上の要点です。

| 層 | ランナー | 場所 | 上流CIのカバー |
|---|---|---|---|
| **1. ユニット** | `nyc mocha` を**コンパイル済み `lib/**/*.spec.js`** に対して | パッケージ毎 | 3 OS × Node 22/24 |
| **2. API / 統合** | **実フロントエンド内で mocha**、`puppeteer-core` の headless Chrome | `examples/api-tests` | Linux+Win+macOS |
| **3. Electron ユニット** | `electron-mocha` を `lib/test/**/*.espec.js` に | `examples/electron` | **Linux のみ、`xvfb-run -a`** |
| **4. E2E / システム** | Playwright ページオブジェクト | `examples/playwright` | **ubuntu のみ、browser のみ** |

### 層1（ユニット）の実装方針

**Theia core の mocha + chai + sinon 規約を採る。Jest は採らない。**

理由が我々の状況に固有です: **エージェントはパターンマッチする。**
`@theia/core` は `*.spec.ts` の**ソースを意図的に同梱**していて
（「ドキュメントとしての目的も兼ねるので」）、**約90個のリポジトリ内・
スタイル一貫・Theia 慣用のテスト実例**をエージェントに与えられます。
公式ジェネレータが吐く Jest だと実例が2つになり、さらに
**Jest のグローバル jsdom 環境が Theia の意図的な opt-in `enableJSDOM()` の順序と喧嘩します。**

**ブラウザ依存コードは jsdom を opt-in で。** 約112ファイルがこの形:
```ts
import { enableJSDOM } from '@theia/core/lib/browser/test/jsdom';
let disableJSDOM = enableJSDOM();
// ...imports...
disableJSDOM();
// before() で再度有効化
```
⚠️ **`jsdom ^22` はルートの devDependencies にホイストされているだけで
`@theia/core` は宣言していないので、自分でインストールが必要。**

**DI のテストは `new Container()` + `ContainerModule`。** `keybinding.spec.ts` が正典。
⚠️ **`ContainerModule`/`Container` は `@theia/core/shared/inversify` から import する**
（素の `inversify` ではない）。Theia と同じ Inversify インスタンスに bind するため。

### 🚨 層1 の落とし穴: 必要なパッケージが未公開

| パッケージ | 状態 |
|---|---|
| `@theia/cli`, `@theia/application-manager`, `@theia/playwright`, `@theia/api-tests`, `@theia/bundle-plugin` | **公開** 1.74.0 |
| **`@theia/test-setup`, `@theia/ext-scripts`, `@theia/eslint-plugin`** | **`private: true`、npm で 404** |

**→ `test-setup.js`（約10行: `@theia/monaco-editor-core` の `.css` import 用 ESM ローダフック +
`global.DragEvent` のモック）を vendor し、`.mocharc.yml` を自分で書く。
`@theia/eslint-plugin` は消費不可なのでルールをコピーするか諦める。**

### 層2 の落とし穴2つ

**(a) `window.theia` への露出が必要で、ドキュメントが古い。**
`dev-packages/cli/README.md` は webpack の `expose-loader` で説明していますが、
**Theia 1.74 は esbuild 既定**で、露出は `@theia/bundle-plugin` の `exposeModulePlugin()` から来ます
（`examples/browser/esbuild.mjs` が `browserOptions.plugins` に明示的に push している）。
**自分の `esbuild.mjs` にこのプラグインを足さないと `theia test` がモジュールを見られません。**

**(b) 🚨 `theia test` に機械可読なレポータが無い。**
`test-page.ts` が `mocha.setup({ reporter: 'spec', ui: 'bdd', ... })` をハードコードしており、
**機械的な信号は終了コードだけ**（`process.exit(failures > 0 ? 1 : 0)`）。
エージェントに読ませたければ `test-page.ts` を fork するかカスタムレポータを注入する。工数に入れる。

### 🎁 タダで使える適合性スイート

**`examples/api-tests` は `@theia/api-tests@1.74.0` として公開されています** —
「アダプタが最終製品に対してテストを走らせられるように公開している」。
20 spec: `saveable`, `menus`, `keybindings`, `preferences`, `monaco-api`, `navigator`,
`explorer-open-close`, `file-search`, `find-replace`, `undo-redo-selectAll`, `views`,
`shell`, `scm`, `task-configurations`, `typescript` など。
**自分の製品に対して走らせれば無料の適合性テストになる。**

---

## 2. スモークスイートの設計

### `@theia/playwright` の実態

- **v1.74.0、`EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0`、公開済み、
  `lib` と `src` の両方を同梱。** 「Theia ベースアプリケーションのシステムテストを開発するための
  Playwright ベースのページオブジェクトフレームワーク。拡張可能」— **下流利用が明示的な設計。**
- **約35のページオブジェクト**: `TheiaApp`, `TheiaAppLoader`, `TheiaWorkspace`,
  `TheiaExplorerView`, `TheiaEditor`, `TheiaTextEditor`, `TheiaMonacoEditor`, `TheiaTerminal`,
  `TheiaQuickCommandPalette`, `TheiaMainMenu`, `TheiaContextMenu`, `TheiaDialog`,
  `TheiaPreferenceView`, `TheiaProblemView`, `TheiaOutputView`, `TheiaNotebookEditor`,
  `TheiaStatusBar`, `TheiaToolbar`, `TheiaTreeNode`, `TheiaWelcomeView` ほか
- **両ターゲットを1スイッチで:** `TheiaAppLoader.load()` が `process.env.USE_ELECTRON === 'true'` で分岐
- ⚠️ **ソース内の逐語コメント:** `// TODO this is just a sketch, we need a proper way to
  configure tests and pass this configuration to the TheiaAppLoader`。
  Electron 設定は暫定的で、しかも**パッケージ済みバイナリではなく未パッケージのアプリディレクトリ**を指す
- ⚠️ 下流テンプレート `eclipse-theia/theia-playwright-template` は
  **`@theia/playwright 1.47.1` / TypeScript ~4.5.5 / ESLint 8 ピンで最終実質コミットが 2024-03**。
  形の参考にするだけで依存のベースラインにしない

### 推奨スモークスイート（browser ターゲット、全PR、目標 4分未満）

| # | シナリオ | 何を証明するか |
|---|---|---|
| 1 | アプリがロードされ shell + main content panel が見える | バンドル、DIグラフ、バックエンド接続 |
| 2 | 準備したワークスペースを開き、エクスプローラに期待するツリーが出る | workspace service、FSプロバイダ |
| 3 | ファイルをエディタで開き1行目の内容を検証 | Monaco 起動、editor manager、リソース解決 |
| 4 | 入力→dirty、undo×2→clean、save→clean、閉じて再開→永続 | saveable ライフサイクル、FS書き込み |
| 5 | コマンドパレットからコマンド名で実行 | command registry、キーバインド、quick input |
| 6 | メニューバーを開きサブメニュー項目の存在を検証 | メニュー contribution |
| 7 | ターミナルビューが開き `.xterm` が見え、文字列をecho | **node-pty、process バックエンド** |
| 8 | ワークスペース検索が既知の文字列を見つける | **ripgrep ネイティブバイナリ** |
| 9 | 設定ビューを開き設定を変えて反映を検証 | preference service、JSONストレージ |
| 10 | Problems ビュー + ステータスバーが描画され、予期しない通知オーバーレイが無い | markers、status bar、安価なエラーカナリア |
| 11 | **自分の製品の主要カスタムビュー/エディタが開く** | 実際の差別化部分 |

**⭐ そして Theia のスイートに無い安価で高価値な検証を1つ足す:
`page.on('console')` / `page.on('pageerror')` で予期しないブラウザコンソールエラーがあれば失敗させる。
これ1つでエージェント起因のリグレッションの大きなクラスをほぼゼロコストで捕まえられます。**

### パッケージ済み Electron スモーク（nightly + リリース前、OS毎）

**theia-ide の6シナリオをそのまま採る。** 各々が「asar を生き延びたか」のカナリアとして選ばれています:

1. アプリ起動 — `#theia-app-shell` が15秒以内。workspace-trust ダイアログを閉じる
2. ウィンドウタイトルにワークスペース名が入る（workspace 解決 + title contribution）
3. **組み込み拡張がロードされる**（`Ctrl+Shift+X` → Builtin を展開 → 特定の名前を検証）
   = **asar 配下のプラグインスキャン**
4. **ワークスペース検索** = 失敗メッセージが *"Ripgrep may not be working correctly with asar packaging"*
5. クイックファイルオープン（`Ctrl+P`）
6. **統合ターミナル** = 失敗メッセージが *"PTY may not be working correctly with asar packaging"*

### フレーキー対策

**上流が実際にやっていること:** `configs/playwright.ci.config.ts` は
`workers: 1`, `fullyParallel: false`, `retries: 2`, `timeout: 30_000`,
`screenshot: 'only-on-failure'`, `preserveOutput: 'always'`。

**分離の中核はテスト毎のワークスペースフィクスチャ。3つ全部真似る:**
- `new TheiaWorkspace([path.resolve(__dirname, 'resources/sample-files1')])` が
  テスト毎に tmp ワークスペースをコピー
- `theia:start` が `rimraf .tmp.cfg` して `THEIA_CONFIG_DIR` を捨て用ディレクトリに向ける
- `run-test.ts` が各 API テスト実行前に `localStorage.clear()`

**Theia 公式の指針:** 「await を使っている限り、タイムアウトや待機関数は不要」。
`page.$` より `page.waitForSelector`。ページオブジェクトから Playwright の型を返さない。

🚨 **真似してはいけない反例: theia-ide の WDIO spec は全操作の前に
`await new Promise(r => setTimeout(r, 5000))` を置いています**
（「キーハンドラの登録を確実にするため」）。5テストで約25秒の固定sleep = 典型的なフレーク製造機。
**`expect.poll` / WDIO の `waitUntil` で観測可能な条件を待つ。**

**Playwright 1.62 のフレークツール:**
- **`--fail-on-flaky-tests`** ← 重要。`retries: 2` を保ったまま
  **リトライで通ったものをビルド失敗にできる**のでフレークが静かに溜まらない。nightly で使う
- `--forbid-only` ← **必ず有効化。エージェントは `test.only` を置き忘れる**
- `--repeat-each=N`（フレーク狩り）、`--last-failed`（エージェントの2周目に最適）、
  `--only-changed [ref]`、`--max-failures N` / `-x`（エージェント向けログを短く保つ）
- 組み込みの quarantine 機能は無い → `@quarantine` タグ + `--grep-invert` で自作

**方針:** PR → `retries: 1`, `workers: 1`, `-x`, JSON+github レポータ。
nightly → `--repeat-each=3 --fail-on-flaky-tests`。
トリップしたテストは `@quarantine` タグを付けて PR ゲートから除外し issue を立てる。**消さない。**

---

## 3. エージェントが自己検証できるようにする

### `scripts/verify.mjs` — エージェントが呼ぶ唯一のコマンド

```
typecheck → unit → browser smoke
```
を順に走らせ、**Playwright の `--reporter=json` を読んで20行以内の要約を出す**:
件数、失敗毎に `file:line` / テスト名 / エラー先頭3行 / trace パス。

**エージェントに生のレポータを読ませない。** `-x` / `--max-failures=3` と組み合わせて
壊れたビルドが200件の失敗を吐かないようにする。

```bash
PLAYWRIGHT_JSON_OUTPUT_NAME=results.json npx playwright test --reporter=json
```

### hooks: スモークは `Stop`、`PostToolUse` ではない

| イベント | 適否 |
|---|---|
| **`Stop`** | **✅ これを使う。** Claude の最終応答後、編集が完了して整合した時点で発火。**終了コード 2 でターンをブロックし stderr をモデルに返すので、エージェントが自分で直す** |
| `PostToolUse(Edit\|Write)` | ファイル毎にタスク中途で発火。1ファイルの `tsc --noEmit` や Prettier には良いが**スイートには無駄**（何十回も走る） |
| `SubagentStop` | サブエージェントのみ。メインセッションの編集を取りこぼす |

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{
      "type": "command",
      "command": "node ${CLAUDE_PROJECT_DIR}/scripts/verify.mjs",
      "timeout": 420
    }]}],
    "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{
      "type": "command",
      "command": "node ${CLAUDE_PROJECT_DIR}/node_modules/typescript/bin/tsc --noEmit -p .",
      "timeout": 120
    }]}]
  }
}
```

⚠️ **ループ安全性:** 連続ブロックには上限があるが、それでも
**hook は安価かつ冪等にする** — 4分のスモークを走らせる。フルマトリクスは走らせない。

🚨 **Windows 固有の注意（公式ドキュメント記載）:**
- shell 形式は既定で Git Bash（`"shell": "powershell"` で強制可）
- **exec 形式（`args` あり）は `node_modules/.bin/eslint.cmd` のような `.cmd` shim を起動できない**
  → `node ./node_modules/<pkg>/bin/<x>.js` を呼ぶ
- JSON 内はスラッシュと `${CLAUDE_PROJECT_DIR}` を使う

### テストエージェント

`.claude/agents/*.md` の frontmatter が使えるキー:
`name`, `description`（必須2つ）, `tools`（**許可リスト**）, `disallowedTools`,
`model`, `permissionMode`, **`isolation: worktree`**, `color`, `mcpServers`, `skills`,
`memory`, `background`, `maxTurns`, `effort`, `initialPrompt`, frontmatter レベルの `hooks`。
優先順位: managed > project（`.claude/agents/`、cwd に近い方）> user。

用意するもの:
- **`test-writer.md`** — `tools: Read, Grep, Glob, Edit, Write`。
  Theia core の約90個の `*.spec.ts` を実例として参照させる
- **`test-runner.md`** — `tools: Read, Grep, Glob, Bash`。`verify.mjs` を走らせて要約を返す

公式の検証ドクトリンを `CLAUDE.md` に引用する:
> 「合否を出すものを Claude に与えれば、ループは自分で閉じる」

---

## 4. Windows でのオーケストレーション

**Claude Code がネイティブで持っているので、サードパーティのオーケストレータは要りません。**

- **`claude --worktree <name>` / `-w`** → `.claude/worktrees/<name>/` を
  `worktree-<name>` ブランチで作る。別ターミナルでもう一度走らせれば2つ目の独立セッション。
  `--worktree "#1234"` で PR から分岐も可
- **`worktree.baseRef`**: `"fresh"`（既定、リモート default から分岐）/ `"head"`（未push作業を持ち込む）
  → **進行中の作業の上に積むサブエージェントを分離するなら `"head"`**
- **`.worktreeinclude`**（gitignore 構文）で gitignore 済みファイルを新 worktree にコピー。
  **これは必須** — Theia の worktree は `node_modules` も `plugins/` も無い素のチェックアウト
- `isolation: worktree` を agent frontmatter に。Claude が実行中 `git worktree lock` する
- ヘッドレス: `claude -p --output-format json|stream-json`, `--resume <session_id>`

🚨 **Windows の注意（公式記載）:** worktree 内のフォルダが NTFS ジャンクションや
ディレクトリシンボリックリンクだと、worktree 削除時にリンクだけ消えて対象が残る。
そして `.claude` / `.claude/worktrees` / worktree ディレクトリ自体がシンボリックリンクだと作成を拒否。
**`node_modules` をジャンクションにする人が多いので注意 — やらない。**

**🚨 Theia 固有の制約: worktree 毎に独自の `node_modules` と
`theia rebuild:*`（node-pty, ripgrep）が必要で、フルインストールは分単位。**
→ **並行 worktree は 2〜3 に上限を置き**、ビルド分離が要らないものは
1チェックアウト内のサブエージェントで回す。
**`--cacheRoot ../..`**（Theia の examples がやっている）でネイティブモジュールのキャッシュを共有する。

**Claude はネイティブ Windows で走らせる**（Electron ターゲットはどうせ Windows でビルド・
スモークするので）。WSL は Linux CI の失敗再現用に残す。

サードパーティを足すなら **ccmanager 4.2.1（MIT、2026-07 活発、tmux 不要の自己完結 Node/ink TUI、
worktree 管理 + 作成後フック + Claude セッションデータのコピー）** がセッションダッシュボードとして唯一の候補。
⚠️ Windows 対応の明言が見つからなかったので「たぶん動く、要確認」扱い。
（uzi は tmux 必須で 2025-06 から停止、Conductor は macOS 専用、Crystal は廃止、claude-squad は AGPL+tmux。）

---

## 5. リポジトリと CI

### レイアウトとパッケージマネージャ

`theia-ide` の構造を踏襲:
```
applications/browser/          browser アプリ
applications/electron/         electron アプリ（+ test/app.spec.js, electron-builder.yml）
theia-extensions/*/            拡張（product ブランディング、launcher、updater）
scripts/                       署名、チェックサム、バージョン
```
workspaces は `["applications/*", "theia-extensions/*"]`。

**🚨 パッケージマネージャは唯一の本当の制約: yarn 1 classic。**

| リポジトリ | マネージャ |
|---|---|
| `theia`（フレームワーク） | **npm workspaces** + lerna ^9（`CLAUDE.md`: 「use `npm`, not `yarn`」）|
| `theia-ide`（製品） | **yarn 1 classic** + lerna ^9（`"engines": {"yarn": ">=1.7.0 <2"}`）|

公式ドキュメントも下流製品には「`npm`（Theia の既定）ではなく `yarn` を使う」と書いています。
**`theia rebuild:electron` + `electron-builder` + `download:plugins` が
end-to-end で実証されているのは yarn 1 だけ。**
`electron-builder` × npm workspaces は上流のどこにも実証がなく、
pnpm の厳格リンクは Theia のホイスティング前提と敵対的。

**ピン:** electron **42.3.0**、Node **>=22**、TypeScript **`~5.9.3`**（最新は 7.x だが Theia が 5.9 ピン）、
React 18.2.0、Lumino 2.x。バンドラは **esbuild**（webpack は deprecated）。

### CI

**リポジトリを最初から public にする** → **GitHub Actions は
public リポジトリ + 標準ランナーで無料**。
⚠️ **制約は分数ではなく同時実行数**（Free: 20ジョブ / macOS 最大5）。
⚠️ larger runners は public でも有料。

**実測の目安:** Theia も theia-ide も全ジョブに `timeout-minutes: 60` を置き、
`NODE_OPTIONS=--max_old_space_size=4096` が必要。
**Electron プラットフォーム1レグあたり 30〜50分**を計画値にする（公表実測値は無い）。

**キャッシュ:** `~/.cache/ms-playwright`（lockfile ハッシュキー）、
ネイティブモジュール（`--cacheRoot ../..`）、ダウンロード済みプラグイン。
⚠️ `vscode-ripgrep` のレート制限を避けるため `GITHUB_TOKEN` を渡し、
`--rate-limit=15 --parallel=false` で絞る（両上流がやっている）。

**カデンツを強く分ける:**
| | 内容 | 目標 |
|---|---|---|
| **PR** | lint + typecheck + unit + browser smoke（ubuntu のみ） | **10分未満** |
| **nightly** | 3 OS マトリクス + `@theia/api-tests` 適合性 + パッケージ済み Electron スモーク + `--repeat-each=3 --fail-on-flaky-tests` | — |
| **release** | パッケージング + 署名 | — |

`paths-ignore` でドキュメント変更を除外。**アクションは SHA でピン**（上流がやっている）。

### 規約

| | 選択 | 理由 |
|---|---|---|
| コミット | **Conventional Commits**（`@commitlint/cli` 21.x, MIT） | **Theia 自身が `CLAUDE.md` で必須化**: 「Use Conventional Commits subjects: `type(scope): summary`」 |
| フック | **lefthook 2.x**（MIT、単一Goバイナリ） | husky はシェルスクリプトで Git Bash 依存 → **Windows で lefthook が明確に良い** |
| ESLint | **eslint 8 + Theia の `configs/*.eslintrc.json`** | **`@theia/eslint-plugin` は未公開。** そして Theia の共有 config は eslintrc 形式で flat config に落ちない。**エージェントは Theia のコードを真似るのでそのルール前提が要る** |
| Prettier | **入れないか、Theia に合わせる** | Theia core は Prettier を使わず ESLint + `tsfmt.json`（4スペース、シングルクォート、`null` より `undefined`）。素で入れると喧嘩する |
| TS project references | **使う**（Theia が依存している） | `theiaext build` = `tsc --build`。ルートの `compute-references` が workspace から参照グラフを**生成**する。同じ生成器を用意する |
| 署名 | **DCO（`Signed-off-by`）** | **ECA は不要。** ECA は Eclipse Foundation ホストのプロジェクトへの貢献に対する合意で、**下流の製品には適用されない**。DCO は軽量で将来の上流化とも整合 |
| リリース | lerna（両上流が使用）か changesets | どちらでも。lerna なら1ツール減る |

**⭐ そして Theia 1.74 はリポジトリルートに `CLAUDE.md` を同梱しています。**
ビルドコマンド、`src/{common,browser,node,electron-browser,electron-main}` のレイアウト規則、
`theiaExtensions` エントリポイント、**プロパティ注入 > コンストラクタ注入**、
**`bindRootContributionProvider` vs `bindContributionProvider`（実在するメモリリークの罠）**、
`nls.localize()` の要件、テストファイル命名規約（`*.spec.ts` ユニット / `*.ui-spec.ts` UI /
`*.slow-spec.ts` 低速、リソースは `test-resources/`）が書かれています。
**この構造を自分の `CLAUDE.md` にコピーし、Theia のドキュメントを `@` 参照する。**
（なお上流に `.claude/agents/` は無いので、そこは前例なし。）

---

## 6. 最初の機能コミットより前に存在すべきもの（順序つき）

**機能開発は1つも含まれていません。全部が「検証不能なコードに対する保険」です。**

| # | 内容 |
|---|---|
| **1** | **スキャフォールド + ピン。** `generator-theia-extension@0.1.49`、yarn 1、lerna、`applications/{browser,electron}` + `extensions/*`、**esbuild に `exposeModulePlugin()`**、TS `~5.9.3` + 生成した project references、eslint 8 + Theia の eslintrc |
| **2** | **層1ハーネス。** vendor した `test-setup.js`（ESM ローダフック + `DragEvent` モック）、`.mocharc.yml`、mocha + chai + sinon + nyc、**`jsdom ^22` を明示インストール**、そして `new Container()` + `enableJSDOM()` を使う**実際に通る spec を1本** |
| **3** | **層4 browser スモーク。** `@theia/playwright@1.74.0` + `@playwright/test@^1.62`、上記11シナリオ、テスト毎 `TheiaWorkspace` フィクスチャ、捨て `THEIA_CONFIG_DIR`、**コンソールエラーカナリア**、`--forbid-only`。**4分未満でグリーン** |
| **4** | **エージェントの検証面。** `scripts/verify.mjs` = typecheck → unit → browser smoke、`--reporter=json` を読んで**20行以内の要約**。**エージェントと hook が呼ぶ唯一のコマンド** |
| **5** | **hooks + agents。** `Stop` → `verify.mjs`、`PostToolUse(Edit\|Write)` → `tsc --noEmit`。`.claude/agents/test-writer.md` と `test-runner.md`。製品の `CLAUDE.md` を Theia のものをモデルに |
| **6** | **worktree 衛生。** `.claude/worktrees/` を `.gitignore`、`.worktreeinclude`、`worktree.baseRef: "head"`、**リポジトリ配下にジャンクション/シンボリックリンクを置かない** |
| **7** | **CI（public リポジトリ）。** PR ワークフロー（ubuntu、lint+typecheck+unit+browser smoke、`paths-ignore`、SHA ピン、Playwright キャッシュ）+ nightly（3 OS + `@theia/api-tests` 適合性 + `--repeat-each=3 --fail-on-flaky-tests`）|
| **8** | **出荷前に:** パッケージ済み Electron の WDIO スモーク（`@wdio/electron-service@10`、theia-ide の6シナリオ、Linux は `xvfb-run -a`）— nightly、PR毎ではない |

---

## 正直なギャップ

| | |
|---|---|
| **`@theia/playwright` の Electron モードは未実証** | ソースに `TODO … just a sketch`、上流CIが一度も動かしていない、未パッケージのアプリディレクトリを指す。**スパイクを取り、パッケージ済み Electron は WDIO 前提で計画する** |
| **`theia test`（層2）に機械可読レポータが無い** | `reporter: 'spec'` ハードコード、終了コードのみ。fork かラップが必要 |
| **electron-builder × npm/pnpm workspaces は未実証** | yarn 1 だけが実証済み構成 |
| **`@theia/eslint-plugin` / `@theia/test-setup` / `@theia/ext-scripts` が未公開** | vendor 必須 |
| `theia-playwright-template` が2年以上古い | 参考のみ |
| **ccmanager の Windows 対応が未言明** | tmux 不要・`os` フィールド無しなので妥当だが未検証 |
| **Theia 製品ビルドの CI 実測時間が未公表** | 30〜50分/レグは60分タイムアウトと作業量からの推定 |
| VS Code の `test/smoke` シナリオ目録と `@vscode/automation` のライセンス | 未確認。上記シナリオは Theia/theia-ide の一次情報ベース（我々のスタックにはむしろ近い）|

## 出典

[theia repo](https://github.com/eclipse-theia/theia) ·
[examples/playwright](https://github.com/eclipse-theia/theia/tree/master/examples/playwright) ·
[doc/api-testing.md](https://github.com/eclipse-theia/theia/blob/master/doc/api-testing.md) ·
[doc/Testing.md](https://github.com/eclipse-theia/theia/blob/master/doc/Testing.md) ·
[theia-ide](https://github.com/eclipse-theia/theia-ide) ·
[theia-ide app.spec.js](https://github.com/eclipse-theia/theia-ide/blob/master/applications/electron/test/app.spec.js) ·
[theia-playwright-template](https://github.com/eclipse-theia/theia-playwright-template) ·
[generator-theia-extension](https://github.com/eclipse-theia/generator-theia-extension) ·
[Theia composing applications](https://theia-ide.org/docs/composing_applications/) ·
[Playwright Electron](https://playwright.dev/docs/api/class-electron) ·
[Playwright CI](https://playwright.dev/docs/ci) ·
[Playwright reporters](https://playwright.dev/docs/test-reporters) ·
[Playwright CLI](https://playwright.dev/docs/test-cli) ·
[WDIO Electron](https://webdriver.io/docs/desktop-testing/electron/) ·
[Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents) ·
[hooks](https://code.claude.com/docs/en/hooks) ·
[worktrees](https://code.claude.com/docs/en/worktrees) ·
[best practices](https://code.claude.com/docs/en/best-practices) ·
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) ·
[Eclipse ECA FAQ](https://www.eclipse.org/legal/eca/faq/)
