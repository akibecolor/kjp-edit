# v0 実装コードの敵対的レビュー — 指摘と対応

`docs/review-findings.md` と `docs/review-2.md` は**設計文書**へのレビュー。
これは v0 の**実装コード**（`v0/*.mjs`, `v0/index.html`, `scripts/verify.mjs`）に対して
別エージェントが行ったレビューの記録。

指摘は10件。全件対応済み。以下、レビュー側の指摘 → 実際の原因 → 対応。

---

## #1 🛑 `v0/git.mjs` に生の NUL バイトが入っており、git が binary と判定していた

**レビュー側の言い方:**
> 「git の正典レシピ」を実装した唯一のファイルが、diff・grep・レビューのすべてから
> 見えない状態で main に入っている。

**原因:** `toNFC` の正規表現を生の文字で書いた。

```js
// ❌ ソースに生の NUL (0x00) と U+0080 が埋まる
? s => (/[^<NUL>-<U+0080>]/.test(s) ? s.normalize('NFC') : s)
```

git は先頭 8000 バイトに NUL があるとファイルを binary と見なすので、
`git diff` は `Binary files differ` しか出さず、`git log -p` に差分が出ず、
`git grep` も当たらない。**レビュー不可能なファイルが1本あった。**

**対応:** エスケープ表記に修正。

```js
? s => (typeof s === 'string' && /[^\x00-\x80]/.test(s) ? s.normalize('NFC') : s)
```

**修正時に踏んだ二次事故:** `node -e "..."` で置換しようとしたら、
bash → `node -e` → テンプレートリテラルの3段でエスケープが失われ、
NUL が消えずに移動しただけ（3039 → 3456）になり、さらに別の行のコメントを壊した。
**生の制御文字を含む置換は、シェルを経由しないスクリプトファイルとして実行すること。**
→ `CLAUDE.md` に規則として追記。

---

## #2 / #3 解決できない ref ひとつでエンドポイント全体が 500 になる

**原因:** `guessBase()` は `origin/HEAD` を候補にするが、remote 側でブランチが消えても
`refs/remotes/origin/HEAD` は残る。これが `log()` に渡ると git が失敗し、
`collect()` が throw して `/api/v0/state` が 500 になる。
worktree ごとの `mergeBase`/`aheadBehind` も同様に生 ref を渡していた。
bare worktree に `git status` を叩いていたのも必ず失敗する経路。

**対応:**
- `refMap()` で全 ref を **1プロセス**で OID に解決した表を作り、`resolveRef()` で表引き
- `log()` に渡す前に解決できない ref を捨てる
- bare worktree は作業ツリーが無いので status/sequencer を飛ばす
- prunable worktree は実体ディレクトリが消えているので `spawn` の `cwd` に使わない（ENOENT）

**回帰テスト:** 「解決できない `--base` を渡してもエンドポイントは生きている」
「worktree のディレクトリが消えても他の worktree は返る（500 にしない）」

---

## #4 `worktreeStatus` が rename を二重にカウントしていた

**原因:** `git status --porcelain=v2 -z` の rename/copy エントリは
`2 <XY> ... <path>` NUL `<origPath>` の**2トークン**。
NUL をレコード区切りとして扱っていたので `origPath` が独立エントリに見え、
旧パスが `1 `/`2 `/`? `/`u ` で始まっていると変更数が増えた。

**これは `log()` の `%D` で踏んだのと同じ罠**（NUL 区切りの多義性）を別の場所で
繰り返していたということ。

**対応:** `2 ` を見たら次のトークンを読み飛ばす。`u `（未解決）を別カウントにして
UI に「未解決 N」を出すようにした。

---

## #5 マージの第二親レーンが、何にも繋がらずに突然生えていた

**原因:** `computeSwimlanes()` は第一親の着地レーン（`firstParentLane`）しか
記録していなかった。`index.html` は第二親のレーンをどこから引けばいいか分からず、
行の中央から下向きの縦線だけを描いていた。

**対応:** `mergeParentLanes: number[]` を追加。
`index.html` 側は「この行で新しく開いたレーン」と「既に開いていたレーンへの合流」を
区別して描く（前者はドットから、後者は縦線＋ドットからの分岐線）。

---

## #6 レーン色が6本目で衝突していた

**原因:** `LANE_COLORS` が5色しかなく、さらに `nextColor()` が
**今開いているレーンの色を見ずに**順送りしていた。エージェント用ブランチが
6本並ぶと隣接レーンが同色になり区別できない。

**対応:** パレットを10色に拡張し、`nextColor(avoid)` が
「現在開いているレーンで使われていない色」を選ぶようにした
（本質はこちら。パレット拡張は選択肢を確保するため）。

---

## #7 basename が衝突する worktree の変更が混ざっていた

**原因:** `overlaps` と `headBy` を `wt.name`（パスの basename）でキーにしていた。
`~/a/agent` と `~/b/agent` はどちらも `agent` になるので、
別 worktree の変更が同一視され、ファイル重複検出が1本に潰れていた。

**対応:** キーを `wt.path` に変更。表示名は `assignLabels()` が
衝突時のみ親ディレクトリを付けて一意化する（`a/agent`, `b/agent`）。
payload には `name`（一意な表示名）と `basename` の両方を入れた。

**回帰テスト:** 「basename が衝突する worktree の変更が混ざらない」

---

## #8 payload に来ている情報を UI が描いていなかった

**原因:** `prunable` / `bare` は payload にあったのにバッジが無く、
シーケンサ状態は `warnings` しか払い出していなかったので
「rebase 中」「merge 中」が UI から見えなかった。
壊れた worktree は数字が 0 のまま静かに並ぶだけで、理由が分からない。

**対応:**
- payload に `sequencer` の全状態（rebasing/merging/cherryPicking/reverting/bisecting）を追加
- `prunable` / `bare` / 進行中シーケンサのバッジを描画
- 収集が部分的に失敗したことを `errors[]` として payload に載せ、UI 上部に出す
  （壊れた worktree が黙って一覧から消えるのを防ぐ）

---

## #9 worktree 11本で1リクエスト 59 プロセス起動

**最初に書いた対策が間違っていた:** 短い TTL キャッシュを入れたが、
**ブラウザのポーリングは15秒間隔なので 1.5 秒の TTL を毎回跨ぐ** — 何も削減しない。
さらにこのキャッシュはスモークテストを偽陰性にした（リポジトリを変更した直後に
素で読むと古い payload が返り、シーケンサ乗っ取り検出が落ちた）。

**実際の対策（プロセス数そのものを削る）:**

| 削ったもの | 方法 |
|---|---|
| worktree ごとの `rev-parse --verify` | `refMap()` で全 ref を1プロセスで解決し表引き |
| worktree ごとの `rev-parse --git-dir` | `<commonDir>/worktrees/*/gitdir` を fs で読む（spawn 0） |
| worktree ごとの `merge-base` | `base...ref` の三点記法が内部で merge base を計算するので不要 |

**実測（`stats.gitSpawns` として payload に載せている）:**

```
定数 5 (worktree list / for-each-ref / git-common-dir / origin/HEAD / log)
+ worktree 1本あたり 3 (status / rev-list / diff)
```

worktree 1本で **8**（測定値、式と一致）。11本なら 59 → **38**。

TTL キャッシュと in-flight 合流は残したが、効くのは
「同時に来た複数リクエスト」（複数タブ・再読込連打）だけと明記した。
状態を変えた直後に読む場合は `?fresh=1` が必要。

**回帰テスト:** 「1回の収集で git を起動する回数が worktree 本数に比例して爆発しない」
— コメントに書くだけでは回帰を防げないので、`stats.gitSpawns` を
`worktrees * 4 + 6` で固定した。

---

## #10 `verify.mjs` が `index.html` を検証対象にしていなかった

**これが #5 / #6 が緑のまま通り抜けた構造的な原因。**
`scripts/verify.mjs` は `*.mjs` にしか `node --check` をかけていなかったので、
`index.html` の `<script type="module">` は構文エラーすら検出されなかった。

**対応:** HTML から `type="module"` の script を抽出して一時 `.mjs` に書き、
`node --check` にかける。`type="module"` が1つも見つからない場合も失敗にする
（抽出の正規表現が壊れたことに気付けるように）。

---

## 自分のテストが間違っていた件（2回目）

`ten sibling branches all get distinct lane colors` で
「兄弟10本は lane 0..9 に並ぶ」と書いたが、**実装が正しくテストが誤り**だった。
兄弟が同じ親に即座に合流する場合、開いているレーンは1本に畳まれるので
2本目以降の枝先は毎回「最初の空きスロット = 1」に座る。
同じ行に2つの点が出るわけではないので視覚的な衝突は起きない。

テストを2つに分けた:
- 10本が**同時に開いたまま**になる形（各枝が固有の親を持つ）で色の衝突を検証 ← 本題
- 兄弟が1本の親に合流する場合はスロット1を再利用することを明示

**前回も同じことをやっている**（「max output lanes は 2」と書いたが 1 が正しかった）。
グラフアルゴリズムのテストは、期待値を手で決める前に
「その形で何が起きるのが正しいのか」を先に言語化する必要がある。

---

## 検証状況

```
✔ syntax (6 mjs, 1 html)
✔ unit (12 pass, 0 fail)
✔ smoke (13 pass, 0 fail)
```

新規の回帰テスト:
- unit: マージの第二親の着地レーン記録 / octopus マージ / 既存レーンへの合流 /
  10本同時オープン時の色の一意性 / 兄弟のスロット再利用
- smoke: プロセス起動数の上限 / prunable worktree で 500 にしない /
  basename 衝突の分離 / 壊れた `--base` での縮退
