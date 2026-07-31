# ビューアパネル設計（埋め込みブラウザ / リッチMarkdown）

## 結論

**A. 埋め込みブラウザ: iframe を既定にする。`WebContentsView` はタイル単位のオプトインな昇格にとどめる。**
理由は D3（単一コンテナツリー）と正面衝突するから。詳細は下記。

**B. リッチMarkdown: Streamdown (Apache-2.0) を採る。** 自作しない。
ただし**Mermaid の描画場所（クライアント or デーモン）はパネルを書く前に決める** — これが最大のリスク。

**C. 意外に安い勝ち筋が2つ見つかった:**
- Vibe Kanban の「devtools内蔵ブラウザ」の実体は **Eruda (MIT) + CSS 3サイズ**だけ。CDPではない
- CSV + Parquet + SQL が **hyparquet + HighTable + squirreling（全部MIT）で合計 ~50KB gz**

---

## A. 埋め込みブラウザパネル

### A1. Electron の4つの選択肢

| | DOM内 | タイルにクリップされるか | DOM要素とのz-index | デバイスエミュレーション | スクショ | X-Frame-Options/CSP |
|---|---|---|---|---|---|---|
| `<iframe>` | ○ | **○ 完全に** | ○ 通常通り | CSSボックスのみ | クロスオリジンは× | **ブロックされる**（後述の回避策あり） |
| `<webview>` | ○（カスタム要素） | ○ | ほぼ○ | ○ | ○ | されない |
| `BrowserView` | **×** | **×** | **常に最前面** | ○ | ○ | されない |
| `WebContentsView` | **×** | **×** | **常に最前面** | ○ | ○ | されない |

**`WebContentsView` が現行APIで確定。** `BrowserView` は Electron 30 以降 deprecated で、
ドキュメントが明示的に `WebContentsView` を指している。DOM には無く、
`win.contentView.addChildView(view)` でアタッチして `view.setBounds({x,y,width,height})` で配置する。
`setAutoResize()` は無くなったので `resize` を聞いて自分で再計算する。
z順は `addChildView` を再呼び出しして最前面に持ってくる以外に制御手段が無い。

**`<webview>` は形式的には deprecated ではないが、Electron が積極的に「使うな」と言っている。**
ドキュメントの警告文:

> 「Electron の `webview` タグは Chromium の `webview` に基づいており、それは劇的な
> アーキテクチャ変更の途上にある。これは `webviews` の安定性に影響する
> （描画・ナビゲーション・イベントルーティングを含む）」…
> 「現在、`webview` タグは**使わないことを推奨**し、`iframe`、`WebContentsView`、
> あるいは埋め込みコンテンツを避けるアーキテクチャなどの代替を検討することを推奨する」

Electron 5 以降は既定で無効（`webPreferences.webviewTag: true` が必要）。

### A2. ⚠️ オーバーレイ問題が設計の急所

**これが `WebContentsView` を既定にできない理由。** Electron でフルのブラウザを作ったチームの報告が最も具体的:

> 「BrowserView は他のすべての上に座る。つまりレンダラプロセスでWebアプリとして動いている
> UI全体がその背後に埋められてしまう。」

彼らが実際に払ったコスト — **すべて我々のタイリングツリーに直接当てはまる:**

- z-index の仕組みが無いので `setTopBrowserView()` を呼ぶことになり、
  「複数レイヤを管理するとき厄介」
- **ドロップダウン・モーダル・ツールチップが Web コンテンツの上に描画できず、
  UI要素ごとに別の BrowserView を作ることになった**
- 「何かが変わるたびに座標を手動更新するのはすぐに悪夢になる」→
  **Facebook Yoga を導入して main プロセスで bounds を計算した** =
  DOM のレイアウトを影で追うレイアウトエンジンを main プロセスに再実装した
- 「新しいウィンドウを開くときのパフォーマンスが明らかに遅かった」→
  空のウィンドウを事前に温めて即座に見えるようにした

`WebContentsView` はこれを全部継承する（同じアーキテクチャで配管が良くなっただけ）。
出荷された部分的な緩和は `View.setBorderRadius()` のみで、角別の半径はまだ open。
**任意のスクロール祖先に `WebContentsView` をクリップするAPIは存在しない。**
Electron #15899（BrowserView の z-ordering サポート）が「HTML要素をビューの上に置きたい」という
長年の要望。

**我々のアーキテクチャはこの痛みを最大化する。** ドラッグ分割・タブのドラッグ並べ替え・
コマンドパレット・コンテキストメニューを持つ再帰的リサイズ可能タイリングツリーは、
「他のすべての上に座る」OSレベルビューにとってまさに最悪のケース。

### A3. iframe の唯一の弱点は Electron 側で消せる

```js
session.fromPartition('persist:preview').webRequest.onHeadersReceived((d, cb) => {
  const h = d.responseHeaders;
  delete h['x-frame-options']; delete h['X-Frame-Options'];
  // CSP からは frame-ancestors だけを外科的に除去する
  cb({ responseHeaders: h });
});
```

これで「iframe に入れられないサイトがある」という `WebContentsView` を選ぶ最大の理由が消える。

**ただし専用の preview パーティションでのみ行い、アプリ全体では絶対にやらない** —
クリックジャッキング防御を無効化しているので。

### A4. Theia の既存資産

- **`@theia/mini-browser` が本物の Lumino ウィジェットとして存在する。**
  つまりオーバーレイ問題ゼロで Theia のレイアウトに正しくタイルされる。**iframe ベース。**
  意図的にサブドメインからコンテンツを配信する: 既定のホストパターンは
  `{{uuid}}.mini-browser.{{hostname}}`（`THEIA_MINI_BROWSER_HOST_PATTERN` で上書き可）。
  変更するとフロント/バック両方が "Potentially Insecure Host Pattern" 警告を出す。
  **⚠️ 公開されたアドバイザリがある: プレビューされたHTMLファイルがRCEを引き起こしうる。**
  オリジン分離の設計は任意ではなく必須。
- **`@theia/preview` は deprecated で npm に公開されていない。**
  Theia自身が「VS Code 組み込みの Markdown 拡張を使え」と言っている。
  そして**Theia の markdown preview では Mermaid が描画されない**（theia#14654）。
- Theia の VS Code webview は別オリジン（`{{uuid}}.webview.{{hostname}}`）の**入れ子iframe**で、
  service worker が `/vscode-resource` を傍受する。Theia は Electron の `<webview>` タグを使っていない。
  **⚠️ theia#16275: `allow-same-origin` + `allow-scripts` のサンドボックス組み合わせにより
  *browser* アプリでは webview コンテンツがブロックされる。「このセキュリティ問題は Electron では起きない」。
  この非対称性は我々の2クライアント設計を刺す。**
- VS Code の **Simple Browser**（`ms-vscode.simple-browser`）は iframe を包む webview。
  Theia の shipped builtin-extension セットに入っているかは**未確認**。
  制約は iframe そのままで、X-Frame-Options/CSP でブロックされ、devtools が無く、
  VS Code 内では親ページの制限的CSPが入れ子iframeに継承され「上書きする既知の方法が無い」。

### A5. Vibe Kanban の「devtools付きブラウザ」の実体

**CDP を使っていない。** ドキュメントに明記されている:

> 「DevTools は **Eruda**（モバイルフレンドリーなデバッグコンソール）で動いている」…
> 「DevTools はプレビュー iframe の内側で走るので、アプリケーションが見ているものを正確に反映する」

パネルは Console / Elements / Network / Resources / Sources / Info。
**Eruda は MIT**（`liriliri/eruda`, v3.4.3）。
そして「デバイスエミュレーション」はエミュレーションではなく **CSS** —
フル幅デスクトップ、**390×844** の電話フレーム、プレビュー端をドラッグするレスポンシブモード。
（Vibe Kanban 自体は Apache-2.0、Rust バックエンド + Web フロントで npx 配布。Electron/Tauri ではない。）

**つまり全体が「iframe + Eruda + CSS 3サイズ」。** 驚くほど安い勝ち筋で、v1 はこれを真似るべき。

本物の devtools と本物のエミュレーションが欲しくなったときの Electron ネイティブ経路:
- `webContents.openDevTools()` — ただし切り離しウィンドウでタイルにならない
- `webContents.setDevToolsWebContents(otherWebContents)` — DevTools フロントエンドを
  2つ目の `WebContentsView` にホストする。**「DevTools をタイルにする」唯一の方法。
  ⚠️ 現行 Electron にこのAPIが残っているか未確認 — DevTools タイル案はこれに依存している**
- `webContents.enableDeviceEmulation({screenSize, deviceScaleFactor, viewSize, ...})` —
  本物の DPR/ビューポート/タッチのエミュレーション。**CSSリサイズでは絶対にできない。
  これが `WebContentsView` を iframe より選ぶ最強の論拠**
- 生CDPなら `chrome-remote-interface` (MIT)。Electron は
  `webContents.debugger.attach()` + `sendCommand()` でソケット無しCDPも提供する

**「Electronアプリにdevtools付きブラウザを埋め込む」ターンキーなOSSライブラリは存在しない。**
Google の `devtools-frontend`（BSD-3）を直接埋め込むのは可能だが重く、バージョンスキュー問題を自分で持つ。

### A6. 要素ピッカー → エージェントへのフィードバック

エージェント開発では極めて価値の高いワークフロー
（プレビューの要素をクリックして、そのセレクタ/スクショ/文脈をエージェントに送る）。

| プロジェクト | ライセンス | 仕組み |
|---|---|---|
| **Vibe Kanban** | Apache-2.0 | iframe内のクロスヘア inspect モード。ホバーでハイライト、クリックで選択、コンポーネント詳細をチャットの文脈に送る。「React, Vue, Svelte, Astro, 素のHTMLで自動的に動作、インストールするパッケージ無し」 |
| **stagewise** | **AGPLv3** | アプリに注入されるツールバー、**shadow DOM** コンテナに描画、フレームワーク毎の core+adapters。VS Code拡張と **HTTP+WebSocket の SRPC**（スキーマ検証付きRPC）で会話し、拡張の `triggerAgentPrompt` がペイロードをプロンプトに変換 |
| **Onlook** | Apache-2.0 | Figma風の直接操作。ただし React+Next+Tailwind 限定で Babel/AST に深く結合 |
| **click-to-component** | MIT（LICENSE実文は未取得） | Option+Click でソースを開く。`@babel/plugin-transform-react-jsx-source` の `__source`（`fileName`, `lineNumber`, `columnNumber`）を使う。本番ではツリーシェイクされる |
| **browser-tools-mcp** | MIT | Chrome拡張 ↔ **WebSocket** ↔ Node middleware ↔ MCPサーバ。全データがローカルに留まる |
| Chrome DevTools MCP / Playwright MCP | Apache-2.0（未確認） | 観測（CDP: console, network, traces, スクショ, a11y監査）vs 操作（アクセシビリティツリー標的、決定的な ref） |

**判断: 自作する。コンポーネントを採用しない。**

1. **stagewise は AGPLv3。** 最も drop-in に近いが、**IDE 全体を AGPL に強制する。**
   ベンダ自身が「AGPLv3 の許す範囲外のユースケースは連絡を」と書いており、デュアルライセンス商売。回避する
2. ピッカー自体は本当に小さい — オーバーレイの iframe/shadow-DOM スクリプトが
   `elementFromPoint`、computed styles、`outerHTML`、安定したセレクタ、
   必要なら React の `__source` / `__reactFiber$*` を読むだけ。**300行程度**
3. 価値があって非自明な部分は*ペイロード形式とエージェントへの受け渡し*で、そこはどうせ自前

**技術は借りる:** `__source`（click-to-component、MIT）、shadow-DOM 分離（stagewise の*考え方*だけ、
コードは読まない）、Eruda（MIT）。

### A7. 人間とエージェントで1つのブラウザを共有する — 差別化要素

先行事例はあるがプロプライエタリ。**Cursor が最も近い** —
「エージェントが Chrome DevTools Protocol を使って Chromium ブラウザを開き制御できる
組み込みブラウザMCPツール。Cursorのタブ内に埋め込むか別ウィンドウとして」。
加えて「Browser Layout and Style Editor」= 要素選択とCSS編集をエージェントとコードベースに
配線した webview を「design-mode DevTools」と称している。Cursor 3.5 (2026-05) はこれをクラウドエージェントに拡張。

技術的には既に踏み固められている: `playwright.chromium.connectOverCDP(wsUrl)` で
既存の Chromium にアタッチしデフォルトコンテキストを共有すると
「AIエージェントはあなたが見るのと全く同じものを見る — 全部のクッキー、全部のログイン済みセッション」。
複数エージェントが1つのブラウザのタブを駆動できる。

**我々のアーキテクチャでは真の差別化要素で、これをやっているOSSプロジェクトは見つからなかった。**
デーモンがブラウザを所有し（`WebContentsView` か `--remote-debugging-port` 付きヘッドレスChromium）、
人間のプレビュータイルが1つのターゲット、エージェントのMCPツールが同じブラウザの別ターゲットを駆動する。

**見返り:** エージェントが人間のログイン済みセッションを継承する（**これが大きい** —
「エージェントが認証壁を越えられない」問題が消える）、エージェントが取ったconsole/networkが
人間が見ているのと同じもの、プロセスが2つではなく1つ。

**2つの危険:**
1. 人間とエージェントが同じタブを取り合うのは最悪のUX → **エージェントには専用ターゲットを与え、
   人間が「adopt」してアタッチする形にする**
2. 人間のクッキージャーをエージェントと共有するのは**プロンプトインジェクションの増幅器。**
   共有セッションモードはプロジェクト単位の明示的オプトインにする

### A8. モバイルからの localhost プレビュー

**Omnara の仕組みは公開されていない。** 確認できたのは、マシン上のヘッドレスデーモンが
リレーに**送信方向のWebSocket**で繋いでエージェント↔クライアントを橋渡しし
「公開ポートもSSHも無し」、モバイルアプリが「Live Localhost Previews — 開発サーバを
スマホでプレビュー、SSHトンネル不要」を謳っていること。同じWebSocket上のHTTPと読むのが自然だが**未確認**。

**OSSでの方法、そして我々の設計にぴったり合う:** デーモンは既にモバイルクライアントへの
認証済みチャネルを持っている。**その上に HTTP リバースプロキシをトンネルする** —
method/URL/headers/body を多重化フレームに直列化し、chunked レスポンスをストリームで返す。

**⚠️ 難所は開発サーバ自身の WebSocket（Vite/Next の HMR）。**
トンネルの中に入れ子の `Upgrade` をトンネルしないと、**プレビューが黙ってホットリロードしなくなる。**
ここは必ず見落とされる部分なので工数を見ておく。

自作したくなければ **frp** (Apache-2.0)、**chisel** (MIT)、**bore** (MIT)、
**OpenZiti** (Apache-2.0) がセルフホスト可能な選択肢。
（Tailscale **Funnel はまだ beta**。）

### ⚠️ A8 のセキュリティ — 製品中で最も危険な機能として扱う

- **localhost の開発サーバは設計上未認証**で、本気で敵対的な攻撃面を持つ
  （Vite の `/@fs` 任意ファイル読み取り、ソースマップ露出、dev専用ミドルウェア）。
  **それをリモート到達可能なサービスに変えようとしている**
- 必須要件: **ポート単位の明示的オプトイン**（listening な全ポートを自動公開しない）、
  短命でスコープ付きのトークン、**プロキシしたアプリを別オリジンから配信する**
  （IDEのクッキー/localStorageに触れないように）。
  **これがまさに Theia が `{{uuid}}.mini-browser.{{hostname}}` を使っている理由で、
  Theia の mini-browser の RCE アドバイザリがそれを怠ったときに何が起きるかの教訓**
- デーモン自身の制御APIを同じプロキシ経路に絶対に通さない。`Host` を書き換え/除去する。既定は deny

### → A の推奨

**v1（数ヶ月ではなく数週間）:**
1. 通常の Theia `ReactWidget` 内の **`<iframe>`**。タイリングツリーの中で
   クリップ・スクロール・リサイズ・スタッキングが**何の努力もなく正しく**動く。
   そして決定的に、**同一のコンポーネントがモバイルWebクライアントでも動く。**
   この対称性は `WebContentsView` の単一機能より価値がある
2. Electron では専用の `persist:preview` パーティションで `onHeadersReceived` により
   `X-Frame-Options` と CSP `frame-ancestors` を除去
3. **Eruda (MIT)** をプレビュー対象ページに注入して devtools パネルにする。
   開発サーバのミドルウェア / プロキシのHTML書き換えで注入すればどのフレームワークでも動く
4. デバイス「エミュレーション」はCSS: desktop / 390×844 電話フレーム / ドラッグ可能レスポンシブ。
   Vibe Kanban を真似る
5. 自前の要素ピッカー: shadow-DOM オーバーレイ、`elementFromPoint`、
   `{selector, outerHTML, computedStyles, boundingRect, screenshotDataURL, __source?}` を
   エージェントの文脈へ
6. **プレビューは別オリジン/サブドメインから配信する。Theia 方式。交渉不可**

**v2（タイル単位のオプトイン「Advanced browser」）** — 本物の `enableDeviceEmulation`、
`setDevToolsWebContents` による本物のChrome DevToolsタイル、クロスオリジンの `capturePage`、
エージェント用CDPが必要になったとき: `WebContentsView` + レイアウトツリー駆動のbounds同期層。
**ハードルール: スプリッタドラッグ中・タブドラッグ中・オーバーレイ（コマンドパレット/
コンテキストメニュー/モーダル）が開いている間は `view.setVisible(false)` にする。**
DOM をその上に合成することは永遠に諦める。

**v3:** 人間とエージェントの共有ブラウザ（A7）。差別化要素だが v1 の機能ではない。

**やらない:** `devtools-frontend` の自前埋め込み、マルチタブのブラウザクローム。

### 🚩 A の最大の技術リスク

**ネイティブオーバーレイとレイアウトの不整合は根本的に解決不可能で、我々のアーキテクチャが
その痛みを最大化する。** 上に引用したチームは結局ドロップダウン毎に別の BrowserView を作り、
main プロセスに Yoga でレイアウトを再実装した。**それがコストであり、直せるバグではない。**

**緩和は戦術ではなくアーキテクチャで行う: iframe を既定の描画経路にしてタイリングツリーが
常にDOM的に正しい状態を保ち、`WebContentsView` はタイル単位の能力アップグレードとして
劣化した操作ルールとともに扱う。** 逆に `WebContentsView` を先に基盤にすると、
main プロセスでの Yoga 再発明に数ヶ月使い、しかもモバイルクライアント用に
2つ目の実装が必要になる。

---

## B. リッチMarkdown + 図

### B1. パイプラインの選択 — ストリーミングが決める

| | ライセンス | 保守 | モデル | GFM | ストリーミング | XSS |
|---|---|---|---|---|---|---|
| **markdown-it** | MIT | 活発 (v15) | トークンストリーム→HTML | プラグイン | 手動 | **既定で安全** (`html: false`) |
| **remark/rehype** | MIT | 非常に活発 | mdast→hast AST | `remark-gfm` | プラグイン | `rehype-sanitize` |
| marked | MIT | 活発 | 単一パス、最速 | 組み込み | 手動 | 最弱（サニタイザ同梱なし） |
| micromark | MIT | 活発 | 低レベルCommonMarkトークナイザ | ○ | トークナイザレベル | 自作 |

VS Code は **markdown-it**。Streamdown/react-markdown と Next/Astro/Gatsby 圏は **remark/rehype**。
一般則としてレンダラ型（marked, markdown-it）が速く、AST型（remark）は遅いが
「無制限の変換」が人間工学的に可能な唯一の選択肢。

**ストリーミングが我々の決定要因。** チャンク毎に素朴に再描画すると
ちらつき・レイアウトジャンプ・O(n²) の作業量になる。ライブラリに関係なく正解は:
**トップレベルの安定した*ブロック*に分割し、描画済みブロックをメモ化し、
末尾の未完成ブロックだけ再描画し、パース前に閉じていないフェンス/テーブルを閉じる。**

**→ 採用: Streamdown (Vercel, Apache-2.0 確認済み)。**
`react-markdown` の drop-in 代替で、remark/rehype + **Shiki** + **KaTeX** + **Mermaid** +
**`rehype-harden`**（セキュリティ）+ **`remend`**（未終端ブロックのパース）+ メモ化描画。
GFM テーブル/タスクリスト。v2.5 (2026) でインラインKaTeXとストリーミングアニメーション。

理由: Theia のウィジェットは React なので drop-in できる、Apache-2.0 は OSS IDE と両立する、
そして**下記 B2 の8割を他人が保守している1つの依存で手に入る。**
非React レンダラが必要になるかバンドル重量を拒否する場合のみ
markdown-it + 自前ブロックメモ化にフォールバックする。

### ⚠️ サニタイズは交渉不可

**エージェントの出力は半信頼。** プロンプトインジェクションによってエージェントが
`<img onerror=…>` や `javascript:` リンクをドキュメントに書き、それを我々が描画しうる。
`rehype-harden`/`rehype-sanitize`（または DOMPurify、MIT）を使い、
**プレビューはサンドボックス化された別オリジンのフレームで描画する。**

### B2. 図・数式・コード

**Mermaid は MIT（LICENSE 実文で確認済み）** — 「The MIT License (MIT) /
Copyright (c) 2014 - 2022 Knut Sveidqvist」。制限的ライセンスに変わっていない。

サイズの正直な姿: v9.4 頃に 2.7 MB (min) に達し、メンテナが後に
**31.48% 削減、2.28 MiB → 1.56 MiB** を記録している。v10 以降は図の種類毎に
動的ESMインポートで遅延ロードするが、コアのロード後にネットワーク往復が1つ増える。
**⚠️ Bundlephobia の mermaid 11 の約5KBという数字は無視すること** —
動的インポートのスタブを測っているだけで実体ではない。
現実的な「コア + 図1種類」は数百KB gzipped（**推定、未検証**）。

軽量な選択肢:
- **`@mermaid-js/tiny`** — 公式、ほぼ半分のサイズ。ただし Mindmap・Architecture・
  KaTeX描画・**そして遅延ロード**を落とす（npm が 403 を返したので**部分的にのみ確認**）
- **サーバ側で描画する。** **Kroki (MIT)** は 30以上の図ライブラリ（PlantUML, GraphViz,
  Mermaid, D2, Structurizr, Excalidraw）を包む単一HTTP APIで SVG/PNG/PDF を返す。
  `docker run -d -p 8000:8000 yuzutech/kroki`。
  **デーモン+シンクライアントというアーキテクチャを考えると、これが構造的に正しい答え:**
  クライアントバンドルがゼロ、モバイルクライアントが図を無料で得る、コンテンツハッシュでキャッシュできる。
  難点は Docker/JVM スタックで、OSS IDE が要求する依存としては重い。
  代替（デーモン内で mermaid を走らせる）は DOM が必要で、jsdom は mermaid に対して不安定、
  ヘッドレスChromium は動くが重い。**ここにフリーランチは無いので意図的に選ぶこと。**

**数式: KaTeX (MIT)。** 同期的でレイアウトのリフローが無く、フォント込みで約 347.5 kB。
**MathJax v3 (Apache-2.0)** は LaTeX カバレッジが広く MathML 出力（スクリーンリーダのa11yが良い）
だが非同期。`remark-math` + `rehype-katex` で KaTeX を使い、マクロ不足の苦情が来たら再検討する。

**その他:**

| | ライセンス | 判断 |
|---|---|---|
| **Excalidraw** | **MIT（確認済み）** | **採用。**ビューア*かつ*エディタで `.excalidraw` を扱え、**エージェントが編集可能な図を出力できる。** Nimbalyst が埋め込んでいるもの |
| **tldraw** | **OSS ではない（確認済み）** | **使わない。** SDK 4.0 (2025-09) 以降プロプライエタリな「tldraw license」。GitHub上は source-available だが本番利用にはライセンスキーが必要。無料の趣味/非商用ライセンスは "made with tldraw" 透かしが出る。**商用は年 $6,000 USD/チーム**（公開の反発を招いた） |
| **PlantUML** | **未確認、かつこれは重要** | GPL系。**バンドルしない。** Kroki 経由でHTTPで消費する（プロセス境界）。出荷前に確認すること |
| **D2** (Terrastruct) | **MPL-2.0** | 言語・CLI・dagre と ELK レイアウトエンジン・全テーマ・VS Code拡張が MPL-2.0。ファイル単位コピーレフトなので別バイナリ/wasm なら問題ない。**⚠️ `tala` レイアウトエンジンはプロプライエタリ** — 無料なのは dagre/ELK のみ |
| **Graphviz** | **両方未確認** | `@hpcc-js/wasm-graphviz` がラップ。Graphviz コアは EPL/CPL系、hpcc-js は Apache-2.0。使用前に確認 |

**シンタックスハイライト: Shiki (MIT)。**
サイズ: フルバンドル 6.4 MB min / **1.2 MB gz**（全テーマ+全言語）、
**web バンドル ~707 KB gz**、**コア ~12 KB** + fine-grained bundle でインポートした分。
fine-grained + **`@shikijs/engine-javascript`** を使う（`engine-oniguruma` より
バンドルが小さくブラウザでの起動が速い）。ストリーミングには **`shiki-stream`** (antfu) が
差分DOM変更のみをコミットするので LLM 出力にちょうど良い。
性能の注意: 2025年のあるベンチマークでは Shiki が Prism の約7倍遅い（単一ブログのベンチマークなので方向性のみ）。

**⚠️ 検討すべきアイデア: 我々は Theia ベースなので既に Monaco と TextMate 文法を出荷している。**
コードフェンスを Monaco の既存トークナイザとテーマでハイライトすれば、
**追加バンドルは約0KB、プレビューの色がエディタと完全に一致し、Shiki を削除できる。**
先行事例が見つからなかったので実証済みの道ではなくプロトタイプすべきアイデアとして扱うが、
バンドルの論拠は強い。

### B3. VS Code / Theia の組み込みプレビューは使わない

**VS Code:** markdown-it ベースで、文書化された contribution point で**拡張可能**:
```json
"contributes": { "markdown.markdownItPlugins": true }
```
に加えて `activate()` が `{ extendMarkdownIt(md) { return md.use(plugin) } }` を返す。
**Mermaid はネイティブに無い** — `bierner.markdown-mermaid` が必要。

**Theia:** `@theia/preview` は **deprecated かつ未公開**。Theia 自身の案内は
「VS Code 組み込みの Markdown 拡張を使え、同じ機能セットを提供する」。
そして拡張を入れても Mermaid は描画されない（#14654）。

**判断: 自作する。** 独立した3つの理由:
1. Theia のものは deprecated なので死んだ依存を採用することになる
2. **VS Code のも Theia のも*ファイル指向*で、どちらもストリーミングの概念を持たない。**
   だが我々の主要ユースケースはまさにそれ — **エージェントは設計文書やレポートを*ストリームする***
3. mermaid・数式・要素単位の操作が欲しい

*パターン*は再利用する（Theia `ReactWidget` + コンテンツタイプをキーにした
preview-handler レジストリ。これが `@theia/preview` の構造だった）が、レンダラは自分で持つ。

### B4. その他のビューアパネル

**安い勝ち筋 — v1 でやる:**

1. **画像 / SVG** — `<img>` だけ。**注意: SVG は `<script>` を運べる。**
   信頼できない SVG は CSP 付きサンドボックス iframe で描画するか **DOMPurify (MIT)** でサニタイズする
2. **HTML ファイル** — A のブラウザパネルにそのまま流す。無料
3. **ログファイル** — ターミナル用に `@xterm/xterm` (MIT) を既に出荷しているので、
   ANSI忠実性・検索・仮想化が無料で手に入る。代替は `anser` (MIT) + 仮想化リスト。
   **必ず仮想化すること** — 500MB のログでタブが死ぬ
   （※モバイルクライアントでは xterm.js を使わない。[secondary-client.md](secondary-client.md) 参照）
4. **CSV/TSV + Parquet — 今回の一番の発見。** Hyperparam スタック、**全部 MIT**:
   - **hyparquet** — 純JS Parquet リーダ、**~9.7 KB gzipped、wasm 不要**
   - **HighTable** — React 仮想化テーブル、数百万行、非同期ロード、列ソート
   - **squirreling** — ブラウザネイティブSQLエンジン、**~9 KB gzipped**

   **合計 ~50 KB gz で CSV + Parquet + SQL。** **duckdb-wasm**（MIT だが数MBのwasm）に対して
   驚異的な取引。duckdb-wasm は本物の分析が要求されてから。*ビューア*には過剰でモバイルに敵対的

**後回し:**

5. **PDF** — `pdfjs-dist` は Apache-2.0、最新 5.7.284 (2026-04) だが
   バンドル約 **3.94 MB**、**インストール 35.6 MB / 展開 69.1 MB**。
   出荷するなら動的インポートで遅延ロード。モバイルで悪い。エージェント開発IDEでの価値は低い
6. **Jupyter ノートブック** — `notebookjs` (jsvine) が `.ipynb` → HTML。
   **ライセンス未確認。** データサイエンス層を狙うなら

### B5. リッチMarkdown編集（WYSIWYG）

| | ライセンス | 備考 |
|---|---|---|
| **Milkdown** / Crepe | **MIT**（プロジェクト全体が許諾的） | ProseMirror + remark + Y.js。markdown-WYSIWYG に最も合う |
| Tiptap | コアは **MIT**、Pro/Cloud は有料 | 2025年中頃に旧Pro拡張10個をMITで公開したが Cloud/collab/comments/AI は有料のまま。**拡張単位で監査が必要** |
| ProseMirror | MIT、階層なし | Marijn Haverbeke。フレームワーク非依存 |
| Lexical | MIT | Meta、React ファースト |

**判断: WYSIWYG は後回し。分割ペインのプレビューで十分 — そして製品的にはむしろその方が良い。**

エージェントIDEにおいて markdown 文書は**エージェントも編集する git 上のファイル**。
WYSIWYG→markdown の直列化は触る必要のない箇所を必ず整形し直すので、
**エージェントの編集に対してノイズだらけの diff とマージコンフリクトを生む。**
Monaco + ライブストリーミングプレビュー + スクロール同期なら追加コストがほぼ無く
（Monaco は既にあり、レンダラはどうせ作る）、**ファイルがバイト単位で安定する。**

後で欲しくなったら **Milkdown/Crepe (MIT)**。Tiptap ではない。

### → B の推奨

**v1:**
- **Streamdown (Apache-2.0)** をレンダラに。remark/rehype + GFM + ストリーミング/未完成markdown処理 +
  `rehype-harden` + KaTeX + Shiki + Mermaid の配線が保守された1依存で手に入る
- **KaTeX (MIT)** で数式
- **Shiki (MIT)** fine-grained + `@shikijs/engine-javascript`、
  または Monaco のトークナイザ再利用（約0KB）をプロトタイプして Shiki を落とす
- **Mermaid (MIT)** を最初の図で遅延ロード、**デーモン側にコンテンツハッシュキーのSVGキャッシュ**
- **Excalidraw (MIT)** パネルで `.excalidraw`。安く、効果が高く、エージェントが書ける
- ビューア: 画像/SVG（サニタイズ）、HTML→ブラウザパネル、ログ→xterm、
  **hyparquet + HighTable (MIT)** で CSV/Parquet
- レンダラは**サンドボックス化された別オリジンのフレーム**で走らせ、すべてサニタイズする

**v2:** **Kroki (MIT)** をデーモンに入れて D2 / PlantUML / Graphviz / サーバ描画Mermaid → SVG。
モバイルのバンドルサイズかオフライン信頼性が苦情になった瞬間にやる

**やらない:** PDF（後回し）、Jupyter（後回し）、WYSIWYG（後回し）、**tldraw（永久に。プロプライエタリ）**

### 🚩 B の最大の技術リスク

**Mermaid。** ビューアスタック全体で圧倒的に最大の依存（~1.5〜2.7 MB min）で、
**DOM を必要とする**のでヘッドレスChromium 無しにデーモンへ綺麗に移せず、
v10 以降は図の種類を**動的ESMインポート**で遅延ロードするので
**Electron のパッケージング・オフライン利用・asar バンドルと喧嘩し**、往復も増える。
そして**軽量なはずのモバイルセカンダリクライアントを軽量でなくする張本人。**
しかもエージェントは mermaid を出したがるので単純にスキップできない。

**緩和: Markdown パネルを書く前に mermaid の描画*場所*を決める。後からではなく。**
```mermaid フェンスを**プラガブルな `DiagramRenderer` インタフェース**経由で解決するように
レンダラを設計し、実装を2つ持つ — クライアント側 mermaid（v1、出荷が速い）と
デーモン側SVG（v2、Kroki かヘッドレスChromium）— 両方が同じコンテンツハッシュSVGキャッシュに供給する。
**クライアント側 mermaid をコンポーネントに直結すると、モバイルクライアントのバンドルが
維持不能になった時点でパネルを書き直すことになる。**

---

## 未確認・出荷前に確認すべき項目

| 項目 | なぜ重要か |
|---|---|
| `webContents.setDevToolsWebContents()` が現行 Electron に残っているか | 「DevTools をタイルにする」計画がこれに依存 |
| `ms-vscode.simple-browser` が Theia の builtin-extension セットに入っているか | 入っていれば v1 のブラウザパネルが実質タダ |
| **PlantUML の正確なライセンス** | GPL系。**バンドルしない** |
| Graphviz コアと `@hpcc-js/wasm-graphviz` のライセンス | |
| `click-to-component` の LICENSE 実文 | MITと記載されているが未取得 |
| Chrome DevTools MCP / Playwright MCP のライセンス | Apache-2.0 と仮定 |
| `@mermaid-js/tiny` の正確なサイズ | npm が 403 |
| Incremark / `markdown-it-ts` のライセンスと成熟度 | Streamdown の代替候補 |
| notebookjs / nbviewer.js のライセンス | |
| Omnara の localhost プレビューの実トランスポート | 非公開 |
| Electron のビュー単位メモリ実測 | 「7ビュー移行で約8%削減」は単一ブログの逸話 |
| Shiki vs Prism の「7倍遅い」 | 単一ブログのベンチマーク |

---

## 出典

**埋め込みブラウザ**
[Electron webview-tag](https://www.electronjs.org/docs/latest/api/webview-tag) ·
[Migrating from BrowserView to WebContentsView](https://www.electronjs.org/blog/migrate-to-webcontentsview) ·
[Electron BrowserView (deprecated)](https://www.electronjs.org/docs/latest/api/browser-view) ·
[Electron Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds) ·
[electron#42320 customize border radius of Views](https://github.com/electron/electron/pull/42320) ·
[electron#15899 Support z-ordering for BrowserView](https://github.com/electron/electron/issues/15899) ·
[electron#4738 capturePage memory growth](https://github.com/electron/electron/issues/4738) ·
[Building a Browser using ElectronJS (ika.im)](https://www.ika.im/posts/building-a-browser-in-electron) ·
[Theia mini-browser](https://github.com/eclipse-theia/theia/tree/master/packages/mini-browser) ·
[@theia/mini-browser advisories](https://advisories.gitlab.com/pkg/npm/@theia/mini-browser/) ·
[@theia/preview (deprecated)](https://www.npmjs.com/package/@theia/preview) ·
[theia#14654 Mermaid Preview not working](https://github.com/eclipse-theia/theia/issues/14654) ·
[theia#16275 Webview sandbox issue](https://github.com/eclipse-theia/theia/issues/16275) ·
[Theia Discussion #10699 Webview/Mini-browser Endpoints](https://github.com/eclipse-theia/theia/discussions/10699) ·
[Vibe Kanban — Browser Testing docs](https://vibekanban.com/docs/browser-testing) ·
[liriliri/eruda](https://github.com/liriliri/eruda) ·
[stagewise (AGPLv3)](https://github.com/stagewise-io/stagewise) ·
[onlook-dev/onlook](https://github.com/onlook-dev/onlook) ·
[ericclemmons/click-to-component](https://github.com/ericclemmons/click-to-component) ·
[AgentDeskAI/browser-tools-mcp](https://github.com/AgentDeskAI/browser-tools-mcp) ·
[Meet the new Cursor](https://cursor.com/blog/cursor-3) ·
[Cursor IDE Browser Tools Review (EPAM)](https://www.epam.com/insights/ai/blogs/composer-ide-browser-tool-review) ·
[Connecting Playwright to an Existing Browser](https://www.browserstack.com/guide/playwright-connect-to-existing-browser) ·
[Launch HN: Omnara](https://news.ycombinator.com/item?id=44878650) ·
[Reverse Proxying over WebSockets (Codemancers)](https://www.codemancers.com/blog/reverse-proxying-over-websockets) ·
[VS Code Webviews on the web (Matt Bierner)](https://blog.mattbierner.com/vscode-webview-web-learnings/) ·
[CSP frame-ancestors (MDN)](https://developer.mozilla.org/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors)

**Markdown・図・ビューア**
[markdown-it](https://github.com/markdown-it/markdown-it) ·
[remarkjs/remark](https://github.com/remarkjs/remark) ·
[marked vs remark vs markdown-it 2026](https://www.pkgpulse.com/guides/marked-vs-remark-vs-markdown-it-parsers-2026) ·
[vercel/streamdown](https://github.com/vercel/streamdown) ·
[streamdown LICENSE](https://github.com/vercel/streamdown/blob/main/LICENSE) ·
[Streamdown 2.5](https://vercel.com/changelog/streamdown-2-5) ·
[mermaid LICENSE](https://github.com/mermaid-js/mermaid/blob/develop/LICENSE) ·
[mermaid bundle size discussion #4314](https://github.com/orgs/mermaid-js/discussions/4314) ·
[Shrinking Mermaid >30% (Sidharth Vinod)](https://www.sidharth.dev/posts/shrinking-mermaid/) ·
[@mermaid-js/tiny](https://www.npmjs.com/package/@mermaid-js/tiny) ·
[Kroki Documentation](https://docs.kroki.io/kroki/) ·
[terrastruct/d2 (MPL-2.0)](https://github.com/terrastruct/d2) ·
[@hpcc-js/wasm-graphviz](https://www.npmjs.com/package/@hpcc-js/wasm-graphviz) ·
[Excalidraw LICENSE (MIT)](https://github.com/excalidraw/excalidraw/blob/master/LICENSE) ·
[tldraw License docs (proprietary)](https://tldraw.dev/community/license) ·
[tldraw SDK 4.0 licensing debate (BigGo)](https://biggo.com/news/202509190115_tldraw_SDK_4.0_Licensing_Debate) ·
[Shiki Bundles](https://shiki.style/guide/bundles) ·
[Shiki RegExp Engines](https://shiki.style/guide/regex-engines) ·
[antfu/shiki-stream](https://github.com/antfu/shiki-stream) ·
[KaTeX vs MathJax (BigGo)](https://biggo.com/news/202511040733_KaTeX_MathJax_Web_Rendering_Comparison) ·
[VS Code Markdown Extension API](https://code.visualstudio.com/api/extension-guides/markdown-extension) ·
[pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) ·
[Hyperparam Open-Source (hyparquet, HighTable, squirreling)](https://hyperparam.app/about/opensource) ·
[duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm) ·
[jsvine/notebookjs](https://github.com/jsvine/notebookjs) ·
[Milkdown LICENSE (MIT)](https://github.com/Milkdown/milkdown/blob/main/LICENSE) ·
[Tiptap Pro license](https://tiptap.dev/pro-license)
