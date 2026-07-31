# 実現可能性調査

調査実施日: 2026-08-01。バージョン・活動状況はすべてこの時点の実測値。

## 結論

**実現可能。** しかも狙っている領域には明確な空白がある。

3つの判断:

1. **ベースは Eclipse Theia が第一候補**（ただし Phase 0 スパイクでの検証必須）。
   要件4つ（任意ウィジェットの再帰タイリング / アプリ内コミットグラフ /
   browser+electron のクライアント・サーバ分離 / OSS）を*同時に*満たす唯一の候補。
2. **アーキテクチャはヘッドレスデーモン + 対等なシンクライアント群。**
   「ローカルUI」と「リモートUI」を作るのではなく、**クライアントは1種類だけ**作り、
   ローカルUIをクライアント#1として扱う。CRDT は不要。
3. **最大の差別化要素はコミットグラフ中心の履歴編集UI。** ここは競合が1つもいない。

---

## 1. ベースアプリケーション比較

| | 任意ウィジェットの再帰タイリング | アプリ内コミットグラフ | browser クライアント・サーバ分離 | ライセンス |
|---|---|---|---|---|
| **Theia** | **○** Lumino DockPanel、任意ウィジェット | **○** 1.71 (2026-05) で上流実装 | **◎** 標準デプロイ形態 | EPL-2.0 OR GPL-2.0+CPE |
| code-server / Code-OSS | △ エディタグリッドのみ再帰、View は sidebar/panel 固定 | × 拡張機能のみ | ○ | MIT |
| Zed | **×** 拡張機能はUIを描画できない | △ ネイティブのみ・実装途上 | **×** ブラウザクライアント無し | GPL-3.0+ |
| 自作 Electron | ○ 自分で作る | × 自分で作る | ○ 自分で作る | 任意 |

### 却下した候補と理由

| | 理由 |
|---|---|
| **Zed** | **拡張機能が任意UIを描画できない**（確定）。WASM/Wasmtime サンドボックスで「GPUIの内部へのアクセスはゼロ — GPUコンテキスト・要素ツリー・ウィンドウハンドルのいずれも無い」、パネル生成も不可。メンテナ発言 (2026-05-21)「我々のチームが主導すべき大仕事で、近い将来に着手する見込みは無いがレーダーには入っている」。つまり欲しいパネルすべてがフォークレベルの変更になる。加えてブラウザクライアントが存在せず要件4と正面衝突 |
| **Void** | リポジトリ **archived**（最終push 2026-06-02、バイナリは2025年6月で停止）。Apache-2.0 で唯一の完全OSS な VS Code フォークだったが、単独メンテのフォークのコストを示す最も明確なデータ点 |
| **Positron** (Posit) | **Elastic-2.0 — OSSではない**。さらにホステッドサービスとしての第三者提供を明示的に禁止しており、リモートクライアント構想を直接殺す |
| **openvscode-server** | VS Code 1.109 相当で **3ヶ月間デフォルトブランチにコミット0**。実質休眠。明示的な非目標として「VS Code を一切変更しない意図」を掲げており、*変更したい*プロジェクトのベースには不適 |
| **Lapce** | デフォルトブランチ最終コミット 2026-04-03。ほぼ休眠。WASI プラグインでリッチUI APIなし |
| **Helix** | ターミナルTUI。GUIレイヤ自体が無い |
| **Onivim** | 2022-08 で死亡 |
| **Pulsar** (Atom後継) | 皮肉にもレイアウトモデルは最良（Atom のペインは任意アイテムの真の再帰分割）だが、2015年由来のコードベース、Electron 30、極小メンテチーム。概念的な参考にはなるがベースとしては高リスク |
| **GitButler** | **FSL-1.1-MIT — OSSではない**。「Permitted Purpose」が競合製品を除外。開発ツールを作るなら直接的な問題。エディタもターミナルも無い。Rust の git 内部実装とブランチUIの参考としては優秀 |

### Theia を推す理由

**レイアウト（最重要）:** `ApplicationShell` は Lumino `Widget` で、`BoxLayout` + `SplitLayout` に
`TheiaDockPanel`（Lumino `DockPanel` 継承）を main / bottom エリアで `'multiple-document'` モードで使う
→ 任意深度の縦横分割。決定的なのは **main エリアが「任意のウィジェット」を保持できる**点で、
VS Code の「View は sidebar/panel に固定」という制約が無い。ターミナル・Explorer・Output・
エディタタブを main / bottom / left / right 間で自由にドラッグできる。

- 既知の制約: **left/right サイドパネルは `'single-document'` モードで分割不可**（タブのみ）。
  ただし何でも main エリアに置けるのでブロッカーではない
- `@theia/secondary-window` で切り離しウィンドウ、`@theia/terminal-manager` で複数ターミナル管理

**コミットグラフ:** Theia **1.71 (2026-05)** で Source Control History Graph を追加。
「SCMビューコンテナ内に完全に描画されたコミットDAG」— ブランチのレーン線、
重複排除された ref バッジ、ページング可能なグラフモデル、線形/マージ/分岐/オクトパス/兄弟トポロジを
カバーするDAGレーン計算、VS Code互換 `SourceControlHistoryProvider` プラグインAPI。
同 1.71 で `@theia/git` は削除され、git は完全に VS Code 組み込み git 拡張が担う。

**browser / electron デュアルターゲット:** 単一モノレポで `"theia": { "target": "browser" }` と
`"electron"` の2つの薄いアプリパッケージだけが違う。browser ターゲットは
フロントエンドを HTTP で配信する Node バックエンド。**要件4がアーキテクチャの標準形**であり、
後付けではない。フロント/バックは WebSocket 上の JSON-RPC。

**拡張モデル — フォーク不要が本質的な優位:** Theia extension は**コンパイル時の npm パッケージ**で、
InversifyJS DI 経由でコア内部にフルアクセスできる。**コアサービスの rebind と
`ApplicationShell` / `TheiaDockPanel` のサブクラス化を含む。** つまり我々のカスタマイズは
他人の146,000コミットの歴史に対するパッチ列ではなく、**バージョン付きAPIに対する加算的なnpmモジュール**になる。
これが VS Code 系に対する最大の構造的優位。

**保守状況:** v1.74.0 (2026-07-31)、月次リリース、年間 ~80人から ~1,200 PR、Eclipse Foundation オープンガバナンス。
`packages/` に既に `ai-claude-code`, `ai-chat`, `ai-mcp`, `ai-terminal`, `terminal-manager`,
`secondary-window`, `collaboration`, `remote`, `dev-container`, `scm`, `navigator` がある。

**出発点:** `eclipse-theia/theia-blueprint` は **MIT** で、明示的に
「Eclipse Theia プラットフォームベースのデスクトップ製品を作るためのテンプレート」。
electron-app + browser-app + ブランディング拡張 + インストーラパッケージングを含む。

### Theia の正直なコスト

- **EPL-2.0 のファイル単位の弱いコピーレフト**: Theia 自身のファイルへの改変は EPL-2.0 で公開義務。
  別モジュールとしてリンクする分は自由。OSSにしたい方針なら実質的に無問題
- **商標**: Eclipse Foundation のポリシーにより製品名に「Theia」を含めてはいけない。
  許容形式は `<Product> for Eclipse Theia` / `<Product>, Eclipse Theia Edition`
- **Monaco がベンダリング**されている (`@theia/monaco-editor-core`、Theia 1.74 で 1.108.201 固定)
  → 常に素の VS Code より少し遅れる。**さらに重大: Monaco はモバイル/タッチを公式に非サポート**（後述）
- VS Code API互換は ~1.116（最先端ではない）
- DI 前提のアーキテクチャの学習曲線が急、~70パッケージの TypeScript ビルドが遅い
- エコシステム/コミュニティは VS Code より圧倒的に小さい
- **マルチクライアント同一セッションは標準では得られない**。2台目のブラウザは同じサーバ・
  同じファイルシステムに対して*独立した*ワークベンチセッションを得る。共有UI状態は無い
  （`@theia/collaboration` が最も近いプリミティブ）

### 第2候補: code-server

VS Code エコシステム完全互換がレイアウト自由度より重要なら。MIT、`lib/vscode` submodule は
`microsoft/vscode@3a03d6f` = **1.131.0** ピンで**現行 VS Code 同等**（2026-07-30 v4.131.0 リリース）。
27本の quilt パッチ列という**小さなフォークを持ち回る正しいモデル**（`quilt push` のコンフリクト解決で済み、
146kコミットのマージにならない）。

ただし:
- コミットグラフは **webview *editor*** として描くしかない（View ではなく）。
  `WebviewPanel` はエディタなので任意HTMLをグリッドセルに置ける。この抜け道で任意タイリングは
  「全部をエディタにする」ことで達成でき、「View システムを解放する」よりは安い
- ファイルツリーを任意タイルに置きたければ、それをエディタ入力として書き直すことになる
- 恒久的なリベース税。Cursor は上流マージが約2週間遅れで、内部フックに依存する拡張が時々壊れ、
  「灯りを維持する」ためだけの専任チームを持つ

### VS Code フォーク共通の落とし穴

`microsoft/vscode` は MIT で無制限（商用フォーク可）だが:

- **リネーム必須**。LICENSE.txt は商標権を付与しない。リポジトリ同梱の `product.json` は
  意図的に無印の `"nameShort": "Code - OSS"`。Microsoft のブランドバイナリは別EULA
- **マーケットプレイス使用不可**。ToU §3.a「Marketplace またはそこで提供されるサービスを、
  Microsoft が提供する Visual Studio Code を含む Visual Studio 製品ファミリー以外の
  いかなる製品を有効化または支援するためにも使用してはならない」→ **Open VSX** 必須
  （2026-03 に AWS が Open VSX のバッカーに）
- **ToSだけでなく技術的強制がある**。C/C++ 拡張 v1.24.5 (2025-04) 以降、
  **実行時のホスト同一性チェック**で公式 Microsoft ビルド外では起動を拒否する
- `product.json` の `webviewContentExternalBaseUrlTemplate` が `*.vscode-cdn.net` にハードコードされており、
  web ビルドでは差し替え必須

---

## 2. 部品の棚卸し

### レイアウト — 最重要かつ差別化の核

| ライブラリ | 版/日付 | ライセンス | サイズ(gz) | ネスト | タイル内タブ | ドラッグ分割 | ポップアウト | 直列化 | 最大化 |
|---|---|---|---|---|---|---|---|---|---|
| **dockview** | 7.0.4 / 2026-07-22 | **MIT** (要確認: `dockview-enterprise` は proprietary として除外) | 78 kB | ○ | ○ | ○ | ○ `addPopoutGroup` | `toJSON`/`fromJSON` | **○ 実APIあり** |
| flexlayout-react | 0.10.2 / 2026-07-29 | MIT | — | ○ | ○ | ○ | ○ (要注意点あり) | `toJson` | ○ |
| react-mosaic | 7.0.0 / 2026-07-13 | Apache-2.0 | — | ○ **v7でn分木化** | ○ **v7で第一級ノード型** | ○ | × | JSONツリー | △ |
| **Lumino** | 2.9.0 / 2026-07-25 | BSD-3-Clause | 50 kB | ○ | ○ | ○ | × | `saveLayout` | × |
| rc-dock | 3.x (4.0-alpha) | Apache-2.0 | — | ○ | ○ | ○ | ○ | ○ | ○ |
| golden-layout | **npm公開 2023-02** | MIT | 30 kB | ○ | ○ | ○ | ○ | ○ | △ |
| allotment | 1.20.5 | MIT | 9.6 kB | 手動合成のみ | × | × | × | サイズのみ | △ |
| react-resizable-panels | 4.12.2 | MIT | 11 kB | 手動合成のみ | × | × | × | `autoSaveId` | △ |

- **golden-layout は npm 最終公開が2023年2月。着手点にしてはいけない**
- allotment / react-resizable-panels はレイアウトマネージャではなく**スプリッタのプリミティブ**。
  ただし allotment は VS Code の splitview/sash 由来なのでリサイズの挙動は正しい
- Lumino は JupyterLab と Theia (1.60以降) のエンジン。任意ネストとタブは実戦検証済みだが、
  独自のレンダ/レイアウト/メッセージライフサイクルを持つ命令的ウィジェットフレームワークで、
  Reactタイルを全部 `Widget` でラップすることになる
- **2025-2026 の新顔は無い。** この分野の実質的なニュースは react-mosaic v7 (2026-07) の
  2分木→n分木・タブの第一級ノード化リライトで、これで react-mosaic は「おもちゃ」から
  真の候補に昇格した

### Zed のレイアウトが分かりづらい理由 — 根本原因

Zed は**ツリーが1つではない**。left/right/bottom の3つの **dock**（panel を保持）と、
中央の **pane group**（editor pane を保持）がある。**panel と pane は別種のもので別のルールに従う。**
この非対称性がすべての混乱の源。

`workspace::ToggleZoom` (既定 `shift-escape`) はアクティブ pane をウィンドウ全体に拡張し、
**同時に全 dock を隠す**。ユーザの言葉:「アクティブpaneをズームしてZedウィンドウ全体に広げるが、
その結果 dock (Project Panel, Agent Panel 等) も見えなくなる」。オール・オア・ナッシングで、
**ファイルツリーを残したままエディタをズームすることができない** (discussion #32715)。

実際に報告されている挙動:

| Issue | 症状 |
|---|---|
| #21776 | 分割でズーム状態が失われ、その後発振する。「ワークスペースが崩壊し、ターミナルに何か打つとまたズームがトグルする」 |
| #47207 | ズームで「余白が増え背後の要素が見える」。開いているファイル行がずれ、dock パネルの残像が隙間に現れる |
| #27237 | dock 内のターミナル pane をズームすると、アクティブなものだけでなく**分割された全ターミナル**が表示される |
| #9501 | 全画面展開したボトムパネルの背後の pane がドラッグ/リサイズ可能なまま → 見えないものをリサイズしてしまう |
| #59563 | agent panel とターミナルを同時にズームできない |
| #23334 | パネルに tmux 風のキーボードリサイズが一切無い |
| #52584 | ユーザの言う「パネルが変に縮む」の一般形。「複数パネルを開くと各パネルが非常に細くなり、フォーカスしても行が切れて全体が見えない」 |

**根本原因を平たく言うと: Zed のズームは「ツリーノードに対する可逆なジオメトリ交換」ではなく
「flexコンテナに対するモードトグル」である。** ズームフラグがツリーの外に住んでいるので、
構造変更（分割・クローズ・フォーカス移動）が必ずそれを非同期化する。そして dock が
pane ツリーの外にあるので、ズームは dock を丸ごと隠す以外にできない。
兄弟のサイズは構造変更ごとに再正規化される flex 比率なので、往復して戻らない。

**我々が採るべき設計ルール:**

1. **ズームは1ノードに対するビュー変換であり、兄弟の状態変更ではない。** レイアウトルートに
   `zoomedNodeId` を持ち、そのサブツリーのみを100%で描画し、**どこのサイズにも触らない**。
   ズーム解除は無変更のツリーを再描画するだけ
2. ズーム中の分割・クローズ・フォーカス移動は、ズームされたサブツリー内で作用するか、
   暗黙にズームを解除する。**両方はしない**
3. **すべてのパネルを同一ツリーに入れる。** dock/pane の非対称性を作らない。これが Zed の問題の核心
4. **i3 の「focus parent」(`$mod+a`) が必須。** ツリーを1階層上がって、次の分割/移動が
   葉ではなく*サブツリー*に作用するようにする。これが無いと「任意にネスト可能」は
   キーボードから使い物にならない。多くのWebレイアウトライブラリに欠けている概念
5. **tmux のズーム意味論を参照。** ズームは pane を自身の全ウィンドウビューに交換し、
   **直前のジオメトリを厳密に記憶**して解除時にバイト単位で復元する。リフローも比例圧縮もしない

参考にすべきモデル: **i3/sway**（すべてがコンテナ、コンテナは1ウィンドウか子コンテナ群を保持。
コンテナ毎のレイアウトモード `splith`/`splitv`/`stacking`/`tabbed`。全画面はコンテナ単位でレイアウト非依存）、
**Obsidian**（同じツリーのより単純な語彙: 親は `split` か `tabs`、葉はコンテンツ。
全体が `workspace.json` に直列化され変更毎に書き直される — 「レイアウト状態は継続的に永続化する
ただのJSONツリー」という良い先例）、**Zellij**（常時表示のキーバインドバー —
キーボード駆動タイリングUIで最も安価なUX改善）。

### エディタ

| | 版/日付 | ライセンス | サイズ | モバイル/タッチ | 大ファイル |
|---|---|---|---|---|---|
| **CodeMirror 6** | `@codemirror/state` 6.7.1 / 2026-07-05 | MIT | view単体 79 kB gz | **唯一の真の選択肢** — タッチ/IME/モバイルが設計要件 | 良好 (ropeドキュメント、遅延ビューポート) |
| monaco-editor | 0.56.0 / 2026-07-20 | MIT | 実アプリバンドル 2-5 MB | **公式に非サポート** | `maxTokenizationLineLength` 既定20,000字、数MBで苦しむ |

**Monaco のモバイル非対応はタブレット/スマホクライアントに対する硬いブロッカー。**
タッチ選択が動作しない (issues #1504, #1365, #4622)。GitLab の Web IDE が
デスクトップ専用なのは**まさに Monaco で作られているから** (GitLab #28217, #28738)。
長年オープンで、issue から discussion に変換された — 「やらない」の標準シグナル。

**マルチインスタンスのメモリ:** Monaco は実質シングルトン（グローバルなサービス/モデルレジストリを
全インスタンスが共有）。同一言語のN個には*有利*（1つのTSワーカーが全部を賄う）だが、
1ページに独立した2つの Monaco「世界」は作れず、インスタンス毎の破棄はリークしやすい。
CodeMirror 6 はグローバルを持たず、各 `EditorView` が自身の状態を所有 → N タイルのコストは
おおよそ N × (ドキュメント + ビューポートDOM) で小さく線形、破棄もクリーン。
**「任意のパネル型を複数並列」という要件には CM6 のモデルが正しい形。**

LSP: `monaco-languageclient` 10.7.0 (TypeFox, MIT, 活発) が完成度最高。
`codemirror-languageserver` 1.22.0 (BSD-3-Clause) は小さく綺麗だが薄い —
hover/completion/diagnostics/signature help は堅いが、rename・code actions・
semantic tokens のカバレッジは未確認で歴史的に弱い。**拡張する工数を明示的に見積もること。**

**ここに Theia とのテンションがある。** Theia は Monaco を前提としている。
モバイルセカンダリを本気で狙うなら、Theia ベースでは（少なくとも Theia の標準エディタでは）
実現できない。→ Phase 0 で判断（後述）。

### ターミナル

**`@xterm/xterm` 6.0.0** (2025-12-22, MIT)。健全で自明な選択。VS Code / JupyterLab / Tabby / Hyper が使用。

v6 の破壊的変更で刺されるもの:
- **canvas レンダラアドオンが削除**。DOM か WebGL のみ（`@xterm/addon-canvas` は 2024-07 で死亡）
- `windowsMode` と `fastScrollModifier` が `ITerminalOptions` から削除
- `overviewRulerWidth` が `overviewRuler` オブジェクト配下に移動
- alt→ctrl+arrow のキーボードハックが削除され、埋め込み側の責務に

v6 の新機能: **DEC mode 2026 同期出力**（TUIのちらつきに効く）、WebGLレンダラのShadow DOM対応、
`@xterm/addon-progress`、OSC 52 クリップボード、esbuild による ESM ビルド。
`@xterm/addon-webgl` 0.19.0 を使うこと（DOMレンダラは互換フォールバック）。

**PTY:** `node-pty` 1.1.0 (2026-07-16, Microsoft保守、VS Code が使うもの) が実戦検証済み。
コストは node-gyp、不完全な prebuild、Node/Electron ABI 毎のネイティブリビルド。
バックエンドが Rust なら `portable-pty` crate (wezterm由来、MIT) を直接。
Windows は **ConPTY のみ**サポートすべき (Win10 1809+)。winpty はレガシーでビルドから外す。

**VS Code のターミナル配線（そのまま真似る価値がある）:**
専用の **ptyHost ユーティリティプロセス**が全 pty を所有（クラッシュとCPUをレンダラから隔離、
ハートビート監視）。永続化は2つの別機構:
1. **プロセス再接続** — ウィンドウリロード時に生きている pty に再アタッチしバッファ復元
2. **プロセス復活** — アプリ再起動時に*直列化されたバッファ*を復元し、元の環境でプロセスを再起動

ただし**ドキュメントは明示している: 保存されるのはスクロールバックバッファのみで、
VS Code 終了時に走っていたプロセスは終了する。「プロセス永続性が必要なら tmux か screen を使え」。**
「VS Code の全ターミナルを tmux で包む」というブログ記事の一大産業がこのギャップのために存在する。

サーバ側マルチプレクサ: **ttyd** (C, MIT, 2026-06-30) がプロトコルの最良の参考。
**wetty** (TS/Node, MIT, 2026-07-31) が Node バックエンドへの drop-in に最も近い。
**sshx** (Rust, MIT) が「サーバ権威的な状態を持つマルチクライアント協調ターミナル」の
最良の設計参考（ただし1年 push 無しで静かになりつつある）。**dtach / abduco** は
デタッチ専用プリミティブで、「サーバ再起動をプロセスに生き残らせたい」なら最も単純で正しい答え。
**tmux/zellij を埋め込むのは避ける** — キーバインド名前空間とレンダリングを継承してしまい、
自前のタイリング層と喧嘩する。

### Git とコミットグラフ

**ライセンスが最大の論点。**

| | 状態 | ライセンス |
|---|---|---|
| **mhutchie/vscode-git-graph** | **最終push 2023-07-08 — 死亡** | **絶対に流用不可。** LICENSE 実文を確認: 改変MITで、逐語的に「publish, distribute, sublicense, and/or sell **derivative works** of the Software する許可は**与えられていない**」。GitHub の表示は "Other"。MITと書いている三次情報は**間違い** |
| hansu/vscode-git-graph (fork) | 活発 | 同じ制限的ライセンスを継承。同じブロッカー |
| gitgraph.js / `@gitgraph/js` | **リポジトリ archived** (2024-07) | MIT だが archived、かつ用途違い（手書きグラフを*描く*だけで実リポジトリのレイアウトはしない）。SVG/DOM で10万コミットは不可能 |
| **VS Code 組み込み Source Control Graph** | **1.93 (2024-09) で標準搭載**、活発に保守 | **MIT。小さく可読。ここが出発点** |
| mlange-42/git-graph (Rust) | v0.7.0 (2025-11) | MIT。ブランチモデル考慮の順序付け、`git2`/libgit2 ベース |
| GitLens | source-available | **非OSS。Commit Graph は明示的に有料 Pro 機能** |
| GitKraken / Sourcetree / Sublime Merge / Fork | proprietary | 流用不可 |

**VS Code のアルゴリズム（具体）:** `src/vs/workbench/contrib/scm/browser/scmHistory.ts` (MIT)。
`SWIMLANE_HEIGHT = 22`, `SWIMLANE_WIDTH = 11`。5色をテーマトークン
`scmGraph.foreground1`〜`5` (`#FFB000`, `#DC267F`, `#994F00`, `#40B0A6`, `#B66DFF`) として登録。

`toISCMHistoryItemViewModelArray()` は単一の前進パス:

```
inputSwimlanes  = deepClone(直前アイテムの outputSwimlanes)
// 第一親はこのコミット自身のレーンを継承する（レーン連続性）
for node of inputSwimlanes:
    if node.id === commit.id && !firstParentAdded:
        outputSwimlanes.push({ id: commit.parentIds[0], color: labelColor ?? node.color })
        firstParentAdded = true; continue
    outputSwimlanes.push(deepClone(node))
// 未処理の親を出力に追加
for i in (firstParentAdded ? 1 : 0) .. commit.parentIds.length:
    colorIdentifier ??= colorRegistry[colorIndex = rot(colorIndex+1, 5)]
    outputSwimlanes.push({ id: commit.parentIds[i], color: colorIdentifier })
```

描画は `renderSCMHistoryItemGraph()` が行毎に小さなSVGを1つ。

**正直な限界:** これは「曲がるブランチ」系。直線化パスもレーン圧縮も無い（レーンは
そのコミットに到達した時に落とすだけ）ので、密なマージ領域で線がうねる。色は5つだけ。
そして決定的に、**順序付けを一切しない** — `historyItems` が既に git の順序で来ることを前提にしている。
大きな履歴で詰まることが既知: issue **#227475**、「数千のコミットを持つ数千の変更」のリポジトリで
ソース管理パネルが無応答になる（報告者のワークスペースは22,031ファイル）。VS Code は履歴をチャンクでページングしている。

**レイアウトアルゴリズムを真面目にやる場合**、最良の文献は
**pvigier "Commit Graph Drawing Algorithms" (2019)**。3段階:

1. **順序付け（縦座標）** — 日付ソートは committer date の歪みや書き換えで壊れる（GitKraken の既知の失敗モード）。
   素のトポロジカルソートは正しいが**実行毎に非決定的**でグラフが目に見えて並び替わる。
   → **temporal topological sort**（彼の貢献）: 走査を「committer date の新しい順」で訪れる
   トポロジカルソート。妥当なトポ順序を与え、決定的で、タイムスタンプが正常なら日付順を保持、
   O(n log n + m)。**これを実装すべき**
2. **レーン割当（横座標）** — *straight branches*: コミット *c* を置く前に禁止インデックス集合 **J(c)**
   （*c* とその最下位マージ子の間で占有されているレーン）を計算する。彼は J(c) が
   **範囲ではなく単一行のチェックに還元される**ことを証明している。次に *c* を最初の空き非禁止レーンに置き、
   **既存レーンを一切シフトしない**（シフトが曲がりの原因）。大リポジトリでの実測: 事前計算 `J_i(c)` リスト維持 =
   **平均274ms**、インターバルツリー = **482ms**。リストの勝ち
3. **描画最適化** — 可視ビューポートのみ描く。可視行はスクロール位置を行高で整数除算して O(1)。
   可視**エッジ**は区間重複クエリとして扱い、インターバルツリーで O(k log m)。
   大リポジトリでの実測: 全ノード+エッジ **106ms** → 可視ノードのみ **26.8ms** →
   可視ノードとエッジ **0.580ms**。**180倍の改善で、10万コミットの成否はここで決まる**

参照実装 `pvigier/gitamine` は **GPL-3.0 かつ 2019-05 で停止**。
**アルゴリズムを読むだけにして、コードをベンダリングしないこと。**

**git 自身の `commit-graph` ファイル** (`.git/objects/info/commit-graph`、generation number付き) は
描画アルゴリズムではなく*走査アクセラレータ*だが、有効化 (`core.commitGraph`, `git commit-graph write`) は
10万コミット超の走査に対する単独最大の効果。

**バックエンドの git バインディング:**

| | 10万コミットグラフに対する評価 |
|---|---|
| **`git log` をシェルアウト** | **推奨。** `git log --topo-order --all -z --pretty=format:%H%x00%P%x00%an%x00%at%x00%s` をストリームして逐次パース。構成上正しく、commit-graph を含む git のあらゆる最適化を継承、ネイティブビルド不要、ABI地獄なし、走査完了前に最初の画面を描ける。コストは1クエリあたり5-30msのプロセス起動と自前パーサ |
| **gitoxide / `gix`** (Rust) | バックエンドが Rust/Tauri なら最良のインプロセス選択肢。並列オブジェクト走査、commit-graph 対応。push・完全マージ・rebase・hooks は未完成 |
| nodegit 0.27.0 | **出荷アプリでは回避。** Node/Electron のバージョン行列を横断する prebuilt バイナリの慢性的な失敗 |
| isomorphic-git 1.40.0 (MIT) | ブラウザ専用/仮想FSには優秀だがこの用途には不適。issue #446: `log` が3,000コミットで**1.2秒**（`simple-git` は0.2秒）。10万では非現実的 |

**10万コミットの描画:** 行を仮想化（固定22-24px → `rowIndex = scrollTop / rowHeight`）し、
可視行に存在するレーンのみ描く。**大きなSVGを1つ作ってはいけない** — 5万DOMノードで停止し、
SVGは数千要素を超えると劣化する。

- **(a) VS Code の形** — 行毎に小さなSVG、おおよそ 2N 個の path（N = アクティブレーン数、通常15未満）を
  仮想化リスト内に。単純、CSSテーマ対応、アクセシブル。可視行×レーンが数百に収まる限り十分
- **(b) ハイブリッド canvas** — グラフ列用に単一 canvas レイヤをスクロール同期し、
  テキスト列は仮想化DOMリスト。レーン数が増える or タブレットで滑らかな慣性スクロールが欲しいならこちら。
  同時プリミティブが数千を超えると canvas が決定的に勝つ。WebGL は鉄道図には過剰

### ファイルツリーとファイル監視

- **react-arborist** 3.16.0 (2026-07-25, MIT, 31.6 kB gz): `react-window` で仮想化、DnD、
  インラインリネーム、複数選択、キーボードナビ、ARIA。週30万DL。`react-dnd` + `redux` + `react-window` を引き込む
- react-complex-tree 2.6.2 (MIT, 16.9 kB, **依存ゼロ**): a11y は最強だが、
  レンダリングについて意図的に非意見的 = 仮想化は自前だった歴史。v2.6 で組み込み仮想化があるかは未確認
- ag-grid はツール違いかつライセンストラップ（ツリーデータのグルーピングは Enterprise 機能）

**監視:** **@parcel/watcher** 2.6.0 (MIT) — ネイティブC++で FSEvents / inotify /
ReadDirectoryChangesW / Watchman バックエンド。**VS Code が再帰監視に使っているもの。**
chokidar 5.0.0 (MIT) は純JS で導入が簡単だが、スケールするとツリーを歩いてディレクトリ毎に
ハンドルを持つ → **inotify watch 枯渇**と巨大ツリーでの遅いコールドスタート。

**VS Code の監視設計（丸ごと真似る価値あり）:**
- 監視は専用 **`UtilityProcess`** で走る（「ファイル監視は計算集約的だから」）
- **再帰には ParcelWatcher**（開いたワークスペースフォルダ）、**非再帰には `fs.watch`**（フォルダ外の個別ファイル）
- **重複排除**: 同一リクエスト（同resource/options/correlation ID/filters）は畳む。
  同correlationの重なる再帰リクエストは**最短パス**に畳む
- **除外**: `files.watcherExclude` を parcel の除外として自動注入
- **サスペンド/レジューム**: 監視パスが存在しない/削除された時サスペンドし、
  親の再帰ウォッチャ再利用か `fs.watchFile` の**5秒**ポーリングで再開
- **正直な注意点、Microsoft 自身の言**: 2024-09 時点で「parcel watcher の不安定性のため
  TS拡張の event correlation を再度無効化した」。つまり parcel-watcher は
  同時に最良の選択肢であり、Microsoft が出荷済み機能を無効化するほど不安定でもある。
  フォールバック経路と防御的なイベント合体を計画に入れること

イベントは**ツリーのパッチ**に合体させること（全体リフレッシュを起こさない）。
この1つの決定が、モノレポで応答性を保つファイルツリーとそうでないものを分ける。

---

## 3. 先行事例とギャップ分析

### ローカルオーケストレータ

| ツール | ライセンス | エディタ | 隔離 | 差分レビュー | グラフ | 状態 |
|---|---|---|---|---|---|---|
| **Conductor** | **クローズド** | 無し | worktree/task | ○ インラインコメント→GitHub同期、PR/merge/archive | × | 活発。**macOS Apple Silicon専用**。$22M Series A |
| **Crystal** (stravu) | MIT | 無し | worktree | 限定的 | × | **2026-02 廃止** → Nimbalyst |
| **Nimbalyst** (stravu) | **MIT** (2026-04-30に転換) | **○ Monaco** + markdown WYSIWYG, mermaid, Excalidraw, CSV | worktree | ○ 赤緑差分、編集+注釈+反復 | △「git log視覚拡張」 | 活発。macOS/Win/Linux + **iOS/Android コンパニオン**（スワイプ承認、push通知）、**ghostty** 内蔵 |
| **Vibe Kanban** (BloopAI) | Apache-2.0 | 無し (Open in VS Code) | worktree/workspace | ○ 差分+インラインコメント→エージェント | × | **Bloop 廃業 (2026-04-10)**。現在コミュニティ保守、完全ローカル化へ移行中 |
| **Sculptor** (Imbue) | **MIT** 全ソース公開 | 無し | **Dockerコンテナ/エージェント** | ○ マージ前レビュー、GitHub PR | × | 活発、「実験的リサーチプレビュー」 |
| **mux** (Coder) | **AGPL-3.0** | レビューUI、vim入力、markdown/mermaid/LaTeX | ローカルdir / worktree / **SSHリモート** | ○ コードレビューUI | △「git divergence UI」 | 活発。**デスクトップ*と*ブラウザ両方** ← 要件4の直接的先例 |
| **claude-squad** | AGPL-3.0 | 無し (TUI) | **tmux + worktree** | ○ preview/diffタブ | × | 活発 |
| **ccmanager** | MIT | 無し (TUI) | worktree | × | × | 活発。8エージェント、エージェント毎の状態検出 |
| **uzi** | MIT | 無し (CLI) | tmux + worktree、大量エージェント | `+n/-n` の数だけ | × | 活発 |
| **container-use** (Dagger) | OSS | 無し | **コンテナ/エージェント** | gitブランチ経由 | × | 初期開発 |
| **Sketch** (boldsoftware) | Apache-2.0 | ブラウザchat UI | Dockerコンテナ | ○ 視覚差分、行コメント→chat | × | **2026-07-22 archived** → Shelley (exe.dev) |
| **Omnara** | Apache-2.0 | 無し | — | — | × | CLIラッパ版**廃止**（「保守が不可能になった」）。新版は Claude Agent SDK 上 |
| **opencode** (Anomaly) | **MIT** | TUI | — | — | × | ~16万star。**サーバ+クライアント構成、OpenAPI 3.1、SSE — デーモンのOSS参考実装として最良** |
| **Crush** (Charm) | FSL-1.1-MIT | TUI | — | — | × | 活発 |

### この表で最も重要なシグナル: 大規模な淘汰

約8ヶ月で: **Crystal 廃止** (2026-02)、**Terragon 停止** (2026-01)、
**Bloop/Vibe Kanban 廃業** (2026-04 —「大多数が無料ユーザで、我々が興奮できるビジネスモデルを
見つけられなかった」)、**Sketch archived** (2026-07)、**Omnara の CLIラッパ方式が
保守不能として放棄**。一方で Conductor は $22M 調達し、Cursor / Anthropic / Google が
このカテゴリを自社製品に吸収した。

**2つの教訓:**
1. **CLI の TUI を薄く包むのは保守の死の罠。** SDK/プロトコルの上に作れ、ターミナルをスクレイプするな
   （Omnara が Agent SDK に書き直したのは文字通りこの理由）
2. **単独のオーケストレーションはビジネスにならない。** 作るなら真にOSS/ローカルファーストか、
   CLIベンダが出荷しないもので差別化するかのどちらか

### ギャップ

| | 内容 |
|---|---|
| **G1** ★最重要 | **本物のコミットグラフと履歴編集面が誰も持っていない。** 表の全ツールは*前進方向*の git（エージェント毎ブランチ、差分、コミット、PR）しかやらない。**コミットグラフ中心の履歴操作UI**（interactive rebase、並べ替え、squash、コミット分割、過去へのfixup、worktree間cherry-pick、reflog救出）は**1つも無い**。最も近い mux の「git divergence UI」と Nimbalyst の「git log視覚拡張」はいずれも Sublime Merge / GitUp 級のグラフではない。エージェントは**大量に形の悪い履歴を生む**（「fix tests」40コミットを人間が3つのレビュー可能なコミットに整形しないと誰もマージしない）ので、ここは急所 |
| **G2** | **オーケストレータかエディタのどちらかで、両方は無い。しかもエディタが弱い。** Conductor / Vibe Kanban / claude-squad / ccmanager / uzi / container-use は全部「Open in VS Code」に投げる。本物のエディタを積んでいるのは Nimbalyst (Monaco) と Async だけ。今日のワークフローは「オーケストレータで発注 → *外部*エディタで理解 → オーケストレータでレビュー」で、このコンテキストスイッチが実際の日常的苦痛 |
| **G3** | **同一ローカルセッションのマルチデバイスが未解決。** モバイル対応は全て*レビュー専用かチャット専用*。Nimbalyst のコンパニオンは差分スワイプ+返信、Omnara はコントロールプレーン、Claude Code Remote Control はエージェント操縦のみでエディタ・ターミナル・git は無い。**「同じ開いているファイル、同じターミナル、同じgit状態を、スマホから」を提供しているものは無い。** デスクトップとブラウザ両クライアントを持つのは **mux のみ (AGPL-3.0)** |
| **G4** | **レビューがエージェント単位でクロスエージェントでない。** 5エージェントがそれぞれブランチを出したとき、興味のある問いは比較的なもの（どの2つが同じファイルを触った? マージでどれが衝突する? マージ順序は?）。mux がここを示唆する程度で、他は差分を1つずつ見せるだけ |
| **G5** | **プロトコル経由でエージェント非依存なものが無い。** マルチエージェント対応は普遍的に N個の場当たり的CLIラッパとして実装されている（ccmanager は文字通り8種類の「独自の状態検出戦略」を持つ）。**ACP がまさにこの作業を殺すために存在するのに、ほとんどのオーケストレータがまだ使っていない** |

---

## 4. エージェント統合の接続点

### Claude Agent SDK

「Claude Code をライブラリとして」。同じエージェントループとコンテキスト管理。
**Python と TypeScript のみ** — 他言語は CLI をサブプロセスで `-p` / `--output-format json`。

機能: 組み込みツール、**hooks**（ライフサイクル時点でのカスタムコード）、**subagents**、**MCP**、
**permissions**（どのツールが自動実行でどれが承認要 — **これが我々の承認UIの接続点**）、
**sessions**（コンテキスト継続、**resume または fork** — デーモンのセッション永続化に直接対応）、
skills/slash-commands/memory を `.claude/` と `~/.claude/` から自動ロード。

**製品を形作る2つの制約:**

1. **「事前承認がない限り、Anthropic はサードパーティ開発者が自社製品に claude.ai ログインや
   レートリミットを提供することを許可しない。Claude Agent SDK 上に構築されたエージェントを含む。
   API キー認証を使用せよ。」**
   → ここに緊張がある。Conductor / Crystal / Sculptor は「自分の Claude サブスクを持ち込め」を
   売りにしているが、それは**SDKを埋め込まずユーザ自身の `claude` CLI をシェルアウトすることで**達成している。
   **SDKを埋め込むならAPIキー前提になる。** これは脚注ではなく実質的な製品判断
2. **ブランディング**: 「Claude Agent」/「Claude」/「{製品名} Powered by Claude」は可。
   **「Claude Code」「Claude Code Agent」は不可**、Claude Code を模したASCII/ビジュアルも不可

### Claude Code の既存IDE接続点（非公式）

公式 VS Code / JetBrains 拡張の仕組み: *エディタ側*がランダムポート (10000-65535) で
**WebSocketサーバ**を立て、Claude Code が **MCP over WebSocket** で接続してくる。
発見は `~/.claude/ide/<port>.lock` のロックファイル（0700ディレクトリ内 0600）経由で、
PID・ワークスペースフォルダ・IDE名・**毎回新しいランダム認証トークン**を含み、CLIは
`X-Claude-Code-Ide-Authorization` として提示する。ループバック専用なので素の `ws://`。
最も良く文書化されているのは `coder/claudecode.nvim/PROTOCOL.md`。
**非公式・非バージョン管理。使えるが基盤にはしないこと。**

### ACP (Agent Client Protocol) — 推奨する接続点

`agentclientprotocol.com`、**Apache-2.0**、~3.8k star、~1,935コミット。

- Zed が2025-08に作成。**現在は Zed と JetBrains の共同ガバナンス** — リード保守者は
  Ben Brandt (Zed) と Sergey Ignatov (JetBrains) が拒否権付き「BDFL」で、
  **独立財団への移行計画を明言した暫定ガバナンスモデル**とラベルされている。
  `zed-industries` org から中立の `agentclientprotocol` org へ移動。
  **公開 ACP Agent Registry を JetBrains と共同ローンチ (2026-01-28)**
- **トランスポート: stdio 上の JSON-RPC** が SHOULD ベースライン（クライアントがエージェントを
  サブプロセスとして起動）。**Streamable HTTP はドラフト提案で議論中。** WebSocket 無し。
  **マルチクライアント・セッション共有・ネットワークリモートの意味論は一切規定されていない**
- 安定版は **1**、**v2 はドラフト**。移行文書は「v2 が安定するまで明示的なバージョンネゴシエーションと
  機能フラグの背後に置け」と明言
- **v2 の重要な変更**: `session/prompt` が*確認応答*になり、ターン完了は `state_update` 通知
  (`running`/`idle`/`requires_action`) で届く。**クライアント側ファイルシステム
  (`fs/read_text_file`, `fs/write_text_file`) とクライアント側ターミナル実行
  (`terminal/create` 等) が削除**され、**エージェント所有の表示専用ターミナル**（スナップショット+追記チャンク）に。
  `session/load` → **`session/resume` with replay**。**git-patch レンダリング可能な構造化差分**。
  メッセージ/tool-call/plan の upsert・patch 意味論。全チャンクに `messageId` 必須
- **採用は現実に広い。** クライアント: Zed (native)、**JetBrains (AI Assistant native, 2025-12以降)**、
  Neovim (CodeCompanion, agentic.nvim, avante.nvim)、Emacs、**VS Code (3拡張)**、Obsidian、
  Qt Creator、Pulsar、Unity、marimo/Jupyter、~27のデスクトップ/Webアプリ、4モバイルクライアント、
  9フレームワーク (LangChain, LlamaIndex, Mastra)。
  エージェント (native): **Claude Agent, Codex CLI, Cursor, Gemini CLI, GitHub Copilot, Cline,
  OpenCode, OpenHands, Goose, Junie, Kiro CLI, Kimi CLI, Qwen Code, Factory Droid, Augment,
  Docker cagent, Poolside, Mistral Vibe** ほか約15

**AG-UI** (CopilotKit) はエージェント↔フロントエンド層。**汎用のchat/生成UI**で、
ワークスペース・差分・ファイル編集・ターミナルの概念を持たない → **コードエディタには層が違う**。
（名前衝突注意: IBM Research にも無関係な agent-to-agent の「ACP」がある）

**判断: ACP をエージェントプラグイン境界として使う。** 理由: Apache-2.0 で2ベンダガバナンス+財団志向、
プリミティブが唯一*コーディングIDEの形*をしている（tool call、permission request、
**git-patchレンダリング可能な構造化差分**、ターミナル、replay付きsession resume）、
約35エージェントが既にネイティブ対応、そしてG5を直接解消する（ccmanagerの8種類の
状態検出戦略ではなくクライアントを1つ書く）。MCP は直交（我々のIDE機能を*エージェントに*公開する側）で、
両方やるべき。

**構造的な注意点:** **ACP は stdio サブプロセス志向で、マルチクライアント/リモート/再接続の
ストーリーを持たない。** よって層構造は:

```
ACP (stdio)   :  kjp-core デーモン ⟷ エージェントサブプロセス   ← worktree毎、1:1
自前プロトコル :  kjp-core デーモン ⟷ N クライアント (desktop + PWA) ← マルチクライアント、WS
```

デーモンが **ACPクライアント**であり**ファンアウト点**。
**ACP自体をマルチクライアントトランスポートにしようとしないこと** — 設計されていないし仕様と喧嘩する。
ただし ACP v2 の `session/resume`-with-replay と `state_update` モデルは
*我々自身の*クライアントプロトコルの再接続意味論の良いテンプレート。**設計を盗み、プロトコルを引き伸ばすな。**

**ACP v1 を今ターゲットし、v2 は機能フラグ化**（移行文書が明示的にそう助言）。
v2 がクライアント側 fs/terminal を削除してエージェント所有ターミナルにしたのは
誰が何を所有するかの大きな再構成だが、**偶然にも我々のサーバ権威デーモンとよく整合する**。

---

## 5. リモートアーキテクチャの調査結果

### code-server / openvscode-server の確定した制約 (公式FAQ)

| 問題 | 詳細 |
|---|---|
| **キーバインド** | 「多くのショートカットは既定で動作しない、ブラウザに『捕まる』ため」。緩和策: **PWAとしてインストール**（ブラウザクロームが消えアクセラレータの大半を取り戻す）、または再マップ |
| **クリップボード** | ブラウザのクリップボードAPIは権限ゲート。Firefox は歴史的に統合ターミナルへの貼り付け不可 |
| **Webview は secure context 必須** | Webview は `/vscode-resource` を傍受する **service worker** を使う。service worker は secure context 必須 → **HTTPS か `localhost`/`127.0.0.1` のみ**。素のIP+HTTPでは全webviewが壊れる。自己署名証明書は長い失敗の尾を引く |
| **認証** | パスワード認証のみ（レート制限 2/分, 12/時）。外部認証はリバースプロキシ必須 |

→ **webview的なサンドボックスiframeを使うならHTTPSは交渉不可。初日からTLSを計画すること**
（Tailscale と Caddy はどちらも無料でこれをくれる）。
**そしてセカンダリはブラウザタブではなくインストール可能なPWAとして出荷すること** —
キーバインド衝突に対する単独で最も効果の高い対策。

### VS Code Remote Tunnels — 使えない

- ホストは**送信方向のみ**の接続を作る（「VS Code はネットワークリスナを一切設定しない」）ので
  ファイアウォール変更不要、二重NAT問題が消える。これは**リレー**でP2P/STUNホールパンチではない
- 認証は両端で*同じ*GitHub/Microsoftアカウント。サードパーティ向けのトークン/OIDC面は無い
- **暗号化/トンネルクライアントのコードは公開** (`microsoft/dev-tunnels`) だが、
  **リレーサービスはプロプライエタリなAzureインフラでOSS等価物が無い**。さらに悪いことに
  **VS Code Server バイナリ自体がプロプライエタリ**で、ライセンスは VS Code Server を
  サービスとしてホストすること・スタンドアロン提供することを明示的に禁じている
  (`microsoft/vscode` #226222, `coder/code-server` #6256)

→ **Microsoftのトンネルリレーもサーババイナリも、我々の製品の基盤にできない（法的に）。**

### VS Code のプロセス分割（形は真似る価値がある、ワイヤフォーマットは不可）

- **main** (Electron): ライフサイクル、ウィンドウ、IPCハブ
- **renderer** (ウィンドウ毎): Workbench UI + Monaco。web/serverモードではブラウザタブ
- **extension host** (ウィンドウ毎): 全拡張。**双方向RPC**（renderer側 `MainThread*` アクタ、
  extension側 `ExtHost*` アクタ）。リモートモードではローカル ext host（UI拡張）と
  リモート ext host（ワークスペース拡張）に分裂
- **shared process**: Node有効の隠しウィンドウ。サンドボックス化移行以降、
  **ファイル監視と統合ターミナルのpty hostがsharedプロセスの子になった**。
  ウィンドウは MessagePort でそれらのサービスを取得
- **pty host**: 全PTYを所有する別プロセス — ターミナルがウィンドウリロードを生き残る理由

**サーバプロトコルは文書化されておらず再利用可能でもない。** 公開仕様は無く、内部実装詳細として
自由に変わり、バージョン一致が強制される。MITソースで*読める*が出荷サーバはプロプライエタリ。
**再利用すべきは*形*（pty hostを別プロセスに、RPCアクタ、権威的バックエンド1つ）でワイヤフォーマットではない。**

### 他の先行事例

**JetBrains Gateway:** Gateway はローカルの*ランチャ*で、フルIDEはリモートホストで
**バックエンド**としてヘッドレスに走り、Gateway がそのバックエンド専用の
**JetBrains Client** シンクライアントを起動。**RD protocol**（Rider の out-of-process モデル由来）で
タイピングがローカルに感じられる — つまりピクセルストリーミングではなく、
**ローカル描画付きの構造化モデル差分プロトコル**。
**Projector**（Swing over the wire = 真のリモート描画）は**スタンドアロン製品として廃止**され Gateway に吸収。
**これは意味のあるデータ点: JetBrainsはピクセル/ウィジェットストリーミングを試して、
構造化プロトコル+ネイティブ寄りクライアントに退却した。**

**Jupyter Server + JupyterLab:** 「サーバが状態を所有する」最もクリーンな先例。かつ CRDT を*追加*した。
JupyterLab 4 以降 `jupyter-collaboration` がドキュメントを **Yjs** `YDoc` にする。
**注意深く読むべき点: ここではサーバがファイルに対して権威的で、それでもCRDTを使っている —
だが理由は同一バッファの*同時マルチユーザ編集*が欲しかったからだけ。** WebSocketサーバは
ルーム管理と転送をやり、衝突解決はしない。

**Zed:** ローカル Zed はUIのみ、`remote_server` バイナリを SSH で `~/.zed_server` に配置。
言語サーバ・タスク・ターミナルは全部リモート。バージョン厳密一致。切断後は
**走っているデーモンに再接続**する。`Project`, `LspStore`, `GitStore`, `Worktree` が
1つのインタフェース背後に *Local* と *Remote* の変種を持つ二重モード設計。
トランスポートは独自バイナリプロトコル（**protobuf over WebSocket**）、バッファは **CRDT** で、
リモート開発とコラボがそのインフラを共有。1リモートプロジェクトへのマルチクライアントは
文書化されたZedのユースケースではない（それはcollab/channelsの役割）。

### マルチクライアント: (a)ストリーミング / (b)サーバ権威 / (c)CRDT

**結論: (b) サーバ権威が正しい。** 正直な根拠:

**(a) シンクライアントストリーミング** — ピクセルストリーミング (VNC/RDP/Projector) は
完全な忠実度と再実装ゼロを与えるが: モバイルで最悪（リフロー無し、固定ビューポート）、
帯域が重い、ネイティブなテキスト選択/クリップボード/IMEが無い、デバイス毎レイアウトが無い。
**JetBrains はこの道を放棄した。** → **純粋なピクセルストリーミングは却下。**

**(b) サーバ権威 + 複数ビュー** — プライマリ機上のデーモンがファイルシステム、gitリポジトリ/worktree、
PTY、エージェントプロセス、LSPセッション、そして*エディタドキュメントモデル*を所有。
クライアントは状態を購読しインテントを送る。**なぜこれが我々の要件に特に正しいか:**

1. **ファイルシステムは物理的に1つしかない。** セカンダリはファイルを保持しない。
   したがって権威の問題はハードウェアが既に答えている — 調停するものが無い
2. **エージェントはプライマリでローカル権限で走らねばならない。** その出力は本質的に
   サーバ側イベントストリーム。どのアーキテクチャでも全クライアントは*そのストリームの視聴者*
3. **git 状態は本質的にシングルライタ。** 2クライアントが同じworktreeを同時にrebaseするのは
   マージすべき事象ではなく防ぐべきバグ
4. **セカンダリは明示的に速度より利便性を優先する。** レイテンシを既に譲歩しているので、
   クライアント側複製の主要な論拠が消える
5. 先例が圧倒的: Jupyter, opencode, Theia, code-server, JetBrains Gateway, Vibe Kanban, mux, Nimbalyst

**(c) CRDT** — Yjs (MIT, 週~92万DL, 最大のバインディングエコシステム)、
Loro (MIT, Rust+Wasm, 2026ベンチマークで多くの項目最速)、Automerge (MIT, Git風変更履歴)。

**正直な評価: CRDT は不要。** 権威的サーバが1つあるとき CRDT が買うのは正確に3つ:
- **セカンダリでのオフライン編集** — 切断中にスマホで編集したいなら実価値。だがオフラインでは
  ビルドも実行もできないエージェント開発IDEでは価値が低い。これは*機能選択*でアーキテクチャ上の必然ではない
- **往復レイテンシ無しのローカルエコー** — 150-300ms のリンクでは唯一の実在する懸念。
  だが CRDT 無しで解ける: 古典的なクライアント側予測+サーバ調停（ゲームがみなやること）、
  またはバッファ毎のシングルライタリース。**注記: Zed が CRDT をリモート開発に使うのは
  リモート開発がCRDTを必要とするからではなく、`Buffer` 型が既にコラボ用のCRDTだったから** — 無料の再利用
- **同一バッファの真の同時マルチユーザ編集** — 要件は「同じ*ユーザ*が逐次的に」であって、これではない

→ **サーバ権威。** リモートのタイピングレイテンシが実際に鬱陶しければ
**バッファ毎のクライアント側予測+サーバ調停**（バージョン付き編集 + 却下時rebase）を追加。
Yjs に手を伸ばすのは真のマルチユーザコラボを後で追加するときだけ。
**CRDTを基盤にしてはいけない** — git・ターミナル・エージェントプロセスのどれにも合わないデータモデルを
全サブシステムに強制することになる。

### NAT越えと露出

| | ライセンス/セルフホスト | モデル | 評価 |
|---|---|---|---|
| **Tailscale** | クライアント **BSD-3** / **コントロールプレーンはクローズド** | WireGuardメッシュ、NAT越え、**DERP**リレーがフォールバック | `tailscale serve` = tailnetに公開、**自動HTTPS + 安定ホスト名 + 開放ポートゼロ**。TLSとNATと認証を一手で解決。**既定の推奨** |
| Tailscale Funnel | 同上 | TSリレー経由でインターネット公開 | ポート443/8443/10000のみ。**ほぼ確実に使いたくない** — Funnel は公開してしまう |
| **Headscale** | **BSD-3**, Go | Tailscale コーディネーションサーバのOSS再実装 | 公式TSクライアントを自前URLに向ける。SaaS依存を拒否する場合の逃げ道 |
| Cloudflare Tunnel | `cloudflared` OSS / **コントロールプレーンはCFのみ** | CFエッジへの送信のみコネクタ | 無料TLS + Cloudflare Access (OIDC/SSO)。難点: ソースコードとターミナルのトラフィックがCFのTLS終端エッジを通る |
| Pangolin | セルフホスト可 | VPS + `Newt` コネクタ (送信WireGuard) | セルフホスト可能なCF Tunnel相当、ID/アクセス制御と自動SSL付き |
| zrok / OpenZiti | **Apache-2.0**, Go | セルフホスト可能な共有オーバーレイ | 真に end-to-end セルフホスト可能 |
| frp / rathole / sish / chisel | OSS (frp Apache-2.0) | VPS上に自分でリレーを立てる | **これらが dev-tunnels リレーのOSS等価物。** frp はP2Pモードあり、rathole はfrp互換設定でより高性能 |
| ngrok | サービスはプロプライエタリ | リレー | 開発には良いが製品には不適 |

索引: `github.com/anderspitman/awesome-tunneling`

### セキュリティ — 2回読むこと

**我々が提案しているのは、SSH鍵・クラウド認証情報・ソースコードを持つマシン上の、
無制限のシェルとファイルシステムアクセスを持つエージェント + ターミナルを公開すること。**
これは設計上リモートコード実行エンドポイントである。認証バイパス1つで開発者マシンの完全な侵害。

交渉不可の項目:

1. **`0.0.0.0` にバインドしない。** デーモンは `127.0.0.1` のみ。リモート到達はすべて
   ループバックで終端するトンネル/オーバーレイ経由。これで「うっかりLAN/インターネットに出ていた」が
   構造的に不可能になる
2. **既定はアプリ層ではなくネットワーク層の認可。** Tailscale ACL / WireGuard ピアID なら
   未認証パケットは届かない。アプリ認証は唯一の防衛線ではなく多層防御になる
3. **アプリ認証は静的トークンではなく forward-auth プロキシ経由の OIDC。**
   `oauth2-proxy` (OSS) か Cloudflare Access。静的ベアラトークンはシェル履歴・QRコード・
   スクリーンショット・ブラウザ履歴に漏れ、期限が来ない。v0でトークンを出すなら:
   短命・デバイス束縛・失効可能・1回だけ表示。IdP で 2FA 必須にする
4. **常時TLS** — service worker/webview が secure context を要求するため、
   かつターミナルのキーストロークを送るため
5. **ターミナルとエージェント承認の面を別々にゲートする。** ケイパビリティモデルを検討:
   リモートクライアントはエージェント出力を*見る*ことと*承認/拒否*はできるが、
   「任意シェルを起動」はリモートセッションから withhold できる別の権限にする。
   Anthropic が Claude Code Remote Control で選んだパターンがこれ（モバイルから承認/操縦、
   認証情報は短命かつ目的別）
6. **レート制限とロックアウト。** code-server の 2/分・12/時 は*床*であり模範ではない
7. **リモート起因のコマンドを全て監査ログに**

### セッション永続性 — これがアーキテクチャ全体を決める

**ターミナルとエージェントはデスクトップアプリの終了を生き残るべきか? → はい。**

- **VS Code**: pty host でプロセス再接続はウィンドウリロードを生き残る。だが
  **ドキュメントは明示: スクロールバックバッファのみ保存され、VS Code終了時に走っていたプロセスは終了する。
  「プロセス永続性が必要なら tmux か screen を使え」**
- **Codespaces**: 未コミットの変更は stop/start を生き残るが、走っているプロセスは生き残らない
- **Zed remote**: `remote_server` は**デーモンとして**走る。「クライアントはデーモンが走っていなければ起動し、
  走っていれば再接続する。これで接続が落ちて復帰したとき中断なく作業を続けられる」
- **tmux/zellij/abduco/dtach**: 正典的モデル — **サーバプロセス**がセッションを保持し、
  クライアントは使い捨て、接続喪失はクライアントのみを殺す
- **opencode**: `opencode` は TUI *と*サーバを起動し、「TUIはサーバと話すクライアント」。
  **HTTP + SSE** に **`/doc` の OpenAPI 3.1 仕様**、`/global/event` のグローバルイベントストリームと
  `/event` のセッションストリーム（最初のイベントは `server.connected`）、同期
  (`/session/:id/message`) と非同期 (`/session/:id/prompt_async`) のプロンプトエンドポイント。
  夜間にエージェントを走らせるためヘッドレス運用されている。
  **これがエージェント領域における「デーモン+アタッチ可能クライアント」モデルそのもので、MITである**

**「ヘッドレスIDEデーモン」の先行事例:** Theia のバックエンド、Jupyter Server、
JetBrains ヘッドレスバックエンドIDE、openvscode-server、Zed の `remote_server`、
opencode のサーバモード、Vibe Kanban のローカル Rust/axum サーバ。
**パターンは十分に実証されている。ただし誰もこれを*ローカルファーストなエージェント開発IDE*の
デーモンとしてパッケージしていない。**

---

## 6. 未検証・要確認の項目

実装前に自分で確認すべきもの:

| 項目 | 理由 |
|---|---|
| **Theia Electron + 共有バックエンドで2台目デバイス** | 文書化されていないトポロジ。Electron ターゲットは自身のバックエンドをエフェメラルな localhost ポートで起動し、それを2台目に公開するのは文書化された経路ではない。**クリーンな設計は「browser バックエンドをプライマリプロセスとして走らせ、Electronアプリと2台目のブラウザの両方をそのクライアントにする」だが、この正確なトポロジを是認する公式文書は見つからなかった。→ Phase 0 スパイク必須** |
| **Theia SCM History Graph の品質と性能** | 機能が出荷されていることと何を主張しているかはリリースノートで確認したが、**実際に動かしていない**。5万コミットのリポジトリでレーンが受容可能に描画されるか要検証 |
| `theia-blueprint` とAI機能 | READMEは「AI機能を含まない」と言うが、Theia IDE *製品*は 2026-05 リリースで Theia AI/Coder を出荷している。READMEが古い可能性。実際の `electron-app/package.json` の依存を確認せよ |
| EPL-2.0 の正確な義務 | 「弱いファイル単位コピーレフト、クローズド製品はOK、Theiaファイルへの改変は公開義務」は標準的な解釈で法的助言ではない |
| dockview の `LICENCE.md` | GitHub は `NOASSERTION` を報告する（`dockview-enterprise` の切り出しのため）。OSSパッケージは明確にMITだが、法務確認前に自分でファイルを読むこと |
| node-pty の正確なライセンス文 | GitHub は "Other"、npm は MIT を報告 |
| Zed `crates/collab` のライセンス | `crates/collab/LICENSE-GPL` の存在と**リポジトリ全体に `LICENSE-AGPL` が存在しない**ことを確認済み（コード検索0件）。よく繰り返される「AGPLのcollabサーバ」は2026年時点で**古い情報**の可能性。法務が気にするなら git 履歴で確認 |
| GitLens のライセンス文 | Commit Graph が有料Pro機能であることは確認済み。ライセンス実文は未確認 |
| react-mosaic v7 のキーボードショートカット | v6 は Blueprint hotkeys で持っていた。v7 README は言及なし |
| `codemirror-languageserver` の rename / code actions / semantic tokens | カバレッジ未確認。歴史的に弱い |
| react-complex-tree 2.6 の組み込み仮想化 | 有無が未確認 |
| zellij の公開ライブラリ/サーバAPI | クライアント/サーバは unix socket 上だが内部IPCで、公開ライブラリAPIがあるかは未確認。**埋め込みを計画に入れないこと** |
| gitoxide の「C git より速い」主張 | プロジェクト文書と三次情報のみ。独立ベンチマークではない |
| Conductor の正確なライセンス条項とWindowsロードマップ | マーケティングページと二次レビューからの推測 |
| Nimbalyst「git log視覚拡張」/ mux「git divergence UI」の実体 | READMEの文言は確認したが何を描画するかは未確認。**G1の空白が本当に空白かの判定に直結するので実際に触って確認すべき** |
| ACP v2 のリリース日 | どこにも記載が見つからない。移行文書はドラフトのままと言っている |

---

## 出典

**ベースアプリ**
[microsoft/vscode LICENSE](https://github.com/microsoft/vscode/blob/main/LICENSE.txt) ·
[VS Code license page](https://code.visualstudio.com/license) ·
[VS Code custom layout](https://code.visualstudio.com/docs/configure/custom-layout) ·
[VS Code Views UX guidelines](https://code.visualstudio.com/api/ux-guidelines/views) ·
[code-server](https://github.com/coder/code-server) ·
[code-server FAQ](https://coder.com/docs/code-server/FAQ) ·
[openvscode-server](https://github.com/gitpod-io/openvscode-server) ·
[VSCodium](https://github.com/VSCodium/vscodium) ·
[Marketplace ToU §3.a](https://gist.github.com/anxkhn/9ae7b2248999168b73f303dec5851460) ·
[C/C++拡張がフォークでブロック (The Register)](https://www.theregister.com/2025/04/24/microsoft_vs_code_subtracts_cc_extension/) ·
[AWSがOpen VSXを支援 (The Register)](https://www.theregister.com/2026/03/03/open_vsx_aws/) ·
[VS Code forks landscape 2026 H1](https://www.vgtc.io/insights/vs-code-forks-ide-landscape-2026-h1) ·
[eclipse-theia/theia](https://github.com/eclipse-theia/theia) ·
[theia-blueprint](https://github.com/eclipse-theia/theia-blueprint) ·
[Theia 1.71 release notes](https://eclipsesource.com/blogs/2026/05/21/eclipse-theia-1-71-release-news-and-noteworthy/) ·
[Theia community release 2026-05](https://eclipsesource.com/blogs/2026/06/19/the-eclipse-theia-community-release-2026-05/) ·
[Theia ApplicationShell](https://deepwiki.com/eclipse-theia/theia/3.1-application-shell-and-layout) ·
[Theia flexible window layout](https://www.typefox.io/blog/flexible-window-layout-in-theia-ide/) ·
[Theia architecture](https://theia-ide.org/docs/architecture/) ·
[Theia composing applications](https://theia-ide.org/docs/composing_applications/) ·
[Eclipse trademark policy](https://www.eclipse.org/legal/logo-guidelines/) ·
[Zed RFC: Visual Extension API](https://github.com/zed-industries/zed/discussions/53403) ·
[Zed extensions custom UI](https://github.com/zed-industries/extensions/issues/1288) ·
[Zed git docs](https://zed.dev/docs/git) ·
[Zed git graph PR #50288](https://github.com/zed-industries/zed/pull/50288) ·
[Zed remote development](https://zed.dev/docs/remote-development) ·
[Positron licensing](https://positron.posit.co/licensing.html) ·
[GitButler](https://github.com/gitbutlerapp/gitbutler) ·
[Tauri Linux graphics issues](https://v2.tauri.app/develop/debug/linux-graphics/)

**レイアウト**
[dockview](https://github.com/mathuo/dockview) ·
[dockview LICENCE.md](https://github.com/mathuo/dockview/blob/master/LICENCE.md) ·
[dockview API](https://dockview.dev/docs/api/dockview/overview) ·
[FlexLayout](https://github.com/caplin/FlexLayout) ·
[rc-dock](https://github.com/ticlo/rc-dock) ·
[react-mosaic](https://github.com/nomcopter/react-mosaic) ·
[react-mosaic v7.0.0](https://github.com/nomcopter/react-mosaic/releases/tag/v7.0.0) ·
[Lumino](https://github.com/jupyterlab/lumino) ·
[golden-layout](https://github.com/golden-layout/golden-layout) ·
[allotment](https://github.com/johnwalley/allotment) ·
[react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) ·
[i3 tree model](https://i3wm.org/docs/userguide.html#_tree) ·
[Obsidian workspace model](https://marcusolsson.github.io/obsidian-plugin-docs/user-interface/workspace) ·
[Zed new panel system](https://zed.dev/blog/new-panel-system) ·
Zed issues: [#32715](https://github.com/zed-industries/zed/discussions/32715) ·
[#21776](https://github.com/zed-industries/zed/issues/21776) ·
[#47207](https://github.com/zed-industries/zed/issues/47207) ·
[#27237](https://github.com/zed-industries/zed/issues/27237) ·
[#9501](https://github.com/zed-industries/zed/issues/9501) ·
[#59563](https://github.com/zed-industries/zed/issues/59563) ·
[#23334](https://github.com/zed-industries/zed/issues/23334) ·
[#52584](https://github.com/zed-industries/zed/discussions/52584)

**エディタ・ターミナル・ツリー**
[Monaco mobile #1504](https://github.com/microsoft/monaco-editor/issues/1504) ·
[Monaco touch selection #4622](https://github.com/microsoft/monaco-editor/issues/4622) ·
[GitLab #28738 desktop-only Web IDE](https://gitlab.com/gitlab-org/gitlab/-/issues/28738) ·
[monaco-languageclient](https://github.com/TypeFox/monaco-languageclient) ·
[codemirror-languageserver](https://github.com/FurqanSoftware/codemirror-languageserver) ·
[Lezer guide](https://lezer.codemirror.net/docs/guide/) ·
[Sourcegraph: Monaco→CodeMirror移行](https://sourcegraph.com/blog/migrating-monaco-codemirror) ·
[xterm.js](https://github.com/xtermjs/xterm.js) ·
[xterm.js 6.0.0 release](https://github.com/xtermjs/xterm.js/releases/latest) ·
[node-pty](https://github.com/microsoft/node-pty) ·
[portable-pty](https://docs.rs/portable-pty) ·
[VS Code terminal advanced](https://code.visualstudio.com/docs/terminal/advanced) ·
[VS Code #117265 pty host](https://github.com/microsoft/vscode/issues/117265) ·
[ttyd](https://github.com/tsl0922/ttyd) ·
[wetty](https://github.com/butlerx/wetty) ·
[sshx](https://github.com/ekzhang/sshx) ·
[react-arborist](https://github.com/brimdata/react-arborist) ·
[react-complex-tree](https://github.com/lukasbach/react-complex-tree) ·
[VS Code File Watcher Internals](https://github.com/microsoft/vscode/wiki/File-Watcher-Internals) ·
[@parcel/watcher](https://github.com/parcel-bundler/watcher)

**Git グラフ**
[Commit Graph Drawing Algorithms (pvigier)](https://pvigier.github.io/2019/05/06/commit-graph-drawing-algorithms.html) ·
[gitamine](https://github.com/pvigier/gitamine) ·
[VS Code scmHistory.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/scm/browser/scmHistory.ts) ·
[VS Code #227475 graph perf](https://github.com/microsoft/vscode/issues/227475) ·
[mhutchie/vscode-git-graph LICENSE](https://raw.githubusercontent.com/mhutchie/vscode-git-graph/develop/LICENSE) ·
[gitgraph.js (archived)](https://github.com/nicoespeon/gitgraph.js) ·
[mlange-42/git-graph](https://crates.io/crates/git-graph) ·
[gitoxide](https://github.com/GitoxideLabs/gitoxide) ·
[isomorphic-git #446](https://github.com/isomorphic-git/isomorphic-git/issues/446) ·
[git commit-graph docs](https://git-scm.com/docs/commit-graph)

**リモートアーキテクチャ**
[VS Code Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels) ·
[microsoft/dev-tunnels](https://github.com/microsoft/dev-tunnels) ·
[VS Code Server license #226222](https://github.com/microsoft/vscode/issues/226222) ·
[code-server vs VS Code Server licensing #6256](https://github.com/coder/code-server/discussions/6256) ·
[Migrating VS Code to Process Sandboxing](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox) ·
[Webviews on the web (Matt Bierner)](https://blog.mattbierner.com/vscode-webview-web-learnings/) ·
[Codespaces deep dive](https://docs.github.com/en/enterprise-cloud@latest/codespaces/getting-started/deep-dive) ·
[A Deep Dive Into JetBrains Gateway](https://blog.jetbrains.com/blog/2021/12/03/dive-into-jetbrains-gateway/) ·
[Projector lives on in Gateway](https://lp.jetbrains.com/projector/) ·
[JupyterLab RTC](https://jupyterlab.readthedocs.io/en/stable/user/rtc.html) ·
[jupyter-collaboration architecture](https://jupyterlab-realtime-collaboration.readthedocs.io/en/latest/developer/architecture.html) ·
[Zed collaboration & remote dev architecture](https://deepwiki.com/zed-industries/zed/5-collaboration-and-remote-development) ·
[Yjs vs Automerge vs Loro 2026](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026) ·
[awesome-tunneling](https://github.com/anderspitman/awesome-tunneling) ·
[Tailscale serve](https://tailscale.com/docs/reference/tailscale-cli/serve) ·
[oauth2-proxy](https://github.com/oauth2-proxy/oauth2-proxy) ·
[Coder security best practices](https://coder.com/docs/tutorials/best-practices/security-best-practices) ·
[opencode server docs](https://opencode.ai/docs/server/)

**エージェント先行事例とプロトコル**
[Conductor](https://www.conductor.build/docs) ·
[stravu/crystal](https://github.com/stravu/crystal) ·
[Nimbalyst](https://github.com/Nimbalyst/nimbalyst) ·
[BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) ·
[Vibe Kanban shutdown](https://www.vibekanban.com/blog/shutdown) ·
[imbue-ai/sculptor](https://github.com/imbue-ai/sculptor) ·
[coder/mux](https://github.com/coder/mux) ·
[smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) ·
[kbwo/ccmanager](https://github.com/kbwo/ccmanager) ·
[devflowinc/uzi](https://github.com/devflowinc/uzi) ·
[omnara-ai/omnara](https://github.com/omnara-ai/omnara) ·
[dagger/container-use](https://github.com/dagger/container-use) ·
[boldsoftware/sketch (archived)](https://github.com/boldsoftware/sketch) ·
[terragon-labs/terragon-oss](https://github.com/terragon-labs/terragon-oss) ·
[awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators) ·
[Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) ·
[claudecode.nvim PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md) ·
[ACP introduction](https://agentclientprotocol.com/overview/introduction) ·
[ACP clients](https://agentclientprotocol.com/get-started/clients.md) ·
[ACP agents](https://agentclientprotocol.com/get-started/agents.md) ·
[ACP transports](https://agentclientprotocol.com/protocol/v1/transports.md) ·
[ACP v2 migration](https://agentclientprotocol.com/protocol/v2/migration.md) ·
[ACP governance](https://agentclientprotocol.com/community/governance.md) ·
[ACP repo](https://github.com/agentclientprotocol/agent-client-protocol) ·
[ACP brings JetBrains on board](https://zed.dev/blog/jetbrains-on-acp) ·
[AG-UI agentic protocols](https://docs.ag-ui.com/agentic-protocols)
