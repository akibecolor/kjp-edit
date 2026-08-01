# 文字コードとパスのハザード（日本語 Windows を前提に）

**発端:** 私（設計者）が PowerShell で日本語ドキュメント5本を文字化けさせた。
**PowerShell 5.1 の `Get-Content -Raw` が既定でシステムANSIコードページ（CP932）を使う**ため、
UTF-8 を CP932 として読んで UTF-8 として書き戻し二重エンコードした。

**それは私のツール選択のミスだが、同じクラスの罠が製品側に並んでいた。**
以下は実測（🧪）と一次情報で確認した内容。**Theia 側に日本語が壊れる欠陥が2つ見つかった。**

測定環境: `chcp` = **932**、ANSI CP = `shift_jis`、**PowerShell 5.1 のみ（`pwsh` は未インストール）**、
git 2.48.1.windows.1、Node v24.12.0。

---

## 🔴 Theia 側に見つかった欠陥（我々が継承してしまうもの）

### 1. `MultiRingBuffer` がターミナルの日本語を壊す — 全バイトが通る hot path

`packages/process/src/node/multi-ring-buffer.ts` は**バイトを格納してバイト範囲をデコード**します:

```ts
enq(str, encoding='utf8') { let buffer = Buffer.from(str, encoding);
  if (buffer.length > this.maxSize) buffer = buffer.slice(buffer.length - this.maxSize); … }

deq(id, size=-1, encoding='utf8') { …
  if (wrapped === false) buffer = this.buffer.toString(encoding, pos, pos + deqSize);
  else buffer = buffer.concat(this.buffer.toString(encoding, pos, this.maxSize),
                              this.buffer.toString(encoding, 0, deqSize - (this.maxSize - pos))); }
```

**UTF-8 の境界を一切見ていない切断が3箇所:**
1. オーバーフロー時の `slice`
2. `deqSize = min(size, maxDeqSize)` の読み出し（`size` はストリームの `_read(size)` から来る）
3. 🚨 **ラップ時 — 2つの半分を*独立した* `toString` 呼び出しでデコードするので確実に壊れる**

**3バイトの日本語文字がこれらの点を跨ぐと U+FFFD になります。**
そして `StringBufferingStream` が JS 文字列を 256KB で切るので、**サロゲートペア（絵文字）も割れます。**

**対処:** ターミナルデータについて **`MultiRingBuffer` を置き換えるかバイパスする** —
Buffer/`Uint8Array` を end-to-end で渡し、**xterm の stateful デコーダに UTF-8 処理をさせる**。
または ring buffer を境界認識にする。
**日本語を maxSize 超えて流してラップを強制する回帰テストを必ず置く。**

### 2. Theia は Windows で `cmd.exe` をハードコードしている

`packages/terminal/src/node/shell-process.ts`:
```ts
public static getShellExecutablePath(): string {
    const shell = process.env.THEIA_SHELL;
    if (shell) return shell;
    if (isWindows) return 'cmd.exe';
    else return process.env.SHELL!;
}
```
pwsh の検出も codepage の扱いも無く、env は `{ COLORTERM: 'truecolor' }` だけ。

**VS Code は pwsh 7 を優先して 5.1 を最後にフォールバック**します
（`getFirstAvailablePowerShellInstallation()` が
PS Core stable → 別ビット幅 → MSIX/Store → .NET global tool → preview → Scoop → **5.1 最後**）。

**対処:** `getShellExecutablePath()` をオーバーライドし、VS Code と同じ探索順で `pwsh` を優先する。
`cmd.exe` と Git Bash は選択可能なプロファイルとしてのみ残す。
🧪 **このマシンには `pwsh` が入っていないので、今は 5.1 の欠陥が全部生きています**
（`$OutputEncoding = ASCIIEncoding` なので**ネイティブexeへのパイプで日本語が復元不能に失われる** —
🧪 `"日本語パイプ" | findstr .` → `??????`）。
5.1 しか無い環境では**「日本語の正しい処理には PowerShell 7 を推奨」の警告を出す**（黙って `?` にしない）。

### 3. ⚠️ 前提の訂正: Theia 1.74 は `xterm@^5.3.0` を使っている

**非推奨の*スコープ無し*パッケージ** + `node-pty@1.2.0-beta.12`。
つまり **「xterm.js 6 を使う」は依存のバンプではなく Theia のターミナルウィジェットの置き換え**です。
安定版のターゲットは **`@xterm/xterm@6.0.0`**（6.1 は 292 beta を経てまだ beta）。

### 4. `@parcel/watcher` の snapshot 経路が ANSI

`BruteForceBackend::readTree` が `FindFirstFile`/`ffd.cFileName`/`strcmp` を使い、
**`binding.gyp` が `UNICODE` も `_UNICODE` も定義していない** → `FindFirstFileA` に解決されるので
`cFileName` は **CP932 バイト**。それが `std::string` に入って
`napi_create_string_utf8` に UTF-8 として渡されます。

**到達経路は `writeSnapshot()` と `getEventsSince()`。`subscribe()` は clean。**
2022年から open（[#118](https://github.com/parcel-bundler/watcher/issues/118),
[#211](https://github.com/parcel-bundler/watcher/issues/211)）、
正しい修正 [PR#125](https://github.com/parcel-bundler/watcher/pull/125) は **3年半マージされていない**。

**対処:** **Windows で `writeSnapshot()`/`getEventsSince()` を禁止する**（lint ルール + issue へのコメント）。
`subscribe()` のみを使う。再起動後の復帰が必要なら JS 側で NFC 対応の `readdir` で自前スナップショット。

### 5. Theia は NFC 正規化をどこでもやっていない

`normalize('NFC')` / NFD が**リポジトリ全体で1箇所も出てきません**
（VS Code は `normalizeNFC` を8ファイルで使う）。
`parcel-filesystem-service.ts` は `isOSX` を**バックエンド選択の1回だけ**使い、
`event.path` をそのまま `FileUri.create()` に渡します。
**macOS の parcel watcher も正規化しません**（`FSEventsBackend.cc` に `CFStringNormalize` が無く、
`pathExists()` が生の `strncmp` なので NFC/NFD 不一致で黙って false を返す）。

**対処:** `ParcelFileSystemService` をサブクラス化して macOS で `normalizeNFC` を挿入する。
**VS Code の `src/vs/base/common/normalization.ts` を移植**（MIT）—
`/[^\u0000-\u0080]/` の ASCII 高速パスと 10k LRU 付き（ウォッチャイベント毎に走るので必要）。

### 6. Theia にエンコーディングのテストが1つも無い

Shift-JIS/CP932 テスト無し、非ASCIIパステスト無し、BOM テスト無し、正規化テスト無し。
`encoding-service.spec.ts` が存在しない。
**VS Code のエンコーディング実装を、そのテストとフィクスチャを1つも持たずに継承しています。**
（VS Code は約90本のエンコーディングテストと実フィクスチャディレクトリを持つ。）

なお訂正: Theia は**エンコーディングのテーブル自体は持っています** —
`packages/core/src/common/supported-encodings.ts` に
`shiftjis: { labelLong: 'Japanese (Shift JIS)' }` と `eucjp` があります。

---

## git の起動 — 正典のレシピ

```js
spawn(gitPath, argvArray)   // ← shell は絶対に使わない
```

**ベース argv:**
```
-c core.quotepath=false
-c i18n.logOutputEncoding=UTF-8
-c core.longpaths=true
(+ macOS では -c core.precomposeUnicode=true)
```
**ベース env:**
```
LANGUAGE=en  LC_ALL=en_US.UTF-8  LANG=en_US.UTF-8
GIT_PAGER=cat  GIT_TERMINAL_PROMPT=0  GIT_OPTIONAL_LOCKS=0  GIT_EDITOR=true
```
**パスを含むコマンドは常に `--porcelain=v2 -z` / `--numstat -z`。**

### なぜこの形なのか

**🧪 `core.quotepath=false` だけでは足りません:**
```
git status --short                          →  ?? "\346\227\245\346\234\254\350\252\236.txt"
git -c core.quotepath=false status --short  →  ?? 日本語.txt
                                               ?? "with space.txt"   ← まだクォートされる
git status --porcelain -z | od              →  346 227 245 … .txt \0  ← 完全に生
```
**→ `-z` が主機構。** VS Code は `core.quotepath` を**一度も設定せず**、
代わりに**パスを含む全コマンドに `-z` を渡します**（`status -z`, `log … -z`,
`diff --raw --numstat -z`, `diff-tree -z`, `stash list -z` …）。
それでも `-z` の無いコマンド用に **C形式のアンクォータは実装が必要**。

**⚠️ ユーザのグローバル設定が我々のパーサを黙って壊しうる:**
```
git log -1 --format=%s                              → UTF-8 ✅
git -c i18n.logOutputEncoding=Shift_JIS log -1 …    → CP932 ❌
```
`i18n.logOutputEncoding=cp932` を `~/.gitconfig` に書くのは**日本語圏のブログでよく推奨される**設定で、
**VS Code はこれに対して防御していません**。
**→ コミットメッセージの読み取りは `-c i18n.logOutputEncoding=UTF-8` と `--encoding=UTF-8` の両方を渡す。**

🛑 **訂正: CI/テストでの設定隔離に `/dev/null` は Windows で使えません。**
当初「`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`」と書きましたが、
Node の `os.devNull` は Windows で `\\.\nul` になり、git が落ちます（実測）:
```
fatal: unable to access '//./nul': Invalid argument
```
**空ファイルを指すのが移植性のある方法です**（`v0/smoke.test.mjs` の `isolatedConfig()`）:
```js
const emptyConfig = join(tmpDir, '.empty-gitconfig');
await writeFile(emptyConfig, '', 'utf8');
env.GIT_CONFIG_GLOBAL = emptyConfig;
env.GIT_CONFIG_SYSTEM = emptyConfig;
```
⚠️ グローバル設定を潰すと `user.name`/`user.email` も消えるので、
テスト用リポジトリには repo local で入れるか `GIT_AUTHOR_*`/`GIT_COMMITTER_*` を渡すこと。

（なお **`core.commitEncoding` は存在しません。** 実在するのは
`i18n.commitEncoding`（既定 utf-8）と `i18n.logOutputEncoding`。）

**✅ 良いニュース: git.exe の stdout はコードページ非依存の UTF-8。**
🧪 `chcp 932` と `chcp 65001` で `git ls-files -z` の出力が**バイト単位で同一**でした。
メンテナ（Johannes Schindelin）も
「Git for Windows は現在のコードページを一切使わず、**常に内部で UTF-8** を使う」と述べています。
**cmd.exe の `dir` は 🧪 コードページで変わったので、これは git 固有の保証です。**

**🚨 `GIT_TERMINAL_PROMPT=0` は必須（推奨ではない）。**
`compat/terminal.c` が `CONIN$`/`CONOUT$` を**直接開く**ので、
stdio をパイプしてもプロンプトを防げません。**`git fetch` が Electron のパイプの背後で永久にハングしえます。**

**🚨 `git add` は深いパスを黙ってスキップします。**
🧪 `core.longpaths` 未設定だと
`warning: could not open directory '…': Filename too long` を出して**成功を報告しつつファイルを stage しない。**

**⚠️ 日本語ファイル名は約85文字で落ちます** — msys2 の `NAME_MAX` が 255 **バイト**なので
（[gfw#2820](https://github.com/git-for-windows/git/issues/2820)、open）。
**bash の glob 展開の問題なので、argv 配列で shell 無しに spawn すれば回避されます。**

---

## ターミナル — `chcp 65001` を絶対にやらない

🧪 node-pty/ConPTY 経由のシェルは**システム OEM コードページ（932）**を受け取ります。
ConPTY の*writer*は無条件に `WideCharToMultiByte(CP_UTF8, …)` で変換するので、
パイプラインは **アプリのバイト → [コンソールCPでデコード] → UTF-16 → [UTF-8でエンコード] → pty**。
**コードページが効くのは ConPTY の上流だけ。**

🧪 実測マトリクス:

| | CP932 のとき | 65001 のとき |
|---|---|---|
| CP932 のファイル | ✅ | ❌ **U+FFFD で不可逆に破壊** |
| UTF-8 のファイル | ❌ 文字化け | ✅ |

**`chcp 65001` が壊すもの（検証済み）:** 🧪 CMD のローカライズメッセージ
（`現在のコード ページ` → `Active code page`）、レガシーな Shift-JIS ツール全部、
conhost の UTF-8 デコードが**書き込み単位でステートレス**なので512バイト境界を跨ぐ文字が置換文字になる
（[#17862](https://github.com/microsoft/terminal/issues/17862)）、
65001 では非ASCIIのコンソール*入力*が壊れる、`chcp.com` が画面をクリアする。

**VS Code はターミナルに対して `chcp` を一度も呼びません。**
🚩 そして `terminalEncoding.ts` の変換テーブルは **`932` を含んでいない**（`437,850,…,936,1252`）ので
日本語 Windows では `return UTF8` に落ちます。**これは真似しない。**

**node-pty の注意:** `useConpty` は「非推奨で無視される」→ **`useConptyDll: true`** を使う。
**Windows では `encoding` オプションが黙って無視される**（`windowsPtyAgent.ts` が
`setEncoding('utf8')` をハードコード）ので常に文字列が返る。
副作用として Node の `StringDecoder` を通るので**チャンク境界の文字化けは起きません**。

**→ 規則: `chcp 65001` をしない。ConPTY は 932 のままにする。
コードページではなく*ツール側*を直す** — プロファイル毎に `PYTHONUTF8=1`、
`LESSCHARSET=utf-8`、git の UTF-8 設定を注入する。
UTF-8 トグルを露出するならプロファイル単位のオプトインにして、
**レガシーな Shift-JIS ツールが壊れることを明記する。**

### xterm.js の全角文字

**`term.unicode.activeVersion` の既定は `'6'`**（2010年の wcwidth テーブル。未文書、`CoreTerminal.ts` 由来）。
🚨 **`@xterm/addon-unicode11` は登録するだけで有効化しません** —
`activeVersion = '11'` を設定しないと**黙って no-op**。

🚨 **曖昧幅（ambiguous width）が日本語の未解決問題:** 両プロバイダが `table.fill(1)` なので
`°×''""…`、矢印、罫線が幅1になりますが、**日本語の等幅フォントは全角で描きます。**
`ITerminalOptions` にノブは無く、`UnicodeGraphemeProvider.ambiguousCharsAreWide` は公開APIから到達不能。
[#2668](https://github.com/xtermjs/xterm.js/issues/2668) に2020年から箇条書きで残るだけ。

**→ 規則: `allowProposedApi: true`、`addon-unicode11` をロードし、
`term.unicode.activeVersion='11'` を明示設定して起動時に assert する。
レンダラは WebGL を既定にする**（全角/絵文字のバグ3件は全部 DOM レンダラ限定 —
[#6058](https://github.com/xtermjs/xterm.js/issues/6058) CJK行が最大+58pxずれる、
[#3097](https://github.com/xtermjs/xterm.js/issues/3097) リサイズで CJK が**データ喪失**、6年 open）。
DOM をフォールバックにするなら `.xterm { text-spacing-trim: space-all; }` を足す。
曖昧幅は**カスタム `IUnicodeVersionProvider` を登録**する（サポートされた唯一の経路）。

---

## Windows のパス — 2つの硬い壁

### 🚨 `child_process` は長いパスに一切対応していない

🧪 実測（git を spawn したときの `cwd` の長さ）:

| cwd の長さ | 結果 |
|---|---|
| 209 | ✅ OK |
| **291** | ❌ **ENOENT** |
| 414 | ❌ ENOENT |
| `\\?\` 前置 | ❌ git が「Unable to read current working directory」で死ぬ |

`CreateProcess` の `lpCurrentDirectory` が MAX_PATH 束縛なので**これはバグではなく Win32 の硬い制限**です。

**→ 規則: 260 に近い `cwd` で絶対に spawn しない。短いルートに解決して
`git -C` + リポジトリ相対パスを使う。**
ワークスペースを開いた時点でルートが約200文字を超えていたら警告する。

Node 自体は `toNamespacedPath()` で `\\?\` を付けるので 🧪 423文字のパスを読めますが、
**`node.exe` は `longPathAware` ではなく**、対応は呼び出し箇所単位なので新しい箇所は毎回リグレッションします。
**Electron も `longPathAware` を持っていません**（[electron#49101](https://github.com/electron/electron/issues/49101)
は `not_planned`「これはシステムの制限」でクローズ）。

### 予約名 — Node は平然と作ってしまう

🧪 **Node は `toNamespacedPath` 経由で `CON.txt` / `aux.txt` / `NUL` / `com1.txt` / `foo.` / `foo `
を実ファイルとして作れます** — Explorer・cmd・他のほとんどのツールからはアクセス不能なまま。
`path.win32.normalize('CON.txt')` は何も警告しません。

予約名は CON, PRN, AUX, NUL, COM1-9, LPT1-9 に加えて **`COM¹²³`/`LPT¹²³`**（`\xb9\xb2\xb3`）、
そして「NUL.txt も NUL.tar.gz も NUL と等価」「**すべてのディレクトリで予約**」。
末尾のドットと空白は Win32 が黙って除去します。

**→ 規則: `validateWindowsFilename()` を1本書いて new-file/rename/save-as の全経路で使い、
**全プラットフォームで**強制する。** そうしないと
**Linux のコントリビュータが `aux.ts` をコミットしてリポジトリをクローン不能にできます。**
チェック項目: 無効文字 `<>:"/\|?*` + 0x00-0x1F、最初のドットより前の basename を26個の予約名と照合、
末尾のドット/空白、空・全部ドット。

### 大文字小文字

macOS/APFS は既定で case-**in**sensitive、Linux は sensitive、
Windows は insensitive だが **build 17107 以降ディレクトリ単位で上書き可能**
（`fsutil file setCaseSensitiveInfo`）なので **`process.platform` は Windows でも権威ではありません。**

`core.ignoreCase` の既定は false ですが、**`git clone`/`git init` が
`access(".git/CoNfIg")` でプローブして適切なら true にします**。
🧪 このマシンでは `core.ignorecase=true`。
**リポジトリを case-sensitive なディレクトリと通常のディレクトリの間でコピーすると値が間違ったまま残り**、
gitfaq の「常に変更されているファイル」として現れます。

**→ 規則:** FS プロバイダで case sensitivity を一度宣言し、
**すべての URI 比較を canonicalize する identity service 経由にする**
（`uri.toString()` を直接比較しない）。
**ワークスペースルート毎に git 自身の `CoNfIg` トリックでプローブする。**
CI ガード: `git ls-files | tr A-Z a-z | sort | uniq -d` が空であること。
**大文字小文字だけの rename は `git mv --force`**（`fs.rename` は Windows/macOS で no-op）。

### NFC vs NFD — よくある誤解の訂正

**APFS は normalization-*insensitive* かつ preserving** です。Apple の APFS FAQ 逐語:
「In macOS High Sierra, APFS is **normalization-insensitive** in both the case-insensitive and
case-sensitive variants, using a hash-based native normalization scheme」。
**HFS+ が NFD で*格納*していた**のであって、APFS は書いた形を保持します。
**→ 「macOS は NFD を返す」は HFS+ と FSEvents のレガシー経路については真だが、
唯一安全な前提は「実世界には混在した形がある」。**

🧪 NTFS では `café`（NFC）と `café`（NFD）が**共存する別ファイル**になります。APFS では1つです。

🔴 **これは VS Code の git 層で今も open なバグクラス** =
まさに我々の面: [vscode#308475](https://github.com/microsoft/vscode/issues/308475)
（2026-04、open。報告者は **`core.precomposeUnicode true` では直らなかった**と述べている）、
[vscode#240892](https://github.com/microsoft/vscode/issues/240892)（日本語NFDディレクトリで差分装飾が出ない）。

**→ 規則: `core.precomposeUnicode=true` を設定するが信用しない。**
**macOS 限定で3つの境界で NFC に正規化する** — ウォッチャイベント、`readdir`、
そしてパスを出す全 spawn ツールの stdout（git, ripgrep）。
**そこから先は NFC を唯一の内部正規形にして二度と正規化しない。**

---

## PowerShell の正確な事実（避けるべき理由の記録）

🧪 二重エンコードを再現しました。`日本語テスト` = `e6 97 a5 e6 9c ac e8 aa 9e …`:
```
Get-Content -Raw                → e8 ad 8c ef bd a5 …   ← 文字化け（譌･譚ｬ…）
Get-Content -Raw -Encoding utf8 → e6 97 a5 e6 9c ac …   ← 正しい
```

| | 5.1 | 7.x |
|---|---|---|
| `Get-Content`（BOM無し） | **ANSI = CP932** | `utf8NoBOM` |
| `Get-Content`（BOM有り） | BOM が勝つ ✅ | BOM が勝つ |
| `Set-Content`/`Add-Content` | **ANSI = CP932** | `utf8NoBOM` |
| `Out-File`, `>`, `>>` | **UTF-16LE + BOM** | `utf8NoBOM` |
| `Export-Csv` | **ASCII** → 🧪 `"??????"` 完全喪失 | `utf8NoBOM` |
| `$OutputEncoding` | **`ASCIIEncoding`** | `UTF8Encoding` |

**普通に誤って語られる3点:**
1. **5.1 は BOM を先に見ます。** ANSI はフォールバック。**BOM無し UTF-8 だけが壊れる**
2. **`-Encoding utf8` は 5.1 では BOM 付き、7.x では BOM 無し。同じフラグで逆の結果。**
   5.1 に `utf8NoBOM` は存在しない
3. **ノブが3つ独立にある**: `$OutputEncoding`（ネイティブコマンドへ*パイプする*テキスト。
   ドキュメント逐語「**出力リダイレクト演算子や cmdlet がファイル保存に使うエンコーディングには影響しない**」）、
   `[Console]::OutputEncoding`（出てくるバイトのデコード）、`-Encoding`（ファイル）

🔴 **ハーネス固有の注意:** Claude Code の PowerShell ツールは
`$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'` を注入しますが、
**5.1 では `utf8` = BOM 付き**なので 🧪 `x > file.json` が **BOM 付き JSON を作り
`JSON.parse` と `tsc` を壊します。** かつ `Out-File` だけが対象で
`Set-Content`/`Export-Csv` は依然 CP932/ASCII。プロファイルはロードされないので profile で直せません。

---

## Claude Code の hooks — encoding は完全に未文書、かつ実際に壊れている

**hooks / hooks-guide / settings のページで `utf`/`encoding`/`codepage`/`chcp` の出現がゼロ。**
UTF-8 の保証はすべて PowerShell *ツール*にスコープされていて hooks には及びません。そして open バグ:

| | |
|---|---|
| [#72391](https://github.com/anthropics/claude-code/issues/72391) | **open** — Windows で非ASCIIのファイルパスが PreToolUse hook にサロゲートエスケープされて渡る |
| [#81187](https://github.com/anthropics/claude-code/issues/81187) | **open** — ハーネスが `$OutputEncoding` を設定するが `[Console]::OutputEncoding` は設定しない |
| [#78756](https://github.com/anthropics/claude-code/issues/78756) | **open** — クライアントが stdin を閉じないので hook がハングする |
| [#6246](https://github.com/anthropics/claude-code/issues/6246) | UTF-8 バイトが hook パイプラインで Latin-1 として再解釈される |

**→ 規則: exec 形式で `command: "node"` を使う。**
これで Git Bash・PowerShell・cmd.exe・CP932 コンソール層・EINVAL 地雷を**一度に全部バイパス**します
（**Anthropic 自身が文書化している推奨**）:

```json
{ "type": "command", "command": "node",
  "args": ["${CLAUDE_PROJECT_DIR}/scripts/verify.mjs"], "timeout": 420 }
```

**スラッシュのみ。`command`/`args` にバックスラッシュを入れない。
`"shell": "powershell"` を設定しない**（5.1 + CP932 コンソールに落ちる）。
`verify.mjs` 側は `setEncoding('utf8')`、stdout には JSON のみ、
文書化された **10,000文字の上限**内、**ブロックは `exit 2`**（exit 1 は非ブロッキング）、
そして #78756 に備えて stdin 読み取りをガードする。
なお **hook の timeout の既定は 600 秒**。

---

## エージェント向けの規則（`CLAUDE.md` に入れる）

1. **PowerShell でファイルを読み書きしない。** Read/Write/Edit ツールか Node を使う。
   **BOM 無し UTF-8 に `Get-Content -Raw` すると CP932 の文字化けが返る**
   — 実測済みで、ドキュメント5本を壊した原因がこれ
2. PowerShell が避けられない場合はプロセス制御のみ。ファイル内容には触らない。
   触るなら `$PSDefaultParameterValues['*:Encoding']='utf8'` +
   `[System.IO.File]::WriteAllText($p,$t,[System.Text.UTF8Encoding]::new($false))`
3. **ビルド/開発スクリプトは全部 `.mjs`/`.ts`。** `package.json` に `.ps1`/`.sh`/`.bat` を書かない。
   **インラインの `FOO=bar` 前置を書かない**（cmd.exe が解釈できない）。
   **`node_modules/.bin/*.cmd` を Node から spawn しない**（EINVAL / DEP0190）—
   `process.execPath` + `require.resolve` を使う
4. **git をシェル経由で呼ばない。** `spawn(gitPath, argvArray)` に上記のベース argv/env。
   `bash -c` も `shell: true` も使わない。常に `-z`。`--stat` と `git submodule status` をパースしない
5. **非ASCII名のファイルを作るときは UTF-8 かつ NFC 正規化。**
   末尾のドット/空白や予約デバイス名を basename に持つファイル名をコミットしない
6. **`chcp` しない。** コンソールのコードページを変えてエンコーディングを「直す」のは、
   レガシーな CP932 ツールと日本語の CMD メッセージを壊す
7. **非ASCII はドキュメントと製品文字列に置く。スクリプトやランチャには置かない**
   （`.sh`/`.bat` は純ASCII に保つ — BOM 無し UTF-8 は CP932 と誤読され、BOM は Unix ツールを壊す）
8. **2つのパスを比較するときは両方を NFC に正規化してから。**
   git 由来のパスとファイルシステム由来のパスを生で比較しない

---

## スモークスイートに足すテストケース（E1-E14）

[development.md](development.md) の11シナリオには**エンコーディング/パスのカバレッジがゼロ**でした。
フィクスチャは `.gitattributes` で `-text` にしないと無意味になります（対応済み）。

| # | ケース | 何を捕まえるか |
|---|---|---|
| **E1** | `日本語.txt` を開く/編集/保存/再オープン | Theia FS + Monaco を通す UTF-8 パスの往復 |
| **E2** | `café` **NFC** と `café` **NFD** を並置し、NFC の綴りで発見できることを検証（件数はプラットフォーム条件付き: ext4/NTFS で2、APFS で1） | **VS Code でもテストされていない穴**。我々の git エンジンの比較 |
| **E3** | `テスト ファイル.ts`（日本語**＋空白**）を git status で | quotepath **と**空白クォートの両方 — 🧪 `quotepath=false` でも空白はクォートされる |
| **E4** | 260 を超える深さ、**かつ >260 の cwd で git を spawn** | 🧪 291 で ENOENT。`core.longpaths` の黙ったスキップ |
| **E5** | CRLF / LF / 混在ファイル、`git ls-files --eol` が全部 `i/lf` | system gitconfig の `autocrlf=true` |
| **E6** | 日本語コミットメッセージを、**scratch config で `i18n.logOutputEncoding=cp932` を強制して**読み戻す | 🧪 再現した corruption そのもの |
| **E7** | 日本語ブランチ名 `機能/新規` の `for-each-ref` と checkout | 🧪 ref は生の UTF-8 でクォートされない — ファイル名とは別経路 |
| **E8** | ターミナル: 日本語を echo、次に `maxSize` を超える日本語を流して**リングバッファのラップを強制** | 上記 `MultiRingBuffer` の欠陥 |
| **E9** | ターミナルの全角整列: 全角テキスト + 罫線 + `°×…`、`unicode.activeVersion === '11'` を assert | addon の黙った no-op、曖昧幅 |
| **E10** | ウォッチャ: 3 OS で `日本語フォルダ/テスト ファイル.ts` を作成/rename し、イベントパスが期待する **NFC バイト**と一致することを assert | Windows の parcel `FindFirstFileA`、macOS の NFC 欠落 |
| **E11** | ファイル名検証テーブル: `CON`, `con.txt`, `COM¹`, `aux.ts`, `nul.tar.gz`, `foo.`, `foo `, `a<b`, 261文字 — **全プラットフォームで**全部拒否 | 🧪 Node は全部平然と作る |
| **E12** | エンコーディング検出: BOM マトリクス（UTF-8/16LE/16BE/ANSI→**null**）、BOM無しUTF-16 のヒューリスティック、shiftjis/eucjp/gbk の autoguess | VS Code のスイートを移植 |
| **E13** | エンコーディング毎の write→read 往復を `'中文abc'`, `'日本語かなカナ漢字'`, **プラス CP932 固有文字（`①`, `㈱`）**で | **真の CP932 ≠ 厳密な Shift-JIS の証明。VS Code はこれをテストしておらず、日本語IDEが壊れるのはまさにここ** |
| **E14** | 位置指定/ストリーム読み出しでバイトオフセットが**3バイト列の途中**に落ちるケース | VS Code の `small_umlaut` テストを CJK に強化 |

---

## リポジトリに追加した/追加するもの

| | 状態 |
|---|---|
| **`.gitattributes`** | ✅ **追加済み。** `* text=auto eol=lf` が要。🧪 これで**セッション中ずっと出ていた警告が消えました** |
| **`.editorconfig`** | ✅ **追加済み**（`end_of_line = lf` — Theia の `.editorconfig` にはあるが `theia-ide` には両方無い） |
| デーモンの git 設定 | 上記「正典のレシピ」。**ユーザ設定に依存しない** |
| `.claude/settings.json` の hooks | exec 形式 + `command: "node"` + スラッシュ |
| `scripts/doctor.mjs` | postinstall で `LongPathsEnabled` / `core.longpaths` / ワークスペースパス長 / `pwsh` の有無 / 現在のコードページ / MSVC+Python を確認 |
| Electron の `longPathAware` マニフェスト | Electron が入れないので自分で入れ、electron-builder の rcedit が保持するかテストする |
| CI ガード | `git ls-files --eol \| grep -v -e 'i/lf' -e 'i/-text' && exit 1`、大文字小文字衝突チェック |

**🧪 `core.autocrlf` の根本原因（セッション中ずっと出ていた警告）:**
```
git config --show-origin --get core.autocrlf
→ file:C:/Program Files/Git/etc/gitconfig    true
```
**upstream git の既定は全プラットフォームで false。**
`core.autocrlf=true` を system-wide に書くのは **Git for Windows のインストーラ**です
（`install.iss` の既定ラジオが `CRLFAlways`）。
**日本語 Windows の開発者はほぼ全員これを持っています。**
`core.safecrlf=false` で黙らせてはいけません（実在する往復ハザードを隠すだけ）。

---

## 未確認

- **pwsh 7 の実行時の `$OutputEncoding` / `[Console]::OutputEncoding`** —
  このマシンに pwsh が無いので PS 7 の主張はドキュメントのみ。5.1 と ConPTY は全部実測
- **Claude Code の hook の stdout/stderr/stdin エンコーディング** — Anthropic が未文書。
  hook JSON でスラッシュが必要という点は2つの open バグからの推論
- **electron-builder/rcedit が注入した `longPathAware` マニフェストを保持するか** — 一次情報が無い。要実測
- **APFS で FSEvents が2026年に実際に何を返すか** — 一次情報無し。
  Apple は APFS を preserving と文書化しているが VS Code は macOS で無条件に正規化しているので混在前提
- **xterm.js の `activeVersion = '6'` 既定と `_stringDecoder`/`_utf8Decoder` の交互利用ハザード** —
  両方ソースから読んだが上流に文書も issue もテストも無い
- `git mv --force` が大文字小文字だけの rename の*正典*手段か — `-f` の意味論は文書化されているが
  git はこのユースケースに言及していない。機構からの推論
