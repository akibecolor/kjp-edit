# kjp-edit

**N 個のエージェントが N 個の git worktree で並行に動くことを前提にした、
git の観測と安全性のためのローカルツール。** 自分が使う道具として作っている（`docs/scope.md`）。

現在は **v0** — 依存パッケージゼロ・読み取り専用のデーモン + 単一ページ UI（`v0/README.md`）。
IDE（Eclipse Theia）に進むかは v0 を使ってから判断する。設計は `docs/` に凍結してある。

## 検証

**変更したら必ずこれを走らせる。合否が出るまで「できた」と言わない。**

```bash
node scripts/verify.mjs          # 構文 + ユニット + スモーク
node scripts/verify.mjs --quick  # スモークを飛ばす（速い）
```

出力は20行以内に収めてある。失敗したら個別に再現する:
```bash
node --test v0/swimlanes.test.mjs
node --test v0/smoke.test.mjs
```

**成功を主張するのではなく証拠を示すこと。** テストを通したなら、その出力を貼る。

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
