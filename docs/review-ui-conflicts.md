# 統合 UI・コンソール・衝突予測の敵対的レビュー — 指摘と対応

3回目のレビュー。1回目は読み取り専用のコア（`docs/review-v0-code.md`）、
2回目は書き込み・実行（`docs/review-write-exec.md`）。
今回は **UI 統合・実行コンソール・衝突予測・順序提案** を別エージェント2名に。

- レビュア1: 統合 UI とコンソールのクライアント側。**CDP でブラウザを実際に駆動**して
  クリック・入力・実行し、プロセスの生存やブロック時間を実測した
- レビュア2: 衝突予測・順序提案・git 呼び出し。**16 worktree のフィクスチャ**で実測した

BLOCKING 4件、SERIOUS 11件。全件対応済み。

---

## 🚨 BLOCKING

### 1. merge driver で任意コード実行（`--allow-write` すら不要）

`core.fsmonitor` と同じクラスの穴。コミット済みの `.gitattributes`（`*.txt merge=evil`）と
`.git/config` の `[merge "evil"] driver` の2つで、**`/api/v0/state` を1回叩くだけで
デーモンの env ごとコードが走る。**

レビュアがビーコンで実証し、環境変数の持ち出し（`env leak: daemon-token-abc123`）まで再現した。
N 個のエージェントが同じ common dir を共有する前提のツールなので、
1本が `.git/config` を書けば他を見ているだけのデーモンが実行してしまう。

対応: `mergeDriverNames()` で列挙し `-c merge.<n>.driver=false` で潰す。
潰すと保守的に「衝突」側へ倒れるので、無効化したことを `errors` に出す。
ペアが無いときは列挙もしない（プロセスを増やさない）。

### 2. `merge-tree` の exit 1 は「衝突」と「マージできない」の両方だった

`merge-tree main no-such-ref` は **exit 1 で stdout 0 バイト**。区別していなかったので
`{clean:false, conflicts:[]}` = **「衝突している。ただし衝突ファイルは0件」という嘘**を返し、
それがそのまま衝突グラフの辺になって UI に「このペアは衝突する」と表示されていた。

| 引数 | exit | stdout |
|---|---|---|
| `main no-such-ref` | 1 | 0 バイト |
| `<oid>^{tree} main` | 1 | 0 バイト |
| `main orphan`（merge base 無し） | 128 | 0 バイト |
| 正常な衝突 | 1 | tree OID + 衝突パス |

対応: tree OID が出ているかで判別し、出ていなければ throw。
衝突と言うなら1件以上あるはずなので0件でも throw。

### 3. worktree の増減で走っているコンソールが破棄され、子プロセスが 600 秒残る

集合キー（path を `|` で連結）が変わると全ペインを作り直す作りで、
**worktree はアルファベット順で中間に挿入されるので1本増えれば必ず全滅**した。
しかも `abort()` していなかったので、サーバから見れば切断ではなく
`res.on('close')` が発火せず、子プロセスが `--exec-timeout`（既定600秒）まで走り続けた。

**エージェントが worktree を作る/片付けるのは日常操作で、15秒ポーリングが必ず拾う。**
4回で `MAX_CONCURRENT_EXEC=8` を使い切り、以降すべての実行が 429 になる。

対応: ペインの id を worktree path にして **id 単位の差分更新**に変更。
`dropPanes()` が捨てる前に必ず `abort()` する。

| | 修正前 | 修正後 |
|---|---|---|
| 増減後の実行中ペイン | 0（全滅） | **2（保たれる）** |
| term の文字数 | 0 | **368** |
| 監査ログ | start 2 / exit 0 | **start 1 / exit 1**（abort が効いた） |
| beacon ファイル | 増え続ける | **止まった** |
| 直後の8本 exec | 200×6 / 429×1 | **200×8** |
| 取り残しプロセス | 2個 | **0個** |

⚠️ 検証の途中で分かったこと: **実行中プロセスの cwd がある worktree は
Windows では `git worktree remove` できない**（Permission denied）。
abort の検証は「表示上限からペインを追い出す」形で行った。

### 4. 端末描画が出力量に対して二次で、UI が数十秒固まる

イベントごとに `scrollHeight` を読む＝**強制同期レイアウト**で、対象は上限なしに伸びる
`white-space: pre-wrap` の塊。コストが総文字数に比例するので全体で二次になる。

対応: `requestAnimationFrame` で1回にまとめ、追従判定は `scroll` イベントで真偽値として保持、
4000 要素で刈り込む（捨てたことを画面に出す）。

| 行数 | 修正前 | 修正後 |
|---|---|---|
| 1,000 | 498ms / 最大ブロック 189ms | **218ms / 2ms** |
| 4,000 | 6,437ms / 6,131ms | **232ms / 17ms** |
| 12,000 | 53,836ms / **28,904ms** | **693ms / 468ms** |

28.9秒の単一ブロック中は停止ボタンも自動更新も効かない。
プリセットの `cmd /c npm test` や `claude -p` は 2〜4MB を普通に出すので、
BLOCKING 3 と合わせて「固まって止められない → タブを閉じる → 子プロセスは生き残る」に直結していた。

---

## SERIOUS

| | 内容 | 対応 |
|---|---|---|
| `MAX_PAIRS` の偏り | 二重ループなので owners[0] と全員のペアで枠が埋まり、実測で「w2〜w8 同士が1つも検査されない」。**その結果 batch に実際に衝突するペアが3組入った**（提案の中核が誤り） | ラウンドロビンで各 worktree に最低1本配る。**batch の条件を「全ペアが検査済みかつ clean」に変更**し、未検査は `unknown` に落とす。同一 OID の worktree を畳む（実測で12枠中8枠を無駄に消費） |
| rename/rename の取りこぼし | overlaps が新パスしか登録せず `a→b` と `a→c` が候補にならない | 候補生成用の索引に旧パス（`f.from`）も入れる |
| merge base 無し | `changedFiles` の失敗を catch で飲んでいたので、git merge が門前払いする worktree が「安全に取り込める塊」の先頭に並んでいた | `noMergeBase` として記録し `errors` に出し候補から外す |
| ラベル衝突 | `x/same/dup` と `y/same/dup` が同ラベルになり自己ペアが生まれ、`merge-tree main main` = exit 0 で **本当は衝突する2本が clean と報告**された | 候補を path でキーにする。`planMerge` 側でも重複ラベルと自己ペアを弾く |
| deferred 同士の衝突が見えない | 「a を入れて b と c を手当」と読めるが b と c も衝突する（2周目の驚き） | `conflictsWith` を全隣接に戻し、`conflictsWithBatch` / `conflictsWithDeferred` に分ける |
| `openDiff` の holder セレクタ | `div > div:last-child` が `wrap` 自身を掴み、**タブ列を消していた**（実測 .tabs 1→0） | DOM を後から探すのをやめ、ペインオブジェクトに `holder` を持つ |
| ファイラから別 worktree のペインへ書き込み | **ヘッダは agent-a なのに中身は agent-b**（観測ツールとして最悪の誤り） | その worktree のペインを探す。無ければ理由を出して開かない |
| 差分ペインの序数 id | worktree 入れ替わりで**同名ファイルなら黙って別 worktree の内容に**。取り残しペインが二重に並ぶ | id を path 由来にし、復元キーを `worktree+path` に |
| 上限の無告知 | 10本で コンソール4/差分2 しか出ないのに理由の表示なし（`docs/performance.md` は10本を想定上限と掲げている） | 「他 N 本は表示していません（上限 M）」を出す |
| 警告が下端を食い潰す | `#alerts` が 22vh を占め、`.shell` が高さ決め打ち + `body{overflow:hidden}` なので**下端 187px が到達不能**（警告が増えるほど見えなくなる = 一番見たい状況で消える） | `body` を flex column にし `.shell { flex: 1 1 auto; min-height: 0 }` |
| バッジが 8px に潰れる | ref が多いコミットで**51個が幅8px**、0〜1文字しか読めない | `.ref` を flex-shrink させない |
| checkout の選択が戻る | 15秒の自動更新で `<select>` が先頭に戻り、**意図しないブランチに checkout する**経路だった（`--allow-write` はフックを起動＝実質コード実行） | worktree ごとに選択を覚える。detached は警告色で出す |

---

## MINOR（抜粋）

- **`splitArgv` を `v0/argv.mjs` に切り出して unit テスト9件。**
  `don't panic now` が `dont panic now` に融合していた（アポストロフィが閉じないクォート）、
  `"say \"hi\""` が `say \hi\` に壊れていた（エスケープ機構が無い）。
  閉じていないクォートは実行を止める。**Windows のパスは壊さない**（クォート外では
  `\` をエスケープとして扱わない）
- **ndjson の `null` 行で呼び出し側が TypeError になり、ストリームが中断されて
  子プロセスが取り残されていた** → オブジェクト以外は解析失敗として扱う。
  `break` 時に `reader.cancel()`（接続を閉じないと子が残る）。1行 1MB の上限
- `mergePreview` に `maxBytes`（2MB）。読み切れないときは `clean: null`（不明）で返す
- `--exec-timeout` 等の数値検証、空入力でボタン無効化、候補40件の打ち切り表示

---

## 破れなかったもの（記録）

- **XSS: 破れなかった。** 実在するブランチ `<img/src=x/onerror=…>` と
  コミット件名の `<script>` で試して発火せず。`app.html` 全体に
  `innerHTML`/`insertAdjacentHTML`/`outerHTML` への代入が**1箇所も無い**
- 連打・実行中の最大化/最小化・1100px 境界・リスナの積み上がり（20回更新で DOM 335→335）
- `-z` のセクション解析は指定された全ケース（add/add, rename/rename, modify/delete,
  binary, symlink, file/directory, submodule, **改行を含むファイル名**）で正しい
- 絶対 URI / Host 重複 / rebinding 後のトークン奪取 / simple request CSRF

---

## 残っている弱点

**issue で追っている**（ここに内容を二重管理しない）:

| | issue |
|---|---|
| **submodule は false positive**（merge-tree はチェックアウトしていない submodule を判断できず衝突扱いにする）。stderr の hint を捨てているので「分からない」が「衝突する」として出る | [#2](https://github.com/akibecolor/kjp-edit/issues/2) |
| **`docs/performance.md` はサーバ側の収集しか測っていない。** クライアント描画の線が無い（BLOCKING 4 はどのテストにも掛からなかった） | [#3](https://github.com/akibecolor/kjp-edit/issues/3) |

### 仕様として許容（直さない）

- **貪欲は最大独立集合ではない**（n=3〜6 の全 33864 グラフで検証: 不変条件違反 0、
  最大より小さいケース 1585、差は常に1本）。そもそも実測で辺の 87% が未知なので
  最適性を論じる意味は薄い

### 解決済み

- ~~`--name-only` の衝突パスに合成パスが混ざる~~ → **#1 で解決。**
  git の情報メッセージ（`moving it to X instead`）から退避名を取り、
  `{path, synthetic, of, why}` として印を付けて「開けない理由」を出す。
  ⚠️ 接尾辞から推測してはいけない（実測は `thing~refs_heads_synth-b` で、
  label でもハッシュでもなかった）
- ~~ファイラのラベルが実体と合っていない~~ → **#4 で解決。**
  見出しを `ファイラ（<base>...HEAD の差分）` にし、
  「コミット済みの差分なし / 未コミット N 件」と**両方の数字を出して**
  食い違いを説明する

- ~~`--repo` にサブディレクトリを渡すと `conflicts[].files` が cwd 相対（`../shared.txt`）になり、
  `overlaps[].path`（リポジトリルート相対）と基準が違う~~
  → **L1 で修正**（`--repo` を `rev-parse --show-toplevel` でリポジトリのルートに正規化）。
  スモークテストで「衝突パスが `..` で始まらないこと」を固定した

⚠️ **解決済みを残したままにしない。** 直った項目が混ざっていると、
残りの項目も信用できなくなる（このリポジトリは「主張ではなく証拠を示す」方針なので、
記録の鮮度は守りの一部）。

---

## 検証状況

```
✔ syntax (15 mjs, 1 html)
✔ unit (56 pass, 0 fail)
✔ smoke (59 pass, 0 fail)
✔ layout
突然変異: 16 KILLED / 2 DEFENSIVE / 2 SKIP
CI: windows-2022 / ubuntu-24.04 / macos-15 すべて緑
```

### この過程で自分が作った誤り

1. **レイアウト検査を固定 2000ms 待ちで書いていた。** 衝突予測を足して描画が遅くなり、
   **幅ごとに別の Chrome を起動するので 390px だけ負ける**形で CI が落ちた。
   中身が出るまでポーリングする形に変更（「固定時間で待たない」はこれで2回目の教訓）
2. **検証スクリプトをヒアドキュメントで書いてバックスラッシュを失った。**
   `CLAUDE.md` の「シェル経由でエスケープを含む置換をしない」を自分で破った。
   Write ツールでファイルとして書き直した
3. abort の検証で、**実行していないペインの worktree を消していた**ので
   「exit 0」を見て一瞬「効いていない」と誤読した。実行中のペインが消える形に直して確認した
