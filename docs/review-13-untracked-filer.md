# レビュー13 — 未追跡編集の capability と、ファイラの新しい経路

範囲 `8048a73..HEAD`（未追跡編集 `--allow-untracked` / `/api/v0/diff?mode=worktree` /
その経路の BLOCKING 修正 `8a12d7f`）。実施 2026-08-18。

## ⚠️ 部分レビューである（全体と読まないこと）

**10観点のうち4観点だけ**を走らせた: `editor`（新設）/ `auth` / `ops-scripts` / `tests`。
**見ていない**のは `pairing` / `exec-session` / `stdin` / `transcript` / `mutation` / `monitor`
（この範囲の変更が触っていないため）。モデルは fable、各指摘は別のエージェントが反証。

観点 `editor` は**このレビューで新設した**。#77 でファイルを読む・書く面ができたのに、
既存の9観点はどれもそこを主対象にしていなかった（`mutation` は checkout / merge 専用）。

結果: **BLOCKING 0 / SERIOUS 3 / MINOR 2 / 反証 0**。
⚠️ MINOR 2件は**ワークフローが検証を省略した**（重大度で足切りする作り）。
うち1件は今日の BLOCKING と同じクラスだったので、**こちらで確かめて直した**。
足切りの基準が危ういことがここで分かった。

## レビューの前に、自分で見つけた BLOCKING（`8a12d7f`）

`/api/v0/diff?mode=worktree` が `.gitattributes` の clean filter を実行していた。
**フラグ0個・ループバックのみのデーモンに1回投げるだけで任意コード実行。**
詳細と実測は `docs/editor-filer.md` §9。

## 生き残った指摘

| | 重大度 | 何が壊れていたか | 直した場所 |
|---|---|---|---|
| **A** | SERIOUS | `autostartServeArgs` が `--untracked` を引き継がない | `scripts/serveargs.mjs` |
| **B** | SERIOUS | `configDiff` が `--untracked` の差を見ない | 同上 |
| **C** | SERIOUS | 素タブが HEAD ↔ 作業ツリー差分を出す（印と中身の食い違い） | `v0/filertabs.mjs`（新設） |
| **D** | MINOR | merge の失敗経路だけ `worktreeStatus` に filter 中和を渡していない | `v0/server.mjs` |
| **E** | MINOR | 省略の告知（`dirtyMore` / `untrackedMore`）に検査も変異も無い | `v0/filertabs.mjs` |

### A / B — 新しい capability の配線漏れ（実測で再現した）

```
autostartServeArgs(--write --untracked) → ["--repo","/r","--port","7749","--write"]
   → --untracked が脱落。その argv を serverArgs に渡しても --allow-untracked が付かない
configDiff(--write --untracked vs --allow-write) → []   ← 差分ゼロ
   → serve.mjs が「既に動いています → URL」で exit 0。要求が無効なことを1文字も言わない
```

🚨 **`--exec` では露見しない。** `serverArgs` が `--exec` に `--allow-untracked` を
自動で付けるので、壊れるのは **`--write --untracked` の組み合わせだけ**。
利用者の日常が `--exec` なので、**手元では絶対に気付けない**形だった。
`scripts/serveargs.mjs` は #30 / #45 で「引き継ぎを落とすと再起動後だけ壊れる」と
**自分で何度も警告している**ファイルで、そこに同じ形を作った。

⚠️ 直したとき既存テストが3件落ちた。どれも**古い期待値**（`--exec` が
`--allow-untracked` を連れてくる前の形）で、実装ではなくテストが誤っていた。
`RUNNING_EXEC` の fixture も実際のコマンド行と食い違っていたので揃えた。

### C — 印と中身の食い違い（このツールの中心的な場面で常時起きる）

振り分けを「押されたタブ」ではなく **`dirtyFiles.includes(sel)`（集合の所属）**で
決めていたので、**同じファイルがコミット済み差分にも未コミット変更にもある**とき
（= エージェントがコミットしてから編集を続ける）、素タブを押しても
HEAD ↔ 作業ツリーの差分が出て、**コミット済み差分には二度と辿り着けなかった**。

自分で読んで、**同じ原因の欠陥がもう2件**あることが分かった:

2. 復元を `files`（コミット済み）からしか探していなかったので、`*` や `+` を
   選んでいると **15 秒ごとの自動更新で選択が `files[0]` に飛んでいた**
   （「自動更新で作り直すと選択が先頭に戻る」— `<select>` で踏んだ型の再発）
3. 点灯の照合が `o.title === path` だったが、`*` / `+` のタブは title に注釈を
   足しているので**一致せず、`*` を押すと素タブが光っていた**

🚨 **3件とも原因は同じ「`app.html` の中にあってテストできなかった」こと。**
CLAUDE.md が「中に置いたロジックはテストできない = 宣言が破れても気付けない」と
書いている、まさにその形。**`v0/filertabs.mjs` に出して unit 8件で固定した。**

⚠️ 直したら `render-check` が落ちた。**検査が壊れた挙動に依存していた** —
先に走る未追跡の閲覧検査が `+新規メモ.txt` を選んだままで、
「選択が先頭に戻るバグ」がたまたま `edit-me.txt` に戻していた。
保存バイト数が 57（未追跡ファイル）で、**意図と違うファイルを編集していた**。
検査側で対象を明示的に選び、**選択されたことを確かめてから**進む形にした。

### D — 門の順序に守りを依存させない

作業ツリーを読む経路のうち、merge の**失敗後の数え直し**だけ `filterNames` を
渡していなかった。上の門（filter があれば 409）で普通は到達しないので**冗長な守り**だが、
「門を動かした瞬間に生きた穴になる」形なので揃えた（CLAUDE.md「順序が守りの本体に
なっている場所がある」）。⚠️ 到達不能なので**専用の変異は置けない**。
守っているのは既存の `merge-filter-gate-order` / `merge-refuses-filter`。

### E — 省略の告知に検査が無かった

画面の上限（6件）とサーバの上限（50件 + `*More`）の**両方**を足さないと
「全部見えている」と読める表示になる。`filertabs.mjs` に集約して unit で固定した。

## 反証されたもの

なし（3件とも反証エージェントが再現した）。

## このレビューで分かった、体制そのものの問題

1. 🚨 **MINOR は検証が省略される。** 今回はそこに「今日の BLOCKING と同じクラス」が
   混じっていた。**重大度はレビュアーの自己申告**なので、足切りの基準として弱い。
   → 当面は **MINOR も自分で全部読む**（省略された件数は `log()` に出ている）
2. 🚨 **観点に無い面は誰も見ない。** #77 でファイルを読む・書く面ができてから
   このレビューまで、`editor` 観点は存在しなかった。
   → **新しい面を足したら、同じコミットで観点も足す**
3. ⚠️ **リファクタで変異が5件 STALE になった。** `--dry` で数秒で出たので実害は無いが、
   「守りを1箇所に集約する」たびに起きる。錨にする行の**隣接**を壊さないこと
   （コメントを2行の間に挟んで2件落とした）。ソースにその旨を書いた

## 体制の改修（このレビューの後に入れた）

上の3点をそのまま `adversarial-review.mjs` に反映した。

| 反省 | 直したこと |
|---|---|
| 1. MINOR が報告から落ちる | **重大度で捨てない。** 重大な順に反証するが、打ち切った分は `unverified` として**別の欄で報告する**。verify エージェントが落ちた分もここに来る |
| 1'. 重大度が自己申告 | レビュアーへの指示に「**迷ったら重い側に**」を追加。反証側にも「**『重大ではない』は反証ではない**」（`severityAdjust` で軽くする）を明記 |
| 2. 観点の足し忘れ | **`Scope` フェーズを追加。** 変更されたファイルのうち、どの観点の「見るもの」にも挙がっていないものを `coverage.uncovered` に出す。レビューと並行に走るので待ち時間は増えない |
| （新規）結果が返らない観点 | `failedDimensions` に名前で出す。以前セッション上限で2観点が黙って抜けた |

⚠️ `Scope` は**知らせるだけで観点を足してはくれない**。
「新しい面を足したら同じコミットで観点も足す」を CLAUDE.md に書いた。

### 🚨 ついでに見つかった: workflow 自体が一度も構文検査されていなかった

`verify.mjs` の `sources()` は **`.claude*` を除外**するので、
`adversarial-review.mjs` は構文検査の対象外だった。
**壊れていると気付くのは「レビューを走らせよう」とした瞬間で、
それは capability を足した直後（一番急いでいるとき）と決まっている。**

⚠️ workflow は top-level `return` を使うので `node --check` は**必ず**
`Illegal return statement` を出す。だから `export` を外して async 関数に包んでから検査する。

そして判定（制御文字の走査と包み方）は **`scripts/sourcecheck.mjs` に出した** —
`verify.mjs` の中に書くと**この検査自身が検査されない**。
実際、制御文字の規則は CLAUDE.md にあったのに**検査が0件で、同じ日に2回踏んだ**。

⚠️ 最初に置いた変異 `workflow-syntax-wrap-hides-errors` が **SURVIVED した**。
原因はテストではなく**変異の方**で、`return` の行だけ差し替えても継続行（`+ …`）が
残って `${body}` が付き、**中身を捨てられていなかった**。最終行に当て直して KILLED。

## 検証

```
node scripts/verify.mjs          → 9段すべて緑（unit 417 / smoke 211 / 3 skip）
node scripts/mutate.mjs --dry    → 408 件すべて字面一致・STALE 0
```

体制の改修で足した変異:

| 変異 | 結果 |
|---|---|
| `control-char-scan-blind` | KILLED |
| `control-char-scan-too-strict`（厳しすぎて普通のソースを落とす方向） | KILLED |
| `workflow-syntax-wrap-hides-errors` | KILLED（変異を直してから） |

| 変異 | 結果 |
|---|---|
| `autostart-drops-untracked` | KILLED |
| `configdiff-blind-untracked` | KILLED |
| `filer-tab-kind-ignored` | KILLED |
| `filer-restore-ignores-kind` | KILLED |
| `filer-hidden-count-partial` | KILLED |
| `untracked-ui-no-tabs` / `untracked-ui-no-reason` | KILLED（`filertabs.mjs` に付け替え） |
| `serve-running-caps` / `serve-shared-modules` | KILLED（字面を更新） |
| `merge-failed-recount` / `merge-failed-cache` | KILLED（隣接を戻して） |
