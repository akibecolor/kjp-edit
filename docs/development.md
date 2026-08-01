# 開発体制・テスト・オーケストレーション

**この文書は製品の差別化が何であれ必要なので、[review-2.md](review-2.md) の
差別化再定義と独立に今すぐ着手できます。**

🔴 **文字コードとパスのハザードは [encoding-and-paths.md](encoding-and-paths.md) に分離しました。**
日本語 Windows での実測で **Theia 側に日本語が壊れる欠陥が2つ**見つかっています
（ターミナルの `MultiRingBuffer` が UTF-8 境界を見ずにバイト範囲をデコードする、
`@parcel/watcher` の snapshot 経路が `FindFirstFileA` で CP932 を返す）。
**スモークスイートの E1-E14 もそちらにあります。**

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

🛑 **当初ここに `PLAYWRIGHT_JSON_OUTPUT_NAME=results.json npx playwright test` と書いていたが、
これは Windows で動きません**（実測で exit 1）。**npm の Windows でのシェルは `cmd.exe`**
（`powershell` ではない）で、**インラインの `FOO=bar` 前置を解釈できません。**

→ **環境変数は `verify.mjs` の中で設定する**（`cross-env` を足すより依存が減る）:
```js
// scripts/verify.mjs
process.env.PLAYWRIGHT_JSON_OUTPUT_NAME = 'results.json';
// spawn は shell を使わず、.bin の .cmd shim も踏まない
spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--reporter=json'], ...)
```

⚠️ **`node_modules/.bin/*.cmd` を Node から spawn できません**（CVE-2024-27980 の対策で `EINVAL`。
`{shell:true}` の抜け道も v24 で **DEP0190** として非推奨）。
**`process.execPath` + `require.resolve` を使う。**

詳細とその他のクロスプラットフォーム規則は **[encoding-and-paths.md](encoding-and-paths.md)**。

### 🎯 Anthropic 公式の「検証ゲート4段」— 私は1段しか使っていなかった

[code.claude.com/docs/en/best-practices](https://code.claude.com/docs/en/best-practices)
（旧 engineering ブログの best-practices は**ここに308リダイレクト**する生きたドキュメント）に
「Give Claude a way to verify its work」という節があり、**セットアップコストと引き換えに
強度が上がる4段のゲート**として明示されています。

| 段 | 機構 | 我々の状態 |
|---|---|---|
| 1. プロンプト1回の中 | 「実装したらテストを走らせて」 | — |
| 2. **セッションを跨いで** | **`/goal` の条件 — 別の評価器が毎ターン後に再チェックする** | **❌ 使っていなかった** |
| 3. 決定的 | **`Stop` フック** — 「Claude Code は8回連続でブロックされるとフックを上書きしてターンを終了する」 | ✅ 計画済み |
| 4. **セカンドオピニオン** | **検証サブエージェント** — 「**新しいモデルに結果の反証を試させる。作業したエージェントが採点者にならないように**」 | **❌ 使っていなかった** |

そして全体を貫く制約が
「**Claude のコンテキストウィンドウはすぐ埋まり、埋まるにつれ性能が落ちる。
コンテキストウィンドウは最も重要な管理対象リソースである。**」

もう1つの指針: **「成功を主張させるのではなく証拠を示させる」**。

**→ 追加する2つ:**
- **`/goal` を使う。** 「スモークがグリーンであること」をセッションを跨ぐ条件として設定すれば、
  毎ターン後に別の評価器がチェックする。`Stop` フックより早く気づける
- **検証サブエージェント（`verifier.md`）を追加する。** `test-writer` / `test-runner` に加えて、
  **「作業したエージェントとは別のモデルが結果を反証しようとする」**役を置く。
  **この文書自体が2回、私の主張を私自身が検証できなかった実例**なので、
  このプロジェクトでは特に効きます

（併せて Claude Code には `agent-view`（セッション一覧）と `agent-teams`（複数エージェントの
タスク要求）のドキュメントもあります。`agent-teams` のコンフリクト対策は散文の
「各担当が別のファイル集合を持つように分割せよ」だけなので、
[s0-verification.md](s0-verification.md) の通りここは我々の領域です。）

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

### ✅ 実測値（theia-ide の run 履歴 約25件から直接測定。当初の推定は悲観的すぎた）

| | |
|---|---|
| **マトリクス全体の wall-clock** | **14分29秒 〜 28分38秒、典型 15〜19分**（4 OS が並列） |
| ジョブ分の合計 | **約60〜80 job-minutes/run** |
| PR run | 14〜25分 |
| **成果物** | **約 3.1 GB/run**（linux 990MB / mac-x64 704MB / windows 699MB / mac-arm64 692MB）、`retention-days: 1` |

**当初「Electron 1レグあたり30〜50分」と書いたのは誤り**（60分タイムアウトからの推定だった）。
実際は4 OS 並列で全体15〜19分。

**マトリクスは3 OS ではなく4:**
`windows-2022` / `ubuntu-22.04` / `macos-15`(arm64) / `macos-15-intel`(x64) × Node **24.x のみ**。
`fail-fast: false` なので**壊れたPRは4ジョブ全部を焼きます。**

### 🎯 CI の最大の改善余地: キャッシュが存在しない

**theia-ide の6ワークフローと Theia core の4ワークフロー全部を `actions/cache` で grep した結果、
theia-ide が 0件、Theia core が 1件**（`playwright.yml` の `~/.cache/ms-playwright` のみ）。
**node_modules も yarn も npm もキャッシュしていません。**

**→ これが我々が取れる一番大きな CI の勝ち。** 上流が単にやっていないだけなので、
`~/.cache/ms-playwright`（lockfile ハッシュキー）、yarn キャッシュ、
ネイティブモジュール（`--cacheRoot ../..`）、ダウンロード済みプラグインを全部キャッシュする。

⚠️ `vscode-ripgrep` のレート制限を避けるため `GITHUB_TOKEN` を渡し、
`--rate-limit` で絞る（両上流がやっている）。
⚠️ `NODE_OPTIONS=--max_old_space_size=4096` が全ビルドステップで必要。

### 🚨 同時実行数が本当の制約（分数ではない）

theia-ide のマトリクスは4ジョブでうち**2つが macOS**。
**Free プランの macOS 同時実行上限は5**なので、
**フルマトリクスの同時 run は約2本でキャップに当たります。**

そして: **larger runner は public リポジトリでも常に課金される**ので、
18分のビルドを8コアで縮めることは無料ではできません。

### 署名は GitHub Actions では一切やっていない

**全パッケージングスクリプトが `-c.mac.identity=null` を渡しています。**
`after-pack.js` は `process.env.THEIA_IDE_JENKINS_CI === 'true'` で署名をゲートし、
**実リリースは Eclipse Foundation の Jenkins で走ります**
（*Release Preview* → *Notarize* → *Upload* の3連ジョブ）。
→ **我々は署名を GitHub Actions の外に置く設計を最初から想定する。**

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
| 署名 | **DCO（`Signed-off-by`）** | **ECA は不要。** ECA は Eclipse Foundation ホストのプロジェクトへの*コミット*に対する合意で、npm から `@theia/*` を消費して自分のリポジトリを出す側には何も課していない。⚠️ ただし「再配布者に適用されない」と*明言した文*は見つからず、contributor-only の一貫した文脈と該当要件の不在からの推論。法務確認を推奨 |
| リリース | lerna（両上流が使用）か changesets | どちらでも。lerna なら1ツール減る |

⚠️ **上流から「継承」できない規約:**
**Theia も theia-ide も prettier / husky / lefthook / commitlint / changesets /
semantic-release を1つも使っていません**（設定ファイル全部 404 で確認）。
バージョニングは `lerna version` + 手書き `CHANGELOG.md`。
**入れるなら我々が導入するのであって、受け継ぐのではない。**

⚠️ **ESLint はさらに厳しい状況でした。** `@theia/eslint-plugin` は
**`configs` オブジェクトを一切エクスポートせず**、5つの Theia 固有ルール
（`annotation-check`, `localization-check`, `no-src-import`,
`runtime-import-check`, `shared-dependencies`）だけの CommonJS で、
flat-config メタデータも無い。
**そして theia-ide は eslint 設定を自分の `configs/` に vendor した上で、
plugins から `"@theia"` を完全に外しています**（eslint ^7.32.0 で、Theia core の ^8.57.1 より古い）。
→ **前例は「設定ファイルをコピーして、Theia の lint ツーリングには依存しない」。**
flat config が欲しければ最初から自分で書く（後で移行するより安い）。

**⭐ そして Theia 1.74 はリポジトリルートに `CLAUDE.md` を同梱しています。**
ビルドコマンド、`src/{common,browser,node,electron-browser,electron-main}` のレイアウト規則、
`theiaExtensions` エントリポイント、**プロパティ注入 > コンストラクタ注入**、
**`bindRootContributionProvider` vs `bindContributionProvider`（実在するメモリリークの罠）**、
`nls.localize()` の要件、テストファイル命名規約（`*.spec.ts` ユニット / `*.ui-spec.ts` UI /
`*.slow-spec.ts` 低速、リソースは `test-resources/`）が書かれています。
**この構造を自分の `CLAUDE.md` にコピーし、Theia のドキュメントを `@` 参照する。**
（なお上流に `.claude/agents/` は無いので、そこは前例なし。）

---

## 5b. 🚨 EPL-2.0 のコーディング規則（エージェントに守らせる必要がある）

**EPL-2.0 §1 の "Modified Works" 定義が、我々の自作拡張を守る条項です。逐語:**

> 「**Modified Works** shall mean any work in Source Code or other form that results from
> an addition to, deletion from, or modification of the contents of the Program,
> **including, for purposes of clarity any new file in Source Code form that contains
> any contents of the Program.** Modified Works shall **not** include works that contain only
> declarations, interfaces, types, classes, structures, or files of the Program solely in
> each case in order to **link to, bind by name, or subclass** the Program …」

**帰結: import / サブクラス化 / 名前でバインドするだけのコードは Modified Works ではないので、
自分の拡張は好きなライセンスにできる（プロプライエタリも可）。**

🚨 **そして罠が「Program の内容を含むいかなる新規ファイルも含む」の部分です。**

**Theia のソースを自分のファイルにコピーペーストしない。**
Theia のクラス本体を自分の拡張にコピーして手直しすると、**そのファイルは EPL-2.0 になります。**
→ **DI の rebind（inversify）とサブクラス化を、コピーペーストより優先する。**
これは theia-ide 自身の拡張の構造そのものです。

⚠️ **我々の現行計画に直接効きます。** [spikes.md](spikes.md) の S1 Step 1 は
**`@theia/toolbar` から `createLayout` の本体を逐語コピー**する形になっています。
そのファイルは EPL-2.0 になるので、**意図してそうするか、`super.createLayout()` を呼んで
差分だけ書く形に変えるかを決める必要があります。**
（VS Code の `ParagraphBuffer` / `scmHistory.ts` 移植は **MIT なので方向としては問題なし** —
ただし Microsoft の MIT 表示をコードに残し NOTICE に列挙する義務がある。）

**エージェント向けに `CLAUDE.md` に書くルール:**
```
- Theia のソースをコピーペーストしない。サブクラス化と DI rebind を使う。
  Theia のコードを1行でも自分のファイルに写したら、そのファイルは EPL-2.0 になる。
- Theia のコードを参照する必要があるときは、import して継承するか、
  ContainerModule で rebind する。
- MIT 由来のコード（VS Code など）を移植したら、元の著作権表示を残し NOTICE に追記する。
```

**§3.1(a) の配布義務**（Electron インストーラの配布時）:
Theia のソースが EPL-2.0 で入手可能である旨の声明を添付し、入手方法を示す
（`github.com/eclipse-theia/theia` の正確なバージョンを指すのが慣例的な履行）。
§3.2(b) で契約書のコピーを同梱。§3.3 で Theia の表示を改変しない。
**→ これが about ボックス / Third-Party-Notices 画面の役割。**
theia-ide の `theia-extensions/product` はまさに about ダイアログを所有するために存在します。

**なお `theia-ide` リポジトリ自体は MIT** で、フレームワーク（`@theia/*`）が
`EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0` の **disjunctive（選択式）**。
**`OR` なので EPL-2.0 の枝を選んで GPL は無視する**（これは decisions.md で既に決定済み）。

🚨 **商標は製品名に直接効きます。** Eclipse のロゴガイドライン逐語:
> 「You may not incorporate the name of an Eclipse Project Trademark into the name of
> your company or software product name.」

許される形は **`<製品名> for Eclipse Theia`** または **`<製品名>, Eclipse Theia Edition`** のみ。
つまり「KJPTheia」「Theia KJP」は**不可**。「kjp-edit for Eclipse Theia」は可。
最初かつ最も目立つ言及は "Eclipse Theia" とし、以降は "Theia" に短縮可。

### 🎁 asar の罠と `ADOPTER.md`

**`theia-ide/ADOPTER.md` が下流製品にとって最も有用なファイル**でした。
**asar / `__dirname` の罠**とその3つの緩和策を文書化しています:
`asarUnpack`、`patch-package`、そして **esbuild 後処理（`@vscode/ripgrep` 向けに
`.asar` → `.asar.unpacked` を書き換える `asarRipgrepPlugin`）**。

`electron-builder.yml` の該当設定: `asar: true`、`nodeGypRebuild: false`、`npmRebuild: false`、
`asarUnpack` が `**/lib/backend/native/**` / `**/lib/backend/shell-integrations/**` / `**/lib/prebuilds/**`、
`extraResources` が `../../plugins` → `app/plugins`。

**ネイティブモジュールのリビルドに専用の CI ステップは無く**、
`@theia/cli` の中（`@electron/rebuild ^4.1.0`）で
`theia rebuild:electron --cacheRoot ../..` として走ります。

⚠️ **Electron 42 は Node 24 をバンドル**（22 から上がった）。

⚠️ **公式サイトのドキュメントは古い。** `theia-ide.org/docs/composing_applications/` は
yarn + Node >=18 と書き、まだ "theia-blueprint" と呼んでいます。
`theia-ide.org/docs/publishing/` は 404。
**リポジトリの `PUBLISHING.md` と `ADOPTER.md` を正典として扱う。**

---

## 6. 最初の機能コミットより前に存在すべきもの（順序つき）

**機能開発は1つも含まれていません。全部が「検証不能なコードに対する保険」です。**

| # | 内容 |
|---|---|
| **1** | **スキャフォールド + ピン。** `generator-theia-extension@0.1.49`、yarn 1、lerna、`applications/{browser,electron}` + `extensions/*`、**esbuild に `exposeModulePlugin()`**、TS `~5.9.3` + 生成した project references、eslint 8 + Theia の eslintrc |
| **2** | **層1ハーネス。** vendor した `test-setup.js`（ESM ローダフック + `DragEvent` モック）、`.mocharc.yml`、mocha + chai + sinon + nyc、**`jsdom ^22` を明示インストール**、そして `new Container()` + `enableJSDOM()` を使う**実際に通る spec を1本** |
| **3** | **層4 browser スモーク。** `@theia/playwright@1.74.0` + `@playwright/test@^1.62`、上記11シナリオ、テスト毎 `TheiaWorkspace` フィクスチャ、捨て `THEIA_CONFIG_DIR`、**コンソールエラーカナリア**、`--forbid-only`。**4分未満でグリーン** |
| **4** | **エージェントの検証面。** `scripts/verify.mjs` = typecheck → unit → browser smoke、`--reporter=json` を読んで**20行以内の要約**。**エージェントと hook が呼ぶ唯一のコマンド** |
| **5** | **hooks + agents（検証ゲート4段のうち2/3/4）。** `Stop` → `verify.mjs`（段3）、`PostToolUse(Edit\|Write)` → `tsc --noEmit`。`.claude/agents/` に `test-writer.md` / `test-runner.md` / **`verifier.md`（段4: 作業者とは別のモデルが反証を試す）**。**`/goal` でスモークのグリーンをセッション横断条件にする（段2）。** 製品の `CLAUDE.md` を Theia のものをモデルに + **EPL コピペ禁止ルール**（5b節） |
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
