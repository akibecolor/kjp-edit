# 第2回 敵対的レビュー（決定1〜4 に対して）

2026-08-01。決定を書いた本人ではない別エージェントに、
「前回の指摘が本当に解決したか、それとも移動しただけか。決定が新しい矛盾を作っていないか」を
検証させた結果。**BLOCKING 8件、SERIOUS 7件。判定は「開発着手には不適」。**

## 一行で

**決定2 の前提が2つとも否定されました。** 新しい第一の差別化（G1）は lazygit と GitUp が
既に実装しており、新しい Phase 2 の合格線は VS Code が既に出荷しています。
そして**決定3 が Theia のコミットグラフを機能停止させる**のに、決定4 が
そのグラフを評価するスパイクを組んでいます。

**私は同じ失敗を2回しました** — 差別化の主張を立て、その上に計画を積み、
後から検証したら主張が成り立たなかった。1回目が「レイアウト」（`Area`/`LayoutData` で倒れた）、
2回目が「グラフ中心の履歴編集」（lazygit/GitUp で倒れた）。

---

## BLOCKING

### R2-1 🛑 G1（新しい第一の差別化）は lazygit と GitUp が既に全項目実装している

decisions.md は差別化を
「interactive rebase / 並べ替え / squash / **コミット分割** / **過去への fixup** /
worktree間 cherry-pick / **reflog 救出**」と定義し、research.md は
「**1つも無い**」と書いています。

**[GitUp](https://github.com/git-up/GitUp)（GPLv3）の README、逐語:**
> 「**a live and interactive repo graph** (edit, reorder, fixup, merge commits…)」
> 「visual commit splitter」「unified reflog browser」
> 「Unlimited undo / redo of almost all operations (**even rebases and merges**)」

**リスト全部です。**

**[lazygit](https://github.com/jesseduffield/lazygit)（MIT）:**
> 「Press `i` to start an interactive rebase. Then squash (`s`), fixup (`f`), drop (`d`),
> edit (`e`), move up (`ctrl+k`) or move down (`ctrl+j`)」
> 「you can build a custom patch from an old commit and then remove the patch from the commit,
> **split out a new commit**」
> 「Press `shift+c` … `shift+v` to paste (cherry-pick)」「Undo uses the **reflog**」
> 「the **commit graph** is shown」

**そして decisions.md は同じページで lazygit を業界最良の姿勢として引用しています**
（`GIT_OPTIONAL_LOCKS` の節、`lazygit#2050` へのリンクつき）。
**自分が製品の根拠にした主張の反例を、模範として引用していた。**

**さらに悪いのは S0 のスコープです。** 対象は
「Nimbalyst / mux / VS Code の Source Control Graph / GitLens / Theia 1.71」の5つで、
**lazygit も GitUp も Sublime Merge も tig も Fork も Tower も SmartGit も GitKraken も入っていません。**
つまり**半日のスパイクは PASS を返し、前提は依然として偽のまま**になります。

### R2-2 🛑 決定2 の新しい Phase 2 合格線は VS Code が既に出荷している

新しい合格線は
「ファイルツリーを見えたまま単一エディタタブをズームでき、解除でサイズがバイト単位で戻る」。

**VS Code はこれを全部持っています。** ソースで確認済み:

```ts
// src/vs/workbench/browser/parts/editor/editorCommands.ts
export const TOGGLE_MAXIMIZE_EDITOR_GROUP = 'workbench.action.toggleMaximizeEditorGroup';
```
既定キーバインド `Ctrl+K Ctrl+M`、タイトル "Toggle Maximize Editor Group"。

**サイドバーを触りません。** その証拠が、すぐ上の行に**別のアクションが存在すること**:
```ts
id: 'workbench.action.maximizeEditorHideSidebar',
title: 'Maximize Editor Group and Hide Side Bars',
...
layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
```
「…and Hide Side Bars」という別バリアントがあることが、
**素の方はエクスプローラを残す**という積極的な証明です。

**粒度はエリアではなく leaf:**
```ts
// gridview.ts:1542
if (!(nodeToMaximize instanceof LeafNode)) { throw new Error('Location is not a LeafNode'); }
```

**バイト単位の復元も明示され、コメントが機構を説明しています:**
```ts
// gridview.ts:1577-1596  exitMaximizedView()
// When hiding a view, it's previous size is cached.
// To restore the sizes of all views, they need to be made visible in reverse order.
```

**そして D3 ルール2（ズーム中の構造変更）も既に実装済み** —
`addView`/`removeView`/`moveView`/`swapViews` が全部
`if (this.hasMaximizedView()) { this.exitMaximizedView(); }` で始まる。

**残りかすは2つだけ:** グループが1つしかないと `arrangeGroups` が早期 return するので
単独グループの最大化は no-op、そして**非エディタのタイル（ターミナル・ファイルツリー自身）は
grid の leaf になれない。** どちらも差別化として書かれていません。

**つまり決定2 はレイアウトを第一位から降ろし、ルール3と5を落とし、
残った合格線を競合の出荷済み機能に設定しました。**
自分が選んだ基準において、**残ったものは VS Code より厳密に弱い。**

### R2-3 🛑 決定3 が Theia のコミットグラフを機能停止させ、決定4 がそれを評価するスパイクを組んでいる

`vscode.git` を除外するとグラフのデータ源が完全に消えます。ソース確認済み:

```ts
// packages/scm/src/browser/scm-history-graph-model.ts:97-99
const repo = this.scmService.selectedRepository;
const hp = repo?.provider.historyProvider;
this._provider = hp;
```
そして `provideHistoryItems` を呼ぶ。**この provider のツリー内の唯一の実装は
`packages/plugin-ext/src/main/browser/scm-main.ts` の `PluginScmHistoryProvider` で、
VS Code 拡張から供給されます。** `vscode.git` を除外すれば
`selectedRepository` が `undefined` になり**グラフは永久に空。**

なのに decisions.md は
**「S0b: Theia 1.71 のグラフを5万コミットのリポジトリで動かす / v1 の土台に使えるかの判定」**を
スケジュールしています。**同じ文書が既に取り除いた土台の耐荷重を測ろうとしている。**

そして architecture.md はまだ Theia を選ぶ理由として「**上流コミットDAG**」を挙げ、
research.md も「アプリ内コミットグラフ ○ 1.71 で上流実装」のまま。
**第1回レビューで Theia の4本柱のうち2本が倒れ、決定3 が自分の手で3本目を倒したのに、
柱の一覧をどの文書も更新していません。** decisions.md はむしろ
「ベースは Theia のまま（決定2 は何のために買っているかを変えただけ）」と書いています。

### R2-4 🛑 今回書いた tmux 修正が、ACP について事実と違う前提に立っている

architecture.md に「依存しようとしていた `session/resume` with replay は **ACP v2 の機能**」と
書きましたが、**ACP v1 に `session/load` があり、完全なリプレイが必須です。** 仕様の逐語:

> 「To load an existing session, Clients **MUST** call the `session/load` method」
> 「The Agent **MUST** replay the entire conversation to the Client in the form of
> `session/update` notifications」

（`loadSession: true` capability が条件。）**v2 は v1 の `session/load` を
`session/resume` に*改名*しただけ。**

**そして research.md には正しく書いてありました** —
v2 の変更点として「`session/load` → `session/resume` with replay」、
ACP を選ぶ理由として「replay付きsession resume」。

つまり**v1 が既に提供しているものを置き換えるために、
自前のトランスクリプト永続化+再プロンプトを設計した。**
それは会話全体を再課金し、エージェント側の状態を失い、
D4 が警告した「プロトコルの意味論を下手に再実装する」パターンそのものです。

### R2-5 🛑 #3 の訂正が architecture.md だけに入り、実際にスパイクを駆動する文書には旧主張が生きている

spikes.md は今も:
> `| **S1: ズーム意味論** | **◎ 既に実装済み** | doToggleMaximized が D3 ルール1をそのままやっている。ゲートを広げるだけ |`
> 「## 1-B. ◎ ズーム意味論は既に実装されている — **これが今回最大の発見。**」
> 「### 広げるべきゲート（2箇所だけ）」

roadmap.md も同様。**そして S1 の8ステップ手順は未変更なので、
Step 5 の PASS 基準が古い誤ったモデルを測ります。**

**開発者が開いてスパイクを走らせる文書に誤りが載っていて、
訂正が載っている文書は実行されない文書。**

### R2-6 🛑 #4 を「解決」と宣言したが、実際は別の問題を解決していた

review-findings.md #4 は**セキュリティモデルの欠陥**でした —
「Phase 1 の完了条件が Phase 5 のインフラを要求し、127.0.0.1 のみの規則に違反する」。
必要な修正は「Phase 1 の完了条件を閲覧経路のみに変え、**loopback 限定バインドを Phase 1 に移す**」。

decisions.md は「#4/B4（**順序**）は決定4で解決」と書きましたが、
**決定4 はスパイクの順序の話で、Phase 1 について何も含んでいません。**

roadmap.md は未変更: Phase 1 の完了条件は「別端末のブラウザから同じバックエンドに繋がる」、
loopback バインドは Phase 5 のまま、Phase 5 の完了条件は
「ターミナル権限は明示的に付与しない限り無い」— レビューが指摘した正面衝突がそのまま。

**閉じたと宣言した BLOCKING が閉じていないのは、開いている BLOCKING より悪い**
（誰も二度と見ない）。

### R2-7 🛑 A2 の訂正が追記されただけで、`persist:preview` を*指示している*4箇所は全部そのまま

viewer.md 内で**180行離れて自己矛盾**しています。訂正部分は
「案1（推奨）… ヘッダ書き換えをデーモン側のリバースプロキシで行う」
「**D6 の根拠から「Electron 側でヘッダを消せる」は削除される**」と書いているのに、
同じファイルの「→ A の推奨 / v1」に:
> 「2. Electron では専用の `persist:preview` パーティションで `onHeadersReceived` により…除去」

architecture.md 2箇所、roadmap.md 1箇所も同様。
**A3b（サブドメインはクッキーを分離しない）も同じパターン** —
viewer.md 111行で「別サイトである必要がある」と結論しながら、
267行で「別オリジン/**サブドメイン**から配信する。交渉不可」が生きています。

### R2-8 🛑 D1 の修正が、同じファイル内の要約表・図・D2 と矛盾している

修正は本文に入れましたが、その上の2つの要約とその下の D2 を更新していません。

- 冒頭の7決定表は今も「ローカルUIもリモートUIも**同じプロトコルを話す対等なクライアント**」
  「**クライアントは1種類だけ作り**」
- ASCII図はデーモンの箱の中に今も
  「・ドキュメントモデル（開いているバッファ、dirty状態）← **権威**」— 47行下で撤回した文字列
- D2 の「共有される状態」行は今も「…**開いているバッファの内容とdirty状態**…」で、
  新しい権威表の「持たない」列と直接矛盾
- secondary-client.md は冒頭で撤回版に依拠: 「**D1（1プロトコル・クライアントは1種類）**が
  既に想定していた形」

**D2 の「共有される状態」行はセカンダリクライアントを作る際の契約なので、
D1 が「フロントエンド毎」と言うものをセカンダリに約束している状態。**

---

## SERIOUS（抜粋）

| | 内容 |
|---|---|
| **R2-9** | 決定1 が allowlist な `validateLink` を要求しつつ、`streamdown:incomplete-link` が通ることに依存している。`link.ts` は検証失敗時に `href=''` にして **`pos` を進めないので、リンクルール全体が失敗し `[text](streamdown:incomplete-link)` が生テキストで出る。** ストリーミング中の全ての部分リンクでこれが点滅する。**そして remend には `linkMode: 'text-only'` という解決策がある**のに言及していない |
| **R2-10** | **「markdown-it@15 は @theia/core 経由で既にツリーにある」は偽。** `@theia/core` は `^14.3.0` ピンで 15 に解決できない。15 を採ると**パーサが2つ入る。** そして実測は 14 で行った（採用版 ≠ 検証版）|
| **R2-11** | **「メモ化を入れない」の根拠が、自分の主要ユースケースで無効になる。** 根拠は「実際のチャット応答が 16KB 未満」だが、viewer.md は「**我々の主要ユースケースは…エージェントが設計文書やレポートをストリームする**」と書いている。設計文書は 64KB 側（=42秒）。しかも loose/tight リストと setext の反転は*以前の*DOMを書き換えるので append-only ガードを外し、フル再描画フォールバック=42秒経路に落ちる。2つの設計選択が互いに前提になっているのが LOC 表に出ていない |
| **R2-12** | 「実行前にコマンドを見せる／**編集させる**（Sublime Merge がやっていること）」の帰属が誤り。Sublime Merge の主張は *"View the exact Git commands you're using"* — **閲覧のみ**で編集は無い。かつコマンドプレビューは**ラッパの透明性の装置**。lazygit は同じ操作を2キーストロークでやり、コマンドを見せない = **価値はそこに無いという証拠** |
| **R2-13** | **`vscode.git` を除外して何を失うかが10文書のどこにも書かれていない。** 失うもの: SCM ビュー、diff の gutter 装飾、blame/timeline、`git.mergeEditor`（3-way マージエディタ。`vscode.merge-conflict` は別 builtin で生き残る）、SCM 入力ボックス、そして **`vscode.git` の拡張API**。API の消費者は広く、`vscode-pull-request-github` と GitLens（`cliGitProvider.ts` が「vscode.git の既知セットからリポジトリを発見する」）が依存。**さらに構造的に: ビルド時のダウンロードフィルタは、ユーザが GitLens を入れることを止められない。**「kjp-core が git を完全所有」は強制されていない願望 |
| **R2-14** | NOTICE/帰属が architecture.md では Phase 1 の義務なのに **roadmap.md の Phase 1 に無い**。しかも今回 MIT の移植を1つ（`ParagraphBuffer`+rAF morpher）追加し、remend の LICENSE 手動 vendor も追加したが**どちらもフェーズ未割当**。EPL §3.1(a) のソース入手可能性の声明も未割当。**Phase 1 の完了条件を満たした日にライセンス違反** |
| **R2-15** | 新しいスパイク順序が、決定4 自身が掲げた原則で**まだ逆転している**。S1c（Monaco マルチインスタンス、半日、失敗するとベースへの一票）が S1（1〜2日、ベースを前提とする）の**後**。S2c（半日）と S2d（1時間、決定3 全体をゲート）も S2 の後。レビュー#11 の指示は「S1 の**隣**に置くべき」だった |
| **R2-16** | **README が捨てた主張をまだ売っている** — 「すべてのパネルが単一のレイアウトツリー上のタイルとして縦横に無限にネストできる」= 決定2 が降ろした D3 ルール3。research.md「レイアウト — **最重要かつ差別化の核**」、architecture.md「**これが差別化の核**」、そして roadmap.md Phase 2 は今も**降ろしたルール5を作業として組んでいる**（「`focus parent` / `focus child`（ルール5）」）+ 旧受入テスト |
| **R2-17** | 第1回の訂正表の6項目が伝播していない。`@theia/git` 削除は **1.70.0**（decisions.md は正しいが architecture.md/spikes.md/research.md は 1.71）、`@theia/preview` は公開されている（3箇所未修正）、EPL「ファイル単位」が research.md に残存、tldraw の $6,000 が未確認のまま断定、`theia-blueprint`/`theia-ide` の表記不一致、D6 の対称性主張、**Streamdown 採用が5箇所に残存**。**10文書のうち6文書が decisions.md と矛盾** |

---

## 🔴 私の判断ミスの構造

**2回とも同じ形です。差別化の主張を立て → その上に計画を積み → 後から検証したら主張が偽。**

| | 主張 | 何で倒れたか |
|---|---|---|
| 1回目 | レイアウト（単一コンテナツリー）が差別化の核 | `Area` が閉じた union、`LayoutData` が非対称 → コアのフォークが必要 |
| 2回目 | グラフ中心の履歴編集が差別化 | **lazygit と GitUp が全項目実装済み** |

**根本原因: 「先行事例調査」で*エージェントオーケストレータ*と*IDE*しか見ていなかった。**
research.md の先行事例表は Conductor / Vibe Kanban / claude-squad / Nimbalyst / mux …と
VS Code フォークで、**git クライアント専用ツール（lazygit / GitUp / tig / Fork / Tower /
SmartGit / GitKraken / Sublime Merge のグラフ）を1つも評価していません。**
「エージェント開発IDE」というカテゴリで探したので、
「git UI」というカテゴリの成熟した競合が視界に入らなかった。

---

## 🔴 提案する第3の再定義（ユーザ決定事項）

**私が2回外したので、今回は「何が残っているか」から先に確定させるべきです。**
レビュー側が指摘した残り物が、実は一番強い:

> 「正直な差別化は別のところにある: **pre-flight のシーケンサガード、
> クロスworktreeの認識、そして reflog 救出** — これらを
> ***マルチworktree・マルチエージェント*のリポジトリに対して**やっている
> lazygit も GitUp も無い」

> 「§決定3 の git 安全性の調査は、この一連の中で最も強いオリジナル素材であり、
> それが弱い『コマンドを組んで見せる』論の下に隠れている」

**つまり差別化は「グラフ + 履歴編集」（既出）ではなく
「N エージェントの並行 worktree に対して安全な git」です。**

**なぜこれが本当に空白か:**

| | lazygit / GitUp / Sublime Merge | 我々 |
|---|---|---|
| 対象 | **単一リポジトリ・単一 worktree・単一ユーザ** | **N worktree で N エージェントが並行** |
| clean index の rebase 中に checkout が通る問題 | ガードしない（そもそも同時アクタが居ない前提） | **pre-flight でブロック** |
| `checkout` が `MERGE_HEAD` を無警告削除する問題 | 同上 | **同上** |
| `refs/stash` が worktree 間で共有され `stash@{N}` がずれる | 概念が無い | **禁止して代替を提供** |
| クロスエージェント比較（どの2ブランチが同じファイルを触ったか、マージ順序） | 無い（G4 は今も未claimed） | **グラフが全ブランチを1枚に描くので自然な表示面** |
| エディタ + ターミナル + エージェント監督 + グラフの統合 | lazygit は横に置く TUI、GitUp は macOS 専用スタンドアロン | **1アプリ** |
| プライマリ/セカンダリ（モバイル） | 無い | mux のみが持ち、AGPL |

**そして我々のオリジナル調査（シーケンサ乗っ取り、`MERGE_HEAD` 消失、
並行 worktree rebase の安全性検証）がそのまま根拠になります。**
これは借り物ではなく自分で実測した知見です。

**ただし今回は主張を立てる前に検証します。** 決定するなら:
- S0 のスコープを **lazygit / GitUp / Sublime Merge / tig / Fork / GitKraken** を先頭にして書き直す
- 問いを「グラフ編集をやっているか」ではなく
  **「*複数の並行 worktree に対して*安全性ガードを持っているか」**にする
- そして**この問いに答えてから**決定1/3/4 が前提にしている「G1 は空白」を確定させる

---

## 判定と処理順

**開発着手には不適。** ただしレビュー側の言葉を借りると:

> 「4つの決定は個別には論証が良く、下敷きの調査は異常に良質。
> だが集合としてはまだ整合していない。」

処理順（レビューの推奨）:
1. **R2-1 / R2-2 / R2-3** — 2つの差別化を再スコープし、決定3 と S0b を整合させる
2. **R2-4 / R2-6 / R2-8** — 誤った、または未完の3つの修正
3. **R2-5 / R2-7 / R2-16 / R2-17** — 6文書への機械的な伝播パス1回
4. **R2-15** — スパイクの並べ替え
5. → Phase 0 を走らせる

**⭐ 重要: テストハーネスとオーケストレーションの整備は上記と独立しています。**
差別化が何であれ必要なので、[development.md](development.md) は今すぐ着手できます。

## レビューが確認して問題なしとしたもの

- **`theiaPluginsExcludeIds: ["vscode.git"]` は効く**（未検証としていたが確定）。
  `download-plugins.ts:289-296` が vsix ファイル名でマッチし、
  `vscode-builtin-extensions` 1.108.2 に `vscode.git.vsix` が実在。
  ⚠️ ただしフィルタは `allVsix` tarball 分岐でのみ動くので、その前提を記録すること
- **`@theia/git` 削除は 1.70.0**（decisions.md が正しい）
- **`@theia/ai-chat-ui` が `mermaid ^11.15.0` をハード依存**（決定1 の追加根拠は妥当）
- **`remend@1.3.0` Apache-2.0 依存ゼロ**
- **ACP v1 に WebSocket トランスポート無し**（B2 の格下げは妥当）
- **A1 は本当に修正された。** ただし B5 の「3つのゲートが強制されていることを
  PASS 条件にする」は散文であって PASS 基準になっていない
- `Area` が閉じた union / `LayoutData` 非対称 / `focusParent` 不存在 — ソースと整合
- markdown-it の既定の堅牢性と `highlight` の穴は正確

## レビューが確認できなかったもの

- WebSearch 枠が開始時に枯渇していたため、**R2-1 の反例リスト（lazygit / GitUp /
  Sublime Merge）は床であって網羅ではない。Fork / Tower / SmartGit / GitKraken / tig /
  gitui / jj の UI、そして Nimbalyst / mux 自体は未確認**
- `toggleMaximizeEditorGroup` がどの VS Code バージョンで入ったか（`main` に在ることは確認）
- 42秒 vs 113ms、~1,700-2,000行削減、~250-300行見積り、Theia の実行時挙動 —
  **これらは私（設計者）自身の実測で、ビルドせずには再現できない**
- `git.enabled: false` が本当に完全なキルスイッチか（`createModel()` を読んでいない）
- **git 2.48.1 のシーケンサ実験と並行 worktree rebase の結果** —
  「この文書で最も価値のあるオリジナル発見であり、最も確認したかったもの」

## 出典

[VS Code editorActions.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorActions.ts) ·
[VS Code gridview.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/gridview.ts) ·
[Theia scm-history-graph-model.ts](https://github.com/eclipse-theia/theia/blob/master/packages/scm/src/browser/scm-history-graph-model.ts) ·
[Theia PR #17148](https://github.com/eclipse-theia/theia/pull/17148) ·
[Theia download-plugins.ts](https://github.com/eclipse-theia/theia/blob/master/dev-packages/cli/src/download-plugins.ts) ·
[markdown-it link.ts](https://github.com/markdown-it/markdown-it/blob/master/src/rules_inline/link.ts) ·
[ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup) ·
[lazygit](https://github.com/jesseduffield/lazygit) ·
[GitUp](https://github.com/git-up/GitUp) ·
[Sublime Merge](https://www.sublimemerge.com/)
