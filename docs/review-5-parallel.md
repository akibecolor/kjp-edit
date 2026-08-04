# 5回目のレビュー（並列・独立） — b1874a0..HEAD

**規則どおりの定期レビュー**（実装コミットが3件たまったら走らせる。`CLAUDE.md`）。
前回（`docs/review-4-parallel.md`）の修正が成立しているかを重点に見させた。

| | |
|---|---|
| 🚨 BLOCKING | **2**（**どちらも前回の修正による回帰**） |
| ⚠️ SERIOUS | 8 |
| MINOR | 3 |
| 反証されて消えた | 3 |
| 規模 | エージェント 22 本 / ツール 598 回 / 33分 |

## 学び: **穴を塞ぐと別の穴が開く**

BLOCKING 2件はどちらも「前のレビューの指摘を直したときに作った回帰」だった。

1. `/api/v0/session` のトークン払い出しを「提示済みの要求だけ」に締めたとき、
   **受け渡し経路を `--require-auth` の中だけに残した**。既定のループバック運用で
   `--allow-write` だけを付けると、トークンは生成されるが表示も永続化もされず、
   **ブラウザが入手する手段が1つも無い**。それでも UI は checkout を描くので
   「有効に見えて必ず 403」。**推奨の起動口（`serve.mjs --write`）がこれに当たる。**
2. 切断で殺さないセッションで、`streamSession` が `spawn` の**後**に呼ばれるため、
   **応答到着前に切ると detach が一度も走らない**。`lastDetachedAt` が永久に入らず
   **「切断後の猶予」が完全に無効化**され、子は絶対上限（600秒）まで走る。
   一覧は「接続中」と表示する（嘘）。UI で「実行→停止」を素早く押すと踏む。

**修正のたびにレビューを回す理由がこれ。** 自己検査は「直したい穴」しか見ない。

---

## 生き残った指摘

### 🚨 BLOCKING [auth] --allow-write / --allow-exec の UI が構造的に死んでいる（ブラウザがトークンを入手する経路が1つも無い）

**場所**: `v0/server.mjs:1181（/api/v0/session の token 払い出し）、v0/server.mjs:1721-1723 / 1732-1742（トークンを表示しない分岐）、v0/app.html:1100・1397-1398（それでも操作 UI を描く）`　**実測**: した

`/api/v0/session` は `presentedToken(req,url)`（= 生トークンをヘッダかクエリで**既に**提示している要求）にだけトークンを返すようになった。しかし requireAuth が false（= --allow-host も --require-auth も付けない既定のループバック運用）のとき、サーバは `?token=` 付き URL を**一切表示しない**。--allow-write だけの場合はトークンが `randomBytes(32)` で生成され、表示も永続化もされないので、**利用者にも UI にも知る手段が無い。** それでも app.html は `session.allowWrite` だけを見て checkout の select+ボタンを描き（app.html:1100）、ヘッダに「⚠️ 書き込み有効」/「🚨 実行有効」バッジを出す（1397-1398）。押すと必ず 403。README:175-178 の「有効にすると worktree カードに checkout が出ます」と daily-use の `--write` / `--exec` 手順は、この状態では成立しない。`scripts/serve.mjs --write` はまさにこの引数になる（serve.mjs:207、--token-file は --exec か --allow-host のときだけ付く）ので、**推奨された起動口で checkout が絶対に動かず、回復手段もない。** 4回目のレビューの BLOCKING（Cookie→実行トークン交換）を塞いだ副作用で、正規の受け渡し経路まで塞がっている。スモークテストは全て `--token <固定値>` を自分で持って `x-kjp-token` で問い合わせる形（smoke.test.mjs:727-750, 2450-2456）に**書き換えられている**ので、この経路は1本も検査していない（smoke.test.mjs:723-725 のコメントがハーネスを合わせた経緯を書いている）。落ちない検査そのもの。

**再現**

```
`node v0/server.mjs --repo <tmp repo> --port 0 --allow-write`（scripts/serve.mjs --write と同じ引数）→ stdout に token の文字列は0件（実測 `/token/i.test(stdout) === false`、出力は「⚠️ 書き込み有効 (--allow-write)。checkout が可能です。」のみ）。
GET /api/v0/session → `{"allowWrite":true,...,"requireAuth":false,"token":null}`
POST /api/v0/checkout（UI と同じ `content-type: application/json` / `sec-fetch-site: same-origin` / `x-kjp-token: ""`）→ **403 `{"error":"x-kjp-token が一致しません"}`**
同じく `--allow-exec --token AAAA…(32)`（README:192-193 の起動例）→ stdout に `?token=` URL 無し、GET /api/v0/session → `"token":null`、POST /api/v0/exec → **403**。`/api/v0/session?token=AAAA…` を手で叩けばトークンは返る（= 経路は `?token=` 付き URL を人間が組み立てたときだけ生きている）。
再現スクリプト: C:\Users\akico\AppData\Local\Temp\claude\C--Users-akico-Documents-kjp-editor\243d11c6-c19f-4c1f-ae8c-7f29ccff177f\scratchpad\advauth.mjs / advauth2.mjs（サーバは毎回 kill、残留プロセス無しを Win32_Process で確認済み）
```

**直し方の案**

requireAuth に関係なく、write/exec を有効にしたら起動時に `http://127.0.0.1:<port>/?token=<token>` を必ず表示する（今は `if (opts.requireAuth)` の中だけ）。加えて app.html は `session.token` を持たないときに checkout フォームと実行バーを出さず、「起動時に表示された ?token= 付き URL を開いてください」と告知する（押せるのに必ず失敗する操作を描かない）。回帰テストは「--allow-write だけで起動 → stdout の URL をそのまま開く → session.token が非 null → checkout が 200」で固定し、URL 表示を消すと落ちることを mutate.mjs で確認する。

---

### 🚨 BLOCKING [exec-session] exec POST の応答が届く前に切断すると購読者が永久に残り、切断猶予が二度と効かない（画面は「中断しました」と嘘をつく）

**場所**: `v0/server.mjs:994-995（`req.on('aborted', detach); res.on('close', detach)`）／v0/server.mjs:958（subscribe が `lastDetachedAt = null` にする）`　**実測**: した

`streamSession()` は `create()` → `await listWorktrees()` → `await auditExec()` → `spawn` の**後**に呼ばれる。この 150ms 以上の窓でクライアントが切ると、`res` の 'close' は listener 登録より前に発火済みなので `detach` が一度も走らない。結果:
(1) `subscribers` が 1 のまま残り、`unsubscribe` の `if (!s.subscribers.size)` が永久に偽になるので **`lastDetachedAt` が二度と入らない** → sweep の `s.lastDetachedAt !== null` が成立せず、**#17 の代替の守りである「切断後の猶予」が完全に無効化**される。子は絶対上限（既定 600s）まで走る。8本作れば実行枠は10分埋まる。
(2) `/api/v0/state` は `subscribers:1, detachedMs:null` を返す。UI（app.html:773）は `detachedMs !== null` のときだけ「切断中 N秒」を出すので、**誰も見ていないセッションが「接続中」として表示される**（嘘）。
(3) `detach` の中の `auditExec({event:'detach'})` も走らないので、README が約束する「detach を記録します」が満たされない。
(4) UI 経路で普通に踏める: `kill()` は `if (!sessionId) { ac.abort(); return; }`（app.html:554-555）なので、**実行→停止を素早く押すと kill ではなく abort になり、この窓に落ちる。** 画面には `⚠ 中断しました`（app.html:637）しか出ないが、コマンドは 600 秒走り続ける。app.html:631-633 が「嘘を書くと走り続けているものを止めたと誤解する（観測ツールとして最悪の誤り）」と書いている、まさにその状態。

**再現**

```
`--exec-detached-grace 2 --exec-timeout 60` で起動し、POST /api/v0/exec（argv = 出力を出し続ける node）を送って **30ms 後にソケットを destroy**。観測値:
  t=0.7s  state=running subscribers=1 detachedMs=null
  t=3.4s  state=running subscribers=1 detachedMs=null   ← 猶予 2s を過ぎても殺されない
  t=9.1s  state=running subscribers=1 detachedMs=null seq=144
  surviving children: 1
対照実験（400ms 後に destroy = 応答到着後に切断）では detach が走り、`detachedMs=687` → 猶予 2s で `exit={"signal":"SIGKILL","note":"⚠ 切断されたまま 2s 経ったので停止します"}` → 保持期間後に台帳から消えた。差は listener 登録のタイミングだけ。
```

**直し方の案**

`res`/`req` の close listener を **`create()` の直後（`streamSession` を呼ぶ前）に登録する**か、`streamSession` の冒頭で `res.destroyed` を見て即 detach する。合わせて `subscribe()` が `lastDetachedAt` を null にするのは「生きている購読者」のときだけにする。変異で固定できる: listener 登録を後ろに戻したら落ちること（`subscribers` が 0 に戻り `detachedMs` が数値になることを assert）。UI 側は sessionId 未確定でも「起動要求は届いている可能性がある」と告知し、state の execSessions から拾って停止できることを示す。

---

### ⚠️ SERIOUS [exec-session] create() 後の await listWorktrees() が reject すると枠が返らない。sweeper 未起動なら実行が恒久に死ぬ

**場所**: `v0/server.mjs:1219（`const worktrees = await listWorktrees(opts.repo)`）／v0/server.mjs:1211（「予約した後の失敗経路は必ず枠を返す」というコメント）／v0/server.mjs:1265（`startExecSweeper()` が attachChild 成功後にしか呼ばれない）`　**実測**: した

`create()` で `reserved++` した後、`bail()` を通らない reject 経路が1つ残っている。`listWorktrees` は git が非ゼロで終わると throw する（リポジトリの移動・削除・破損・`worktree list` の失敗）。throw は外側の `handleRequest().catch()` に吸われて 500 になるだけで、**finish も remove も走らない。**
・`reserved` が戻らないので 8 回で 429。
・`sweep()` は `sweepTimer` が無ければ呼ばれず、`startExecSweeper()` は attachChild 成功後にしか呼ばれない。つまり**一度も正常な exec が通っていないデーモンでは回収機構が存在せず、429 が恒久化する**（再起動しか回復手段が無い）。
・その間 `/api/v0/state` は `state:"starting"` を返し続ける。server.mjs:1293 が ENOENT の修正理由として挙げた「起動していないプロセスを実行中と表示する（嘘）」と同一の症状。
・sweeper が動いていれば絶対上限で回収されるが、そのとき残るのが `exit={"signal":"SIGKILL","note":"⚠ 上限時間 4s を超えたので停止します"}` と監査の `{"event":"kill","reason":"timeout","worktree":"(未検証)"}`。**spawn すらしていないプロセスを SIGKILL で殺したという主張**で、server.mjs:1295 が「嘘」として挙げた形そのまま。対応する `start` 行の無い `kill` 行が監査に残る。

**再現**

```
実験A（恒久化）: `--exec-timeout 5` で起動 → 正常な exec は一度も投げず → `.git` を退避 → POST /api/v0/exec を8本（全部 500 `git worktree list --porcelain -z exited 128`）→ `.git` を戻す → 正常な POST が `429 同時実行が上限（8）に達しています`。8秒待って（絶対上限 5s 超）再送しても **429 のまま**、`/api/v0/state` は `state=starting` 8本を返し続ける（ageMs=8360 まで確認）。
実験B（嘘の記録）: `--exec-timeout 4 --audit-log <外部>` で起動 → 正常な exec 1本で sweeper を起動 → `.git` 退避 → 1本 POST（500）→ 6.5s 待つ → `/api/v0/state` に `exit={"code":null,"signal":"SIGKILL","note":"⚠ 上限時間 4s を超えたので停止します"}`、監査に `{"event":"kill","reason":"timeout","worktree":"(未検証)","argv":[…"console.log(\"NEVER RAN\")"]}`（`start` 行なし）。
```

**直し方の案**

`create()` 以降を try/catch（または try/finally で「まだ running なら finish+remove」）で囲む。`worktree:"(未検証)"` のまま kill されることが「検証前に落ちた」の証拠なので、そこを見て `reason:'never-started'` と区別して記録する。加えて **`startExecSweeper()` はサーバ起動時か exec ハンドラの入口で呼ぶ**（回収機構の有無を「過去に1本成功したか」に依存させない）。変異: try/catch を外すと「500 を8回返しても9本目が 429 にならない」が落ちること、`startExecSweeper()` を成功後に戻すと「sweeper 未起動でも絶対上限で回収される」が落ちることを確認する。

---

### ⚠️ SERIOUS [transcript] 最新の .jsonl から cwd が取れないと、そのプロジェクトを丸ごと黙って捨てて「記録なし」と嘘をつく

**場所**: `v0/transcript.mjs:422 （`if (!cwd) continue;`。選定は 407-417、readCwd は 348-367）`　**実測**: した

稼働中のエージェントに対して UI が「この worktree でエージェントを走らせた記録がありません。」(v0/app.html:1004) と断言する。#27 で「記録なし」と「読めなかった」を分けたのと同じ嘘の型が、頭側（cwd 取得）で復活している。しかも errors=[] なので告知が一切無い（#27 の tooBigToRead には告知がある）。実データに引き金が既に存在する: ~/.claude/projects/C--Users-akico-Documents-tadaima-kochi-web に cwd を1つも持たない 112B の `teleported-from` スタブが3本あり（rev-l2-probe3.mjs で MISS 判定）、同じディレクトリに 182MB の実セッションが同居している。今回はスタブの方が古かったので助かっているだけで、テレポート/ブリッジのスタブが後から書かれれば mtime 最新になり、そのプロジェクトの観測が死ぬ。dir 内の次に新しいファイルへのフォールバックが無い。

**再現**

```
node <scratchpad>/rev-l2-repro.mjs  → 
A) 最新が cwd 無しのスタブ（112B の teleported-from、live セッションは同 dir の1本古い方）:
   state = none  lastActivityAt = null  errors = []
B) 先頭レコードが 16KB 超（cwd はその後ろの行にある。headBytes=16KB の窓に入らない）:
   state = none  lastActivityAt = null  errors = []
どちらも 20秒前に tool_use を書いた live 行が同じファイル/同じ dir にある。実データ側の裏付け: rev-l2-probe3.mjs が cwd を持たない実ファイル3本を MISS として列挙する。
```

**直し方の案**

(1) newest 1本で readCwd が null なら、mtime 降順で次の候補を試す（.jsonl 全部が null なら初めて諦める）。(2) 頭は固定 16KB ではなく「cwd を持つ最初の完全な行が出るまで」ストリームで読む（末尾側が readTailAdaptive でやっているのと同じ扱い）。(3) 諦めた場合は state='none' にせず 'unknown' 相当にして errors に理由を出す。テストは transcript.test.mjs に「cwd 無しスタブが最新」「先頭レコードが 16KB 超」の2件、mutate.mjs に対応する変異を追加する（現状 transcript.test.mjs にこの2形の検査は無い）。

---

### ⚠️ SERIOUS [transcript] 末尾の窓が許可リスト外のレコードだけだと scanned=0 → 「記録なし」と嘘をつく（tooBigToRead も立たず告知ゼロ）

**場所**: `v0/transcript.mjs:161（SCAN_TYPES フィルタ）と 225-230（newestTs が無ければ state='none'）。collectAgents 436-441 に「抽出できなかった」を伝える経路が無い`　**実測**: した

完全な行は取れている（needMore=false, tooBigToRead=false）ので #27 の救済に乗らず、summarize が lastActivityAt=null を返し、UI は 5秒前に Edit を書いたエージェントに「走らせた記録がありません」と表示する。実データで引き金の大きさが確認できる: 182MB の実セッション（tadaima-kochi-web）には**許可リスト外の type が 304KB 連続する箇所**があり、既定の tailBytes=256KB を超えている。file-history-snapshot / attachment / queue-operation は実コーパスで 438/937/1165 件あり、まとまって出る種類なので「窓が全部非許可 type」は起こりうる。

**再現**

```
node <scratchpad>/rev-l2-repro3.mjs  → 
E) 末尾 300KB が file-history-snapshot だけ（先頭に cwd、5秒前に tool_use あり）:
   state = none  lastActivityAt = null  scanned = 0  dropped = 0  tooBigToRead = false  bytesRead = 262144
   errors = []
実データ計測（rev-l2-real2.mjs）: d6a94eb6…jsonl の「非許可 type の連続最大」= 304KB（>256KB）。
```

**直し方の案**

summarize が「窓に許可 type が0件だった（scanned=0 かつ行はあった）」ことを返し、collectAgents で needMore と同じ扱いにして読み直す or errors に「活動を抽出できませんでした（記録が無いのではありません）」を出す。app.html:1003 の分岐も state==='none' 一本ではなく「記録が無い / 抽出できなかった」を分ける。

---

### ⚠️ SERIOUS [transcript] tool_use の path は clip されず、--watch-agents だけで最大 4096 文字の任意文字列が payload に出る（「自由文は1文字も通さない」が成立していない）

**場所**: `v0/transcript.mjs:200-206（PATH_KEYS の抽出。clip を通さない）/ 105-116（repoRelative）`　**実測**: した

docs/agent-observation.md:130「--watch-agents だけなら payload に載るのは列挙可能な値と時刻とパスだけ。自由文は1文字も通さない」という背骨の主張が破れている。パス自体が自由文で、通す条件は「worktree 配下に見える」「isSafeRepoPath を通る」だけ。isSafeRepoPath は空白・改行・任意の Unicode を許し 4096 文字まで通すので、recent 12件 × 4096 ≒ 48KB の任意テキストを、text/command 用のフラグ（--allow-transcript-text）を経由せずにトンネル越しの相手へ渡せる。実在する引き金: エージェントが読んだ README / issue / Web ページのプロンプトインジェクションが `Read("<repo>/<秘密>")` を1回呼ばせれば、失敗した read でも tool_use として記録され、そのまま画面に出る。text と command には clip があるのにパスには無いので、長さの歯止めもない（狭い画面の崩れも付随する）。

**再現**

```
node <scratchpad>/rev-l2-repro2.mjs  → allowText=false（--watch-agents 相当）で
   len=4000 outside=false path="AAAA…"（4000文字が丸ごと payload に）
   len=82  outside=false path="INJECT-SECRET-12345 AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
   payload に秘密が含まれるか: true
入力は `{type:'tool_use',name:'Read',input:{file_path:'<worktree>\\<任意文字列>'}}` の1行だけ。
```

**直し方の案**

パスにも clip 相当の上限を掛ける（例: 全体 256 文字・セグメント長で切り、超えたら省略を告知する）。加えて「実在する追跡対象のパスか」を worktree の files 集合で照合して、合わないものは path を出さず outside 扱いにする（app.html は既に openable 集合を持っている）。背骨テストに「path キーに秘密を仕込んでも payload に出ない」を1件足す（現在の transcript.test.mjs の秘密注入は path キーを試していないので、この穴は緑のまま通る）。

---

### ⚠️ SERIOUS [ops-scripts] --token-file の「リポジトリの中に置かせない」門が linked worktree と bare を見ておらず、トークンが実際にコミットされた

**場所**: `v0/server.mjs:1695-1707（inside 判定は containsPath(top, opts.tokenFile) の1本だけ、top は rev-parse --show-toplevel）`　**実測**: した

門の目的は「コミットされるから置かせない」。ところが見ているのはメイン worktree のルート1つだけで、**このツールが存在理由にしている linked worktree** は全部素通りする。N 個のエージェントは常時 `git add -A` するので、置いた token はそのまま commit に入る（--allow-exec のトークンなら push で RCE 資格情報が公開される）。さらに bare では rev-parse が exit 128 で落ちて catch → `return false` になるため、**bare を --repo にした構成では門が丸ごと無効**。cc7e9b0 が「bare の門が到達不能だった」と直したのと同じクラスがここに残っている。

**再現**

```
一時リポジトリ + linked worktree を作って実測（Windows, HEAD=747ddb2）:
$ node v0/server.mjs --repo ./lab/main --port 0 --token-file ./lab/wt-a/token
トークンを生成して保存しました: ...\lab\wt-a\token   ← 拒否されない
kjp-edit v0  →  http://127.0.0.1:63140
（比較）--token-file ./lab/main/token → ✖ --token-file をリポジトリの中に置かないでください

そのまま agent が add した場合:
$ cd lab/wt-a && git status --porcelain → `?? token`
$ git add -A && git commit -m "agent commit"
$ git show --name-only --format= HEAD → token
$ git show HEAD:token → Ae-SqqYmopGDTCNVeJf8jPoBIFzsxgL4OOfTCc9KySA  ← トークン本体がコミットに入った

bare:
$ node v0/server.mjs --repo ./lab/bare.git --port 0 --token-file ./lab/bare.git/token
bare リポジトリを見ています / トークンを生成して保存しました ...  ← 判定が働いていない（catch で false）
```

**直し方の案**

inside 判定を「メインの top」ではなく **listWorktrees() が返す全 worktree のパス + git-common-dir** に対して containsPath する（サーバは起動時にこの表を持っている）。bare のときは rev-parse の失敗を「外」と読まず、`rev-parse --git-common-dir` と worktree 一覧で判定する。

---

### ⚠️ SERIOUS [ops-scripts] smoke の孫プロセスの仕込みが中断時に無期限で生き残る — 現に6本が動き続け、beacon が計 11MB、temp dir が33個残っている

**場所**: `v0/smoke.test.mjs:1722-1758（grandchild.mjs は setInterval のみで自死しない）, :116-128（after が孫を掃かない）`　**実測**: した

仕込みが `setInterval(()=>appendFileSync(beacon,"x"),100)` で**自分では絶対に終わらない**。正常終了時は killTree が殺すが、run が落ちる/SIGKILL される/assert 前に例外が出ると finally も after も孫には届かず、**ログオフまで 100ms 毎に書き続ける**。CLAUDE.md「バックグラウンドでプロセスを起動したら必ず止める」に正面から反し、0f28cde（「重いテストが子プロセスを残していたので後始末する」03:21）**より後**に作られた個体が現存している = その修正はこの経路を塞げていない。

**再現**

```
観測（2026-08-05 04:36、HEAD=747ddb2。いずれも自分が作ったものではない）:
$ Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -like '*grandchild.mjs*'
  6本: PID 17716(2:19:15) 22044(2:22:42) 36332(2:54:44) 27816(2:59:57) 41028(3:09:41) 31508(4:31:26)
  ← 31508 は 0f28cde(03:21) より後
今も書いている:
  kjp-smoke-B3pvgN/grandchild-beacon.txt: 76732 -> 76742 bytes（1秒で +10）
  kjp-smoke-uxwV8k/grandchild-beacon.txt: 3811 -> 3821 bytes
$ du -ch kjp-smoke-*/grandchild-beacon.txt | tail -1 → 11M total
$ ls -d /c/Users/akico/AppData/Local/Temp/kjp-smoke-* | wc -l → 33
単体では漏れない（正常系は緑）ことも確認: node --test --test-name-pattern '孫プロセスも殺し' → pass 1、前後で孫の PID 集合は 6→6 で増減なし。つまり漏れるのは中断/失敗した run。
```

**直し方の案**

grandchild.mjs に自死を入れる（`setTimeout(()=>process.exit(0), 30_000).unref()` 相当）。これだけで**どんな中断でも上限30秒**になる。加えて after() で `kjp-smoke-*` に属する孫を掃く（beacon パスで照合）。

---

### ⚠️ SERIOUS [tests] `?token=` の守りが「ソースの字面」しか検査していない（到達不能にしても緑）

**場所**: `v0/smoke.test.mjs:2150`　**実測**: 未

検査が `assert.match(boot.body, /sessionStorage\.setItem\(TOKEN_KEY, t\)/)` と `/history\.replaceState\(null, '', /` の**文字列一致**で、ページの JS を1度も走らせていない。行を残したまま到達不能にする変更（早期 return / 条件で囲む / 使われない関数へ移す）は完全に見えない。壊れると読み取りトークンが URL に残って**履歴と Referer に漏れ**、sessionStorage に入らないので書き込み・実行が静かに使えなくなる。mutate.mjs はこの2件を ✔ KILLED と報告するが、測っているのは「行が消えたこと」だけ — `core.fsmonitor` / `pathspec magic` と同じ型の偽陽性が再発している。

**再現**

```
コピーで v0/app.html:1374 の `if (t) {` を `if (false && t) {` にするだけ（`sessionStorage.setItem(TOKEN_KEY, t)` と `history.replaceState(...)` の行はそのまま残す）→ `node --test --test-name-pattern='読み取り用の Cookie を焼き、ページ本体を返す' v0/smoke.test.mjs` → `✔ 🔒 ?token= は読み取り用の Cookie を焼き、ページ本体を返す (1318.4087ms) / pass 1 / fail 0`。実際の挙動はトークンが保存されず URL からも消えない。
```

**直し方の案**

`v0/layout-check.mjs` が既にブラウザを持っているので、`--require-auth` のサーバを `?token=...` で開き、probe から `sessionStorage.getItem('kjp_token')` と `location.search` を読んで固定する。文字列一致の assert は消す（実装を縛るだけで挙動を測っていない）。

---

### ⚠️ SERIOUS [tests] handleRequest の catch-all（デーモンを落とさない最後の砦）を外しても smoke が全緑。それを測ると称する `also` は無効

**場所**: `v0/server.mjs:1084`　**実測**: 未

認可の手前の同期例外でデーモンが exit 1 する事故を2回起こしている（`new URL` と `decodeURIComponent`）。その2つには個別の try/catch と変異があるが、**汎用の砦である top-level `.catch()` には検査が1つも無い。** さらに mutate.mjs の cookie-decode-crash の `also` は `handleRequest(...).catch(err => { throw err; }).catch(本体)` に書き換えるだけで、**直後の catch が再捕捉するので catch-all は外れていない。** コメントは「両方外して守り全体を測る」と書いてあるので、変異の記録自体が事実と違う。

**再現**

```
(a) v0/server.mjs:1084-1092 の `.catch(...)` を丸ごと消して `handleRequest(req, res);` にし `node --test v0/smoke.test.mjs` → exit 0 / `tests 90 / pass 89 / fail 0`（1件も落ちない）。(b) `also` が無効であること: url-crash 相当（`new URL` の try/catch を外す）だけを入れた版と、それに `also` も足した版で `GET //[ HTTP/1.1` を生の TCP で送る → どちらも `HTTP/1.1 500 Internal Server Error` / `died=null` で**完全に同一**。
```

**直し方の案**

`also` を「catch ブロックの中身を `throw err;` に置き換える」形にする（再捕捉されない）。加えて、必ず throw する分岐を `--layout-probe` のような検査専用フラグ配下に置き、500 が返ってデーモンが生きていることを smoke で固定する。

---

### MINOR [auth] kjp_auth Cookie は先頭1本しか見ないので、127.0.0.1 の他ポートのページが恒久的に 401 へ締め出せる

**場所**: `v0/server.mjs:706-723（readCookie が最初の一致で return）、v0/server.mjs:1128-1129（焼き直しは Path=/ のみ）`　**実測**: した

`readCookie()` は `Cookie:` を `;` で分割して**最初に見つかった kjp_auth で return する**。他の同名 Cookie は見ない。Cookie はポートで分離されない（この事実はコード自身が server.mjs:680-698 で「読み取りが漏れる」向きだけ書いている）ので、`http://127.0.0.1:3000` など**任意のローカルページ**が `document.cookie = 'kjp_auth=junk; path=/api/v0'` を焼ける。RFC 6265 §5.4.2 は path の長い Cookie を先に並べることを要求するので、`/api/v0/*` への全要求で junk が**決定論的に先頭**に来る。サーバが焼き直す Cookie は `Path=/` なので上書きできず、`?token=` URL を開き直しても復旧しない。結果、--require-auth / --allow-host 構成のツールが**手で Cookie を消すまで 401 のまま**になる（トンネル越しのスマホからは消す手順が最も面倒な相手）。--allow-host のときは同一 tailnet の別ノードが `Domain=<tailnet>.ts.net` で同じことをできる。認可の手前の Cookie 解析で自滅した型（`kjp_auth=%` の DoS）と同じ場所の別の穴で、テストは1本も無い（smoke.test.mjs は常に正しい Cookie 1本しか送らない）。

**再現**

```
`node v0/server.mjs --repo <tmp> --port 0 --require-auth --token BBBB…(32)`
GET /?token=BBBB… → 200, Set-Cookie `kjp_auth=<derived>; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`
GET /api/v0/state `Cookie: kjp_auth=<derived>` → **200**
GET /api/v0/state `Cookie: kjp_auth=junk; kjp_auth=<derived>` → **401**（ブラウザは path=/api/v0 の junk を必ずこの順で送る）
GET /            `Cookie: kjp_auth=junk; kjp_auth=<derived>` → **401**
GET /api/v0/state `Cookie: kjp_auth=<derived>; kjp_auth=junk` → 200（先頭勝ちであることの対照）
再現スクリプト: scratchpad\advauth2.mjs
```

**直し方の案**

readCookie を「名前が一致する**全ての**値を返す」形にして、`authed()` はどれか1つでも `secretMatches` すれば通す。焼き直しは同じ Path=/ のままで良い。回帰テストは `Cookie: kjp_auth=junk; kjp_auth=<正しい値>` で 200 を assert し、mutate.mjs に「最初の一致で return に戻す」変異を足して落ちることを確認する。

---

### MINOR [stdin] makeChatFilter が「解釈できない行は捨てずに出す」と書いてありながら、末尾行と未知 type を黙って捨てる

**場所**: `v0/app.html:476-501（特に 481 の buf=parts.pop() と 498 のコメント）`　**実測**: した

関数の先頭コメントは「⚠️ 解釈できない行は捨てずにそのまま出す。形式は Claude Code の内部形式なので変わる。黙って消すと『応答が来ていない』ように見える」と約束しているが、実際にそのまま出すのは **JSON.parse に失敗した行だけ**。(a) 改行で終わらない最後の行は `buf` に残り、フラッシュ経路が存在しない（`runExec` の finally は queue を flush するが chatFilter は触らない）ので**永久に表示されない**。プロセスが kill された / 落ちた / 出力が途中で切れた場合の最後の応答が丸ごと消える。(b) valid JSON で `type` が assistant/result/system-init 以外の行は 498 のコメント通り全部捨てる。これは rate_limit だけでなく `control_response`（stream-json 入力時の許可拒否）や将来増える type も含み、まさにコメントが警戒している「形式が変わったら黙って消える」状態。しかも省略の告知が無い（このリポジトリの「表示上限で省略したら必ず告知する」に反する）。

**再現**

```
v0/app.html から makeChatFilter を抜き出して単体実行（adv18-chatfilter.mjs）。実測:
  A 改行つき assistant → [["","こんにちは\n"]]                      ← 出る
  B 改行が来ない完全な assistant 行 → []                          ← 消える
  C {"type":"system","subtype":"compact_boundary"} / {"type":"stream_event",...} / {"type":"control_response","response":{"subtype":"error","error":"許可されていません"}} → 全部 []
  F JSON でない行 → [["","not json at all\n"]]                     ← これだけ約束通り
```

**直し方の案**

(1) `runExec` の finally（または exit レコード受信時）に chatFilter のフラッシュ関数を呼び、残っている `buf` を生のまま出す。(2) 未知 type は捨てるのではなく `line('d', ...)` で1行の要約（type/subtype だけでも）を出すか、少なくとも「N 件の未知の行を省略しました」を告知する。

---

### MINOR [ops-scripts] 運用スクリプトの門にテストも変異も1件も無い（#29 / #30 / #31 / c0948ea の修正は全部「外しても緑」）

**場所**: `scripts/mutate.mjs（60 項目すべて v0/ 配下、scripts/ は0件）, scripts/winargs.test.mjs（純関数4つだけ）, scripts/verify.mjs:166`　**実測**: した

この観点でレビュー対象になっている門は全部これ: serve.mjs の KNOWN_FLAGS 拒否（#30）、--port 範囲検証、二重起動判定の repoOf 呼び出し（#31）、autostart の --repo 文字検証（#29）、**--allow-host / 観測フラグの引き継ぎ（c0948ea = 「再起動後だけ 403」）**。どれも実行して確かめるテストが存在しない。winargs.test.mjs は winQuote/repoOf/samePathish/trimTrailingSep を単体で見るだけで、**それを使う側の配線**（serve.mjs:162 の already 判定、autostart.mjs:135-145 の引き継ぎループ）は誰も触らない。CLAUDE.md が「テストを足したらここに変異も足す／落ちない検査は無意味」と 🚨 で書いている通りで、しかも c0948ea が直したバグは brief 自身が「手元では気付けず再起動後だけ壊れる形を既に1件出している」と名指ししているもの。引き継ぎループを消しても verify.mjs は緑のまま通る。

**再現**

```
$ grep -rln "serve\.mjs|autostart\.mjs" --include=*.test.mjs .
→ ./scripts/winargs.test.mjs のみ（中身は**コメントでの言及だけ**。実行はしていない）
$ grep -rn "KNOWN_FLAGS|知らないオプション" --include=*.test.mjs . → 0 件
$ grep -n "file:" scripts/mutate.mjs | 集計 →
  28 v0/server.mjs / 10 v0/git.mjs / 8 v0/transcript.mjs / 8 v0/execsession.mjs
   2 v0/ndjson.mjs / 2 v0/mergeplan.mjs / 2 v0/app.html / 1 v0/swimlanes.mjs
  → scripts/ 0 件（winargs.mjs / serve.mjs / autostart.mjs いずれも変異なし）
verify.mjs:166 が走らせる unit は 8 ファイルで、serve.mjs / autostart.mjs を起動する経路は無い（syntax ステップの parse のみ）。
```

**直し方の案**

最低3本: (1) autostart の install を run() 注入可能にして「--allow-host / --watch / --agents-text が serveArgs に入る」ことを assert する（c0948ea の回帰）。(2) serve.mjs を子プロセスで起動して未知フラグ→exit 1 を assert する。(3) mutate.mjs に scripts/ の変異を足す（引き継ぎループの削除、KNOWN_FLAGS の常時 continue、winQuote の素朴実装）。

---

## 反証されて消えた指摘

- **[stdin] 子が自分の stdin を閉じた後の書き込みが ok:true で通り、届いていないことが一切告知されない**

  反証できた（SERIOUS としては成立しない）。機構そのものは正しいが、重大度を支えている前提が3つ事実として誤りで、かつ既に docs/review-*.md に MINOR として記録・裁定済みの再報告であり、再発ではない。

■ A. これは既知の記録済み弱点であり、再発していない
docs/review-4-parallel.md:650 に「MINOR [stdin] 相手が自分で stdin を閉じた場合、書き込みは黒穴になるのに 200 ok を返し `▸` を全購読者に流す」として同一の機構が記録され、反証1〜4付きで **MINOR に格下げ済み**。当時「独立の指摘として起票を推奨」とされた実行可能な部分（stdin の 'error' listener が無くデーモンが落ちる）は**実装済み**: v0/server.mjs:1305 `child.stdin?.on('error', …)` が `⚠ 標準入力に書けませんでした: …` を購読者に流し、scripts/mutate.mjs:411 の `stdin-error-listener` が変異で固定している。残っているのは前回「原理的に検出できない」と裁定した部分そのもの。コード側の退行は無い。

■ B. 「README と smoke テストが 409 を主張している」は誤り（これが「嘘」框の土台）
- v0/README.md の会話コンソール節（210-250行）に「閉じた後の書き込みは 409」に相当する記述は**無い**。上限は 413/429、`{t:"in"}` は明示的に「**別端末から見ても何を送ったか分かる**」= 自分の送信のエコーと書いてあり、到達を主張していない。
- v0/smoke.test.mjs:1366 のコメント「閉じた後の書き込みは 409（黙って捨てない）」は、その直前で**クライアント自身が `{eof:true}` を送り `t:"exit"` を待った**文脈にある。そこで返る 409 は server.mjs:1405 の `if (!s.running)`（セッション終了）由来で、1411 の writable 判定由来ではない。つまりテストは「自分が閉じて子が終わった後」だけを主張しており、指摘が言う広い主張はしていない。

■ C. 「UI は入力欄をクリアし、打った本文は消える」は誤り（実測不要、コードで確定）
v0/app.html:742-746 は `inField.value=''` の後 `if (!r?.ok) inField.value = text;`（失敗時は戻す）。ok の場合でも本文は失われない: `in` レコードが app.html:620 で `▸ ${ev.d}` としてコンソールに描画され、リングバッファに残り、**再接続で再生される**（smoke.test.mjs:1372「入力は再接続でも再生される（自分の発言が消えない）」が固定）。「打った本文は消える」は成立しない。

■ D. kill の嘘と同型ではない
kill は `alreadyDone` を返して**状態変化を主張**する。input の `{ok:true,bytes:N,totalBytes,pending}` が主張しているのは「N バイトを標準入力に書いた」であって「相手が読んだ」ではない。パイプに ack は無いので「読んだか」は原理的に不可知で、良性の一般ケース（まだ読んでいない `npm test` 等）と観測上**完全に同一**。滞留は `pending` として応答に出しており（README にも記載）、隠していない。「clean=false なのに conflicts=[]」のような状態の虚偽報告とは別種。

■ E. 指摘が求める 409 は実装不可能（Windows 11 / node v24.12.0 で私が再実測）
scratchpad/refute-stdin.mjs（リポジトリは無変更、プロセスは終了確認済み）:
  child reported fd0 closed. childAlive = true
  write#0 returnValue=true cbErr=null writable=true destroyed=false writableLength=0 errors=[]
  write#1..#2 も同一。end() は throw せず、after end / after kill も errors=[]
つまり `writable` / `destroyed` / `writableLength` / write コールバックのどれを見ても「相手が閉じた」を「まだ読んでいない」から区別できない。指摘者自身も 4) で同じ結論を書いており、要求は充足不能。前回レビューの反証1（A_closed と B_never_reads が1つも違わない）と一致。

■ F. 到達性
「fd 0 を閉じてなお走り続ける」プログラムを operator が意図的に選ぶ必要がある。README が動くものとして挙げる `claude --input-format stream-json` / `git commit -F -` / `patch` / REPL / y-N CLI はどれも stdin を読み切るか、閉じたら**終了する**（終了すれば `!s.running` が正確な文言で 409 を返し、smoke.test.mjs:1367 と :1413 が固定）。指摘の「claude が内部で入力を打ち切った場合」は実測の裏付けが無い推測。決定的再現には人工的な `process.stdin.destroy()` + `setInterval` が必要。

■ 残る有効な芯（MINOR 相当、独立に扱うべき小さな指摘）
指摘の 1402-1412 の try/catch が実質到達不能である点は正しい: 1411 のガードと 1438 の `write()` の間に await が無く同一ティックであり、`write` after end / destroyed は同期 throw ではなく非同期 'error' なので catch に落ちない。コメント「子が既に死んでいると EPIPE。落とさずに理由を返す」は不正確で、CLAUDE.md が要求する「冗長な防御なら mutate.mjs の `defensive` に理由を書く」も満たしていない。ただしこれは**コメントの正確さの問題**で、利用者に対する嘘でも穴でもない。

以上より、SERIOUS としては反証成立。報告するなら「コメントの不正確さ + defensive 記載漏れ」として MINOR。

- **[stdin] 滞留の 429 が {eof:true} まで拒否するので、詰まったセッションを EOF で終わらせる道が消える**

  機構の記述は正しいが、被害の主張が実測で崩れる。

■ 認めるところ（コード確認済み）
`v0/server.mjs:1429-1435` の滞留の門は `eof` を除外していない。`pending = s.child.stdin.writableLength` を eof かどうかに関係なく見て 429 を返すので、`{eof:true}`（`bytes=0`）も未読 1MB 超の状態では拒否される。413 側（`s.inputBytes + 0 > limits.inputTotalBytes`）が eof を通すという指摘も正しい。UI の EOF ボタンは `v0/app.html:750` → `write('', true)` → body は `{eof:true}` なので、この経路に確実に乗る。

■ 反証（「EOF で終わらせる道が消える」は成り立たない。その道は元から存在しない）
`inputPendingBytes`（1MB, `v0/execsession.mjs:41`）を超えた状態で `stdin.end()` を呼んでも、**stdin は閉じない**。`end()` は「キューを吐き切ってから FIN」なので、相手が読まない限り FIN は永久に届かない。指摘と同じ形（stdin を読まない子 + 60KB 行）で実測（サーバ抜きの素の Node、Node v24.12.0 / Windows）:

```
i=17 wrote=1105938 writableLength=1105938
--- before end(): writableLength= 1105938
right after end(): {"writableLength":1105938,"writableEnded":true,"writableFinished":false,"destroyed":false,"childExited":false}
3s after end():   {"writableLength":1044497,"writableEnded":true,"writableFinished":false,"destroyed":false,"childExited":false}
```
`writableFinished=false` / `destroyed=false` のまま、3秒で抜けたのは OS のパイプバッファ1杯ぶん（約60KB）だけ。子は EOF を観測せず、終了もしない。

したがって、もし門が eof を通していたら、サーバは 200 ok を返し `emit(s,'note','（標準入力を閉じました）')` を全購読者と再接続先に流すのに、**実際には閉じていない**。これはこのリポジトリが最も重いとしている「停止しましたと言って停止していない」そのもので、`docs/review-4-parallel.md:656` に記録済みの「200 ok と `in` 記録は出るのに相手に届いていない」と同種の嘘。つまり現在の 429 は救済手段を奪っているのではなく、**効かない操作の実行を断っている**（拒否する方が誠実）。

さらに論理として、429 が eof を塞ぐ状態集合と、eof が無効な状態集合は一致する: EOF を見て終われる子は、EOF に到達する前に先頭の 1MB を必ず読まなければならない。読めば滞留が 1MB を下回り門は開く。読まない子は EOF では終われない（`setInterval` の例がまさにこれ）。よって「唯一の穏当な手段が奪われ、残るのは kill だけ」は誤りで、この状態の正しい手当ては kill（`/kill` は入力の門を通らず `killTree` する）か `--exec-detached-grace` / `--exec-timeout` の自動終了である。滞留が 1MB 以下なら eof は今も通り（`v0/smoke.test.mjs:1362` が実証）、1MB 超は「排出後に再送すれば同じ結果」＝待ちが要るだけで能力の喪失はない（`end()` 自体がどうせ排出待ちになる）。

「無反応に見える」も成り立たない。`v0/app.html:571-578` が `✖ <error>` を赤で出す（黙って捨てていない = 規則どおり）。

■ 残る瑕疵（SERIOUS ではなく MINOR）
メッセージの文言だけ。eof は1バイトも送らないのに「読まれるまで**送れません**」と言うのは不正確（内容としての「相手が読むまでこの操作は効かない」は上の実測どおり真）。`eof` のときは「未読 1080KB が残っているので閉じても届きません。読まれるのを待つか、停止してください」のように分ければ済む文言修正で、機能の欠落ではない。

- **[tests] smoke の全体実行が孫プロセスを取り残す（「孫も殺す」テストは ✔ のまま）**

  反証できた。指摘の中核（「`node --test v0/smoke.test.mjs` が実行のたびに孫を1本取り残し、しかもテストは緑」）は実測で成立しない。残っている 5 本は**緑の全体実行の残骸ではなく、`scripts/mutate.mjs` が意図的に守りを外して走らせた変異実行の残骸**（そのときテストは正しく落ちる）である。

【1. 全体実行では取り残さない（実測）】
HEAD=284ddac で `node --test v0/smoke.test.mjs` を1回。開始 04:50:03 / 終了 04:51:13、`ℹ tests 92 / pass 91 / fail 0 / skipped 1`（exit 0、duration 70.1s）。並行して 250ms ごとに `Win32_Process` で `*grandchild*` を監視したログ（scratchpad/procs.log）:
- APPEAR 04:50:35.36 pid=34780 cmd.exe created=04:50:34.9496（`cmd /c node …\kjp-smoke-0ahfxi\grandchild.mjs …`）
- APPEAR 04:50:35.36 pid=33580 node.exe created=04:50:34.9865 parent=34780
- GONE 04:50:37.35 pid=34780 / GONE 04:50:37.36 pid=33580
つまり孫は 2.4 秒後に消えている。テスト後の `*grandchild*` プロセス数は実行前と同じ 5 本（17716,22044,36332,27816,41028 = すべて実行前から存在）で **1本も増えていない**。`kjp-smoke-0ahfxi*` は `after()` の rm で消えており（`ls` で不在）、rm 失敗が飲まれた形跡もない。単体指定（`--test-name-pattern='中間シェルを挟んだ孫プロセス'`）でも APPEAR 04:52:20.077 → GONE 04:52:22.63、`kjp-smoke-du25Va*` も消滅。

【2. 残っている 5 本の出自は変異実行】
5 本の作成時刻は、それぞれの `kjp-smoke-*` 作成時刻の **+1 秒**（2:19:14→2:19:15、2:22:41→2:22:42、2:54:43→2:54:44、2:59:56→2:59:57、3:09:40→3:09:41）。しかし全体実行では孫テストに到達するのは **+31 秒**（上の実測）で、+1 秒に到達するのは `--test-name-pattern` で1件だけ走らせた形（実測 +1.0 秒）。それは `scripts/mutate.mjs` のやり方そのもので、同ファイル 620-630 行に
`name: 'exec-kill-tree-win'` / `from: execFile('taskkill', ['/PID', …, '/T', '/F'],` → `to: … ['/PID', …, '/F'],` / `pattern: '中間シェルを挟んだ孫プロセス'`
という変異がある。`/T` を外せば孫は残る（=変異は検出され、テストは落ちる）。残骸の beacon はそれを裏づける: B3pvgN は 04:53:25 に 85,027 バイト（作成 2:19:15 から 154 分 ≒ 9,250 秒、10回/秒なら 92,500 → 稼働率 92%）で、**生まれた直後から一度も止まらず書き続けている** = kill が最初から効いていない = そのランでは assert が落ちていた。緑のまま漏れた証拠にはならない。

【3. 「2点しか見ないので取りこぼしを捕まえられない」も成立しない】
孫は 100ms ごとに無条件で append する。実測でも生存孫は 3 秒で 28 バイト（≈9.3B/s）伸びる。`a` と `b` の間は 900ms あるので生存していれば差は ≈9 バイトで assert は必ず落ちる。さらに `a` の `readFileSync(beacon)` が成功する時点で孫は既に interval を回している（起動遅延で静かにすり抜ける余地がない。ファイルが無ければ ENOENT でテストが落ちる）。したがって「taskkill が取りこぼした1本」は**緑にならず落ちる**。

【4. 指摘側の再現の裏づけが弱い】
報告は `tests 91 / pass 90` だが HEAD は `tests 92 / pass 91`（= 別ツリー）。また「新規 PID 32676（04:41:04）」の時刻は作者のコミット 747ddb2(04:33)/284ddac(04:42) の間で、変異実行が並走していた時間帯にあたり、他プロセス由来の1本を自分の実行に帰属させた可能性が高い（+1 秒シグネチャの残骸 uxwV8k は 4:31:25 のディレクトリに対し 4:32 頃から連続書き込み＝やはり落ちるランの残骸）。

【残る本物（別の場所・軽微）】
`scripts/mutate.mjs` は「プロセス後始末の守りを外す」変異（`exec-kill-tree-win` / `exec-kill-tree-posix`）を走らせた後、置き去りになった孫と `%TEMP%\kjp-smoke-*` を回収しない。現在 5 本（17716,22044,36332,27816,41028）が生存し合計 CPU 約 120 秒・WS 約 310MB、beacon が今も 10B/s で伸びている。これは「変異ハーネスの後始末」の欠落で、smoke が緑のまま嘘をつく話ではないので MINOR。証拠として残す意図の 5 本は停止していない（私の 2 回の実行で作ったものは 0 本、監視用 PowerShell は停止済み）。ファイルは一切変更していない。


## 追記: 描画の予算を実測に載せたら、自己検査が別の嘘を見つけた（#3）

`v0/render-check.mjs` を入れて 12,000 行を実ブラウザに流したところ、
**「古い行を捨てています」の告知が消えていた**（先頭が `line 8000`）。
原因は告知を `prepend` してから毎回**先頭から**捨てていたことで、
次のトリムで告知自身が最初に消える。上限で省略したことを告げる仕組みが、
**上限そのものに食われていた**。告知を掴んで持ち、その次から捨てる形に直した。

学び:
- **`dataset` のフラグを見る検査だと通り抜けた。** 実際に見える文字を見るべき
  （フラグは立っていた。消えたのは要素の方）
- **予算の検査を入れる作業そのものが、予算とは別の欠陥を出した。**
  「測れる形にする」は検証の準備ではなく検証の一部
- `verify.mjs` が `render 240.7s` を出したのは遅いからではなく、
  CDP の上限タイマーを解除していなかったから。**遅さと取り違えて原因を探した**

## 対応の記録（#35〜#45 を全件）

11件すべてに手を入れた。**修正そのものより、「検査が守りを測れていなかった」形が
繰り返し出た**のが今回の主題なので、そこを分けて書く。

### 検査が守りを測れていなかった（型として再発している）

| | 何が起きていたか |
|---|---|
| #41 | `assert.match(body, /sessionStorage\.setItem\(…\)/)` は**JS を1度も走らせていない**。行を残したまま到達不能にする変更（`if (false && t)`）が完全に見えない。変異は KILLED でも測っているのは「行が消えたこと」だけ |
| #42 | 個別の try/catch には変異があるのに、**汎用の砦（top-level `.catch()`）には検査が1件も無く**、丸ごと消しても全緑。しかも `also` の書き方（`.catch(err => { throw err; }).catch(本体)`）は**直後の catch が再捕捉するので無効**で、コメントが事実と違っていた |
| #45 | 運用スクリプトの門に**テストも変異も1件も無かった**。`--allow-host` と観測フラグの引き継ぎは落ちても手元では気付けない（再起動後だけ 403 / ログオン後だけパネルが消える） |
| CI | `stream-detach-if-gone` が **Linux だけ SURVIVED**。`res` の 'close' がリスナ登録の前か後かの競争で、環境によって守りが不要になる。`worktree-allowlist` は字面がずれて **SKIP のまま**（守りが未検証のまま静かに続いていた） |

打った手:

- **字面の assert を消し、実ブラウザで挙動を測る**（`render-check.mjs` が
  `sessionStorage` と `location.search` を読む）。**「行を消さずに到達不能にする」変異**を
  1件置いた（`auth-token-bootstrap-unreachable`）
- **砦そのものに検査用の throw 経路**を `--layout-probe` 配下に置いた。
  ⚠️ **内側の `try` より手前**に置く（中だと内側が捕まえて砦を測れない。最初これで測り損ねた）
- **`--exec-stream-delay`（既定 0）**で「応答が届く前に切られた」を決定的にした
- **`mutate.mjs` の SKIP を分割した。** 字面がずれた変異は `STALE` として**失敗**に
  する（exit 1）。SKIP はプラットフォーム外だけ。これが無いと同じ穴が静かに再発する
- **`mutate.mjs` に `script` を足した。** `node --test` 以外の検査（実ブラウザ）にも
  変異を掛けられるようにした。これが無いと実ブラウザの検査だけが変異の外に残る

### 実装の穴（塞いだ）

- **#39** `--token-file` の門が linked worktree と bare を見ていなかった。
  実測でトークン本体が `git show HEAD:token` に出た。全 worktree + `.git` を根にする
- **#35** 予約した実行枠が返らない経路（8回で恒久 429）。回収機構の起動を
  「過去に1本成功したか」に依存させるのもやめた。`never-started` を `timeout` と分けた
- **#43** 同名 Cookie の先頭1本しか見ていなかった（他ポートのページが締め出せる）
- **#38** パスに上限が無く、`--watch-agents` だけで 48KB の任意テキストが出た。
  **「自由文は1文字も通さない」という背骨の主張が成立していなかったので、文書を直した**
  （パスは本質的に自由文。160 文字で切って告知し、残るリスクを明示した）
- **#36 / #37** 「記録なし」と嘘をつく2経路。cwd が最新1本から読めない／窓が全部
  「知らない種別」。どちらも**読み直して、駄目なら「抽出できなかった」と言う**
- **#44** 「解釈できない行は捨てない」という宣言が JSON.parse の失敗にだけ効いていた。
  `app.html` の中にあったのでテストできず、宣言が破れても気付けなかった →
  `v0/chatfilter.mjs` に切り出した
- **付随して見つけた**: `handleRequest` の内側の catch が**例外メッセージをそのまま
  返していた**（内部のパスや git の出力が、認証を通っていない相手にも渡る）
