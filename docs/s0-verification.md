# S0: 差別化の検証結果

2026-08-01。**今回は主張を立てる前に検証しました。**
別エージェント複数に「仮説を反証せよ。確証を探すな」という指示で実施。
（一部はセッション上限で途中終了。取れた範囲を記録し、未確認を明示します。）

## 検証した仮説

> 「**同一リポジトリの N 個の git worktree で N 個のコーディングエージェントが並行動作する**
> ことを前提にした git の安全性とレビュー機能を提供するツールは存在しない」

## 一行の答え

**部分的に反証されました。`clash` という MIT のツールがまさにこれを狙って存在します。**
ただし**反証されたのは4つの主張のうち1.5個**で、残りは
**14以上のツールで「無い」ことを実際に確認できた**ので、以前の2回の主張より根拠が強くなりました。

---

## 🔴 最強の反例: `clash`

**[clash-sh/clash](https://github.com/clash-sh/clash)（MIT、Rust、63★）**
タグライン逐語:
> 「**Avoid merge conflicts across git worktrees for parallel AI coding agents.**」

そして問題設定が我々のものと同一:
> 「複数のAIエージェント（または開発者）が別々の worktree で作業すると、
> **互いの変更が見えない**… 既存のツールはこれらのコンフリクトを後段でしか捕まえない。
> もっと早く検出することでより良くできる。」

**やっていること:**
- **全 worktree を跨いだペアワイズのコンフリクト予測。** `git merge-tree`（gix 経由）で
  リポジトリを変更せずに3方向マージをシミュレート。worktree を発見 → 各ペアのマージベースを探す →
  マージをシミュレート → コンフリクトファイルを報告
- **Conflict Matrix** — 全 worktree ペアの N×N グリッドにセル毎のコンフリクトファイル数。
  明示的に「1つずつ差分を見る」形ではない
- `clash check <file>` → JSON（`current_worktree`, `current_branch`, コンフリクト毎に
  `{worktree, branch, has_merge_conflict, has_active_changes}`）、**exit 2 = コンフリクトあり**
- **Claude Code の `PreToolUse` フックで衝突する編集をブロックする**
  （`Write|Edit|MultiEdit` を対象に、stdin からパスを読んで全 worktree と照合、
  コンフリクトがあれば "ask" で承認/拒否を求める）
- **100% read-only** — リポジトリを一切変更しないので、ロックの問題を構成上回避している

**やっていないこと（本人が明記）:** 「コンフリクトを解決できるか? まだ」。
マージ順序の推奨も、stash の認識も、シーケンサ/`MERGE_HEAD` のガードも無い。

**MIT なので学習も利用も可能。** そして**これは IDE ではなく CLI+TUI なので、
コンポーネントとして統合する選択肢もあります。**

---

## 4つの主張の判定

| | 主張 | 判定 |
|---|---|---|
| **1** | シーケンサ乗っ取りの pre-flight ガード | **🟢 完全に未claimed（生存）** |
| **2** | クロスworktree の認識 | **🟡 半分反証** |
| **3** | クロスエージェントの比較レビュー | **🟡 分裂: 衝突検出は反証、マージ順序は生存** |
| **4** | 並行安全な git 実行 | **🟢 ほぼ完全に未claimed（生存）** |

### 主張1: シーケンサ乗っ取りのガード → 🟢 生存

**14以上のツールで「無い」ことを確認しました。** 一番近いものが3つあり、どれも届いていません:

| ツール | 何をしているか | なぜ届いていないか |
|---|---|---|
| **GitUp**（GPL-3.0） | `git_repository_state() != NONE` で約20の操作をゲート | **checkout が意図的にバイパスしている。** ソースのコメント逐語: 「*This will preemptively abort on conflicts in workdir or index so there's no need to require a clean repo*」。clean index の rebase 中の checkout は通る |
| **git-cola**（GPL-2.0） | `MERGE_HEAD`/`rebase-merge`/`rebase-apply`/`CHERRY_PICK_HEAD` の**4状態を正しく検出**（ディレクトリ存在確認なので `rebase -i` も捕まえる） | **助言テキストとウィンドウタイトルだけ。** 無効化するのは "Start Rebase" ボタンのみ。`Checkout.do()` は argv を `git checkout` に素通し |
| **gitui**（MIT） | `RepoState::Rebase` のとき **commit をブロック** | **`rebase -i` を取りこぼす。** `asyncgit/src/sync/state.rs` は libgit2 の `RebaseMerge` **のみ**を `RepoState::Rebase` にマップするが、libgit2 は `GIT_REBASE_MERGE_INTERACTIVE_FILE` を先にチェックして `REBASE_INTERACTIVE` を返す → `RepoState::Other` → ガードが効かない。**そして `checkout_branch` にはガードが一切無い**（生の `checkout_tree` + `set_head`） |
| **amux**（MIT） | マージ時にベースブランチが期待の worktree に checkout されているか確認し、違えば拒否 | **HEAD の移動を守っているだけ**でシーケンサ状態は見ていない |

**`MERGE_HEAD` が無警告で消える件を警告するツールは1つも見つかりませんでした。**
（OpenHands 両リポジトリで `MERGE_HEAD` 0件、opencode ではリリーススクリプトのノイズ1件のみ。
Claude Code / Cursor / amux / clash / Devin / Jules / Factory / Amp のドキュメントに言及なし。）

### 主張2: クロスworktree の認識 → 🟡 半分反証

**反証された部分:** 「どのブランチがどの worktree に checkout されているか」は
**clash**（全 worktree 発見 + Conflict Matrix）、**amux**、**opencode**（`worktree list --porcelain`）、
**Claude Code**（`git worktree lock` + dirty/unpushed を検査する sweep）がやっています。

そして **GitUp が2026-07-27（5日前）に唯一の本物のクロスworktreeガードをマージしました**
（PR #2803、issue #2713 の修正）:
```objc
// Bail out *before* touching the working directory if the branch is checked out in another worktree.
if (git_reference_is_branch(branchReference) && !git_branch_is_head(branchReference)
    && git_branch_is_checked_out(branchReference)) {
  GC_SET_GENERIC_ERROR(@"Branch '%@' is already checked out in another worktree", branch.name);
```
起票者は2つの worktree を使うユーザで、**まさに我々のマトリクスの1セル**です。

**生存した部分（全ツールで0件を確認）:**
- **共有される `refs/stash` と `stash@{N}` のインデックスずれ** — 言及ゼロ。
  opencode で `refs/stash` 0件。**Gitless はむしろ危険で、
  ブランチ切替ごとに黙って共有 `refs/stash` に `git stash save` を積む**
- **`--ignore-other-worktrees` のガード** — 全5ツールで0件
- **全 worktree の HEAD を1枚のグラフに描く** — 誰もやっていない

### 主張3: クロスエージェント比較レビュー → 🟡 分裂

**反証:** ファイル重複と予測コンフリクトは **clash** がやっています（全ペア一括のマトリクス）。

**生存: マージ順序を推奨するツールは1つも見つかりませんでした。**
そして主要プラットフォームはこれを**やっていません** — この区別が重要でした:

| | 何をしているか |
|---|---|
| **Cursor `/best-of-n`** | **同じタスクを N モデルが競走 → 人間が1つ選ぶ。** ドキュメント逐語: 「**`/best-of-n` only compares the runs. This feature does not merge changes back into your main checkout.**」ファイル重複検出もコンフリクト予測もマージ順序も無い |
| **Claude Code `agent-view`** | セッション毎の行のみ（名前・活動・経過・状態・PR番号・要約）。明示的にクロス比較なし。`agent-teams` のコンフリクト対策は**散文のみ**: 「**ファイル衝突を避ける**: 2人が同じファイルを編集すると上書きになる。各担当が別のファイル集合を持つように作業を分割せよ」 |
| **Devin** | コーディネータが「スコープ設定、進捗監視、**コンフリクト解決**、結果のコンパイル」を担うと書いているが、**マージ順序のアルゴリズムもコンフリクト解析の機構もドキュメントに無い** |

### 主張4: 並行安全な git 実行 → 🟢 ほぼ生存

**この分野で最強の成果物が Python の `threading.Lock()` でした**（git-cola、プロセス内のみ、
書き込みパスのみ、`_readonly=True` はロックをスキップ）。

**全ツールで0件:**
- 読み取りパスへの **`GIT_OPTIONAL_LOCKS=0`**（opencode / OpenHands で0件）
- **`gc.auto` / `maintenance.auto` の無効化**（同0件）
- **`index.rock` のリトライ+バックオフ**の文書化
- **read→decide→write を跨いだロック保持**

Claude Code の `git worktree lock` は**worktree のライフサイクル**を守るもので、
git 状態の read→decide→write を守るものではありません。
**gc の並行 corruption 窓を認識しているツールは1つもありません。**

---

## 🎯 構造的に最も重要な発見

**主要クラウドプラットフォーム8/8 が、そもそもこの問題を回避しています。**

| 共有 `.git` を持つ | 持たない（各エージェントに独自の clone/VM/コンテナ） |
|---|---|
| **Cursor（ローカルモード）** | Cursor（クラウド）、Jules（VM+clone）、OpenHands（Docker/リモート）、Devin（セッション毎に隔離VM）、Factory Droid（Droid Computers）、Codex cloud、Copilot coding agent（Actions の一時環境）、Terragon、Tembo、Sketch→exe.dev（VM） |
| **opencode**（worktree） | |
| **amux**（worktree） | |
| **Claude Code**（worktree、明示的に文書化） | |
| **clash**（読み取り専用の観測者） | |

**つまり「N worktree で共有 `.git`」という前提自体が少数派で、
そこに投資しているのは Claude Code・Cursor ローカル・opencode・amux・clash の5つだけ。**

そして **Claude Code のドキュメントが共有を明示しています**:
> 「worktree は独自のファイルとブランチを持つが、**リポジトリの `.git` ディレクトリを共有する**」
> 「worktree 内の git コマンドはメインリポジトリの共有 `.git` に書き込み、
> サンドボックスはその書き込みを許可する」

---

## 🔴 そして2つのツールが、自分の issue トラッカーに我々の論点を書いています

| | |
|---|---|
| **tig #1420**（open、2026-04-24） | worktree ビューと「どの worktree がどのブランチを checkout しているかの表示」を要望。動機が逐語で「worktree の利用が増えている、**特に各自が独自の worktree で動作するエージェント型コーディングツールを使う開発者の間で**」 |
| **gitui #2995**（**未マージ**、2026-07-14） | Worktrees popup の提案。「**並行 worktree を立ち上げるツーリング**（および一般的なマルチworktreeワークフロー）に対して、アプリ内で見たり移動する手段が無かった — 別の worktree を指して終了・再起動する必要があった」。スコープは list/switch/create/remove/lock のみ |
| **GitUp #2803**（**マージ済み 2026-07-27**） | 上記のクロスworktreeガード1つ |

**需要は実在していて、しかもこの4ヶ月で急速に動いています。**

---

## ✅ 残った、防御可能な差別化

**narrowly かつ検証済みに述べると:**

| # | 内容 | 根拠 |
|---|---|---|
| **1** | **シーケンサ乗っ取りの pre-flight ガード** — clean index の rebase 中の checkout/commit/merge をブロックし、`checkout` が `MERGE_HEAD` を消す前に止める | 14+ツールで不在を確認。最も近い3つがどう届いていないかも特定済み |
| **2** | **共有 `refs/stash` の認識**と `stash@{N}` ずれの防止、`--ignore-other-worktrees` のガード | 全ツールで0件 |
| **3** | **全 worktree の HEAD を1枚のグラフに描く** | 誰もやっていない |
| **4** | **マージ順序の推奨** | clash が「まだできない」と明記。他は皆無 |
| **5** | **並行安全な git 実行** — `GIT_OPTIONAL_LOCKS=0` on reads、`gc.auto=0`、read→decide→write を跨ぐロック | 最強の既存実装がプロセス内 `threading.Lock()` |
| **6** | **統合**（エディタ + ターミナル + エージェント監督 + グラフが1アプリ） | clash は CLI+TUI、GitUp は macOS 専用スタンドアロン、lazygit はエディタの横に置く TUI |

**そして正直に降ろすもの:**
- ~~「グラフ + 履歴編集」~~ → lazygit と GitUp が全項目実装済み（第2回レビュー R2-1）
- ~~「クロスworktreeのコンフリクト予測」~~ → **clash がやっている**
- ~~「どのブランチがどの worktree にあるか」~~ → clash/amux/opencode/Claude Code がやっている

---

## 🔴 これを受けた提案

**差別化を「git 安全性」単独ではなく「安全性 + 統合」に置く。** 理由:

1. **安全性の5項目は本当に空白**で、しかも**我々が自分で実測した知見**（シーケンサ乗っ取り、
   `MERGE_HEAD` 消失、並行 worktree rebase の安全性）が根拠になる。借り物ではない
2. **しかし clash の存在が示すのは、安全性だけなら CLI+フックで足りる**ということ。
   実際 clash は Claude Code の `PreToolUse` フックとして動いている。
   **単機能なら我々は不要**
3. **だから統合が本体になる。** clash のマトリクスも lazygit の履歴編集も
   「エディタとターミナルとエージェント監督と同じ画面に、同じグラフの上に」は誰もやっていない

**そして戦術として: clash を敵にせず使う。** MIT で read-only なので、
**v1 では clash を依存として取り込んでコンフリクトマトリクスを表示し、
我々は「安全性ガード + 統合 + グラフ」に集中する**のが合理的です。
自分で `git merge-tree` を叩き直す価値は薄い。

**判断が必要な点:** これで「差別化」として十分か。
第2回レビューの指摘（「グラフは table stakes」）は正しく、
残ったものは**「地味だが実際に人が困っていることの解決」**です。
派手さは無いが、tig/gitui の issue が示す通り需要は実在しています。

---

## 未確認（正直に）

- **セッション上限で3エージェントが途中終了。** 未確認のまま:
  Fork / Tower / SmartGit / GitKraken / Sourcetree / Magit / vim-fugitive、
  **jujutsu（jj）** ← これが最大の未確認。**jj は index とシーケンサを設計で無くしており
  op log で並行操作を扱うので、このバグクラス全体を「ガードする」のではなく
  「起こり得なくする」可能性がある。要検証**
- `git-branchless`（**MIT OR Apache-2.0** — GitHub のサイドバーは Apache-only と誤表示）の
  スマートログと `git undo` がどこまでシーケンサを守るか
- GitLens の Worktrees ビュー + Launchpad の実機能、無料/Pro の境界
- GitButler の `crates/but-core/src/sync.rs` の現状（PR #13094 以降）
- Nimbalyst と mux の実機能（元の S0 対象）
- `git-imerge` / `git test-merge` / Graphite / GitHub の mergeability API による
  投機的マージ・マージ順序計画
- Aider / Charlie / Warp agent mode / Codex CLI のローカル worktree 対応

## ライセンス（学習可否）

| 学習・移植可 | 読むだけ（コピー不可） |
|---|---|
| **clash**（MIT）、**amux**（MIT）、**opencode**（MIT）、**lazygit**（MIT）、**gitui**（MIT）、**Gitless**（MIT）、**git-branchless**（MIT OR Apache-2.0、MIT の枝を採る） | **tig**（GPL-2.0）、**git-cola**（GPL-2.0）、**GitUp**（GPL-3.0）、**mux**（AGPL-3.0）、**gitamine**（GPL-3.0） |

⚠️ **GitUp が最も関連する先行事例なのに GPL-3.0 で読むだけ**というのが痛いところ。
`GCRepository+HEAD.m` のガードと `GCSnapshot`/`performReferenceTransformWithReason` の
ref トランザクション設計は**振る舞いを観察して自分で書き直す**必要があります。

## 出典

[clash](https://github.com/clash-sh/clash) ·
[amux](https://github.com/andyrewlee/amux) ·
[opencode](https://github.com/anomalyco/opencode) ·
[Cursor worktrees](https://cursor.com/docs/configuration/worktrees) ·
[Cursor 2.0](https://cursor.com/blog/2-0) ·
[Claude Code worktrees](https://code.claude.com/docs/en/worktrees) ·
[Claude Code agent-view](https://code.claude.com/docs/en/agent-view) ·
[Claude Code agent-teams](https://code.claude.com/docs/en/agent-teams) ·
[Devin advanced capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities) ·
[gitui #2995](https://github.com/extrawurst/gitui/issues/2995) ·
[tig #1420](https://github.com/jonas/tig/issues/1420) ·
[GitUp #2713](https://github.com/git-up/GitUp/issues/2713) ·
[GitUp PR #2803](https://github.com/git-up/GitUp/pull/2803) ·
[Gitless #67](https://github.com/gitless-vcs/gitless/issues/67) ·
[OpenHands sandboxes](https://docs.openhands.dev/openhands/usage/sandboxes/overview) ·
[exe.dev/sketch](https://exe.dev/sketch)
