# kjp-edit

**N 個のエージェントが N 個の git worktree で並行に動くことを前提にした、
git の観測と安全性のためのローカルツール。** 自分が使う道具として作っている（`docs/scope.md`）。

現在は **v0** — 依存パッケージゼロ・読み取り専用のデーモン + 単一ページ UI（`v0/README.md`）。
IDE（Eclipse Theia）に進むかは v0 を使ってから判断する。設計は `docs/` に凍結してある。

## 検証

**変更したら必ずこれを走らせる。合否が出るまで「できた」と言わない。**

```bash
node scripts/verify.mjs          # 構文 + ユニット + スモーク + レイアウト
node scripts/verify.mjs --quick  # スモークとレイアウトを飛ばす（速い）
```

出力は20行以内に収めてある。失敗したら個別に再現する:
```bash
node --test v0/swimlanes.test.mjs
node --test v0/smoke.test.mjs
node v0/layout-check.mjs         # 実ブラウザでレイアウトを測る（無ければスキップ）
```

**成功を主張するのではなく証拠を示すこと。** テストを通したなら、その出力を貼る。

テストを書くときの規則:

- **リポジトリを変更した直後に読むテストは `?fresh=1` を付ける。**
  サーバは短い TTL キャッシュを持つので、素で読むと古い payload が返り
  「変更が検出されない」形の**偽陰性**になる（これでシーケンサ乗っ取り検出が落ちた）
- **グラフアルゴリズムの期待値を手で決める前に、「その形で何が起きるのが正しいか」を
  先に言語化する。** レーン割当のテストで**自分の期待値が誤っていた事故が2回**ある
  （`docs/review-v0-code.md` 末尾）。実装ではなくテストが誤っている可能性を先に潰す
- **性能や資源消費の主張はコメントに書かず、テストで固定する。**
  プロセス起動数は payload の `stats.gitSpawns` として観測できるようにしてある
- 🚨 **入れたテストは「修正を外すと落ちる」ことを必ず確認する。**
  `node scripts/mutate.mjs` が守りを1つずつ外して確認する。**テストを足したらここに変異も足す。**
  survive したら、テストがその守りを検証できていない（冗長な防御なら `defensive` に理由を書く）
  `core.fsmonitor` のテストはフックのクォート不足で起動していなかった偽陽性、
  `pathspec magic` のテストは入口の検証しか見ておらず git フラグを外しても緑だった
  （どちらも `docs/review-write-exec.md`）。**落ちない検査は無意味**
- **突然変異テスト用のスクリプトで `process.exit()` を `try` 内に書かない。**
  `finally` を飛ばして書き換えたソースが復元されず、修正を1行失った。`throw` にする
- 🚨 **変異の `pattern` は「テスト名」に含まれる文字列にする。**
  `--test-name-pattern` に外れたテストも `ℹ tests` には数えられて `skipped` になるので、
  **1件も走っていないのに「落ちなかった → SURVIVED」と誤報する。**
  assert のメッセージを `pattern` に書いてこれを踏んだ。走った本数は `pass + fail` で数える
- 🚨 **変異の `gone` は、同じ式が他所にもできた瞬間に無効化される。**
  `samePath` の realpath を共通化したら `realpathSync.native(t)` が2箇所になり、
  「書き換えが効いていない」で SKIP に落ちて**守りが検証されない状態が静かに続いた**。
  インデントまで含めて一意にする。**SKIP を緑と読まない**
- 🚨 **テストが待ち続ける形にしない。** 「拒否されるはず」を
  `await close` で待つと、拒否されなかったとき**サーバは正常に動き続けて永久に閉じない**。
  `node --test` ごとハングして SIGKILL され、要約が出ず
  `smoke (0 pass, 0 fail)` だけが残って**原因が完全に消える**（CI で1往復無駄にした）。
  `Promise.race` で上限を付け、失敗を失敗として観測できる形にする
- **レイアウトの主張も同じ。`v0/layout-check.mjs` で実ブラウザで測る。**
  「狭い画面で崩れていない」をコメントに書いても回帰は防げない。
  **入れた検査は、壊れたときに実際に落ちることを確認する**
  （`main > * { min-width: 0 }` を消しても落ちなかったので、
  「これが無いと溢れる」というコメントを撤回した）

## 🚨 ブラウザで検証するときの規則（実際に事故を起こした）

1. **headless Chrome の `--window-size` は Windows では最小幅に丸められる。**
   390 を指定しても `innerWidth` は 500 になる（実測）。
   **狭い viewport は iframe を指定幅で作って中から測る**（`--layout-probe`）
2. **スクリーンショットは撮影前に消し、mtime で新しさを検証する。**
   Chrome が上書きに失敗しても exit 0 を返すので、
   古い画像を3回見て「修正が効いていない」と誤診断した
3. **ブラウザは撮影後に必ず落とす。** 残留した Chrome が後続の撮影の
   書き込みを妨げる（**53プロセス残した**）
4. **ブラウザ側の検査は固定時間で待たない。中身が出るまでポーリングする。**
   描画は fetch を待つので、処理を足すと固定待ちが足りなくなる。
   幅ごとに別の Chrome を起動する検査では**レースになって片方だけ落ちる**
   （衝突予測を足したら 390px だけ「バッジ0個」で CI が落ちた）
5. **画像の切り取りを「レイアウトの崩れ」と読み違えないこと。**
   viewport 500px のページを 390px の PNG に収めると右が切れるだけで、
   横溢れではない。`bodyScrollWidth` と `bodyClientWidth` を比べて判断する

## 🚨 スクリプトの規則（実際に事故を起こした）

1. **PowerShell でファイルを読み書きしない。** Read/Write/Edit ツールか Node を使う。
   **PowerShell 5.1 の `Get-Content -Raw` は BOM 無し UTF-8 を CP932 として読む** —
   これで日本語ドキュメント5本を文字化けさせた（`docs/encoding-and-paths.md`）
2. **スクリプトは `.mjs` のみ。** `.ps1`/`.sh`/`.bat` を `package.json` や CI に書かない
3. **`FOO=bar cmd` のインライン前置を書かない。** npm の Windows でのシェルは `cmd.exe` で
   これを解釈できない。環境変数は Node コード内で設定する
4. **`node_modules/.bin/*.cmd` を spawn しない**（`EINVAL` / DEP0190）。
   `process.execPath` + `require.resolve` を使う
5. **バックグラウンドでプロセスを起動したら必ず止める。**
   Windows では `pkill` が `node.exe` に効かない。
   `Get-NetTCPConnection -LocalPort <port> -State Listen` でコマンドラインを照合してから停止する
   （検証用サーバを残してポートを塞いだことがある）
6. **ソースに生の制御文字を書かない。必ずエスケープ表記にする。**
   `/[^\x00-\x80]/` と書く。生の NUL を入れると git がファイルを **binary** と判定し、
   `git diff` / `git log -p` / `git grep` の全てから見えなくなる
   （`v0/git.mjs` が丸ごとレビュー不可能になっていた。`docs/review-v0-code.md` #1）
7. **生の制御文字を含む置換を `node -e "..."` でやらない。**
   bash → `node -e` → テンプレートリテラルの3段でエスケープが失われる。
   6 の修正でこれを踏み、NUL が消えずに移動しただけ（3039 → 3456）になり、
   さらに無関係な行のコメントを壊した。**スクリプトを `.mjs` ファイルに書いて実行する**
   これは `node - <<'EOF'`（heredoc）でも同じ。**`\r` を含む文字列を流し込んで
   コメント行の途中に生の CR を埋め込み、構文エラーにした**（規則7を3回踏んでいる）。
   Windows のパスや正規表現を**書き換える側の文字列**に入れるときは、
   バックスラッシュを持ち込まない書き方（`Users/RUNNER~1` のように書く）にする

## 🚨 git の呼び方（`v0/git.mjs` に実装済み。必ずこれを通す）

**`spawn(gitPath, argvArray)` で `shell` は絶対に使わない。**
理由: injection の回避、そして msys2 の `NAME_MAX` が 255 **バイト**なので
bash の glob 展開だと日本語ファイル名が約85文字で落ちる。

毎回渡すもの:
```
argv: -c core.quotepath=false -c i18n.logOutputEncoding=UTF-8 -c core.longpaths=true
      (macOS では + -c core.precomposeUnicode=true)
env:  LANGUAGE=en LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 GIT_PAGER=cat
      GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_EDITOR=true
```

- **パスを含むコマンドは常に `-z`。** `core.quotepath=false` だけでは**空白がクォートされる**
- **`--stat` と `git submodule status` をパースしない**（前者は lossy、後者は生の空白区切り）
- **`Buffer` で受けて最後に一度だけデコードする。** chunk 毎の `toString()` は3バイト文字を割る
- **`GIT_TERMINAL_PROMPT=0` は必須。** git は `CONIN$` を直接開くのでパイプでは防げず、
  `git fetch` が永久にハングしうる
- テストで設定を隔離するときは **`/dev/null` ではなく空ファイル**を指す
  （`os.devNull` は Windows で `\\.\nul` になり git が落ちる）
- **`-z` の出力で NUL をレコード区切りに使わない。** NUL はフィールド区切り専用。
  `%D` が空だと NUL が3連続して分割が1つずれる（`log()`）。
  `status --porcelain=v2 -z` の rename は `<path>` NUL `<origPath>` の**2トークン**
  （`worktreeStatus()`）。**改行を含みえないフィールドなら改行を区切りにする**
- **`git merge-tree` は衝突を exit 1 で返す。** 失敗と区別するため `withCode` を使う。
  `-z` の出力は「tree OID → 衝突パス群 → **空トークン** → 情報メッセージ」で、
  NUL を素朴にレコード区切りにすると情報メッセージ側のパスを衝突パスと混同する。
  `--write-tree` は **loose object を書く**（ref/index/作業ツリーには触らない）
- **`git for-each-ref` に `-z` は無い**（`unknown switch 'z'` で 129 終了）。
  refname は改行を含みえないので `--format=%(refname)%00%(objectname)` +
  改行区切りで安全にパースできる
- **ループの中で新しい `git` 呼び出しを足さない。** worktree 本数に比例して
  プロセスが増える（11本で 59 spawn になっていた）。ref 解決は `refMap()`、
  `$GIT_DIR` は `worktreeGitDirs()` の表引きで済ませる。
  payload の `stats.gitSpawns` をスモークテストが上限で固定している
- 🔒 **HTTP から来た値を git に渡すときは `isSafeRepoPath()` / `isSafeRef()` を必ず通す。**
  `..` / 絶対パス / ドライブレター / 先頭 `-`（オプション注入）/ NUL を弾く。
  **パスは必ず `--` の後ろに置く**（無いと ref として解釈されうる）
- 🔒 **ファイルの中身は `git cat-file` 経由で読み、`fs` で読まない。**
  git オブジェクト経由なら「コミットに入っているもの」に限定され、
  リポジトリ外や未追跡の `.env` に触れる経路を作らない

## UI の規則（レビューで実際に壊れた。`docs/review-ui-conflicts.md`）

- **ペインは id 単位で差分更新する。集合キーで作り直さない。**
  worktree はアルファベット順で中間に挿入されるので、1本増えると全滅する
- **ペインを捨てる前に必ず `abort()` する。** 中断せずに DOM を捨てると
  サーバは切断を検知できず、子プロセスが `--exec-timeout`（600秒）まで残る。
  **worktree の増減4回で実行枠（8）を使い切っていた**
- **ストリーム出力を1件ずつ DOM に足して `scrollHeight` を読まない。**
  強制同期レイアウトで**総文字数に対して二次**になる（12,000行で54秒、
  単一ブロック28.9秒。その間 停止ボタンも自動更新も効かない）。
  `requestAnimationFrame` でまとめ、追従判定は `scroll` イベントで真偽値として持つ
- **DOM を後から `querySelector` で探して掴まない。** 作った要素はオブジェクトに持つ。
  構造が変わると静かに別の要素を掴む（`div > div:last-child` が親自身を掴んでいた）
- **表示上限で省略したら必ず告知する。** カードはあるのにコンソールが無い、
  という状態を無言で作らない
- **書き込み操作の入力（`<select>` 等）は自動更新で作り直さない。**
  選択が先頭に戻り、意図しない対象に実行される
- **ペインの id は序数にしない。** 対象（worktree の path）由来にする。
  序数だと払い出し順が変わったときに「ヘッダは A なのに中身は B」になる

## 🔒 サーバの規則

- **`0.0.0.0` にバインドしない。** ループバックのみ（`docs/architecture.md` D1）
- **Host ヘッダの検証を外さない。** `127.0.0.1` バインドと CORS では
  **DNS rebinding を防げない**（攻撃者のページのオリジンが `127.0.0.1` になるため）。
  閲覧しただけのサイトから差分が読まれる。トンネル用のホスト名は
  `--allow-host` で明示的にオプトインさせる（`docs/auth-ordering.md`）
- **副作用のある経路（書き込み・実行）を足すときは、同じコミットで
  「必ず通る関門関数」も作る。** 経路を散らしてから認証を入れると
  全経路の監査になり、1つ忘れると穴が残る
- **実行系の capability を書き込みとまとめない。** `--allow-exec` は
  `--allow-write` と別。checkout を許すことと任意コマンドを許すことは危険度が桁違い
- **コマンドの allowlist で安全を装わない。** `git` を許すだけで
  `git -c alias.x='!sh -c ...' x` から任意コードが動く。**扉（認可）を守る方に賭ける**
- **PTY を足すなら node-pty が必要**（Node 標準に PTY は無い）。依存が増えるので、
  その前に `claude -p` の非対話実行で足りないかを確かめる。
  **エージェントを遠隔から動かすだけなら PTY は要らない**
- **子プロセスを起動する経路は、クライアント切断で必ず殺す。**
  取り残すとプロセスが溜まる。テストで固定する（`kill` を外して落ちることも確認する）
- **`Host` を検証するテストは `fetch` で書かない。** undici は Host を
  上書きできず（forbidden header）黙って既定値を送るので、
  「攻撃が防がれた」ではなく「攻撃を送れていない」を見てしまう。
  `node:http` の `request()` を使う（実際にこれで偽陽性を出した）

## パスの扱い

- **内部正規形は NFC。** macOS では境界（watcher / `readdir` / spawn の stdout）で正規化する
- **`cwd` が 260 文字に近い状態で spawn しない。** `CreateProcess` の `lpCurrentDirectory` は
  MAX_PATH 束縛で、実測で 291 文字は `ENOENT`。短いルートに解決して `git -C` を使う
- **`CON` / `aux.ts` / `foo.` / `foo ` のようなファイル名を作らない。**
  Node は作れるが Windows の他のツールから触れず、リポジトリをクローン不能にする
- **パスの一致判定は `===` でやらない。`samePath()` を使う。** 同じ場所が
  3種類の別表記になる: 区切り文字（git は Windows でも `/`、`path.join` は `\`）、
  大文字小文字（Windows/macOS）、**8.3 短縮名とシンボリックリンク**
  （Windows CI の `os.tmpdir()` は `RUNNER~1` を返すのに git は `runneradmin`、
  macOS の `/var` は実体 `/private/var`）。`realpathSync.native()` で実体に解決する。
  **手元の Windows では短縮名にならないので、この種のバグは CI だけで出る**

## ライセンス

- **このリポジトリのコードは MIT**（`LICENSE`）。新規ファイルには
  `// SPDX-License-Identifier: MIT` を入れる
- **他プロジェクトからコードを写したら `NOTICE.md` に追記し、元の著作権表示をコードに残す。**
  例: `v0/swimlanes.mjs` は VS Code の `scmHistory.ts`（MIT）由来
- **GPL/AGPL のコードをコピーしない。** 読むのは自由。
  読むだけ: tig / git-cola（GPL-2.0）、GitUp / gitamine（GPL-3.0）、mux（AGPL）
  写してよい: lazygit / gitui / clash / amux / opencode（MIT）、git-branchless（MIT枝）
- **`mhutchie/vscode-git-graph` は derivative works の配布が禁止**なので触らない
- **Theia を採る場合**、Theia のソースをコピーペーストしない。
  サブクラス化と DI rebind を使う。1行でも写したらそのファイルが EPL-2.0 になる（`docs/licensing.md`）

## コードの書き方

- **依存パッケージを増やさない。** v0 は Node 標準ライブラリのみで動く。
  追加を提案する場合はライセンスと、なぜ標準ライブラリで足りないかを述べる
- テストは `*.test.mjs`。**バグを直したら回帰テストを足す**
  （`v0/swimlanes.test.mjs` には実際に踏んだ3件が入っている）
- コメントはコード自体が示せない制約を書くときだけ。「なぜこうしないと壊れるか」を書く
- 日本語はドキュメントと UI 文字列に。**スクリプトとランチャは純 ASCII に保つ**

## コミット

Conventional Commits（`type(scope): summary`）。**何を変えたかではなく、
なぜそれが正しいか・何を検証したかを本文に書く。**
`main` に直接コミットしてよい（個人用リポジトリ）。

🚨 **コミットの前に必ず `git branch --show-current` を確認する。**
このツール自身が worktree のブランチを切り替えられるので、
UI で checkout を押した後は**メイン worktree が別ブランチに居ることがある**。
確認せずにコミットして `spare/candidate` に乗せ、push が no-op になった事故がある。
push 後は `git rev-list --count origin/main..HEAD` が 0 になることも見る。
