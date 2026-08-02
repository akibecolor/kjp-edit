# 書き込み・実行経路の敵対的レビュー — 指摘と対応

`docs/review-v0-code.md` は**読み取り専用だった頃**の実装レビュー。
これは `--allow-write` / `--allow-exec` を載せた後、**遠隔コード実行を持つ状態**で
別エージェント2名（認可境界担当 / exec・git 担当）に行わせたレビューの記録。

両名とも**実際にサーバを立てて再現手順つきで**報告した。全件対応済み。

---

## 🚨 認証の手前でデーモンを殺せた（1パケット・無認証）

`new URL(req.url, ...)` が `try` の外・Host 検証より手前にあった。
`GET //[ HTTP/1.1` のような request-target は `ERR_INVALID_URL` を投げ、
async ハンドラの unhandled rejection で**プロセスが exit 1 で落ちる**。

```
target=//[   前=200  後=ECONNREFUSED  exit=1
```

4関門も Host 検証も `--allow-write` も**一切通らない**。ブラウザからは送れない形なので
脅威は「同一マシンの別ユーザ」と「トンネル越しの別デバイス」だが、
**繰り返せば永続的 DoS**。`try` の内側へ移動し、生ソケットで回帰テストを書いた
（既存の `rawGet` は `new URL` で組むので不正な target を送れず、この経路を踏めなかった）。

---

## 🚨 exec の枠が永久に戻らず、8回で死んでいた（Windows）

3つが連鎖していた:

1. **`child.kill()` は Windows で子孫を殺さない。** 中間が `cmd.exe` だと孫が残る
   （中間が Node なら libuv の job object が巻き込むので気付けない）
2. **孫が stdout パイプを握るので `close` が発火しない。** `runningExec--` も `res.end()` も
   `close` ハンドラの中だったため実行されない
3. よって応答は開いたまま、枠は埋まったまま。**8回のタイムアウトで exec が再起動まで死ぬ**

しかも **Windows でこの形は避けられない**: `.cmd` は `shell:false` で spawn できず（`EINVAL`）、
`npm test` を動かす唯一の道が `cmd /c npm test` = まさにこの形。

対応:
- 後始末を `close` ではなく **`exit`** で行う（stdio に依存しない）
- `killTree()` で木ごと殺す（Windows は `taskkill /T /F`）＋ stdio を `destroy()`
- `finish()` に集約して1回だけ走らせ、kill 後の**保険タイマー**からも呼ぶ
- 回帰テストは**中間シェルを挟んだ形**で、(a) 応答が完結する (b) 孫が止まる
  (c) 枠が返る（次の exec が 429 にならない）の3点を固定

**既存の「切断で子を殺す」テストは直接の子しか見ておらず、永久に緑だった。**

---

## 🚨 `--force` という名前のブランチでオプション注入（未コミットの作業が消える）

`checkout` の `ref` に `isSafeRef` を通していなかった。`isSafeRef` は存在したのに
blob/diff にしか使われていなかった。

```
git update-ref refs/heads/--force <oid>     # git branch では作れないが update-ref は通る
POST /api/v0/checkout {"ref":"--force"}
→ 200 / 未コミットの変更が破棄された（git checkout --force -- として解釈）
```

この ref は `localBranches` に載るので **UI の候補にも並ぶ**（事故として踏める）。

対応: `isSafeRef` を通す ＋ `git checkout --end-of-options <ref> --`（多層防御）。

---

## 🚨 同時実行の上限が効いていなかった（上限8に対して24本）

検査 `runningExec >= MAX` と予約 `runningExec++` の**間に `await` があった**
（`listWorktrees` と `auditExec`）。イベントループを手放すので同時要求が全部通る。

対応: `reserveExecSlot()` で検査と予約を同じ同期ブロックにし、
予約後の全失敗経路で `release()` する。回帰テストで 14 本同時 → 受理 ≤ 8 を固定。

---

## 🚨 読み取り専用でもリポジトリ設定のコマンドが実行されていた

`core.fsmonitor` にコマンドを書ける相手（= 同じ common dir を共有する別のエージェント）が
いれば、**`--allow-write` も `--allow-exec` も付けていないデーモンの `git status` が
それを実行する**。デーモンの env をそのまま継承するのでトークンの持ち出しにも使える。

`BASE_ARGS` に `-c core.fsmonitor=false` を追加。`fileDiff` に `--no-textconv` も追加
（`--no-ext-diff` は textconv を止めない）。

**テストで偽陽性を1回作った。** フックを `node <空白を含むパス> <script>` で設定すると
クォート不足で起動に失敗し、「発火しないので守れている」と誤判定する。実測で切り分けた:

| | |
|---|---|
| `node <script>`（未クォート） | 発火せず ← 壊れた setup |
| シェルスクリプト | **発火** |
| `GIT_OPTIONAL_LOCKS=0` でも | **発火**（読み取り経路は本当に脆弱） |
| `-c core.fsmonitor=false` | 発火せず（修正は効く） |

---

## 🚨 sequencer/todo の取りこぼし（v0 自身の checkout で乗っ取りが起きる）

`git cherry-pick A B` が衝突し、`--continue` ではなく**手で commit** すると
`CHERRY_PICK_HEAD` は消えるのに `sequencer/todo` に残りの pick が居座る。
フラグは全部 false になるので**一見何も進行していない**が、そこで checkout して
`--continue` すると**残りが切り替え先に乗る** — まさにこのツールが警告している乗っ取り。

`sequencerState` に `sequencing`（`sequencer/todo` の存在）を追加し、
warning（`sequencer-todo-left`）と checkout の blocker に加えた。

---

## `--allow-write` はフックがあるリポジトリでは実質コード実行

checkout は `post-checkout` を起動する。capability を分けている前提が
フックの存在で崩れる。**既定で止めるとワークフローを壊す**ので、止めずに
payload の `errors` に出して見えるようにした（このツールの流儀に合わせた）。

---

## その他の対応

| | |
|---|---|
| `--exec-timeout abc` | `NaN` → `setTimeout(fn, NaN)` が 1ms 扱いで**全コマンドが即殺**されていた。数値検証を入れ、不正なら起動を拒否（`--port` / `--limit` も同様） |
| `isSafeRef` が `@{…}` を通す | `agent-a@{1}` で `reset --hard` で捨てたコミットの中身が読めた。「コミットに入っているものに限定される」という主張が崩れていたので拒否 |
| `isSafeRepoPath` が pathspec magic を通す | `:(exclude)x` で1ファイル指定が「それ以外全部」になった。入口で `:` を拒否＋`--literal-pathspecs` の2層 |
| exec が bare worktree を弾かない | checkout は弾いていたので揃えた |
| 無音のコマンドで応答ヘッダが来ない | `res.flushHeaders()` |
| `.cmd` の `EINVAL` | Windows では `["cmd","/c",…]` を使うようエラーメッセージで案内 |
| 監査ログに呼び出し元が無い | `peer` と `host` を記録 |
| `tooLarge` のとき `binary: false` | 読んでいないので `null`（未知を偽らない） |

---

## 破れなかったもの（レビュアが試して駄目だったもの）

記録として残す。同じ経路を再検討する時間を節約するため。

- **絶対 URI のリクエストライン**（`GET http://evil/... HTTP/1.1`）— Host ヘッダで判定するのでバイパス不成立
- **Host 重複・`127.0.0.1.evil.example`・末尾ドット・`[::ffff:127.0.0.1]`・大文字** — 全て 403
- **DNS rebinding 後のトークン奪取** — rebind すると Host が攻撃者ドメインになり 403
- **`Content-Type: text/plain` の simple request による CSRF** — トークン必須で 403。
  OPTIONS に CORS を返していないので preflight は必ず失敗する（**preflight 強制は本当に効いている**）
- **worktree の cwd に置いた偽 `git.exe`** — libuv は cwd を探索しない（`shell:false` である限り）
- **worktree allowlist の TOCTOU（ジャンクション差し替え）** — 差し替え先に `.git` が無いと
  git が `prunable` と報告して止まる（有効な `.git` を用意した場合は**未検証**）
- **`samePath` の realpath による allowlist の拡大** — 実際に使う cwd は常に git 由来の
  `wt.path` なので広がらない
- **`isSafeRepoPath` の抜けからのリポジトリ外読み出し** — 通る値（ADS `a.txt:b`、`CON`、
  短縮名）はいずれも git のツリー検索にしか渡らず、ファイルシステムに触れない

---

## 残っている既知の弱点（実装では消せない / 未対応）

- **トークンは非ブラウザに対して防御にならない。** `/api/v0/session` は Host 検証を通った
  クライアントにトークンを払い出す。トークンは CSRF 対策専用であり、
  **トンネル越しの認証要素として当てにしてはいけない。** 実質的な認可はトンネル側だけが担う
- **`--allow-exec` + 公開トンネルで終わり。** デーモンからトンネル構成は検出できない
- **監査ログを exec した相手が消せる**（`<GIT_DIR>` 内）。`--audit-log` で外に出せるように
  するのは未対応
- `tokenMatches` は長さ不一致を早期 return するのでトークン長が timing で漏れる（実害は無視できる）
- `showBlob` の `cat-file -s` → `cat-file blob` に TOCTOU があり、`size` と `text` が
  別オブジェクトになりえる
- checkout に 40 桁 hex を渡すと静かに detached HEAD になる（`ok:true` を返す）

---

## 検証状況

```
✔ syntax (8 mjs, 2 html)
✔ unit (19 pass, 0 fail)
✔ smoke (50 pass, 0 fail)
✔ layout
```

新しい回帰テストは**修正を外すと落ちることを確認済み**
（`url` / `fsmonitor` / `literal` / `checkout の ref` / 孫プロセス / 同時実行上限）。
落ちない検査は無意味なので、これを通していないテストは信用しない。

### この過程で自分が作った誤り

1. **`core.fsmonitor` のテストが偽陽性だった**（フックのクォート不足で起動していなかった）。
   「修正を外しても緑」で気付いた
2. **`pathspec magic` のテストは入口の検証しか固定していなかった。** `--literal-pathspecs` を
   外しても緑だったので、git の実挙動を見る unit テストを足した
3. **突然変異テストのスクリプトで `process.exit()` を `try` 内に書き、`finally` を飛ばして
   修正1行を消したまま復元しなかった。** `throw` に変更
