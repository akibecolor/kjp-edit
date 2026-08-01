# 決定記録（2026-08-01）

[review-findings.md](review-findings.md) で「ユーザ決定事項」として上げた4件の決定と、
決定後に実施した裏取り調査の結果。

---

## 決定1: Markdown レンダラ → **B案（markdown-it + 自前ストリーミング層）** ✅

**「B案でもいけそうじゃない?」→ いけます。しかも想定よりずっと安い。実測で裏を取りました。**

### 決定的だったのは `remend` が単体で使えること

Streamdown を捨てる理由だった依存の中で、**未終端マークダウンの修復（`remend`）だけは
独立して再利用できる**ことが確認できました。

```typescript
const remend = (text: string, options?: RemendOptions): string
```

**remark プラグインではなく mdast でもなく、生の markdown 文字列を受けて文字列を返す。**
Apache-2.0、**実行時依存ゼロ**、~12.5 KB。`markdown-it@14` と実際に組み合わせて動作確認済み:

| 入力 | `remend()` の出力 | markdown-it の HTML |
|---|---|---|
| `this is **bol` | `this is **bol**` | `<p>this is <strong>bol</strong></p>` |
| `see [text](https://exa` | `see [text](streamdown:incomplete-link)` | リンクになる |
| `~~strike` | `~~strike~~` | `<p><s>strike</s></p>` |
| `Some text\n=` | `Some text\n=​` | `<p>` のまま（setext 見出しへの反転を抑止） |

使い方は `md.render(remend(buffer))` の1行。**これが省いてくれる作業は
ソース13ファイル・約1,700〜2,000行**（`emphasis-handlers.ts` だけで20KB —
強調の delimiter バランシングは本当に厄介）**+ テスト24ファイル。**
今回の調査で最も強い再利用ケースです。

⚠️ ライセンス注意: remend の npm tarball には LICENSE ファイルが同梱されていない
（`files` が `["dist", "README.md"]`）。`license: "Apache-2.0"` フィールドと
リポジトリルートの LICENSE が根拠なので、**Apache-2.0 §4 に従い LICENSE 本文を
手で attribution に入れる**必要があります。

### 実装コストの内訳（実測とソース確認ベース）

| 項目 | 行数 | 備考 |
|---|---|---|
| 未終端構文の修復 | **0** | `remend` を使う |
| フェンス対応の `lastBlockBoundary` + paragraph buffer | ~70 | **VS Code のものを移植（MIT）** |
| rAF バッチング + append-only ガード + フル再描画フォールバック | ~120 | 同上、アニメーション抜き |
| テーブルの修復（remend の穴） | ~60 | VS Code の `completeTable` の考え方 |
| サニタイズ設定 + テスト | ~50 | |
| **合計（メモ化なし）** | **~250〜300行** | **これが推奨** |
| （メモ化あり） | ~450〜550行 | 16KB超のドキュメントが必要になってから |

### VS Code の実装が「メモ化なしで十分」を証明している

`chatIncrementalRendering/` の `IncrementalDOMMorpher` のドキュメントコメント（MIT、逐語）:

> 「[…] レンダラは既存の markdown 描画パイプラインと*ともに*動作する。
> **各更新は標準の `doRenderMarkdown()` 経路を通して再描画される**ので、
> コードブロック・テーブル・KaTeX・その他すべての markdown 機能が正しく描画される。」

つまり VS Code の「インクリメンタル」は**インクリメンタルなパースではなく**、
(1) append-only ガード、(2) **rAF バッチング**（トークン到着数ではなく
フレーム数でレンダー頻度を上限する — これが本当のコスト制御）、
(3) いつ描画するかを決める差し替え可能なバッファ戦略、の3つだけです。

実測した O(n²) の爆発は本物で、**64KB のドキュメントを 40文字チャンクで流すと
素朴な全再パースは 42秒**、メモ化ありは 113ms。**しかし VS Code は中間の
「paragraph バッファ」版を出荷して問題になっていない** — rAF がレンダー数を
フレームで縛るのと、実際のチャット応答が 16KB 未満に収まるのと、
本当に高コストな部分（Monaco コードブロック）が別途プールされているからです。

### 🎯 そして Theia 側に再利用できるものは無く、逆に同じ問題を抱えていた

「Theia の AI チャットが既にストリーミング Markdown レンダラを持っているなら
再利用できるかもしれない」という期待は**外れました。**

`@theia/ai-chat-ui@1.74.0` の `markdown-part-renderer.tsx` は
`[markdownString]` をキーにした `useEffect` で、**変更ごとに新しい `markdownit()`
インスタンスを作り、全文を描画し、全体を DOMPurify に通し、コンテナの子を全削除して
再追加する。** スロットリングもデバウンスもブロック再利用もありません。
**Theia は素朴な O(n²) を、しかも VS Code より悪い形でやっています**
（毎回パーサ新規生成 + 全 DOMPurify + 全 DOM 破棄、rAF 合体なし）。

**さらに重要: `@theia/ai-chat-ui` は `mermaid: ^11.15.0` をハード依存に持っています。
Streamdown を却下した理由と同一の問題。** つまり Theia の AI チャットUIをそのまま使うと
mermaid が結局入ってきます。**`DiagramRenderer` を通す設計を守るなら、
チャットの markdown 描画部分も自前にする必要がある** — B案を採る追加の理由になりました。

⚠️ **そして Theia のサニタイザは絶対に真似しないこと。** プロンプトインジェクション可能な
入力に対して危険な方向に緩められています:
```typescript
const markdownIt = markdownit({ html: true }).use(markdownitemoji.full);
template.innerHTML = DOMPurify.sanitize(html, {
    ALLOW_UNKNOWN_PROTOCOLS: true,
    ADD_TAGS: ['iframe', 'frame'],
    ADD_ATTR: ['src','srcset','srcdoc','poster','href','xlink:href','data']
});
```
`html: true` + 未知プロトコル許可 + `iframe`/`srcdoc` の再追加。
クリック傍受と `blockExternalResources()` で補償していて**信頼できるコンテンツには
一貫した設計ですが、半信頼のLLM出力に対する姿勢ではありません。**

### サニタイズ: markdown-it の既定は安全。穴は1つだけ

既定は `html: false`, `linkify: false`, `typographer: false`。
そして **URL 検証が組み込みで全シンクをカバー**しています:
```typescript
const BAD_PROTO_RE = /^(vbscript|javascript|file|data):/
const GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/
```
`link.ts` / `image.ts` / `autolink.ts` / `linkify.ts` に適用されるので
**href・画像 src・autolink・linkify 済みURLが全部カバーされる。**
実測で `<script>` はエスケープ、`javascript:` リンクは非リンク化、
`java&#115;cript:` もエンティティデコード後に検証、`data:image/svg+xml` は
allowlist に無いので拒否（これは正しい）。

🚨 **唯一の実在する穴は `highlight` オプション。** fence ルールがハイライタの戻り値を
**生で挿入**し、`<pre` で始まると短絡します。実際に XSS が再現しました:
```
入力 : ```js\n<img src=x onerror=alert(1)>\n```
出力 : <pre class="hl js"><img src=x onerror=alert(1)></pre>   ← 実行される
```
**コード内容と言語文字列の両方が注入点。Shiki を繋ぐならエスケープは我々の責任。**

**最小の正しい設定:**
```js
const md = new MarkdownIt({
  html: false, linkify: false, typographer: false,
  highlight: (code, lang) =>
    `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`,
});
// さらに validateLink を allowlist に上書きする（既定は blocklist で probe 可能）
md.render(remend(buffer))
```

**DOMPurify は多層防御として残す。** 厳密には `html: false` なら不要ですが、
(1) `highlight` の実装ミスを拾う、(2) `validateLink` は blocklist で
`[c](java script:...)` が抜けることが実証された（悪用不可だが probe 可能）、
(3) プラグインを足すたびに攻撃面が増える、(4) プロンプトインジェクションが脅威モデルにある。
**ただし Theia とは逆に厳格に設定する** — `ALLOW_UNKNOWN_PROTOCOLS` なし、
`ADD_TAGS` なし、明示的な `ALLOWED_URI_REGEXP`。

### 採用構成

1. **`markdown-it@15`**（MIT、TS 化済み、活発。**`@theia/core` 経由で既にツリーに入っている**）既定のまま
2. **`remend@1.3.0`**（Apache-2.0、依存ゼロ、string→string）。LICENSE は手動で vendor
3. **VS Code の `ParagraphBuffer` + rAF morpher を移植**（~200行、MIT）。
   ただし**フェンススキャナは boolean ではなく fence の長さと文字を追跡するよう直す**
   （VS Code の実装は行頭の `` ``` `` で boolean を反転するので入れ子フェンスを誤カウントする）
4. **メモ化は最初は入れない。** VS Code が入れずに出荷している。16KB超が問題になってから
5. **Mermaid / KaTeX は `DiagramRenderer` レジストリの背後** — Streamdown 2.5.0 も
   `@theia/ai-chat-ui` もくれないもので、自作する唯一の構造的理由

**なお私の Streamdown 評は一部不正確でした:** mermaid は 2.0.0〜2.4.0 の4リリースで
**不在**で、2.5.0 で再追加されています。つまり **peerDependency 化は上流に交渉可能かもしれない**
（`@incremark/react` が差し替え可能パターンを実証済み）。B案を選ぶ判断は変わりませんが、
「構造的に無理」ではなく「今はそうなっている」が正確です。

---

## 決定2: ベース選定 → **B案（レイアウトを第一位から降ろし、G1 を第一位にする）** ✅

**Theia を維持。差別化の第一位を「レイアウト」から「コミットグラフ + 履歴編集（G1）」に移す。**

これで [review-findings.md](review-findings.md) #1 の矛盾が解けます。
Theia を選んだ理由の中核「フォーク不要（加算的なnpm拡張）」を保ったまま、
差別化を**コアのフォークを要求しない領域**に置くことになります。

| | 変更前 | 変更後 |
|---|---|---|
| 第一の差別化 | レイアウト（単一コンテナツリー） | **コミットグラフ + 履歴編集（G1）** |
| レイアウトの位置づけ | 差別化の核。D3 ルール1〜5 を完全実装 | **「Zed の具体的な不満を直す」まで。** コアのフォークはしない |
| Theia のフォーク | 単一ツリーのために `Area` / `LayoutData` / `SidePanelHandler` を書き換え = 実質フォーク | **しない。** サブクラス + rebind の範囲に留める |

### レイアウトで「どこまでやるか」の新しい線引き

コアをフォークしないと決めたので、D3 の5ルールは達成度が変わります。

| ルール | 新しい扱い |
|---|---|
| **1. ズームは可逆なジオメトリ交換** | ○ やる。ただし Theia の `doToggleMaximized` はエリア単位・全ウィンドウオーバーレイ・比率サイズなので、**`maximizedElement` と `unmaximize` スロットを流用して、粒度をノード単位に、オーバーレイを非全画面に、サイズを非比率に作り替える** |
| **2. ズーム中の構造変更** | ○ やる（1の一部） |
| **3. すべてのパネルが同一ツリー** | **△ 降ろす。** `Area` が閉じた union で111ファイルが消費しているので外部から広げられない。**代わりに「ファイルツリーを消さずにエディタをズームできる」という*結果*だけを取る**（= Zed #32715 の解決） |
| **4. 非比率サイジング** | ○ やる |
| **5. focus parent** | **△ 降ろす。** 共通ノード型が無いので `mainPanel` 内に限定。エリアを跨ぐ focus parent は諦める |

**受入テストも現実的なものに変える。** 「Zed の issue 全部が起こらない」ではなく、
**「ファイルツリーを見えたまま単一エディタタブをズームでき、解除でサイズがバイト単位で戻る」**
（#32715 + #52584 の解決）を Phase 2 の合格線にします。
これは `PerspectiveService` + 一般化した `doToggleMaximized` の範囲で届く可能性が高く、
届かなければそこで初めてコアフォークのコストを判断します。

---

## 決定3: git の共存方針 → **kjp-core が git を完全に所有し、`vscode.git` をビルドから除外する** ✅

### ⚠️ ただし先に、決定2との構造的な衝突を指摘します

いただいた回答は「①ツリー構造と差分の表示、②チェックアウトなどができれば良い。
**ビューア側面が大きいので②はCLIに委ねても良い**」でした。

**これをそのまま読むと決定2の前提が消えます。**
①（グラフ + 差分の表示）だけなら、それは **VS Code 1.93 と Theia 1.71 が既に出荷しているもの**で、
差別化になりません。そして決定2は「G1（コミットグラフ + **履歴編集**）を第一位にする」でした。
**②を落とすと第一位の差別化が無くなります。**

### 解決: 「CLIに委ねる」の解釈を1つに絞れば両立します

「CLIに委ねる」には2つの読みがあって、片方は決定2を壊し、片方は壊しません。

| 読み | 内容 | 決定2との関係 |
|---|---|---|
| **(a)** | ユーザが自分でターミナルに git コマンドを打つ。アプリは変更UIを持たない | **決定2が死ぬ** |
| **(b)** | **アプリの変更操作は git をシェルアウトして実装され、そのUIがグラフである** | **決定2が生きる** |

**(b) を採ることを推奨します。そしてこれは既に我々の設計です** —
research.md で「`git log --topo-order` をシェルアウトする」と決めた時点で、
**git CLI が我々の変更エンジンでもある**ことになっています。

つまり:
- **グラフは選択面。** コミットを選ぶ
- **変更操作は git コマンドとして組み立てられ、デーモンが自分のロックの下で実行する**
- **実行前にコマンドを見せる／編集させる**（Sublime Merge がやっていること）

**②が安いのは、まさに実行を git CLI に委ねているからです。**
高コストなのは rebase を自分で実装することで、それはやりません。
「委ねる」と「差別化」は対立しません。

### v1 / v2 の切り分け

| | 内容 | いつ |
|---|---|---|
| **① グラフ + 差分の表示** | DAG のレーン描画、仮想化、差分ビュー | **v1（Phase 4 前半）** |
| **②-a ナビゲーション** | checkout、ブランチ作成/切替、コミット選択 | **v1。**グラフが使い物になるために必要で、かつ安い |
| **②-b 履歴編集** | interactive rebase / 並べ替え / squash / **コミット分割** / **過去への fixup** / worktree間 cherry-pick / **reflog 救出** | **v1 の後半。ここが差別化の本体。** 「グラフで選ぶ → git コマンドを組み立てる → 見せる → 実行する」 |
| クロスエージェントレビュー | 全ブランチを1枚のグラフに描き、ファイル衝突とマージ順序を可視化 | v2 |

**「40個の『fix tests』コミットを3つに整形する」を、グラフ上の操作 →
生成された git コマンドの確認 → 実行 で完遂できる**のが Phase 4 の合格線です。

### そして共存の判断: `vscode.git` を除外する

裏取り調査で判断材料が揃いました。**レビューの「git エンジンが2つ」という指摘は
過大評価でしたが、除外する理由は別にありました。**

**まず良いニュース: 現代の Theia には第2の git エンジンは無い。**
`@theia/git` は 1.61.0 で publish 停止、**1.70.0（2026-03-26、PR #17148）で完全削除**。
Theia 1.74.0 の `packages/` に `git` はありません。`@theia/scm` はUIフレームワークのみで、
**`vscode.git` が唯一の git アクタ。**

**そして `vscode.git` は思ったより礼儀正しい:**
- **`GIT_OPTIONAL_LOCKS: '0'` を status に設定している**（`extensions/git/src/git.ts:2745`、2017年から）。
  これが無ければ常時 `index.lock` を取り合うことになる唯一の経路
- ポーリングはタイマーではなく**ウォッチャ駆動 + フォーカスゲート**。
  **フォーカスされていないウィンドウは status を更新すらしない**
- ウォッチャのフィルタが**`index.lock` を明示的に除外**しているので、
  我々のロックファイルがフィードバックループを起こさない
- `RepositoryIsLocked` を**約19秒リトライ**してくれる

**それでも除外する理由が2つ見つかりました。**

**理由1: 未文書の自律的な `.git/config` 書き込み。**
`Operation.Status` が `readOnly: false` と宣言されていて、`historyProvider.ts` が
非readOnly操作を購読し、ブランチ名の変化を見て
**`branch.<name>.vscode-merge-base` を `.git/config` に書き込む**（`.git/config.lock` を取る）。
**ユーザ操作ゼロで発火する連鎖:** 我々のデーモンが `git checkout -b feature` →
`.git/HEAD` 変化 → DotGitWatcher → 1秒デバウンス → ウィンドウがフォーカス中 →
`status()` → history provider がブランチ変化を検出 → **config 書き込み。**
ゲートは `git.autorefresh`（**既定 true**）のみ。

**理由2: autofetch が唯一の実corruption窓に繋がっている。**
`git.autofetch`（既定 false）が有効だと `git fetch` を自律実行し、
`git.ts:2388` は `['fetch']` を `--no-auto-gc` **なしで**組み立てます。
git-fetch のドキュメントによれば auto-maintenance は「既定で有効」なので、
**repack と loose object の prune が走りうる。**
そして git-gc(1) の NOTES が認めている唯一の corruption 窓がこれです:

> 「'git gc' が他のプロセスと並行して走ると、他のプロセスが使っているが
> まだ参照を作っていないオブジェクトを削除するリスクがある。[…]
> **他のプロセスが後でその削除済みオブジェクトへの参照を追加すると
> リポジトリを壊す可能性がある。**」

**オブジェクトは全 worktree で共有されるので、worktree 分離はこれに対して無力です。**

### 実施すること（優先順）

1. **`theiaPluginsExcludeIds: ["vscode.git"]`** でビルドから除外する
   （`vscode.extension-editing` の除外に既に使われている仕組み。
   ⚠️ `"vscode.git"` で実際に効くかは類推で未検証 → スパイク項目）。
   代替は `git.enabled: false`（**完全なキルスイッチであることが検証済み** —
   `createModel()` が走らず、`SourceControl` 登録も FS ウォッチャも AutoFetcher も無い）。
   ⚠️ ただし live-reactive なので**実行時に true に戻すと全部が武装する**
2. 🛑 **SCM ビューを隠すのは無意味**（検証済み）。activation と refresh の経路は
   ビューの可視性を一切読んでいない。**隠す ≠ 無効化**
3. **デーモンは lazygit の姿勢を採る: 読み取り専用の呼び出し全てに `GIT_OPTIONAL_LOCKS=0`。**
   書き込みには付けない。lazygit は2019年から全コマンドに既定で付けていて、これが業界最良の姿勢
4. **リポジトリ config に `gc.auto=0` + `maintenance.auto=false` を設定し、
   `--prune=now` を絶対に使わない。** メンテナンスは自分のロックの下でデーモンから走らせる

### 🚨 そして「git エンジンが2つ」より深刻な問題が見つかりました

**レビューが指摘した「2エンジン」よりも、シーケンサが無防備なことによる
サイレントなデータ喪失の方が危険です。しかもこれはエンジンが1つでも起きます。**

**rebase が clean index で停止しているとき（`git rebase -i` の `break` など）、
ガードがほぼ全部消えます**（実測、git 2.48.1）:

| rebase 中・clean index でのコマンド | 結果 |
|---|---|
| `git checkout main` | **exit 0** 「Switched to branch 'main'」 |
| `git commit` | **exit 0** |
| `git merge topic` | **exit 0** |
| 2回目の `git rebase` | exit 128（拒否される） |

`.git/rebase-merge` は `head-name=refs/heads/topic` のまま残り、
その後の **`git rebase --continue` が間違ったブランチにリプレイする**
（`HEAD` が今どこを指しているかにリプレイするので）。reflog が証拠を残します。

**さらに insidious なもの: `MERGE_HEAD` の消失。**
コンフリクトを解決してコミットしていない状態（index clean、`MERGE_HEAD` あり）で
**`git checkout -b other` が成功し、`MERGE_HEAD` を削除する。**
続く `git commit` は**単一親のコミット**を作ります —
マージした内容はあるがマージの*関係*が消え、`git branch --merged` に出ず、
再マージすると再度コンフリクトする。**どの時点でも exit 0 で警告も無し。**

**対策（安く、実際にデータを失うクラスを捕まえる）:**
- **すべての変更操作の前に pre-flight チェック:**
  `.git/worktrees/<n>/rebase-merge/head-name` と `HEAD` を比較し、
  `MERGE_HEAD` / `CHERRY_PICK_HEAD` の存在を確認する
- **ロックは write の周りだけでなく read→decide→write を跨いで保持する**
  （GitButler の postmortem: 「リポジトリ変更に DB セマンティクスが必要」）
- **worktree 間で `git stash` を禁止する。** `refs/stash` は共有で、
  `stash@{N}` のインデックスが他の worktree の push でずれる（実測済み）。
  エージェント毎のコミットか private ref を使う
- **`--ignore-other-worktrees` と `worktree add --force` を絶対に使わない。**
  worktree-per-agent を安全にしている唯一のガードを無効化する

### 良いニュース: worktree 分離は思ったより強い

- **`index` は worktree 毎**（`.git/worktrees/<name>/index`）。
  **`index.lock` の競合は worktree 境界を越えない** — 想定より良い
- **2つの worktree が同時に rebase しても安全（実測検証済み）。**
  40コミットずつを10コミット進んだ main に対して真に並行で rebase →
  両方 exit 0、両方正しく51コミット、`fsck` clean。
  シーケンサ・HEAD・index が worktree 毎で、オブジェクト書き込みは
  content-addressed で冪等、ブランチ ref が別なので `.lock` が衝突しない
- ブランチ衝突ガードも効く: `fatal: 'featB' is already used by worktree at '...'`

---

## 決定4: フェーズ順序 → **G1 の前提検証を最優先の S0 に繰り上げる** ✅

「設計的に妥当ならよい」ということなので判断します。

**レビューの指摘は正当で、決定2によってさらに重くなりました。**
決定2で G1 を第一の差別化にしたので、**「G1 が本当に空白か」の検証が
プロジェクト全体の最重要スパイクになりました。** それが現状 S5「軽い、並行実施可」に
置かれていて、最大のフェーズ（Phase 4）をゲートしています。順序が逆です。

### 新しい Phase 0 の順序

| | 内容 | 工数 | なぜこの位置 |
|---|---|---|---|
| **S0** 🔴新 | **G1 の前提検証。** Nimbalyst の「git log視覚拡張」と mux の「git divergence UI」を実際に触る。VS Code 1.93+ の組み込み Source Control Graph、GitLens の Commit Graph、Theia 1.71 のグラフも触る。**問い: グラフ中心の履歴*編集*を既にやっているものはあるか** | **半日** | **決定2により第一の差別化の前提。どれかが Sublime Merge 級なら製品論拠を組み直す。最も安いチェックが最も高価な作業をゲートしている** |
| **S0b** | Theia 1.71 のグラフを5万コミットのリポジトリで動かす | 半日 | v1 の土台に使えるかの判定。S0 と同時にできる |
| **S1** | シェルのサブクラス化とレイアウト（[spikes.md](spikes.md)） | 1〜2日 | 決定2でスコープが縮んだので、**Step 3/4/6（単一ツリー系）の重みが下がり、Step 5（ズーム）が最重要になった** |
| **S1b** 🔴新 | **ズームの受入確認: ファイルツリーを見えたまま単一エディタタブをズームする**（Zed #32715 / #27237 相当） | 半日 | 決定2の新しい Phase 2 合格線そのもの |
| **S1c** 🔴新 | **Monaco マルチインスタンス測定。** 3〜4言語で 8〜12 タイル、開閉サイクル、RSS 増加と dispose リーク | 半日 | 要件5（多数の並列パネル）に対する未回答。research.md 自身が「CM6 のモデルが正しい形」と書いたのに検証していない。**失敗するとベースへのもう一票になる** |
| **S2** | バックエンドを kjp-core の器にする（[spikes.md](spikes.md)） | 1〜2日 | ⚠️ Step 3 の PASS 基準を修正すること（`FRONTEND_CONNECTION_TIMEOUT=-1` だと失敗し得ない） |
| **S2b** | Theia を実機のスマホで開く | 10分 | |
| **S2c** 🔴新 | **theia#16275: browser ターゲットで webview がサンドボックス組み合わせでブロックされるか** | 半日 | 2クライアント設計を刺す既知の非対称性。自分で「早めに確認する」と書いて Phase 0 に入れていなかった |
| **S2d** 🔴新 | **`theiaPluginsExcludeIds: ["vscode.git"]` が実際に効くか**（決定3） | 1時間 | 類推で未検証 |
| **S4** | ACP でユーザのローカル CLI を駆動 | 1日 | ⚠️ 「モバイルクライアント4つがタダ」は**未検証の主張**（ACP に WebSocket トランスポートが無い）。Agmente をスタブ `/acp` に向けて確認するステップに格下げ |
| **S5** | 残りの未確認項目 | 並行 | S0 に繰り上げた分を除く |

**S3（旧 Theia グラフ検証）は S0b に統合。** 旧 S1 の Step 8（perspectives 評価）は
決定2により**より重要になった**ので S1 内で優先度を上げます。

---

## この決定で変わらなかったこと

- D1（ヘッドレスデーモン）、D2（サーバ権威・CRDT なし）、D4（ACP）、
  D5（セカンダリは別実装）、D6（iframe 既定）、D7（サインアップ不要）は維持
- ベースは Theia のまま（決定2 は「何のために買っているか」を変えただけ）
- git はシェルアウト（決定3 で「Theia に他の選択肢が無い」に加えて
  「`vscode.git` を除外する」が決まった）
- [review-findings.md](review-findings.md) の BLOCKING のうち #1（ベース選定）は決定2で、
  B1（Markdown）は決定1で、#10（git 共存）は決定3で、#4/B4（順序）は決定4で解決。
  **残る BLOCKING は #2（D1 の記述が実態と違う）・#3（ズーム評価の訂正済み、Phase 2 再定義は決定2で対応）・
  #5（tmux と ACP stdio の非両立）・A1〜A3（修正済み）。#2 と #5 は次に片付ける。**

## 出典

[remend source](https://github.com/vercel/streamdown/tree/main/packages/remend) ·
[VS Code chatIncrementalRendering](https://github.com/microsoft/vscode/tree/main/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatIncrementalRendering) ·
[VS Code markdownRenderer.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/markdownRenderer.ts) ·
[Theia markdown-part-renderer.tsx](https://github.com/eclipse-theia/theia/blob/master/packages/ai-chat-ui/src/browser/chat-response-renderer/markdown-part-renderer.tsx) ·
[markdown-it src](https://github.com/markdown-it/markdown-it/blob/master/src/markdownit.ts) ·
[vscode extensions/git/src/git.ts](https://github.com/microsoft/vscode/blob/main/extensions/git/src/git.ts) ·
[git-worktree(1)](https://git-scm.com/docs/git-worktree) ·
[git-gc(1) NOTES](https://git-scm.com/docs/git-gc) ·
[lockfile.h](https://github.com/git/git/blob/master/lockfile.h) ·
[gitlens#163](https://github.com/gitkraken/vscode-gitlens/issues/163) ·
[gitbutler#13094](https://github.com/gitbutlerapp/gitbutler/pull/13094) ·
[lazygit#2050](https://github.com/jesseduffield/lazygit/issues/2050) ·
[IJPL-105821](https://youtrack.jetbrains.com/issue/IJPL-105821)
