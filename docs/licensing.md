# ライセンス: MIT で行ける（条件つき）

2026-08-01。全ライセンスを実ファイル取得で検証。**法的助言ではありません**が、
ライセンス本文が何を書いているかは正確に写しています。

## 結論

**自分のコードは MIT で問題ありません。** 前例も直接あります —
**`eclipse-theia/theia-ide`（参照製品）自身が MIT** で、EPL-2.0 の `@theia/*` に依存しています。

根拠は **EPL-2.0 §1 の "Modified Works" の carve-out**:

> 「Modified Works shall **not** include works that contain only declarations, interfaces,
> types, classes, structures, or files of the Program solely in each case in order to
> **link to, bind by name, or subclass** the Program or Modified Works thereof.」

**→ import / サブクラス化 / 名前でバインドするだけの我々のファイルは Modified Works ではないので MIT にできる。**

---

## それでも残る EPL-2.0 の義務（自分のコードのライセンスとは無関係に発生）

Electron インストーラを配布する時点で発生します。

| 条項 | 義務 |
|---|---|
| **§3.1(a)** | Theia のソースが EPL-2.0 で入手可能である旨の**声明**を添付し、**入手方法**を合理的な形で示す |
| **§3.2(b)** | **EPL-2.0 の本文コピー**を各配布物に含める |
| **§3.3** | Theia の著作権・特許・商標・帰属表示・免責を**削除も改変もしない**（自分の表示は追加してよい） |
| **§4** | 商用配布者は他の Contributor に対する**免責（indemnification）義務**を負う |

**Apache-2.0（remend, Playwright, ACP）は §4(d) が条件付きでした。逐語:**
> 「**If the Work includes a "NOTICE" text file** as part of its distribution, then any
> Derivative Works that You distribute must include a readable copy of the attribution
> notices contained within such NOTICE file…」

**`remend` の npm tarball には LICENSE も NOTICE も入っていない**（`files` が `["dist", "README.md"]`）
**→ (d) は発生しません。** ただし (a) ライセンスコピーの提供、(b) 改変ファイルの明示、
(c) Source 形式での著作権/特許/商標/帰属表示の保持は**無条件に適用**されます。
→ **リポジトリの LICENSE 本文を手で attribution に写す。**

---

## 前例4つの比較（どのパターンを採るか）

| | 構成 |
|---|---|
| **VSCodium**（MIT） | **1つの MIT ファイルに著作権行を3段積み** — VSCodium contributors + Squicciarini + **Microsoft**。第三者通知ファイルは無し（ビルド時に Microsoft の `ThirdPartyNotices.txt` を継承） |
| **code-server**（MIT） | **MIT は自分の著作権だけ**。Microsoft は専用の `ThirdPartyNotices.txt` に分離（`%% … NOTICES AND INFORMATION BEGIN HERE` 形式）。⚠️ バージョン文字列が `1.47.0` で止まっていて保守されていない |
| **microsoft/vscode**（MIT） | `LICENSE.txt` + **`ThirdPartyNotices.txt` 179KB** — エントリ毎に**ライセンス本文を丸ごと逐語再掲**（リンクや SPDX ID だけにしない）。`cgmanifest.json` + `cglicenses.json` で自動生成 |
| **eclipse-theia/theia** | **`LICENSE` ファイルが存在しない。** ライセンス別に4ファイル（`LICENSE-EPL` / `LICENSE-GPL-2.0-ONLY-CLASSPATH-EXCEPTION` / `LICENSE-MIT.txt` / `LICENSE-vscode.txt`）+ `NOTICE.md`。第三者は **SPDX ID + URL のみで本文は再掲しない** |

**採る構成:**

```
LICENSE               ← MIT（我々のコード）
LICENSE-EPL           ← EPL-2.0 本文（§3.2(b) の履行）
NOTICE.md             ← 第三者通知
```

**そして Theia の2つのパターンを真似ます:**

**(1) `LICENSE-vscode.txt` の provenance ピン。** Theia はこう書いています:
> 「This license covers code originally copied from the vscode repository and integrated in this project」
> + `https://github.com/microsoft/vscode/blob/2dd03eae…/LICENSE.txt`（**コミットSHAで固定**）

**(2) `NOTICE.md` に「コピーしたコード」専用のエントリを、上流バージョン毎に置く。**
Theia の実例:
```
Code copied from project Microsoft/vscode (1.31.0)
Code copied from project Microsoft/vscode (1.32.3)
code copied from project cortex-debug (0.1.21)
```
**これが我々の `scmHistory.ts` と `ParagraphBuffer` 移植にそのまま使える形です。**

⚠️ **Theia の npm tarball は LICENSE ファイルを同梱していません**（`@theia/core@1.74.0` の
tarball 2,981 エントリを展開して確認、`licen|notice` にマッチ0件）。
SPDX の `license` フィールドと**全ソースファイルの15行ヘッダ**（`src` が `files` 配列に入っているので同梱される）に依拠しています。
**これは前例の中で異例。** react は publish 時に LICENSE をコピーしています
（`scripts/rollup/packaging.js`: `asyncCopyTo('LICENSE', \`build/node_modules/${name}/LICENSE\`)`）。
**我々は react 方式を採る**（各パッケージの publish 時に LICENSE を入れる）。

---

## 🔴 エージェントに守らせるルール（1行）

> **Theia のソースをコピーペーストしない。サブクラス化と DI rebind を使う。
> Theia のコードを1行でも自分のファイルに写したら、そのファイルは EPL-2.0 になる。**

**理由（EPL §1 の該当部分）:** Modified Works は
「Program の内容への追加・削除・変更から生じるあらゆる著作物、
**明確化のため、Program の内容を*いかなるもの*でも含む新規ソースファイルを含む**」。
**ファイル単位**なのでプロジェクト全体には伝播しませんが、そのファイルは EPL-2.0 になります。

⚠️ **現行計画に該当箇所があります。** [spikes.md](spikes.md) S1 Step 1 は
`@theia/toolbar` の `createLayout` 本体を逐語コピーする形です。
**`super.createLayout()` を呼んで差分だけ書く形に変えるか、そのファイルを EPL-2.0 にすると決めるか。**
前者を推奨します（コードとしても素直）。

⚠️ **Theia の `configs/*.eslintrc.json` は JSON なのでライセンスヘッダを持ちません**が、
**ヘッダの不在はライセンスの不在ではなく**、リポジトリの dual grant 配下です。
theia-ide は実際にこれを自分の `configs/` に vendor しています（前例あり）が、
**MIT リポジトリへの逐語コピーは意図的な判断として記録すべき**で、既定の前提にしない。

`private-test-setup`（vendor 予定、~4.1 KB / 4ファイル）は
**ソースファイルにヘッダが入っています**（© STMicroelectronics）。**ヘッダを残す。**

---

## 移植元の検証結果（MIT なので安全）

| 移植元 | ライセンス | 必要な対応 |
|---|---|---|
| `microsoft/vscode` の **`src/vs/workbench/contrib/scm/browser/scmHistory.ts`** | **MIT** | 3行ヘッダをそのまま残す + NOTICE に「Code copied from project Microsoft/vscode (1.13x.x)」を追加 |
| `microsoft/vscode` の **`ParagraphBuffer` / `IncrementalDOMMorpher`** | **MIT** | 同上 |

🛑 **パスを訂正しました。** 私が書いていた
`src/vs/workbench/contrib/chat/browser/chatIncrementalRendering/` は **404**。
実際は**セグメントが2つ多い**:

```
src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatIncrementalRendering/
├── chatIncrementalRendering.ts        ← IncrementalDOMMorpher (line 32), tryMorph() (line 175)
├── buffers/paragraphBuffer.ts         ← ParagraphBuffer (line 53), lastBlockBoundary()
├── buffers/{buffer,bufferRegistry,offBuffer,wordBuffer}.ts
├── animations/{animation,animationRegistry,blockAnimations}.ts
└── media/chatIncrementalRendering.css
```
（`lastBlockBoundary` は `@internal Exported for testing.` と注記されています。）

⚠️ **vscode は MIT でないコードも vendor しているので**（`ThirdPartyNotices.txt` 179KB、
`cglicenses.json` 79KB）、**コピーする個別ファイルのヘッダを毎回確認する**こと。
リポジトリレベルの MIT を前提にしない。上記2つは確認済みで clean MIT です。

---

## 🛑 コピー禁止リスト（全件実ファイルで確認）

| | ライセンス | |
|---|---|---|
| **mhutchie/vscode-git-graph** | **改変MIT（非フリー）** | 供与句から `publish, distribute, sublicense, and/or sell` が**削除された上で明示的に再否定**: 「Permission is **NOT GRANTED** to publish, distribute, sublicense, and/or sell derivative works of the Software.」ローカルでの使用/複製/改変は可、**配布不可 = 実質読むだけ**。⚠️ デフォルトブランチは `master` でも `main` でもなく **`develop`** |
| **tldraw** | **プロプライエタリ「tldraw license」** | ⚠️ **v5 で、しかも 4.0 以降「透かし付きなら無料」ではなくなっていました。** commit `e455ab83` で `Use the Software in your commercial or non-commercial projects` が削除され `Use the Software in **Development Environments**` に、条件が `Not to use the Software in **Production Environments**` に変更。**本番利用は有料 License Key が必須。** ライセンスキー検証・環境検出・透かし表示の技術的強制と使用データ送信つき |
| **stagewise** | **AGPL-3.0-only** + Nucleo アイコンのプロプライエタリ carve-out | デュアルライセンスではない（`LICENSE-COMMERCIAL` は存在したことがない）。アイコンは**抽出・複製・再配布・他プロジェクトでの使用が禁止**。※ `packages/karton` 単体は MIT |
| **coder/mux** | **AGPL-3.0**（追加条項なしの標準本文） | 読むだけ |
| **git-up/GitUp** | **GPL-3.0** | 読むだけ。**最も関連する先行事例なのでこれが痛い**（[s0-verification.md](s0-verification.md)）。振る舞いを観察して自分で書き直す |
| **pvigier/gitamine** | **GPL-3.0** | 読むだけ |
| **tig** / **git-cola** | **GPL-2.0** | 読むだけ |

## ✅ 学習・移植して良いもの

| | ライセンス |
|---|---|
| **lazygit** | MIT（© 2018 Jesse Duffield、無改変の標準MIT） |
| **gitui** | MIT |
| **Gitless** | MIT |
| **clash** | MIT |
| **amux** | MIT |
| **opencode** | MIT |
| **git-branchless** | **`MIT OR Apache-2.0`** ⚠️ **GitHub のサイドバーは Apache-2.0 のみと誤表示。** 実際は member crate の `Cargo.toml` に `license = "MIT OR Apache-2.0"` があるので **MIT の枝を採れる** |

---

## デュアルライセンスの枝は EPL-2.0 を選ぶ（決定済み）

Theia は `EPL-2.0 **OR** GPL-2.0-only WITH Classpath-exception-2.0` の**選択式（disjunctive）**。
**EPL-2.0 の枝を選び GPL は無視します。**

**理由:** GPL-2.0+CPE の枝を行使すると、採用予定の Apache-2.0 依存
（remend, Playwright, ACP, pdfjs 等）が **Apache-2.0 / GPL-2.0 の特許条項非互換**に当たります。
**EPL-2.0 の枝なら MIT + Apache-2.0 + EPL-2.0 の組み合わせに問題はありません。**

## リポジトリに追加するファイル（Phase 1 の成果物）

| ファイル | 内容 |
|---|---|
| `LICENSE` | MIT（我々のコード） |
| `LICENSE-EPL` | EPL-2.0 本文（§3.2(b)） |
| `NOTICE.md` | Theia（SPDX + リポジトリURL + バージョン）、**コピーしたコードのエントリ**（Microsoft/vscode のバージョン毎、Theia private-test-setup）、Apache-2.0 依存の attribution（remend の LICENSE 本文を手写し）、Lumino BSD-3、その他 MIT 依存の一覧 |
| about ボックス | §3.1(a) の**ソース入手可能性の声明** + §3.3 の表示保持。theia-ide の `theia-extensions/product` がまさに about ダイアログを所有するために存在する |
| SPDX ヘッダ | 我々のソースファイルに `// SPDX-License-Identifier: MIT` |
| publish 時の LICENSE コピー | react 方式（各パッケージの tarball に LICENSE を入れる） |
| `license:check` CI | Eclipse **dash-licenses**（`@eclipse-dash/nodejs-wrapper`、Java 17 必要）。両上流が lockfile 変更時 + nightly で走らせている |

## 商標（製品名に直接効く）

Eclipse のロゴガイドライン逐語:
> 「You may not incorporate the name of an Eclipse Project Trademark into the name of
> your company or software product name.」

許容形式は **`<製品名> for Eclipse Theia`** または **`<製品名>, Eclipse Theia Edition`** のみ。
**`kjp-edit` 単体なら問題なし。** 「KJPTheia」「Theia KJP」は不可。
最初かつ最も目立つ言及は "Eclipse Theia"、以降は "Theia" に短縮可。

## 未確認

- **ECA が再配布者に適用されない**ことを**明言した文**は見つかりませんでした。
  contributor-only の一貫した文脈（両 CONTRIBUTING.md と eclipse.org/legal/eca/ が
  「Eclipse プロジェクトのリポジトリにコミットする人」にしか言及していない）と
  該当要件の不在からの推論です。**法務確認を推奨。**
- stagewise の配布デスクトップアプリのインストーラが AGPL 以外の EULA を追加しているか（バイナリ未検査）
- `squirreling` パッケージ — 見つけられませんでした。**実在するか、正しいパッケージ名は何か要確認**
  （`hyparquet` と `HighTable` は MIT 確認済みなので「全部MIT」は 2/3 しか検証できていない）
- `node-pty` の LICENSE 実文（npm は MIT、GitHub は "Other"）

## 出典

[EPL-2.0 本文](https://www.eclipse.org/org/documents/epl-2.0/EPL-2.0.txt) ·
[Apache-2.0 本文](https://www.apache.org/licenses/LICENSE-2.0.txt) ·
[Theia NOTICE.md](https://raw.githubusercontent.com/eclipse-theia/theia/master/NOTICE.md) ·
[Theia LICENSE-vscode.txt](https://raw.githubusercontent.com/eclipse-theia/theia/master/LICENSE-vscode.txt) ·
[theia-ide LICENSE](https://raw.githubusercontent.com/eclipse-theia/theia-ide/master/LICENSE) ·
[VSCodium LICENSE](https://raw.githubusercontent.com/VSCodium/vscodium/master/LICENSE) ·
[code-server ThirdPartyNotices.txt](https://raw.githubusercontent.com/coder/code-server/main/ThirdPartyNotices.txt) ·
[vscode ThirdPartyNotices.txt](https://raw.githubusercontent.com/microsoft/vscode/main/ThirdPartyNotices.txt) ·
[vscode scmHistory.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/scm/browser/scmHistory.ts) ·
[mhutchie LICENSE](https://raw.githubusercontent.com/mhutchie/vscode-git-graph/develop/LICENSE) ·
[tldraw LICENSE.md](https://raw.githubusercontent.com/tldraw/tldraw/main/LICENSE.md) ·
[git-branchless Cargo.toml](https://raw.githubusercontent.com/arxanas/git-branchless/master/git-branchless/Cargo.toml) ·
[Eclipse ロゴガイドライン](https://www.eclipse.org/legal/logo_guidelines.php)
