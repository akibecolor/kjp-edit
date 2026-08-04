# 4回目のレビュー（並列・独立） — b1874a0..HEAD

**きっかけ**: 「レビューアーがちゃんとチェックしていますか？」と問われたこと。
それまでの6コミット（L1 / `--token-file` / L2 / 認証 / #17 / #18、約1,400行の
新規実装）は**自己検査だけで進めていた**。

**やり方**: `.claude/workflows/adversarial-review.mjs` で6観点を独立に並列レビューし、
各指摘を別のエージェントに反証させ、**反証できなかったものだけ**を残した。
エージェント24本 / ツール呼び出し698回 / 39分。

| | |
|---|---|
| 検証した指摘 | 18 件 |
| 🚨 BLOCKING | **4** |
| ⚠️ SERIOUS | 11 |
| MINOR | 2 |
| 反証されて消えた | 1 |

**打ち切った範囲（黙って絞らない）**:

- auth: MINOR 2 件は検証を省略しました
- transcript: MINOR 4 件は検証を省略しました
- transcript: 検証は上位 3 件に絞りました（4 件中）
- ops-scripts: MINOR 2 件は検証を省略しました
- ops-scripts: 検証は上位 3 件に絞りました（6 件中）
- stdin: MINOR 2 件は検証を省略しました
- stdin: 検証は上位 3 件に絞りました（5 件中）
- exec-session: MINOR 4 件は検証を省略しました
- tests: MINOR 3 件は検証を省略しました
- tests: 検証は上位 3 件に絞りました（4 件中）

---

## 最も重い発見: 直したはずの穴が直っていなかった

コミット `9451473` は「Cookie に実行トークンを入れていた」を直したことになっていて、
本文に**「Cookie が漏れても実行はできない」**と書いた。**これは事実と違った。**

`/api/v0/session` は Cookie で認証を通った要求に `opts.token` をそのまま返す。
`sameOrigin` の判定は `!site || ...` なので **`Sec-Fetch-Site` を送らない
非ブラウザのクライアントは素通り**する。つまり Cookie を受け取った相手は
**リクエスト1本多いだけで任意コード実行に到達する**。

さらにコード側のコメントにも「残るリスクは**読み取りはできる**」「実行を分離するのが
対策の要点」と書いた。**修正可能な欠陥を仕様上の限界として説明していた。**
これはこのリポジトリが最も重いとする「嘘」の型そのもの。

守りの検証も無かった: 該当のスモークテストは `code === 200` しか assert せず、
**応答にトークンが入っているかを一切見ていない**（塞いでも塞がなくても緑）。

---

## 生き残った指摘

### 🚨 BLOCKING [auth] 読み取り専用 Cookie が /api/v0/session で実行トークンに交換できる（9451473 の分離が成立していない）

**場所**: `v0/server.mjs:1105`　**実測**: した

**何が壊れるか**

commit 9451473 は「Cookie に実行トークンを入れていた（他のローカルサービスに漏れる）」を直したことになっているが、Cookie を受け取った相手は追加の1リクエストで実行トークンを取り戻せる。authed() は Cookie で通り（server.mjs:748）、/api/v0/session は `opts.allowWrite && sameOrigin` で opts.token をそのまま返す。sameOrigin は `!site || site==='same-origin' || site==='none'` なので、**Sec-Fetch-Site を送らない裸の HTTP クライアント（=ブラウザ以外の何でも）が該当する。** Cookie はポート分離が無いので 127.0.0.1 の他のポートを開くだけで届く — つまり修正前とまったく同じ攻撃者が、リクエスト1本多いだけで任意コード実行に到達する。さらに server.mjs:694-697 は「残るリスクは**読み取りはできる**」「実行を分離するのが対策の要点」と書いており、これは事実と違う（このリポジトリで最も重い欠陥の型）。smoke.test.mjs:1742-1747 は挙動を認識しているが「Sec-Fetch-Site を偽装できるので受け入れたリスク」としており、code 200 しか assert せずトークンが入っていないことを検査していないので、守りとして落ちない。

**再現**

```
node v0/server.mjs --repo <tmp> --port 0 --require-auth --allow-exec --token EXEC-TOKEN-0123456789abcdefghij
1) Cookie 値は token から決定的に導ける: sha256(TOKEN + "\nkjp-edit auth cookie v1").base64url（ブートストラップが焼く値と一致を実測: true）
2) GET /api/v0/session （ヘッダは Cookie のみ、Sec-Fetch-Site 無し）
   → 200 {"allowWrite":true,"allowExec":true,...,"token":"EXEC-TOKEN-0123456789abcdefghij"}
3) POST /api/v0/exec に x-kjp-token: <そのトークン> で {argv:["node","-e","console.log('RCE-PROOF:'+process.pid)"]}
   → 200 {"n":1,"t":"out","d":"RCE-PROOF:31552\n"} / {"n":2,"t":"exit","code":0}
   Sec-Fetch-Site を一切付けない場合も同じく成功（実測）。
```

**直し方の案**

認証を通ったことと「実行トークンを渡してよいこと」を分ける。(a) /api/v0/session は Cookie 認証の要求にはトークンを渡さない（生の token / X-Kjp-Token で認証した要求だけに渡す）、または (b) 実行の関門を Cookie から導出できない別の秘密で守る（Cookie とは逆向きの導出にする）。少なくとも server.mjs:694-697 の「読み取りはできる」を「実行まで到達できる」に訂正し、smoke テストに `assert.equal(JSON.parse(sess.body).token, null)` を入れて落ちる検査にする。

**反証を試みた結果**

反証できませんでした。指摘どおりに再現しました（自前スクリプトで実測、サーバは終了確認済み）。

実測値: `--repo <tmp> --port 0 --require-auth --allow-exec --token EXEC-TOKEN-0123456789abcdefghij` で起動し、
1) `GET /?token=...` → 302、Set-Cookie の値は `sha256(TOKEN + "\nkjp-edit auth cookie v1").base64url` と一致（cookie==derived = true / cookie==TOKEN = false ← 9451473 の「Cookie に生トークンを入れない」自体は効いている）
2) `GET /api/v0/session`（Cookie のみ、Sec-Fetch-Site 無し）→ **200 `{"allowWrite":true,"allowExec":true,...,"token":"EXEC-TOKEN-0123456789abcdefghij"}`**
3) そのトークンを `x-kjp-token` に入れて `POST /api/v0/exec` → **200 `{"n":1,"t":"out","d":"RCE-PROOF:9544\n"}` / `{"n":2,"t":"exit","code":0}`**

試した反証と、なぜ成り立たないか:
- 「`--allow-write` が無ければ 1105 は null」→ v0/server.mjs:76 が `--allow-exec` で `opts.allowWrite = true` を暗黙に立てる。exec を有効にした構成では必ず allowWrite が真なので回避不能。
- 「入口の Sec-Fetch-Site 検証で止まる」→ `siteAllowed()`（v0/server.mjs:633-637）は `if (!site) return true`。ヘッダを送らないクライアントは素通り。明示的に `cross-site` を送った場合だけ 403（実測）。攻撃者は送らないだけでよい。
- 「`hostAllowed()` のポート一致で止まる」→ 接続先ポートは既知なので `Host: 127.0.0.1:<port>` を正しく付けられる（実測で通した）。
- 「`authed()` が Cookie を弾く」→ v0/server.mjs:748 が Cookie を第一候補で受ける。

加えて、指摘の「最も重い欠陥の型」の部分も裏付けられました。v0/server.mjs:694-697 の「残るリスク（消せない）… **読み取りはできる** … 実行を分離するのが対策の要点」と、9451473 のコミット本文「**Cookie が漏れても実行はできない**」は実測と矛盾します。しかも「消せない」も誤りで、`/api/v0/session` のトークン払い出しを「`?token=` を提示した要求のみ」等に絞れば分離は成立するため、修正可能な欠陥を仕様上の限界として説明しています。

守りの検証も不在: v0/smoke.test.mjs:1742-1747 は `code === 200` しか assert せず、応答にトークンが入るかを一切見ないので、この経路を塞いでも塞がなくても緑のまま（「落ちない検査は無意味」）。

再現スクリプト: C:\Users\akico\AppData\Local\Temp\claude\C--Users-akico-Documents-kjp-editor\243d11c6-c19f-4c1f-ae8c-7f29ccff177f\scratchpad\refute-session-token.mjs（起動したサーバは停止確認済み。`kjp-repro*` の node プロセスは残っていない）

重大度は BLOCKING のまま妥当: Cookie を受け取った相手がリクエスト1本で任意コード実行に到達し、かつコメント/コミットが事実と異なる主張をしている。

---

### 🚨 BLOCKING [exec-session] spawn が非同期に失敗すると（存在しないコマンド / Windows の `npm`）セッションは永久に「running」。枠も返らない

**場所**: `v0/server.mjs:1197（`child.on('exit')`）と 1194（`child.on('error')`）`　**実測**: した

**何が壊れるか**

`exit` は spawn 失敗では**発火しない**（Node は `error` と `close` だけを出す。実測: `pid= undefined events= error:ENOENT | close:-4058`）。#17 で「exit が来なくても枠を返す保険タイマー」を削除した（scripts/mutate.mjs:366 に「不要になった」と書いてある）ため、`finish()` を呼ぶ経路が1つも残っていない。結果:
(1) `/api/v0/state` が `state:"running", exit:null` を返し続ける — **起動していないプロセスを「実行中」と表示する嘘**。UI のコンソールは exit を受け取らないので永久に回り続ける（fetch が解決しない）。
(2) 枠が返らない。ミスタイプ 8 回で `--allow-exec` が実質死ぬ。回復は購読を切って 300 秒（切断猶予）か、購読したままなら 600 秒（絶対上限）。
(3) その回復時の記録が `⚠ 上限時間 600s を超えたので停止します` / `signal:"SIGKILL"` — **起動すらしていないプロセスを殺したと主張する**。
Windows では `argv:["npm","test"]`（拡張子なし）がこの経路。`npm.cmd` は同期 EINVAL でハンドルされるのに、素の `npm` は ENOENT でここに落ちる。つまり**一番打ちそうなコマンドが必ず踏む**。

**再現**

```
1. `node v0/server.mjs --repo <repo> --port 0 --allow-exec --token <32桁>`
2. `POST /api/v0/exec {worktree, argv:["no-such-command-xyz"]}`（`["npm","test"]` も同じ）
実測（v0/server.mjs 現行, Node 24.12, Windows）:
- 8 秒後 `stream ended=false`、受信は `{t:session,state:running}` と `{t:err,d:"実行エラー: spawn no-such-command-xyz ENOENT"}` の2行だけ。exit が来ない
- `/api/v0/state?fresh=1` → `{"state":"running","exit":null,"subscribers":1,"ageMs":8254}`
- 同じ要求を 9 回 → status `200,200,200,200,200,200,200,429,429`、`running のまま残っている本数: 8 / 台帳 8`（全部 pid 無し）
- `--exec-timeout 3` で起動すると 3 秒後に `{t:err,d:"⚠ 上限時間 3s を超えたので停止します"}` `{t:exit,code:null,signal:"SIGKILL"}` が流れる（存在しないプロセスに対する SIGKILL の主張）
```

**直し方の案**

`child.on('error', ...)` の中で `finish(session, {code:null, signal:null, note:'起動できません: ...'})` まで行う（`spawn` の同期 EINVAL 経路と同じ扱いにする）。加えて `close` も購読して「exit が来ないまま stdio が閉じた」を終端として扱う（`exit` を選んだ理由＝孫がパイプを握る件は、`exit` を主、`close` を保険にすれば両立する）。回帰テストは「存在しないコマンドを投げたら exit レコードが来て、続けて 9 本目が 200 になる」で固定でき、`child.on('error')` から finish を外すと落ちる。

**反証を試みた結果**

反証できなかった。指摘は実測で再現する。(1) Node の spawn 非同期失敗では 'exit' が来ない: 実測 `no-such-command-xyz` / 素の `npm` → `pid=undefined events= error:ENOENT | close:-4058`（`npm.cmd` だけが同期 EINVAL で 1167-1179 にハンドルされる）。(2) server.mjs:1194 の `child.on('error')` は `emit()` だけで `finish()` を呼ばず、1180 の `attachChild()` は try の外で無条件に走るので state='running' になる。scripts/mutate.mjs:366 の「sweep と明示的 kill がどちらも先に finish() するから保険タイマーは不要」という理由付けは、finish() を呼ぶ経路が1つも無いこの経路を覆っていない。(3) 実測（--port 0 / --allow-exec、実行後にサーバは停止済み・残留リスナー無しを確認）: POST は 8 秒後も ended=false、受信は session と `実行エラー: spawn … ENOENT` の2行のみ。`/api/v0/state?fresh=1` → `{"state":"running","exit":null,"subs":1,"ageMs":8260}`。9 連投で `200×6,429,429`（初回含め計 8 本予約）→ `running のまま 8 / 台帳 8`。`--exec-timeout 3` で `⚠ 上限時間 3s を超えたので停止します` + `{"t":"exit","code":null,"signal":"SIGKILL"}` が流れる（起動していないプロセスへの SIGKILL 主張）。(4) 検査は存在しない: smoke.test.mjs に ENOENT / 起動できません / 実行エラー の grep が0件で、同期 EINVAL 側も未検証。試した反証2件はいずれも失敗した。(a) 「Windows の UI プリセットは app.html:437 で `cmd /c npm test` なので素の npm は打たない」→ 報告者の「一番打ちそう」という枕詞だけが弱まる。実測で `pytest` と `make` も `error:ENOENT`（exit 無し）で同じ経路に落ちる。`claude` と `git` はこの環境では実体が .exe なので通る。(b) 「ペインを閉じれば枠が返る」→ app.html:722-724 は意図的に abort（購読解除）だけで、server.mjs:939-951 の detach も明示的に kill しない。さらに app.html:636 が「セッション … はまだ走っています」と、存在しないプロセスについて表示する。唯一の即時回復は 停止（/kill → finish）で、報告はこの緩和策に触れていないが、利用者が「running は幻」と気付いている必要があるので判定は変わらない。state:"running" と signal:"SIGKILL" はどちらもこのリポジトリが最も重いとする「嘘」に該当するため BLOCKING を維持する。

---

### 🚨 BLOCKING [stdin] 標準入力に送った直後に相手が終わるとデーモンが Unhandled 'error' (EPIPE) で死ぬ

**場所**: `v0/server.mjs:1260（`s.child.stdin.write(data)`。child.stdin に 'error' リスナが無い。1194 の `child.on('error')` は spawn 用でストリームの書き込み失敗は拾わない）`　**実測**: した

**何が壊れるか**

入力の書き込み失敗は**同期例外ではなく非同期の 'error' イベント**なので 1259-1266 の try/catch は効かず、リスナが無いため uncaughtException になり **サーバプロセスが exit 1 で落ちる**。落ちると (a) 走っている exec セッション全部が一緒に消える（Windows では libuv の job object でぶら下がった子も死ぬ。実測で残存 0）、(b) SIGINT/SIGTERM ハンドラ（server.mjs:1618）を通らないので **監査ログに exit が1件も書かれない**（実測: start / start / input×40 で終わり）、(c) scripts/serve.mjs にも autostart にも再起動の面倒見が無い（serve.mjs:194 は子の exit をそのまま返すだけ）ので**ログオンまで観測が止まる**。しかも直前の POST は `{"ok":true,"bytes":61441}` を返し UI は `▸ …` を出しているので、記録の上では「送れた」ことになっている。README が『動くもの: y-N を stdin で読む CLI』と書いている使い方でそのまま起きる。実際に動いている本人のデーモン（--allow-exec --allow-host <tailnet> --watch-agents）がこの形。

**再現**

```
scratchpad/probe-realistic.mjs（一時リポジトリ + `--allow-exec --token … --port 0`）:
1) `POST /api/v0/exec` argv=[node,-e,'1行読んだら exit'] （README の y-N CLI 相当）
2) `POST /api/v0/exec/<id>/input` に 60KB の行を1回
観測: `paste part 1 -> 200 {"ok":true,"bytes":61441,"seq":2}` / `paste part 2 -> fetch failed` / `daemon exitCode = 1`
サーバの stderr: `Unhandled 'error' event … Error: write EPIPE at Socket._writev … errno -4047`
同じ形を2通り確認（probe-crash.mjs）: (A) 入力を溜めた状態で UI の「停止」= `POST /kill` → `POST /kill -> fetch failed` / exitCode 1、(B) 相手が自分で exit → exitCode 1。閾値は 3×60KB=180KB から決定的に再現（probe-thresh.mjs: 3/5/8/16 個すべて exitCode=1。1〜2 個は OS のパイプバッファに収まって落ちない）。stdin を読まない相手なら 2.3MB で確実。
```

**直し方の案**

spawn 直後に `child.stdin.on('error', err => execRegistry.emit(session,'err',`標準入力に書けません: ${err.code}`))` を付ける（最低限、落とさない）。さらに `write(data, err => …)` のコールバックで失敗を購読者に流し、失敗したら以後 `in` を「送れた」と表示しない。回帰テストは「入力を溜めて kill → デーモンが生きていて /api/v0/state が 200」で固定し、mutate.mjs から 'error' リスナを外して落ちることを確認する。

**反証を試みた結果**

反証できず。現 HEAD で2通り再現した（スクラッチパッドの refute-epipe-02.mjs / refute-epipe-03.mjs、いずれも一時リポジトリ + --allow-exec --token <32文字> --port 0、デーモンは子として起動して exitCode と stderr を観測、終了時に必ず kill）。(A) README の「y-N を stdin で読む CLI」相当（`node -e 'process.stdin.once("data",()=>process.exit(0))'`）に 60KB を無遅延で8回 → `input 8 -> 200 {"ok":true,"bytes":61441,"seq":8}` の直後に `daemon.exitCode=1`、stderr は `Error: write EOF (errno -4095) Emitted 'error' event on Socket instance`、監査ログは `{"start":1,"input":8}` で exit が1件も無い。(B) stdin を読まない子に 60KB×3 の後 UI の停止ボタン相当 `POST /kill` → `kill -> FETCH FAILED` / `exitCode=1` / `Error: write EPIPE at clearBuffer (node:internal/streams/writable:781:7)` / 監査は `{"start":1,"input":3,"kill":1}`。守りが無いことも確認: server.mjs 内の stdin 参照は 1254/1260/1261 のみ、`ExecRegistry.attachChild`（execsession.mjs:186）は stdio に触らず、v0 に `uncaughtException` ハンドラは無い。1254 の writable/destroyed 判定と 1250 の 409 は「遅い」場合だけ効く（150ms 間隔の最初の probe では 409 が返り落ちなかった。指摘の「1〜2個は OS のバッファに収まる」と一致）が、既に writable の内部バッファに積まれた分は非同期 'error' で来るので 1259-1266 の try/catch は到達不能。killTree（848）は stdout/stderr のみ destroy し stdin を残すので停止経路も無防備。監督も無い（scripts/serve.mjs:194 は子の exit をそのまま返すだけ、autostart.mjs は Startup 登録のみ）。既存テスト（smoke.test.mjs:1301-1435）は小さな単発入力と関門/409/404 だけで、バッファ済み書き込みと exit の競合を一切踏まない。指摘の唯一の訂正は装飾的なもので、子が先に終わる経路は EPIPE ではなく `write EOF`（errno -4095）、kill 経路が EPIPE（-4047）。どちらも同じ未処理 'error' で exitCode 1。重大度は BLOCKING 維持: 認証済み POST が {"ok":true,...} を返し UI が「▸」を出した直後にデーモンが全セッションごと死に、監査に exit が残らない = このリポジトリが最も重いと定めた「記録の上では送れたことになっている／停止したと言って停止していない」そのもの。

---

### 🚨 BLOCKING [transcript] T5（コマンド出力）が user の文字列 content から text[] に漏れる。同じ画面に「出しません」と書いてある

**場所**: `v0/transcript.mjs:171-177`　**実測**: した

**何が壊れるか**

`message.content` が**文字列**の user レコードを「ユーザのプロンプト(T4)」と決め打ちして clip している。実データではこのチャネルに `<local-command-stdout>…</local-command-stdout>`（スラッシュコマンド／`!` bash モードの**標準出力**）が入る。つまり `--allow-transcript-text` で **T5 = コマンド出力**が payload に載る。app.html:1041 は同じペインに「ツールの結果（読んだファイルの中身・コマンド出力）は出しません。」と表示するので、画面上の断言が嘘になる。`!cat .env` 相当が走っていれば秘密がそのまま 400 文字ぶん出る。背骨のテスト（transcript.test.mjs:57 と :97 の出現回数3）は、このチャネルに**素のプロンプトしか入れていない**ので緑のまま通る = 落ちない検査。

**再現**

```
実データで確認: `~/.claude/projects/C--Users-akico-Documents-tadaima-kochi-web/d6a94eb6-d6e9-44eb-819b-474c426f7760.jsonl` に `{"type":"user","message":{"content":"<local-command-stdout>Set model to claude-opus-5[1m]</local-command-stdout>"}}` が実在。その1行を `summarize([line],{allowText:true})` に通すと
  text[] = [{"at":"2026-07-30T17:16:57.374Z","role":"user","text":"<local-command-stdout>Set model to claude-opus-5[1m]</local-command-stdout>"}]
合成でも同形を確認: content が `<bash-stdout>OPENAI_API_KEY=sk-INJECT-SECRET-12345</bash-stdout>` / `<local-command-stdout>AWS_SECRET_ACCESS_KEY=INJECT-SECRET-12345\nDB_PASSWORD=hunter2</local-command-stdout>` の user レコードで `JSON.stringify(summarize(...,{allowText:true})).includes('INJECT-SECRET-12345') === true`（allowText=false なら false）。`<local-command-stdout>` は3本の実記録（kjp-editor 自身の記録も含む）に存在する。
```

**直し方の案**

文字列 content も許可リストで縛る: `<local-command-stdout>` / `<local-command-stderr>` / `<bash-stdout>` / `<bash-stderr>` / `<local-command-caveat>` / `<ide_*>` / `isMeta:true` / `isCompactSummary:true` を含む・始まるものは T5 または非発話として落とす（残すなら talk だけ数えて本文は出さない）。テストは「user の文字列 content に上記タグで秘密を仕込み、allowText=true でも出現回数が増えない」を追加し、mutate に `transcript-user-string-t5` を足す。

**反証を試みた結果**

反証できず、むしろ範囲が広がった。(1) 実データ確認: ~/.claude/projects/C--Users-akico-Documents-tadaima-kochi-web/d6a94eb6-....jsonl に type:"user" / message.content が文字列で "<local-command-stdout>Set model to claude-opus-5[1m]</local-command-stdout>" が実在。全記録の string-content 481件は plain 434 / task-notification 44 / local-command-caveat 1 / command-name 1 / local-command-stdout 1 で、このチャネルが素のプロンプト専用でないことは実測で確定。(2) 再現成功（scratchpad/refute-t5-stdout.mjs）: allowText=true で JSON.stringify(summarize()).includes('INJECT-SECRET-12345')===true、allowText=false で false。(3) 指摘より穴が広い: 同じ秘密が transcript.mjs:211-217 の b.type==='text' ブロック経路でも出た（<bash-stdout>ARRAY-CHANNEL-…）。171-177 だけ直しても塞がらない。(4) 他の守りは効いていない。app.html:1041 の「ツールの結果…は出しません。」は s.agentsText で分岐しておらず無条件（分岐は 1037 のみ）。server.mjs:1607 の起動警告は「発話とコマンド行も出します」だけ。server.mjs:494 のコメント「自由文が入るのは text[] と recent[].command だけ」は真だが、コマンド出力がその text[] に入るので不変条件が空振りしている。v0/ 全体に local-command / bash-stdout のフィルタは無い（grep はコメントと test の toolUseResult のみ）。読み取り側の認証（e7c7d05）は「誰が」を絞るだけで、docs/agent-observation.md:87-93 の T5 解禁条件のうち 3（T5 は三段目の独立フラグ）は未達。(5) テストの盲点も確認: transcript.test.mjs:57 は文字列チャネルに素のプロンプト、:59 は text ブロックに assistant の散文しか置かないので :97-99 の出現回数3は緑のまま。さらに scripts/mutate.mjs:234-247 が transcript-t5 を defensive として「ブロックの抽出も許可リスト（text/tool_use のみ）なので現状は二重」と記録しており、この根拠自体が誤り（text/文字列チャネルがコマンド出力を運ぶ）。変異台帳が成立していない守りを保証してしまっている。唯一の緩和材料は、この手元の記録では実在した 1 件が「Set model to…」で秘密を含まず、真の <bash-stdout> user 文字列レコードは存在しない（bash-stdout の grep hit は全てこのレビュー用ワークフローの subagents/workflows/wf_0b9bb0aa-700/*.jsonl 内の tool_use/tool_result、つまりレビュープロンプトが文字列を引用しているだけ）こと。ただし ! bash モードは1キーの正規経路で、docs:83-84 が T5 の理由として挙げているのは「予測できない」ことそれ自体なので、正しさの反証にはならない。重大度は BLOCKING 維持: 画面の無条件の断言が、その断言を表示するモードにおいて嘘であり（このリポジトリで最重の欠陥類型）、設計文書が「交渉不可」と書いた線を越え、背骨と呼んでいるテストが原理的に落ちない。

---

### ⚠️ SERIOUS [auth] 壊れた Cookie 1本で無認証のままデーモンが落ちる（認可の手前の同期例外。同じ型を一度直したのに再発）

**場所**: `v0/server.mjs:713`　**実測**: した

**何が壊れるか**

readCookie() の decodeURIComponent は不正なパーセント表記で URIError を投げる。呼び出し元 authed() はリクエストハンドラの `try {`（server.mjs:1066）より**手前**にあるので、例外が async ハンドラの unhandled rejection になりプロセスが exit 1 で死ぬ。認証はまだ通っていない段階なので、**--allow-host でトンネルに出していれば、トークンを持たない相手が1リクエストでデーモンを止められる**。server.mjs:1016-1019 が `new URL()` について「認可の手前にある同期例外はプロセスを殺す／認証前の1パケット DoS だった」と書いて直した箇所と同一の型で、hostAllowed/siteAllowed/authed/302 の区間（1020-1065）が丸ごとこの脆い領域に残っている。走っていた exec セッションの audit は `start` だけ残り `exit` が書かれないので、監査ログが「終わっていない実行」を残す。

**再現**

```
node v0/server.mjs --repo <tmp> --port 0 --require-auth --allow-exec --token <32文字>
curl 相当で GET /api/v0/state に `Cookie: kjp_auth=%` を1本送るだけ:
  クライアント側: ECONNRESET
  サーバ側: URIError: URI malformed
    at readCookie (v0/server.mjs:713:16)
    at authed (v0/server.mjs:748:26)
    at Server.<anonymous> (v0/server.mjs:1037:10)
  プロセス: exit { code: 1, signal: null }（1.5 秒後に確認）
※ 走っていた exec の子はこの環境では一緒に死んだ（取り残しは観測されず）。
```

**直し方の案**

readCookie の decodeURIComponent を try/catch で包んで null を返す。加えて 1020-1065 の区間を try の中に入れる（`new URL()` だけを特別扱いにしたのが再発の原因）。テストは `Cookie: kjp_auth=%` を送ってサーバが生きていることを assert し、mutate.mjs に「try/catch を外す」変異を足して落ちることを確認する。

**反証を試みた結果**

反証できませんでした。指摘どおり再現します（自作スクリプトで確認）。`--require-auth --allow-exec --token <32字>` で起動し、Host: 127.0.0.1:<port>、Cookie: kjp_auth=% の GET /api/v0/state を1本送るだけで `URIError: URI malformed at readCookie (server.mjs:713:16) at authed (748:26) at Server.<anonymous> (1037:10)` → クライアント ECONNRESET → `EXIT {"code":1,"signal":null}`、以後 ECONNREFUSED。検討した反証路はすべて成立しません: (1) 手前の関門で防がれる → 否。:1030 の hostAllowed/siteAllowed は許可 Host かつ Sec-Fetch-Site 無しの素の要求を通し、authed() は :1066 の try の外（スタックトレースに 1037 のフレームが出る）。(2) プロセス級ハンドラがある → 否。v0/ 全体に unhandledRejection / uncaughtException / clientError は無く、process.on は :1619 の SIGINT/SIGTERM だけ。Node 24 既定で unhandled rejection は致命的で、実測 exit 1。(3) 特殊な起動条件だから届かない → 逆。:1533 `if (opts.requireAuth === null) opts.requireAuth = opts.allowHosts.size > 0;` により --allow-host で requireAuth が既定オンになるので、トンネルに出す構成こそこの経路が生きている（素のループバック既定は :744 で早期 true なので無影響、影響範囲は狭まるが指摘の想定は否定できない）。(4) 既知として記録済み → 否。docs/review-*.md に記載無し、テストも無い（smoke.test.mjs:1713/1728/1737 の decodeURIComponent は正常な Cookie をクライアント側で復号しているだけで、壊れた Cookie を一切踏まない＝守りを外しても落ちる検査が存在しない）。(5) ブラウザ経由は siteAllowed で防がれる → 事実だが、指摘の経路は --allow-host への直接要求なので無関係。加えて :1016-1019 の作者コメント自身が new URL() について同一の失敗モードを記述しており、修正が URL パースだけを try で囲み :1030-1065（hostAllowed/siteAllowed/authed/302）を外に残したことは読み取れる。重大度は SERIOUS 維持（認証のための構成でのみ有効な認証手前のリモート kill、かつ exec 中に死ぬと監査ログが start だけ残して「終わっていない実行」を嘘として残す）。ファイルは変更していません。起動したサーバは自ら exit 1 で落ち、ポート残留はありません。

---

### ⚠️ SERIOUS [exec-session] 購読者が読まないと応答の書き込みが無制限に溜まる（RSS 72MB→433MB を実測）。しかも done セッションが evict されない

**場所**: `v0/server.mjs:914（`const send = obj => { if (!res.writableEnded) res.write(...) }`）と v0/execsession.mjs:263`　**実測**: した

**何が壊れるか**

リングバッファは 256KB / 4000 件で縛ってあるが、**購読者へ流す側には上限が無い**。`res.write()` の戻り値も `res.writableLength` も見ていないので、TCP の受信窓が閉じた購読者（= #17 が守りたかった「凍ったモバイルタブ」そのもの）に対して、子プロセスの全出力がサーバのユーザ空間に溜まる。execsession.mjs 冒頭に列挙した5つの制約（同時数・絶対上限・切断猶予・保持期間・バッファ上限）はどれもこれを縛らない。
さらに悪いことに、子が終了して `state:done` になっても、読まない購読者が接続を保っている間は `sweep()` の evict 条件 `!s.subscribers.size` が成立せず**台帳からも消えない**（絶対上限も切断猶予も done には効かない）。凍ったタブ 1 本で、数百 MB と台帳の1枠を無期限に押さえられる。

**再現**

```
1. サーバを `--allow-exec` で起動（既定値のまま）
2. 生ソケットで `POST /api/v0/exec` を送り、**一度も read しない**（`socket.pause()`）。argv は 200MB を stdout に吐く node -e
3. `tasklist` でサーバの RSS を1秒ごとに 12 回測る
実測: `before= 72,216 KB` → `433,504,433,504,433,528,...,350,152 KB`（子は 0.6 秒で exit 済み）。
同時に `/api/v0/state?fresh=1` は `{"state":"done","subscribers":1,"dropped":3196,"seq":3201}` を返し、14 秒後も台帳に残っている（`--exec-retain` を過ぎても消えない）。
```

**直し方の案**

`send()` で `res.writableLength`（あるいは write の戻り値と drain）を見て、閾値（例 1MB）を超えたら **その購読者だけ切る**。リングバッファと通番による再生機構があるので、切っても利用者は `from` で追いつける（黙って捨てるのではなく `{t:'err', d:'追いつけないので購読を切りました'}` を1行入れてから閉じる）。evict 側は `subscribers.size` ではなく「最後に書き込みが成功した時刻」を条件に足す。

**反証を試みた結果**

反証できなかった。独立に再現した（--allow-exec --exec-retain 2 --exec-detached-grace 2、生ソケットで POST /api/v0/exec して一度も read せず、子は 200MB を stdout に吐く）: サーバ RSS は before=68MB → t+1..7s=426MB → t+8..12s=331MB（子は 0.8 秒で exit 済み）。/api/v0/state?fresh=1 は {"state":"done","subscribers":1,"detachedMs":null,"seq":3200,"dropped":3195} を返し、retain=2s を大きく過ぎた +20.6s でも台帳に残る。socket.destroy() した 2.5 秒後にだけ execSessions が [] になった。コードも一致する: server.mjs:914 は res.write() の戻り値も res.writableLength も見ず、child.stdout の 'data'（server.mjs:1186）を止めない。RingLog の上限は再生用のみを縛り、購読者へのファンアウトは別の無制限コピー。server.timeout / requestTimeout / socket timeout は server.mjs に存在しないので詰まったソケットを切る者がいない。sweep()（execsession.mjs:263）は !s.subscribers.size を要求し、unsubscribe は res.on('close') / req.on('aborted') でしか走らないため done セッションが evict されない。加えて残った行は subscribers:1 / detachedMs:null を無期限に主張する（「嘘をつかない」に触れる）。／ただし1点だけ事実誤り: 「台帳の1枠を無期限に押さえる」は実行枠の意味では成り立たない。finish() が reserved を戻し（execsession.mjs:206）、create() は sessions.size ではなく reserved で判定するので、ghost な done/subs=1 を残したまま 8 本同時に投げて 200,200,200,200,200,200,200,200（429 は 0 件）だった。残るのは Map のエントリと state の嘘だけで、メモリはソケットの書き込みキューが持っている——修正箇所が別なので指摘文はここを直すべき。重大度は SERIOUS のまま: 蓄積の時間上限は --exec-timeout（既定600秒）だけで、溜まるのは V8 ヒープ外の Buffer なので高レートの子なら OOM まで行き、購読者8本で倍加する（過小ではない）。一方で --allow-exec が前提で、それは既に RCE 同等なので悪意モデルでは新しい権限は増えない。効いているのは #17 が守ろうとした善意の経路（停止したスマホのタブ）そのもの。

---

### ⚠️ SERIOUS [exec-session] `attachChild()` が finish 済みのセッションを running に戻す（枠の二重返却 + 「停止した」後に走り続ける）

**場所**: `v0/execsession.mjs:186-189（`attachChild`）と v0/server.mjs:1180`　**実測**: した

**何が壊れるか**

`attachChild` は状態を見ずに `s.state = 'running'` を書く。`create()` から `attachChild()` までの間には `await listWorktrees()` / `await auditExec()` / 2つの `await import()` があり、その窓の中で `sweep()` が同じセッションを kill 対象に選べる（`lastDetachedAt` は create 時に入っているので、購読が始まる前の `starting` セッションが `reason:'detached'` で拾われる — 実測で確認）。順序:
1. sweep が finish() → `exit` レコードを積み、`reserved` を1つ返す。child は null なので**プロセスは何も殺されない**
2. spawn が戻って attachChild → `state='running'`。以後 streamSession が購読するので `lastDetachedAt=null` になり、**sweep は二度と detached で拾わない**
3. クライアントは replay で `{t:'exit',signal:'SIGKILL'}` と「⚠ 切断されたまま…停止します」を受け取り、コンソールを終了扱いにする。**が、プロセスは絶対上限まで動き続ける** = 「停止しました」と言って停止していない
4. 子が本当に終了すると finish がもう一度通り、`reserved` が**同じセッションで2回減る** → 同時数 8 の勘定が恒久的に狂う（上限を超えて走らせられる）
note の文面も嘘になる（クライアントは切断していない）。

**再現**

```
台帳レベルで実測（`ExecRegistry` を直接叩いた出力）:
```
create: reserved=1 state=starting
finish: true state=done reserved=0
attachChild 後: state=running running=true reserved=0   ← 復活。枠は返却済み
2度目の finish: true reserved=0
log records: [{n:1,t:err},{n:2,t:exit,signal:SIGKILL},{n:3,t:exit,code:0}]  ← exit が2つ
上限2の台帳で同じことをすると、a が走っているのに新規2本が作れる（sessions=3）
```
sweep が child 未設定の starting を拾えることも実測: `sweep kill: [{reason:'detached', child:null}]`。
サーバ経路で窓が開くのは create→spawn が猶予/上限より長いときで、`--exec-detached-grace 1` や `--exec-timeout 1`（**プロジェクトのスモークテスト自身が使っている値**）なら現実的。既定値（300s/600s）では踏まない。
```

**直し方の案**

`attachChild` を `if (!s.running) return false;`（あるいは `assert`）で守り、サーバ側は spawn 直後に「もう finish されていたら即 killTree して枠を戻さない」分岐を持つ。あわせて `sweep()` の detached 判定から「まだ購読が始まっていない starting」を外す（`child === null` のセッションは kill ではなく `evict`／`finish` 専用の扱いにする）。テストは「finish 済みに attachChild しても running に戻らない」で固定でき、ガードを外すと落ちる。

**反証を試みた結果**

反証できなかった。機構はコードのとおりで、台帳レベルで再現も一致した。(1) attachChild (execsession.mjs:186-189) には状態の検査が一切なく done を running に戻す。(2) sweep は s.running（'starting' を含む）で選ぶので child=null のセッションを detached で拾える（create() が lastDetachedAt を入れているため）。sweeper の kill ループは finish を先に呼び `if (session.child)` で killTree するので、枠だけ返ってプロセスは殺されない。(3) attachChild(1180) と subscribe(1209) は同一同期ブロックなので lastDetachedAt が即 null になり、detached では二度と拾われない = 嘘が持続する（timeout は述語が真のまま残るので次の tick で本当に殺され、1秒で自己修復する。ただし reserved の二重返却は残る）。(4) killRequested は server.mjs:968 で書かれるだけで読まれず、create→attachChild の間に state を見る守りは存在しない。実測（未改変の ExecRegistry, maxConcurrent=2, grace=1s）: sweep kill [{reason:'detached',child:null}] → finish true reserved=0 → attachChild 後 state=running / reserved=0 → subscribe 後の sweep は空 → 2度目の finish が true で再度返却 → exit レコードが2件 → 上限2で3本作れる（reserved=2, sessions=3）。describe() は state:'running' と exit が同時に立つので /api/v0/state も矛盾する。回帰テストも無い（execsession.test.mjs に attachChild の順序を固定するものが無い）。

指摘の記述で不正確な点は2つあるが、どちらも欠陥を消さない: (a) startExecSweeper() は server.mjs:1181 でしか呼ばれないので、そのサーバでの最初の成功 spawn の窓は掃除されない（以降 sweepTimer は消えないので常に開く）。(b) クライアントは「終了扱い」にはしない — app.html:624 は偽の exit 行を出すが、936 の `!s.running` が偽なのでストリームは閉じず、以後の出力が exit 行の後に流れ続け、停止ボタンも効く（1231 で child が非 null）。つまり嘘は「自己矛盾する形で見える」ものであり、無言の最終宣告ではない。

到達性は非既定設定に依存する: 窓が min(grace, timeout) ≥ 1000ms を超える必要があり、窓は listWorktrees の git spawn 1回（git.mjs:155、キャッシュ・キュー無し）+ appendFile 1回なので通常 1s 未満。既定 300s/600s では踏まない（指摘自身もそう書いている）。スモークが使う --exec-timeout 1 / --exec-detached-grace 2 のテストも1サーバあたり窓が1回なので当たらない。それでも結果はこのリポジトリで最も重い種類（「停止した」と言って走り続ける + reserved の恒久的な過少計上で同時8本を超えられる）で、機構は台帳では無条件、修正は attachChild に2行の門（done なら復活させず、spawn した子を殺す）+ mutate 追加で済むため重大度は据え置き。

---

### ⚠️ SERIOUS [stdin] 入力の上限は1回 64KB だけで累積は無制限。backpressure も見ていない

**場所**: `v0/server.mjs:983（readJson の maxBytes は1リクエスト単位）と 1260（`write()` の戻り値を捨てている）`　**実測**: した

**何が壊れるか**

相手が stdin を読まないと書いた分は**親プロセスのメモリに無限に溜まる**。README の『上限 1回 64KB』は総量を縛っていないのに、表からは縛られているように読める。溜まった分は上の BLOCKING の燃料でもあり（相手が死んだ瞬間に EPIPE）、execsession.mjs が「守りを緩めた代わりの制約」を集めた表（同時8本 / 256KB リングバッファ / 上限時間）に**入力の総量だけが無い**。しかも溜まっている間も応答は `ok:true` なので、画面からは滞留が見えない。

**再現**

```
scratchpad/probe-input.mjs の B:
argv=[node,-e,'setTimeout(()=>{},60000)']（stdin を読まない）に 60KB を200回。
観測: `accepted 200 bodies of 61441 bytes = 11.7 MiB` / 全部 200 / `server RSS 68.2 MiB -> 101.8 MiB (delta 33.6 MiB)`（入力 11.7MiB に対して 3倍の増加）/ `/api/v0/state` の当該セッションは `"state":"running","seq":200,"dropped":196` で滞留は一切出ない。上限に当たる気配は無く、拒否は1件も返らなかった。
```

**直し方の案**

セッションごとに未書き出しバイト数（`child.stdin.writableLength`）の上限を持ち、超えたら 429/409 で断る。`write()` が false を返したら `drain` まで受け付けない。上限は execsession.mjs の DEFAULTS に置いて（守りを1箇所に集める方針どおり）テストで固定する。

**反証を試みた結果**

反証できなかった。むしろ機構を独立に確認した。

コード上の事実（読んだ範囲）:
- v0/server.mjs:983 の readJson は 1 リクエスト 64KB のみ。累積の勘定はどこにも無い。
- v0/server.mjs:1260 `s.child.stdin.write(data)` の戻り値は捨てている。リポジトリ全体で `writableLength` / `writableNeedDrain` / `drain` の grep は 0 件（v0, scripts, docs）。
- v0/execsession.mjs の制約は「同時8本 / 256KB・4000件のリングバッファ / execTimeoutMs / 猶予 / 保持」だけで、**入力の総量に相当するものは無い**。入力のエコー（`emit(s,'in',data)`）はリングバッファで 256KB に縛られるので、指摘の RSS 増加はリングバッファ由来ではありえず、stdin の書き込みキュー由来である（＝リングの上限では防げていない）。

独立プローブ（scratchpad/probe-backlog.mjs, probe2.mjs、いずれもサーバは起動せず child_process のみ。残留プロセスなし）:
- `spawn(node,['-e','setTimeout(...)'])` に 60KB×200 を書くと `write()` は **false**、`child.stdin.writableLength = 12,288,000 bytes`（= 投入量そのまま親プロセスの writable キューに滞留）、`writableNeedDrain = true`。→ 滞留は親側にあり、**サーバは観測手段を持っているのに見ていない**（指摘の是正案は実装可能）。
- さらに: その 12MB を抱えたまま子を `kill()` すると、キューのフラッシュで **`Unhandled 'error' event: write EPIPE` でプロセスが即死した**（Node 24.12）。server.mjs には `child.stdin` の `error` リスナも `process.on('uncaughtException')` も無い（grep 0 件）。
- 対照実験: 子が既に exit 済みなら `stdin.destroyed === true` なので server.mjs:1254 のガードが 409 で弾く。滞留ゼロで少量書いてから kill しても落ちない。**つまり「溜めていること」こそが、sweep の `--exec-timeout` 超過 kill や UI の停止ボタン、子の自然終了を『サーバ全体の死』に変える必要条件**であり、指摘の「BLOCKING の燃料」は誇張ではなく、むしろ滞留が無いとその経路に届かない。

弱い点は1つだけある: README の `| 上限 | 1回 64KB |` は「1回」と明記しており、総量を縛るとは書いていないので「表が縛られているように読める」は解釈寄り。ただし #17 の「守りを緩めた代わりの制約」表に入力総量の行が無いこと、および ok:true 以外に滞留の手掛かりが画面に無いこと（seq/dropped は消費済みか滞留中かを区別しない）は事実として残る。

到達条件は `--allow-exec` + トークン（設計上 RCE 相当）なので権限境界の越えは無い。しかし引ける相手は攻撃者でなくてよい: UI の「会話」ボタンで起動した `claude` が stdin を読まなくなった、あるいは stdin を読まないプログラムに貼り付けた、という**事故**で滞留が作られ、その後の上限時間超過 kill でサーバが落ちる。よって SERIOUS のまま維持。

---

### ⚠️ SERIOUS [transcript] 末尾に 300KB 超の1レコードがあると state=none になり「記録がありません」と嘘をつく

**場所**: `v0/transcript.mjs:235-251`　**実測**: した

**何が壊れるか**

readTail は 256KB しか読まず、先頭の不完全行を必ず捨てる。実データには**1行 1.25MB / 776KB** のレコードが実在する（大きい tool_result / file-history）ので、そのレコードが末尾付近にあると完全な行が0本になり、summarize は scanned=0 / dropped=0 / lastActivityAt=null を返す。app.html:987 の `state==='none'` 分岐は早期 continue するので、tailOnly の警告（app.html:1033）も出ず**何の手がかりも残らない**。稼働中のエージェントに対して「この worktree でエージェントを走らせた記録がありません。」と表示される = docs/agent-observation.md の失敗表（「ファイルが巨大 → 影響なし」）が成立していない。

**再現**

```
実データの行長（末尾4MB を実測）: kjp-editor 776,299B / tadaima-kochi-web 1,249,078B / naruko-app 731,222B の単一行が存在（256KB 超の行は各1〜6本）。
合成再現: `[プロンプト, tool_use(Read), {type:'user',message:{content:[{type:'tool_result',content:'x'.repeat(300*1024)}]}}]` を1本の jsonl にして collectAgents →
  state= none scanned= 0 dropped= 0 last= null bytesRead= 262144  （直前のツール呼び出しは1分前）
```

**直し方の案**

完全な行が0本なら state を 'none' にせず 'unknown'（例: 「記録が大きすぎて末尾から1行も読めません」）にする。または「完全な行が1本も無ければ読む量を倍にして再試行（上限付き）」。scanned / dropped を UI に出す（`none` 分岐の前に警告を append する）。

**反証を試みた結果**

反証できなかった。むしろ実データで発生頻度まで測れた。

**1. 合成再現（指摘どおり）** — `collectAgents` を直接叩いた観測値:
```
readTail: bytes=262144 truncated=true lines=1 nonEmpty=0
agents=[{...,"state":"none","lastActivityAt":null,"scanned":0,"dropped":0,"bytesRead":262144,"tailOnly":true}]
errors=[]
UI: wt [記録なし]  ← app.html:987 の早期 continue で :1033 の tailOnly 警告は出ない
```
`errors` も空。payload には `tailOnly:true / bytesRead:262144 / scanned:0` という手掛かりが**入っている**のに、UI が `state==='none'` で捨てている。つまり「記録が無い」と「末尾 256KB に完全な行が1本も無い」を区別できるのに区別していない。

**2. 「そんな末尾は現実に起きない」で反証しようとしたが、逆に頻度が出た。**
`~/.claude/projects` の実ファイルを全走査（256KB 超の行の位置と、その後に「復帰させられる行」＝SCAN_TYPES かつ timestamp 持ちが現れるまでの時刻差を実測）:

| セッション | records | 256KB 超 | 「記録がありません」と出る時間 |
|---|---|---|---|
| kjp-editor (31.2MB, 96.9h) | 6560 | 22 本 | 合計 227秒 / 中央値 9.6秒 / 最大 21.9秒 |
| naruko-app (44.0MB, 1013h) | 8372 | 57 本 | 合計 445秒 / 中央値 5.7秒 / **最大 61.6秒** |

行長は最大 10,178,236B（`type:"user"` = tool_result）。**1セッションで数十回、毎回5〜60秒**、稼働中のエージェントに対して「走らせた記録がありません」と表示される。UI は 1.5秒 TTL でポーリングするので確実に見える。

**3. 指摘の再現条件をむしろ補強する事実を1つ見つけた。**
実データでは巨大 tool_result の**直後に 152〜171B の `type:"last-prompt"` が必ず書かれている**（8/8 サンプル）。一見これで「完全な行が1本ある」ので救われそうだが、`last-prompt` は `SCAN_TYPES` に無いので `out.scanned++` の前に `continue` され、`timestamp` フィールドも持たない → `newestTs` は null のまま → `state='none'`。**小さい行が後続しても救済にならない**（上の実測はこれを織り込んである）。

**4. 恒久化する経路もある。** 巨大 tool_result の直後にセッションが終わる（Ctrl-C / context 上限 / クラッシュ）と、そのファイルは永久にこの形で残り、その worktree は**ずっと**「記録がありません」になる。手元の完了済みセッションでは永続 0 件だったが、経路は塞がれていない。

**5. 守りもテストも無い。** `readTail` の既存テスト（`v0/transcript.test.mjs:275`）は「残った行が全て完全な JSON」しか見ておらず、**残った行が0本のケースを検査していない**。`scripts/mutate.mjs` にも該当変異は無い。

**6. `docs/agent-observation.md:237` の失敗表「ファイルが巨大 → 末尾だけ読むので影響なし。読めた範囲で判断する」は成立していない。** 読めた範囲が空のとき「記録が無い」に化ける。

重大度: SERIOUS のまま妥当。稼働中を「記録なし」と言う = このリポジトリが最重と定めた「嘘をつく」欠陥そのもの（`clean=false` なのに `conflicts=[]` と同型）だが、opt-in の観測パネル限定で多くは10秒程度で自己回復するため BLOCKING には上げない。修正は安く済む（`state==='none'` を `tailOnly && scanned===0` で分岐し「末尾 256KB に完全な行が無い（巨大なレコードで埋まっている）」と告知する／`readTail` に「完全な行が0本なら倍の窓で読み直す」を足す）。

---

### ⚠️ SERIOUS [transcript] サブエージェントの活動が全く観測されず、稼働中の親が「待機」と表示される（sidechains は常に 0）

**場所**: `v0/transcript.mjs:315-320`　**実測**: した

**何が壊れるか**

`readdir(dir)` は `<slug>/` の直下だけを見るので、サブエージェントの記録（`<slug>/<sessionId>/subagents/**/agent-*.jsonl`）は読まれない。かつ実記録の `isSidechain:true` は**4本すべてで0件**なので out.sidechains は構造上ゼロのまま。結果、親がサブエージェントを走らせている間は親ファイルへの追記が止まり、UI は「待機 N分」と出す。docs/agent-observation.md は「答えられること」に「agent-c はサブエージェントを2本走らせている」を挙げており、これは現行のデータ配置では**答えられない**。同 doc の「isSidechain は実測0件（サブエージェントを使っていないため）」という理由付けも誤り（使っていても0件）。

**再現**

```
ライブ計測（2026-08-04 16:16:45Z 時点、サブエージェント6本が稼働中）:
  親 243d11c6….jsonl → lastActivityAt=16:10:09.120Z, ageMs=395,883 → **state=idle（UI:「待機 6分」）**, sidechains=0
  サブエージェント記録の最新 mtime = 16:16:42.767Z（2秒前）: `<slug>/243d11c6…/subagents/workflows/wf_0b9bb0aa-700/agent-aa3ad745b1ff07cfe.jsonl`
  `grep -c '"isSidechain":true' <slug>/*.jsonl` → 0,0,0,0
```

**直し方の案**

最終活動時刻に `<slug>/<sessionId>/subagents/**/*.jsonl` の mtime（読まずに stat だけ）を合わせる、または同ファイル群も同じ許可リストで走査して sidechains / recent に入れる。少なくとも「サブの活動は観測していない」ことを UI に明記して、待機表示が嘘にならないようにする。

**反証を試みた結果**

反証できず。ライブで再現・確認した（実測はすべて今このセッション上、read-only。サーバは起動していない）。

【1】データ配置の確認（実測）
- `~/.claude/projects/C--Users-akico-Documents-kjp-editor/` の直下は `*.jsonl` 4本 + ディレクトリ `243d11c6-.../` と `memory/`。
- サブエージェントの記録は `243d11c6-c19f-4c1f-ae8c-7f29ccff177f/subagents/agent-*.jsonl`（188ファイル）と `.../subagents/workflows/wf_0b9bb0aa-700/agent-*.jsonl`。**`projects/` の2階層下**なので、`collectAgents` の `readdir(root)`（直下のみ）→ `readdir(dir)`（直下のみ）では到達経路が存在しない。`f.endsWith('.jsonl')` で `243d11c6-...`（拡張子なしのディレクトリ）も落ちる。

【2】`isSidechain` は親ファイルで構造的に0（実測）
- `grep -o '"isSidechain":[a-z]*' 243d11c6-....jsonl | sort | uniq -c` → **`"isSidechain":false` が 4073件、true は 0件**。
- `grep -rl '"isSidechain":true' --include=*.jsonl ~/.claude/projects/` の全ヒットが `.../subagents/` 配下のみ。**このマシンの7プロジェクト全部で、トップレベルの jsonl に true は1件も無い。** よって `summarize()` の `if (r.isSidechain === true) out.sidechains++` は到達不能で、`out.sidechains` は恒久的に 0。

【3】「稼働中の親が待機と表示される」を実コードで再現
`collectAgents([{path:'C:\\Users\\akico\\Documents\\kjp-editor'}])` を実データに対して実行（2026-08-04T16:23:17Z）:
```
state: "idle", lastActivityAt: "2026-08-04T16:10:09.120Z", ageMs: 788513, sidechains: 0
recent[0]: 2026-08-04T16:03:43.128Z Workflow sc=false
```
同時刻のサブエージェント側 mtime は **16:23:25Z（2秒前）** が9本（`subagents/workflows/wf_0b9bb0aa-700/agent-*.jsonl`、うち1本は 123行 / last ts 16:23:56Z / `isSidechain:true`）。親の mtime は 16:15:54Z で以後7分半動いていない。`app.html:975` の `{idle:'待機'}` により UI は **「待機 13分」+ サブ badge なし**を出す。**9本のサブエージェントが今まさに書き込んでいる最中に「待機」と表示される。**

【4】親が沈黙する理由が Workflow 固有ではないこと
親の末尾を走査すると `16:03:43 tool_use:Workflow` → `16:09:46 tool_result` の間に SCAN_TYPES のレコードが1件も無い。その後に付いたのは `attachment` / `system` / `queue-operation`（いずれも許可リスト外）。つまり **`activeMs=3分` を超える tool 呼び出しは必ず偽の `idle` を作る**。Task/Workflow は数分〜十数分が普通なので、N エージェント運用という本来の用途でこそ外す。

【5】守りが1つも無い
`grep -n sidechain v0/transcript.test.mjs v0/smoke.test.mjs scripts/mutate.mjs` → **ヒット0**。`sidechains` と `(サブ)` badge を検証するテストも変異も存在しない（CLAUDE.md「落ちない検査は無意味」以前の、検査ゼロ）。

【6】修正可能性（指摘の正しさを補強する）
サブエージェントの記録は1行目から `cwd: C:\Users\akico\Documents\kjp-editor` / `sessionId` / `agentId` / `isSidechain:true` を持つ。深さを1段だけ増やせば対応付けは既存の `containsPath` でそのまま通る。到達不能なのは実装の走査範囲だけ。

【指摘の記述への微修正（反証ではない）】
- 再現パスは workflow 経由のもので正しいが、通常の Task サブエージェントは `<slug>/<sessionId>/subagents/agent-*.jsonl`（`workflows/` を挟まない）にも出る。両方が漏れている。
- docs/agent-observation.md:303 は「サブエージェントを走らせたときに数えられるかは未確認」と**未確認であること自体は明記している**ので、そこは嘘ではない。ただし (a) 同行の理由付け「このセッションでサブエージェントを使っていないため」は事実に反する（`subagents/` に 2026-08-03 03:00 書き込みのファイルがあり、計測日には既に使っていた）。(b) 同 doc:283 が「agent-c はサブエージェントを2本走らせている」を**無条件に「答えられる」側**に挙げているのは、現行実装では答えられないので過大主張。

severityAdjust は keep（SERIOUS）。理由: 「待機」という状態ラベルは稼働中に対して偽で、repo の最重視する「嘘をつかない」に触れる一方、(a) opt-in の `--watch-agents` 配下、(b) 並記される経過時間そのものは「親ファイルへの最終追記からの経過」として真、(c) セキュリティ／データ整合性への影響なし。BLOCKING まで上げるほどではないが、観測機能の存在意義（動いているかを知る）を主要ケースで反転させるので MINOR には下げられない。

---

### ⚠️ SERIOUS [ops-scripts] autostart の Run キー値が「空白 + 末尾セパレータ」で崩れ、--port と --allow-host が repo 引数に飲まれる（既定の --repo がこの形）

**場所**: `scripts/autostart.mjs:123-124（値の組み立て）, :98（--repo は無検証）, :28（ROOT は末尾 \ 付き）`　**実測**: した

**何が壊れるか**

Run キーの値は CreateProcess の lpCommandLine としてそのまま CRT に解釈される。`"...kjp-editor\"` の末尾 `\"` は**リテラルの二重引用符**になるので引用が閉じず、後続の `--port 7749 --allow-host <host>` が全部 repo 引数の中身になる。結果ログオン時に serve.mjs が `git rev-parse` で失敗して exit 1 → **デーモンが起動しない／--allow-host も消える**のに、`autostart.mjs status` は「登録されています（… / Host 許可: …）」と表示し続ける。c0948ea で直した「再起動後だけ壊れる」形の再発で、手元では絶対に気付けない。`--allow-host` は `^[A-Za-z0-9._-]+$` で検証しているのに `--repo` は無検証という非対称が原因。既定値 ROOT が末尾 `\` 付きなので、`C:\Users\Aki Shibata\...`（空白入りのユーザ名は Windows の既定形）に clone した人は**引数なしの `install` がそのまま壊れる**。今のこのマシンは `--repo C:/Users/akico/...`（空白なし・末尾なし）なので現状は無事。

**再現**

```
autostart.mjs:123-124 の組み立てをそのまま実行し、生成値を windowsVerbatimArguments（= lpCommandLine と同じ意味）で node に食わせて argv を実測した。
repo = "C:\Users\a b\kjp-editor\" のとき
  Run値: node.exe printargv.mjs --repo "C:\Users\a b\kjp-editor\" --port 7749 --allow-host box.example.ts.net
  実測 argv: ["printargv.mjs","--repo","C:\\Users\\a b\\kjp-editor\" --port 7749 --allow-host box.example.ts.net"]
  → --port と --allow-host が消滅（1引数に融合）
空白なし・末尾 \ だけなら壊れない: [...,"--repo","C:\\src\\kjp-editor\\","--port","7749",...]
また ROOT の実測: fileURLToPath(new URL('..', '.../Aki%20Shibata/Documents/kjp-editor/scripts/autostart.mjs')) = "C:\\Users\\Aki Shibata\\Documents\\kjp-editor\\" ← 空白 + 末尾セパレータ両方
```

**直し方の案**

install 時に repo を `git -C <repo> rev-parse --show-toplevel` で解決してから使う（存在しないリポジトリの登録も同時に防げる）。加えて値の組み立てで MSVC 規則に従い、閉じ引用符直前のバックスラッシュ列を二重化する（または末尾セパレータを剥がす）。理想は install 後に登録値を CRT 解釈して argv を検証するテスト（今の検査は「reg add が 0 で返る」までしか見ていない）。

**反証を試みた結果**

反証できなかった。指摘の全リンクを実測で確認した。(1) ROOT は空白入りユーザ名で `"C:\\Users\\Aki Shibata\\Documents\\kjp-editor\\"`（空白+末尾セパレータ）になる。(2) autostart.mjs:123-124 の組み立てを lpCommandLine と同じ意味（argv0=引用符付き exe + 残りを verbatim）で node に食わせた実測: repo=`C:\Users\a b\kjp-editor\` → argv=["--repo","C:\\Users\\a b\\kjp-editor\" --port 7749 --allow-host box.example.ts.net"] で --port と --allow-host が1引数に融合。空白なし／末尾なし／末尾 `/` の3形は正常。トリガは「空白+末尾 \」= まさに既定の --repo。

反証の試みと、それが成り立たなかった理由:
- 「reg add が " を含む値を拒否／変形して失敗が大きく出るのでは」→ 否。捨てキー HKCU\Software\kjp-edit-review-tmp に壊れた値を書いて読み戻した結果 reg add code=0 / identical: true（キーは削除済み・不在を確認）。つまり autostart は「登録しました」と言って exit 0 しつつ、動かない値を書く。
- 「他の守りが --repo を正規化するのでは」→ 無い。:98 は `val('--repo', ROOT)` のみ。末尾セパレータの除去も、末尾バックスラッシュの二重化も、検証も無い。--port は :100 で、--allow-host は :115 で検証されており、指摘の非対称性はそのまま成立。execPath と SERVE は末尾が `\` になり得ないので --repo が唯一の経路。
- 「serve.mjs が回復するのでは」→ 否。serve.mjs:120-127 が融合文字列を git rev-parse の cwd に渡して失敗し exit 1。stdio:'inherit' なのでログオン時のコンソール窓が即閉じ、痕跡が残らない。
- 「既定経路に到達できないのでは」→ v0/README.md:13 が引数なしの `node scripts/autostart.mjs install` を案内している。
- 「テストで守られているのでは」→ scripts/verify.mjs と scripts/mutate.mjs に autostart への言及ゼロ。カバレッジなし。
- 「docs/daily-use.md:61-64 で CreateProcess 解釈で実測済みと書いてある」→ 実測したのは通る形だけ。現在登録されている実値（読み取りのみで確認）は `--repo C:/Users/akico/Documents/kjp-editor`（スラッシュ・末尾なし・空白なし）で、唯一の通る入力で測っている。

重大度は keep。fail-closed でセキュリティ露出は無く、このマシンでは現に無害だが、c0948ea 自身のコミット本文が「Run キーの値は1つの文字列なので、空白や引用符を混ぜられると別の引数に化ける」と不変条件を書いた上で --allow-host にだけ適用し --repo を放置しており、同じ「手元では気付けない／再起動後だけ壊れる」クラスの再発。加えて status（:74-78）は効かない文字列から `Host 許可: …` を読み出して表示し続ける。CLAUDE.md のパス節はまさに「他人の Windows でだけ出る」この種のバグを一級の危険として扱っている。

---

### ⚠️ SERIOUS [ops-scripts] 起動口が知らないフラグを黙って捨てる — autostart は観測フラグを引き継げず、serve.mjs は `--allow-write` を渡しても「--allow-write で有効化」と表示する

**場所**: `scripts/autostart.mjs:104-120（serveArgs の組み立てに watch 系が無い）, scripts/serve.mjs:182-188`　**実測**: した

**何が壊れるか**

(a) 実機のデーモンは `--watch-agents` 付きで動いているのに、autostart は `--watch` / `--agents-text` を知らない。`install --watch` は**警告なしで読み取り専用の登録になる**ので、ログオン後だけエージェント活動パネルが消える（--allow-host の引き継ぎ漏れと同型の再発）。(b) 逆に serve.mjs は server 側の名前（--allow-write / --allow-exec / --watch-agents）を渡されても全部捨てて読み取り専用で起動し、しかも `読み取り専用（書き込みは --allow-write で有効化）` と表示する。**今まさに --allow-write を渡した人にそれを付けろと言う**のは表示の嘘で、「フラグを打ったのに効いていない」ことが分からない。安全側に倒れる方向ではあるが、capability を明示させる設計の根拠（意識的な操作にする）が壊れる。

**再現**

```
(a) autostart.mjs:104-120 の組み立てを同一コードで実行:
  argv = install --repo <ROOT> --exec --allow-host fractal2.tail73c198.ts.net --watch
  → 登録値: ... serve.mjs --repo <ROOT> --port 7749 --exec --allow-host fractal2.tail73c198.ts.net   ← --watch なし、警告なし
  argv = install --repo <ROOT> --agents-text
  → 登録値: ... --repo <ROOT> --port 7749   （フラグ無しと完全に同一）、caps 表示は「読み取り専用」
(b) node scripts/serve.mjs --repo <一時repo> --port 7905 --allow-exec --watch-agents --allow-write
  出力: 「読み取り専用（書き込みは --allow-write で有効化）」
  実際に起動した子: v0/server.mjs --repo ... --port 7905   ← 3つ全部消えている（Win32_Process で実測）
```

**直し方の案**

両方のスクリプトで**知らない `--` フラグは起動を拒否する**（typo と名前違いは黙って無視する価値がゼロ）。autostart は serve.mjs のフラグ集合を1箇所に持って引き継ぐ。serve.mjs は server 側の別名（--allow-write/--allow-exec/--watch-agents）を受理するか、明示的に「それは server の名前です」と言って止める。

**反証を試みた結果**

反証できなかった。むしろ実機で裏付けが取れ、指摘より結果が悪い。

【(a) autostart が観測フラグを引き継げない — 確認】
scripts/autostart.mjs:104-120 の serveArgs は `--repo/--port` + `--exec|--write` + `--allow-host` のみ。`--watch` / `--agents-text` を見る箇所はファイル中に1つも無い（grep で 0 件）。unknown flag を拒否する経路も無いので、`install --watch` は警告なしで読み取り専用の登録になる。実機の乖離も実測で確認:
  レジストリ値（HKCU\...\Run\kjp-edit、Get-ItemProperty で読み取り）:
    node.exe ...\scripts\serve.mjs --repo C:/Users/akico/Documents/kjp-editor --port 7749 --allow-host fractal2.tail73c198.ts.net
  実際に動いている子（PID 33244、Win32_Process）:
    v0\server.mjs --repo ... --port 7749 --allow-write --allow-exec --token-file ... --audit-log ... --allow-host fractal2... --watch-agents
つまり **今日使っている構成（--watch-agents 付き）は autostart から再現不能**で、ログオン後だけ観測が消える。

【他の守りで防がれていないことの確認】
- watch を後から入れる経路が無い: `watchAgents` は v0/server.mjs の起動時 argv だけ（87/89行）。HTTP から切り替える口は無い（1101行は payload への露出のみ）。
- テストが無い: `grep -rn "serve.mjs|autostart" scripts/verify.mjs scripts/mutate.mjs v0/*.test.mjs` → 0 件。scripts/serve.mjs / autostart.mjs は今回の diff で新規追加なのに検査ゼロ。
- 🚨 **UI 側の告知も存在しない（指摘より悪い）。** v0/app.html:945-947 のコメントは「`--watch-agents` が無いときは『機能が無効』であることを1行で言う（黙って消えない）」と書いているが、実装は
    function renderAgents(s) { if (!s.agents) { dropPanes('agents', new Set()); return; } }
  でペインを捨てるだけ。app.html 全体で「無効」を出しているのは 658 行の実行ペインだけで、活動観測の無効告知は無い。よって「ログオン後だけパネルが黙って消える」は仮説ではなく確定であり、コメントとコードの食い違い（=嘘）も同時に存在する。

【(b) serve.mjs が server 側の名前を捨てる — 確認】
scripts/serve.mjs:164-188 は `has('--exec')` / `has('--write')` / `has('--watch')` / `has('--agents-text')` しか見ず、args は白紙から組み立てる。`--allow-write` / `--allow-exec` / `--watch-agents` を渡しても `argv.includes('--write')` 等はすべて false なので全部落ちる（v0/server.mjs の argv パーサも 69-105 行に else 節が無く unknown flag を黙って無視する）。banner は v0/server.mjs:1598 の `読み取り専用（書き込みは --allow-write で有効化）` が出るので、--allow-write を打った人に --allow-write を付けろと言う状態になる。子プロセスを起こす実験はポートを塞ぐ事故を避けて省いたが、コード経路は分岐が無く一意なので結論は変わらない（指摘の実測値とも一致）。

【軽微な訂正】(b) の「表示」の出所は scripts/serve.mjs:182-188 ではなく v0/server.mjs:1598。serve.mjs 自身は caps を何も表示しない（それ自体も、--allow-host は同名で通るのに --write/--exec/--watch だけ別名という非対称を隠す要因）。また ~/.kjp-edit/last.json は `exec`/`write` しか記録せず watch を残さないので、後から「観測付きで起動したか」を確認する手段も無い（実測: {"repo":...,"port":7749,"exec":true,"write":true,"pid":33244}）。

【severity】keep（SERIOUS）。capability が減る方向にしか倒れないので security hole ではなく、`--watch` は autostart の文書化フラグでもない。しかし (1) `--allow-host` 引き継ぎ漏れ（serve.mjs:107-109 のコメントで「再起動後だけ 403 になる」と自ら記録した事故）と同型の再発、(2) 検査ゼロ、(3) UI の告知がコメントの主張どおりに存在しない、の3点が重なり「フラグを打ったのに効いていないことが誰にも分からない」状態が成立している。根治は両スクリプトで unknown flag を拒否すること（両方とも今は typo すら黙って飲む）。

⚠️ 副作用なし: 参照とレジストリ/プロセスの読み取りのみ。ファイル変更なし、サーバ起動なし（PID 17784/8484 は既存の smoke テスト由来で、こちらが起動したものではない）。

---

### ⚠️ SERIOUS [ops-scripts] 二重起動の判定と --status がリポジトリのパスに空白があると外れ、同一リポジトリのデーモンが2本立つ（しかも「別のプロセス」と嘘の説明を出す）

**場所**: `scripts/serve.mjs:131-135（/--repo\s+(\S+)/）, :101（--status の同じ正規表現）, :149-160`　**実測**: した

**何が壊れるか**

Node は空白を含む引数を `"..."` で囲むので、Win32_Process の CommandLine 上では `--repo "C:/Users/a b/repo"` になる。`(\S+)` は `"C:/Users/a` までしか取らないため既存デーモンと一致せず、README が約束する「二重起動しない（同じリポジトリなら URL を出して終わる）」が偽になる。しかも案内は `⚠ ポート 7900 は使用中です（別のプロセス）` — 掴んでいるのは同じリポジトリを見る自分自身で、説明が事実と違う。2本目が立つと watcher・TTL キャッシュ・exec 台帳・監査ログが二重化し、`--exec` なら**実行枠が2セット**開く。`--status` も壊れたパスを表示する。空白入りのユーザ名（Windows の既定形）で普通に踏む。

**再現**

```
USERPROFILE を一時ディレクトリに逃がして実測（~/.kjp-edit は触っていない）。repo = %TEMP%\kjp-dbl-XXXX\a b\repo
1回目: kjp-edit v0 → http://127.0.0.1:7900
2回目: ⚠ ポート 7900 は使用中です（別のプロセス）。7901 を使います。 → http://127.0.0.1:7901
Win32_Process: v0/server.mjs が 2 本（--port 7900 / --port 7901、どちらも --repo "C:/.../a b/repo"）
判定ロジック単体の実測: CommandLine から `/--repo\s+(\S+)/` → "\"C:/Users/a"、比較結果 false（--status の表示も同じ値になる）
```

**直し方の案**

CommandLine を正規表現で切らない。serve.mjs が起動時に書いている ~/.kjp-edit/last.json を（pid + port + repo の生存確認付きで）一次情報にするか、`Win32_Process.CommandLine` をクォート対応で分割してから比較する。テストは「空白を含むパスで2回起動して1本しか立たない」を固定する（今この検査が無い）。

**反証を試みた結果**

反証できなかった。機構を実測で確認: spawn(process.execPath, [...], {shell:false}) は空白入り引数を libuv が引用符で囲むため、Win32_Process の CommandLine は `--repo "C:/Users/a b/repo"` になり、`/--repo\s+(\S+)/` の捕獲は `"C:/Users/a`、比較は false（実測出力: capture: "\"C:/Users/a" / compare → false）。serve.mjs:131-135 の二重起動判定と :101 の --status 表示の両方が同じ正規表現なので同時に外れる。

他の守りが無いことも確認した:
- v0/server.mjs に singleton/lock は無い（lock|EADDRINUSE|last.json|already の grep は :1437 のメッセージと :1563 の listen だけ）。リポジトリを鍵にした排他は存在しない。
- serve.mjs:199 が ~/.kjp-edit/last.json を書くが読み戻していない（:202 が `void readFile; void existsSync; void dirname;` — 読み側の守りは未実装）。正規表現が唯一の関門。
- serve.mjs を触るテストが皆無（v0/*.test.mjs と scripts/verify.mjs に言及なし）、scripts/mutate.mjs にも変異が無い。このリポジトリの基準では「落ちない検査」以前に検査が無い。
- 約束は v0/README.md:17 と docs/daily-use.md:22 に無条件で書かれている。
- さらに :133-134 は CLAUDE.md が禁じている手書きのパス比較（samePath() を使えという規則）で、空白が無くても 8.3 短縮名・symlink で外れる。指摘を広げる方向であって反証にはならない。

見つかった緩和（成立を否定はしない）:
- --stop（:109-117）は --repo 正規表現を使わず `*v0/server.mjs*` で照合するので2本とも殺す。「停止したと言って停止していない」形の嘘は重ならない。
- 認可境界は越えない（2本目も同じ token/Host 検証を通す）。auditExec（v0/server.mjs:822）は1行ずつ追記なので監査ログは共有されるだけで破損しない（指摘の「監査ログが二重化」はやや不正確）。
- serve.mjs:79 により非 Windows では判定自体が常に空（best-effort な守り）。ただしこれは README の文言が強すぎる証拠であって、空白バグの許容理由にならない。
- 作者の実環境では現に効いている（稼働中デーモンの CommandLine は引用符なしの `--repo C:/Users/akico/Documents/kjp-editor`）。空白入りプロファイル/プロジェクトパスのユーザで顕在化する潜在バグ。

重大度は SERIOUS 維持。観測可能な嘘が2つ（自分自身が掴んでいるポートを「別のプロセス」と説明する、観測ツールの --status が repo を `"C:/Users/a` と表示する）と、ドキュメントの明示的な約束が偽になる。capability 境界は越えず --stop で両方片付くので BLOCKING ではない。

---

### ⚠️ SERIOUS [tests] mutate.mjs はテストの SIGKILL（ハング）を「pattern に一致するテストが無い」と誤報し、SKIP 扱いで exit 0 になる

**場所**: `scripts/mutate.mjs:574`　**実測**: した

**何が壊れるか**

守りを外したのにハングするケースが、**失敗ではなく想定内のスキップ**として報告され、`node scripts/mutate.mjs` が exit 0 で緑になる。CLAUDE.md は「SKIP を緑と読まない」と書いているが、ツール自身が SKIP を緑にしている（`if (r.status === 'SURVIVED') bad++` だけ）。しかも診断が事実と逆（pattern は一致している）ので、読んだ人は「テスト名を直せ」という無関係な修正に誘導される。

**再現**

```
上記の stdin 無効化を変異として登録して単体実行した実測:
```
– y-stdin-write-noop  SKIP  pattern に一致するテストが無い（テスト名に含まれる文字列を書く）: 標準入力に書けて
0 件が期待通り落ちた / 0 件は冗長な防御（想定内）/ 1 件はスキップ
MUTATE_EXIT=0
```
一方で同じ pattern を素で流すと確かに1件走る: `ℹ tests 1 / pass 1`。つまり 300 秒の `p.kill('SIGKILL')` で要約が出ず `pass 0 + fail 0` になった結果を、pattern 不一致と読み替えている。
```

**直し方の案**

runTest が SIGKILL で終わったこと（タイムアウト到達）を戻り値で区別し、`pass+fail==0 かつ timedOut` は SKIP ではなく失敗（bad++）にする。ついでに SKIP 全体を「緑」から外すか、少なくとも終了コードに反映する。

**反証を試みた結果**

反証できなかった。指摘のとおり再現する。(1) scripts/mutate.mjs:475-497 の runTest は verify.mjs:34-46 と違い timedOut を持たず、resolve は {code,out} だけ。(2) SIGKILL 時の出力は空になる（実測: Node v24.12.0 / Windows、300_000 を 5s に短縮して runTest をそのまま模した probe で out="" / code=null / pass=0 / fail=0）。(3) 判定順が pass+fail===0 → SKIP（574 行）→ continue で、その後の killed = r.code !== 0（581 行）に到達しない。(4) bad は SURVIVED のみ（599 行）なので exit 0。同じ pattern を素で流すと `✔ 標準入力に書けて 反映される` / `ℹ pass 1` が出るので、診断文（pattern に一致するテストが無い）は事実と逆。反証の試みは3つとも失敗: [a] 他の守り→逆に verify.mjs:122-136 が同じ教訓（timedOut と生の末尾出力、`smoke (0 pass, 0 fail)` で原因が消えた事故）を既に実装済みで、mutate.mjs だけ継いでいない。[b] 経路に到達できない→ハングの形は現存する: smoke.test.mjs:926 と :1610 は素の `await child.on('close')`、:896-906 の readExec は signal/timeout 無しの `await res.text()`、:1287-1301 の until は 15s の期限を `await rd.read()` の合間だけで見るのでストリームが無音だと永久に待つ。CLAUDE.md 自身がこの形で CI を1往復無駄にした事故を記録している。[c] CI が赤くなる→ci.yml はジョブ全体の timeout-minutes: 15 だけでステップ単位の上限が無く、5分のハング1件では 15 分を超えない可能性があり、超えても「ジョブがタイムアウト」と読めるだけで「守りが検証されていない」は伝わらない。重大度は SERIOUS が妥当（開発ツールであり `– … SKIP` 行と `N 件はスキップ` は表示されるので完全に無音ではないが、他の全テストの信頼性が乗る meta-check であり、変異ステップは CI でしか走らず、exit 0 で緑になる）。

---

### ⚠️ SERIOUS [tests] 『exec: bare worktree では実行しない』は bare worktree を1つも作っていない。bare / prunable の門は exec も checkout も外しても全テストが緑

**場所**: `v0/smoke.test.mjs:1589`　**実測**: した

**何が壊れるか**

テスト名が検証していないことを主張している（過去2件と同じクラスの偽陽性）。`wt.bare` を外すと bare worktree が spawn の cwd になり、作業ツリーの無い場所で任意コマンドが走る。`wt.prunable` を外すと実体の消えたディレクトリが cwd になり ENOENT で経路が壊れる。どちらも「誰も気付かない状態」で外せる。テスト内のコメントは「bare の網羅は unit 側の責務」と書くが、`grep -n bare v0/*.test.mjs` の結果はこの1件だけで、unit 側に bare のテストは存在しない。

**再現**

```
リポジトリのコピー（.git を作り直したもの）に4つの変異を足して実行した実測:
```
✖ x-exec-bare-worktree   SURVIVED  （v0/server.mjs:1145 の if (wt.bare) { bail(400,...) } を削除）
✖ x-exec-prunable        SURVIVED  （v0/server.mjs:1146 の if (wt.prunable) { bail(409,...) } を削除）
✖ y-checkout-bare        SURVIVED  （v0/server.mjs:1319 を削除）
✖ y-checkout-prunable    SURVIVED  （v0/server.mjs:1320 を削除）
```
pattern はそれぞれ実在するテスト名（'bare worktree では実行しない' / 'exec は既知の worktree 以外を cwd にしない' / 'checkout は既知の worktree 以外を cwd にしない'）で、1件以上走ったうえで落ちていない。
```

**直し方の案**

フィクスチャに `git worktree add --detach` ではなく `git clone --bare` / `git worktree add` 済みディレクトリを消した prunable の2本を足し、exec と checkout の両方で 400 / 409 と**拒否理由の文言**を assert する。そのうえで4つの変異を mutate.mjs に登録する（今どれも無い）。

**反証を試みた結果**

反証できなかった。(1) テストに bare の実体が無いことを確認: `grep -rn "init --bare|'--bare'" v0/ scripts/` は0件、`grep -rn bare v0/*.test.mjs` は smoke.test.mjs:1589-1594 の1件のみ。テスト内コメントの「bare の網羅は unit 側の責務」も偽で、git.mjs:169 の bare パースを見る unit テストは存在しない。(2) prunable も同様: 唯一の prunable フィクスチャ（smoke.test.mjs:279-305）は /api/v0/state だけを叩き、最後に worktree prune している。exec/checkout を prunable に対して呼ぶテストは無い。(3) 経路は到達可能（dead code ではない）: server.mjs:1465-1475 は --show-toplevel が空なら --git-dir にフォールバックして bare リポジトリを明示的に許可している。実測（git init --bare）で `worktree list --porcelain` は `bare` 行を出し、`rev-parse --show-toplevel` は 128。つまり --repo に bare を渡せば bare エントリが server.mjs:1143/1317 の find に載る。app.html:1223 の除外は UI だけで、API はトークンがあれば直接叩ける。(4) prunable の門は実際に効いている: 実測で `spawn(..., {cwd: 存在しないディレクトリ})` は error ENOENT → close -4058 を出し **exit を出さない**。exec の枠を返すのは child.on('exit')（server.mjs:1197-1206）だけなので、門を外すと枠が --exec-timeout（既定600秒）の sweep まで返らず、8回で exec が10分間使えなくなる。これを見るテストも無い。(5) 既存の変異はこの2つを通っていない: scripts/mutate.mjs の worktree-allowlist は置換オブジェクトに `{ bare: false, prunable: false }` を書いており（line 398）、両方の門を意図的に迂回する。bare/prunable 名の変異は無く、`defensive` の記載も無い。部分的な反論としては、checkout 側の2件は git 自身が拒否する（bare で `git checkout --end-of-options master --` は exit 128 → server.mjs:1357-1361 が 409 に変換、prunable は spawn 失敗）ので多層防御にすぎない。ただし CLAUDE.md はその場合 `defensive` に理由を書くことを要求しており、書かれていない。exec 側の実害（枠リーク）とテスト名の虚偽は残るので SERIOUS を維持する。

---

### MINOR [stdin] 相手が自分で stdin を閉じた場合、書き込みは黒穴になるのに 200 ok を返し `▸` を全購読者に流す

**場所**: `v0/server.mjs:1254（`stdin.destroyed || !stdin.writable` は**自分が end() したか**しか見ていない）→ 1260 → 1280 の `{ok:true,bytes}``　**実測**: した

**何が壊れるか**

409『標準入力は既に閉じています』が出るのは自分の eof の後だけ。相手側が fd 0 を閉じた場合は writable=true のままなので、**何度でも 200 ok が返り、`in` レコードが記録に載って全購読者と再接続先に `▸ 送った行` として再生される**のに、相手には届いていない。このリポジトリが最も重いと言っている「停止しましたと言って停止していない」と同種の嘘で、会話コンソールでは「送ったのに応答が来ない」に見える（原因が画面から辿れない）。

**再現**

```
scratchpad/probe-input.mjs の A:
argv=[node,-e,'require("fs").closeSync(0); 30秒生存']（子は生きたまま stdin を閉じる）
観測: `input #1 -> 200 {"ok":true,"bytes":6,"seq":2}` / #2 → 200 / #3 → 200、`server alive? exitCode=null`、`GET /api/v0/state -> 200`。1件も 409 にならない。
素の Node でも同じ（scratchpad/pipe-epipe.mjs）: `write#0..2 callback err= null` / `writable= true destroyed= false`。つまり「相手が閉じた」はこの検査では原理的に検出できない。
```

**直し方の案**

`write(data, cb)` のコールバックで失敗を捕まえ、失敗したら `in` を「送った」ではなく「送れなかった」として流す（成功の ack を出す前に少なくとも1回 drain を待つ設計にする）。検出できないことを黙って ok にしない。

**反証を試みた結果**

コードの記述自体は正しい（server.mjs:1254 は自分の端しか見ていない）ので mechanism は反証できない。しかし「最も重い嘘（停止しましたと言って停止していない）と同種の SERIOUS」という評価は、実測で崩れる。MINOR に下げるべき。

■ 反証1: 指摘が求める 409 は Windows では実装不可能で、しかも「相手が閉じた」は良性の一般ケースと**観測上完全に同一**
`scratchpad/rev18-stdin-compare.mjs`（新規、scratchpad のみ。リポジトリは無変更）で A/B/C を並べて実測:
- A_closed（子が `fs.closeSync(0)` して生存）: `{"writable":true,"destroyed":false,"len":18}` → 700ms後 `len:0` → 200KB書込後 `len:204800`、write callback errors `[null,null,null]`
- B_never_reads（stdin は開いたまま、ただ読まない。`npm test` 等の普通の形）: **上の数値と1つも違わない**（`len:18`→`0`→`204800`、errors `[null,null,null]`）
- C_reads（読む子）: 200KB も `len:0` に落ち、子が `got 65536...` と受領を報告
つまり `writable` / `destroyed` / write の callback / `writableLength` のどれを見ても A と B を区別できない。
`scratchpad/rev18-longwait.mjs` でさらに、A の子を8秒生かしたまま会話サイズの行を100KB送って観測: `t+1000/2000/4000/8000ms` すべて `queued=99790 writable=true destroyed=false childAlive=true`、`error` イベントは**子を kill した瞬間まで一度も来ない**（`!! stdin error while child alive: EOF 8614 ms` = kill 時刻）。よって error listener を足しても A の生存中は 409 にできない。指摘者自身が「原理的に検出できない」と書いており、これは修正不能な要求。

■ 反証2: `{ok:true,bytes:N}` は偽の主張ではない
主張しているのは「N バイトを標準入力に書いた」であって「相手が読んだ」ではなく、実際に書かれている。「読んだか」はパイプでは ack 無しに原理的に不可知で、B（子がまだ読んでいない・永久に読まない）でも同じ 200 が返る。「clean=false なのに conflicts=[]」のような**状態の虚偽報告とは別種**。

■ 反証3: 記録も UI も到達を主張していない
app.html:620 は `▸ ${ev.d}`、その CSS コメント（app.html:182）は「自分が送った行」、README は `{t:"in"}` を「別端末から見ても**何を送ったか**分かる」と書いている。自分の送信のエコーであることが明示されている。kill 側は `alreadyDone` を返し UI 文言も分けている（README「停止」節）のと対照的に、input 側はそもそも相手の状態を主張していない。

■ 反証4: 到達性
「fd 0 を閉じてなお走り続ける」プログラムを operator が意図的に選ぶ必要がある。文書化された対象（`claude --input-format stream-json` / `git commit -F -` / `patch` / REPL）はどれもそうしない。普通の形（stdin を閉じて終了する）は server.mjs:1250 の `!s.running` が正確な文言で 409 を返し、smoke.test.mjs:1331 と :1413 が固定している。

■ ただし、この経路には別の（そして重い）欠陥があるので独立の指摘として起票を推奨
server.mjs は `child.stdin` に `error` listener を一切付けておらず（`grep -n stdin v0/server.mjs` は 1254/1260/1261 の3箇所だけ）、`process.on('uncaughtException')` も無い（`process.on` は 1619 のシグナルのみ）。親に未送出のデータが残った状態で子が死ぬと Node は `child.stdin` に `error` を出す（Windows: `EOF`、POSIX: `EPIPE`）。`scratchpad/rev18-nolistener.mjs` の実測: 読まない子に 400KB を積んで（`queued: 409600`）SIGKILL すると `UNCAUGHT in parent: EOF write EOF`。デーモンでは**UI の「停止」を押しただけでサーバ全体が落ち、全セッション・全購読者・観測が消える**（これは検査可能で修正可能。`s.stdinBroken` を立てる形にすれば、副産物として「死後の書き込み」に 409 も返せる。ただし子の生存中の黒穴は反証1の通り依然無理）。

（実験は scratchpad 内のみ。v0/server.mjs 等リポジトリのファイルは一切変更していない。起動したプロセスはすべて終了済みで、残っている node.exe は他エージェントのもの。）

---

### MINOR [tests] until() の 15 秒上限が効かず、標準入力の配達を見るテストが「落ちる」代わりにハングする

**場所**: `v0/smoke.test.mjs:1284`　**実測**: した

**何が壊れるか**

#18 の一番 load-bearing な行（子の stdin へ実際に書く）が壊れても、テストは失敗として観測されない。サーバは 200 と bytes を返し `{t:"in"}` を購読者全員に流すので「送った」と表示されるのに届いていない、という**嘘の表示**が起きる形だが、それを捕まえるはずのテストは 15 秒で throw せず `rd.read()` の中で待ち続ける。CLAUDE.md の「🚨 テストが待ち続ける形にしない」を、そのルールが書かれた後に作った経路で踏んでいる。下流の影響は別項（mutate.mjs が SKIP と誤報して exit 0）。

**再現**

```
1) v0/server.mjs:1260 の `if (data !== null) s.child.stdin.write(data);` を `if (false) s.child.stdin.write(data);` に変える（200 / bytes / `{t:"in"}` はそのまま出る）
2) `node --test "--test-name-pattern=標準入力に書けて" v0/smoke.test.mjs`
   実測（外から 200 秒で打ち切った値）: `✖ 🚨 exec: 標準入力に書けて、往復し、EOF で閉じられる (199993.4638ms)` — limitMs=15000 を 13 倍超過。未変異なら 906ms で pass する（同じコマンドで実測）。
原因: `while (!seen.some(pred)) { if (Date.now()-t0 > limitMs) throw; await rd.read(); }` の上限判定が await の**手前**にしかないので、read が返らない限り一度も評価されない。
もう1つ: `if (done) break;` は述語未達でも黙って `seen` を返すので、ストリームが先に閉じた場合は**assert 無しで緑**になる。
```

**直し方の案**

`await Promise.race([rd.read(), 上限で reject するタイマー])` にして、read の待ち自体に上限を掛ける。`if (done) break` は「述語未達で done」なら throw に変える（`until` は「条件が来た」ことを保証する契約なので、来ないまま return してはいけない）。

**反証を試みた結果**

部分的に反証。**「落ちる代わりにハングする／失敗として観測されない」は実測で誤り。** 指摘者の再現手順をそのまま実行した（リポジトリ本体は触らず、v0 をスクラッチパッドに複製してそこだけ変異させた。C:\Users\akico\Documents\kjp-editor は git status クリーン・server.mjs:1260 は原文のまま）。

1) 変異（`if (false) s.child.stdin.write(data);`）を当てて指摘者と同じコマンドを打ち切らずに完走させた実測:
```
exit=1 elapsed=310s
ℹ pass 0  ℹ fail 1
✖ 🚨 exec: 標準入力に書けて、往復し、EOF で閉じられる (309160.8316ms)
  TypeError: terminated ... [cause] Error [BodyTimeoutError] code: 'UND_ERR_BODY_TIMEOUT'
```
テストは**落ちる**（fail 1 / exit 1 / テスト名も file:line も出る）。指摘者は 200 秒で外から打ち切ったため、この結末を見ていない。

2) 原因の裏取り（Node v24.12.0、無音の ndjson 応答を読むだけの最小実験）:
`first read 16 ms` → `second read REJECTED TypeError terminated 308326 ms`。
**global fetch の body は undici の bodyTimeout（既定 300 秒）で必ず reject する**ので、`rd.read()` は「返らない」のではなく約 308 秒で throw する = `until` は throw する。よって「永久に待ち続ける」という前提は成り立たない。

3) 仮に bodyTimeout が無くても緑にはならない: `--exec-timeout`（既定 600 秒）で sweeper が exit レコードを流して res.end() するため `done` で break したあと、**1323 行の `assert.deepEqual(ins.map(r => r.d), ['hello\n','second\n'])` が実 assert として残っている**（2 通目は 409 で `in` が出ないので不一致で落ちる）。指摘の「`if (done) break` で assert 無しで緑」は、この経路では成立しない。

4) 規定の検証口 `node scripts/verify.mjs` は smoke を **timeout 240_000 で SIGKILL** し（scripts/verify.mjs:181）、`testDetail()` が `⏱ 240.0s で SIGKILL（上限に達した）` + 末尾 8 行を出す（同 130-137）。CI も `node scripts/verify.mjs` を通るので、ここでも緑にはならない。

**残る本当の欠陥（だから refuted にはしない）:** 上限判定が `await` の手前にしかないのは事実で、意図した 15 秒は効いていない（実測 309 秒 = 20 倍）。かつ失敗メッセージが「条件を満たすレコードが来ない。見えたもの: …」ではなく `TypeError: terminated` になり、**診断情報が失われる**。さらに mutate.mjs の SIGKILL は 300_000ms（scripts/mutate.mjs:484）で、実測 309 秒の失敗より **9 秒早い**ので、ここに変異を足すと SKIP 誤報になりうる（＝指摘者の下流項目は成り立つが、対象の変異は MUTANTS に存在しない）。修正は `Promise.race([rd.read(), 時限])` の1行。

影響は「嘘の緑」ではなく「300 秒後に読みにくい理由で落ちる」なので、SERIOUS ではなく MINOR。

---

## 反証されて消えた指摘

- **[auth] 秘密がサーバ実例に紐づいていない — 読み取り専用サーバの ?token= が別リポジトリの実行サーバの鍵になる**

  指摘の因果（cookieSecret がサーバ実例に紐づいていない → 読み取り URL を渡した相手が別リポジトリの実行サーバで RCE）は成立しない。実測で反証した（プローブ: C:\Users\akico\AppData\Local\Temp\claude\C--Users-akico-Documents-kjp-editor\243d11c6-c19f-4c1f-ae8c-7f29ccff177f\scratchpad\refute-shared-token.mjs、指摘と同じ2本立て。共通 --token-file、B=--allow-exec --require-auth、C=--allow-host phone.example.test。両サーバは終了確認済み）。

1) **Cookie では実行に到達しない。指摘した秘密の導出は impact と無関係。**
   `B /exec cookie only -> 403 {"error":"x-kjp-token が一致しません"}`
   requireExec → requireMutation（server.mjs:764-783）は **生トークンを X-Kjp-Token で**要求し、Cookie を一切見ない（authed() の Cookie 照合は cookieSecret とだけ、server.mjs:748）。指摘の再現で "CROSS-RCE" が出たのは Cookie ではなく**生の共有トークンをヘッダに入れた**からで、実測でもそう出た（`B /exec loopback + raw token -> 200 ... "d":"CROSS-RCE\n"`）。したがって cookieSecret に repo/port/capability を混ぜても impact は 1 バイトも変わらない。「秘密がサーバ実例に紐づいていない」という表題の欠陥と、報告された被害の間に因果が無い。

2) **URL を渡された遠隔の相手は実行サーバに到達できない。**
   B は `server.listen(opts.port, '127.0.0.1')`（server.mjs:1563）でループバック限定、さらに hostAllowed()（server.mjs:607-627）が**ループバック名 + ポート一致**しか通さない。実測:
   - `B /session  Host: phone.example.test + 生トークン -> 403 forbidden`
   - `B /exec     Host: phone.example.test + 生トークン -> 403 forbidden`
   - `B /session  Host: 127.0.0.1:<C のポート> + 生トークン -> 403 forbidden`
   つまりトンネルに出ていない exec サーバは、正しいトークンを持っていても**トンネル/tailnet 側からは叩けない**。到達できるのは「そのマシンの loopback で、そのポートを名乗れる者」＝**既にそのユーザ権限でコードを動かせる者**で、その者は `~/.kjp-edit/token`（0600、同一ユーザ）を直接読める。共有トークンは新しい権限を何も与えていない。tailscale serve の写像は1ポートなので、読み取り専用サーバが 7750 に落ちた場合は**そもそも相手から見えず**、逆に exec サーバが 7749 を取っても --allow-host が無ければ 403 で fail-closed（daily-use.md の「再起動後だけ 403」がまさにこの壁）。
   なお C 側からトークンを吸い出すこともできない: `C /session -> token:null`（allowWrite=false、server.mjs:1105）。

3) **残る本当の論点は「鍵が実例ごとでない＝失効の粒度が無い」だけ。** serve.mjs:173 と :179 が同じ `~/.kjp-edit/token` を渡すのは事実で、`--exec --allow-host` を**自分で選んだ**構成（実際に PID 33244 がその形で動いている）では、その1本のトークンを渡した相手はそのサーバで実行できる。ただしそれは README/daily-use が明示している設計（「トンネルに届く相手 = このマシンでコードを実行できる相手」）そのもので、capability 分離が守ると主張しているのは *サーバに与える権限* であって *トンネルの向こうの人間の識別* ではない。読み取りだけを第三者に渡して後で失効させたい、という運用は現状できない — これは資格情報の衛生の話なので MINOR。BLOCKING（クロスリポジトリ RCE）としては反証済み。

（補足: 別セッションのスモークテスト由来と思われる node サーバ PID 17784 / 8484 が残っている。私の起動分ではないので触っていない。）

---

## この回から変えたこと

- **レビューを体制にした**（`CLAUDE.md` の「レビューの規則」）。
  capability や認可に触った直後 / 子プロセスの寿命を変えたとき /
  リポジトリ外に触ったとき / 実装コミット3件ごとに必ず走らせる
- 観点を独立させ、**各指摘を別のエージェントに反証させる**。
  迷ったら残す側に倒す（見落としより誤検出の方が安い）
- **レビュアーには修正させない**（誰がどう直したかを追えなくなる）
- **打ち切りは `log()` に出す**（黙って上位N件に絞ると「全部見た」と読める）
