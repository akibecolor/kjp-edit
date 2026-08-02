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
4. **画像の切り取りを「レイアウトの崩れ」と読み違えないこと。**
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

## パスの扱い

- **内部正規形は NFC。** macOS では境界（watcher / `readdir` / spawn の stdout）で正規化する
- **`cwd` が 260 文字に近い状態で spawn しない。** `CreateProcess` の `lpCurrentDirectory` は
  MAX_PATH 束縛で、実測で 291 文字は `ENOENT`。短いルートに解決して `git -C` を使う
- **`CON` / `aux.ts` / `foo.` / `foo ` のようなファイル名を作らない。**
  Node は作れるが Windows の他のツールから触れず、リポジトリをクローン不能にする

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
