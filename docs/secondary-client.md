# セカンダリクライアント（モバイル）設計

## 判定: Theia は合う。ただしモバイルに Theia のワークベンチを載せないことで合う

運用イメージ（縦方向にウインドウが並び、最小化と展開ができ、展開した内容の観測と指示出しができる）は正しく、
かつ**それは Theia の `ApplicationShell` を設定で得られる形ではない。**
別の軽量クライアントを同一バックエンドに対して立てるのが正解で、これは
[architecture.md](architecture.md) の D1（1プロトコル・クライアントは1種類）が既に想定していた形。

**Monaco のモバイル問題は、セカンダリが Monaco を使わないことで消滅する。**
これが前回「未解決点」として残していた論点の解決。

---

## 1. Monaco のタッチ非対応の具体的な破綻レベル

「非対応」の一言では判断できないので、どの操作が動きどれが壊れるかを実装レベルで確認した。

| 操作 | 判定 | 実態 |
|---|---|---|
| **描画** | **問題なし** | モバイル Safari / Chrome Android で正常にレンダリングされる |
| **タッチドラッグでのスクロール** | **問題なし** | 実装されている。`pointerHandler.ts` の `onChange` が `pointerType === 'touch'` を `deltaScrollNow` に直結。慣性スクロールも `touch.ts` に `SCROLL_FRICTION = -0.005` の物理演算として実装済み（ブラウザ任せではなくMonaco自身の実装なのでネイティブと完全に同じ感触にはならないが、設計上ジャンクではない） |
| **タップでカーソル配置** | **問題なし** | `onTap` がヒットテストして `moveTo` する。タップ判定は700ms以内・30px以内 |
| **テキスト選択** | **構造的に破綻** | 下記詳述 |
| **ソフトキーボードでの入力** | **Android: 不安定 / iOS: より悪い** | 下記詳述 |
| **ページのスクロール継続** | **破綻** | エディタが末端に達してもホイール/スクロールを消費し続け、**ページが先にスクロールしない**（#4880, #4348）。`alwaysConsumeMouseWheel: false` も効かない |

### テキスト選択が「バグ」ではなく「構造的に不可能」な理由

2つの原因が重なっている。

**原因1: Monaco はネイティブ選択を使っていない。** メンテナ `rebornix` の発言（monaco-editor#626, 2017-11-11）:

> 「選択は模造品で、ブラウザから見れば単なる div の集まりだ（フォーカスは textarea にある）。
> だから iOS はタッチアクションを提供する方法を知りようがない。」

選択が偽の div で、フォーカスが画面外の textarea にあるので、
**iOS/Android には選択ハンドルを付ける対象が存在しない。** ネイティブハンドルも虫眼鏡も
「選択/すべて選択/貼り付け」のコールアウトも出ない。

**原因2: 1本指ドラッグはスクロールに使い切られている。** `pointerHandler.ts` の `onChange` は
`pointerType === 'touch'` に対して**無条件にスクロールする**。「選択」を意味するジェスチャが残っていない。
`pointerType === 'pen'` だけが `inSelectionMode: true` を受け取る（＝**スタイラスなら選択できる**）。

結果:

| 操作 | 結果 |
|---|---|
| 長押しで単語選択 | **失敗。** `touch.ts` が 700ms で `Contextmenu` ジェスチャを発火するので、選択ではなくMonacoのコンテキストメニューが出る |
| ドラッグで選択 | **失敗。** 常にスクロールになる |
| ネイティブ選択ハンドル | **存在しない** |
| ダブルタップで単語選択 | **動く**（`tapCount === 2` が dispatch される）。ただし選択範囲をタッチで**調整できない** |
| スタイラスでのドラッグ選択 | **動く** |

このダブルタップ後に調整できない件が monaco-editor#4860（2025-03-25 起票、**現在も open**、
最終コメント2025-12-01）。唯一の返信は「全く同じ問題、まだ解決策なし?」だけ。

**そして #4622（タッチ選択サポート追加）に付いていた PR #4623 は、
2024-11-10 にメンテナの説明なしで unmerged クローズされた。**

### 入力とIME

**Monaco は iOS 専用の回避ウィジェットを同梱している** — これ自体が状況の証拠。
`iPadShowKeyboard.ts` は iOS でのみフローティングの「キーボード表示」textarea を注入する。
`onTap` が `event.preventDefault()` を呼ぶため iOS の自動キーボード表示が抑止されるからで、
**この抑止は `readOnly: true` のときだけ解除される。**

Android の予測入力は歴史的に入力を壊してきた。#2261 では `const` + スペースが **`constconst`** になった
（`case`, `catch`, `class`, `delete`, `if`, `throw`, `function`, `instanceof` も同様、
`break`, `do`, `else`, `for`, `return` は無事）。2021-02 に修正の波があり、
「全く使えない」から「不器用」に改善したという報告がある。**「不器用だが使える」が今の公正な評価。**

根本原因は CodeMirror 作者 Marijn Haverbeke の説明が的確:

> 「ブラウザでのcomposition/IME処理は独自の地獄だ（…**Android の仮想キーボード入力はほぼ全部これ**）」
> 「composition中にDOMや選択をいじると composition が*中断*され、エディタはIMEユーザにとって使い物にならなくなる」

**つまり Android のソフトキーボード入力は全部IME composition なので、
DOMに対してシャドウバッファを同期するエディタは注意深く扱わないと入力を壊す。**

**日本語IMEについて、探していた事例が見つかった。** monaco-editor#528「Japanese IME not working on
Android Chrome」— `こんにちは` と入力すると `んにちはこ` になる（公式デモサイトでのスクリーンショット付き）。
2021-02 にクローズ済みだが、**現在の実機で正しいかは未検証。**

**2025-2026 の重要な変化: EditContext。** VS Code は隠しtextareaから
[EditContext API](https://developer.mozilla.org/en-US/docs/Web/API/EditContext) に移行し
（vscode#207699、2026-01-09 クローズ）、`editorOptions.ts` で**既定 `true`** になった。
これがターゲットを分断する:

- **Chrome Android → EditContext が効く。** IME/composition 専用に設計されたブラウザAPIで、
  脆いtextarea同期を置き換える。**Android と日本語IMEは実質的に改善しているはず**
- **iOS Safari → EditContext が効かない。** WebKit が未実装（Chrome/Edge 121+ のみ）。
  iOS は旧来の隠しtextareaにフォールバックし、歴史的な問題を全部保持する

### 読み取り専用モードが答え

monaco-editor#1143「Readonly view with mobile」(2018年起票、最終活動 2025-02-18) の
原報告がまさにこの用途:

> 「読み取り専用のMonacoを使っているが、**モバイルブラウザでほぼ動く** —
> エディタ内で何か選択するとキーボードが出てくる場合を除いて」

**そして解決策（`jjonescz`, 2025-02-18）がこの調査全体で最も実用的な1行:**

```js
{ readOnly: true, domReadOnly: true }
```

`domReadOnly` は隠しtextareaに DOM の `readonly` 属性を付ける。
これで**ソフトキーボードが一切開かない** — スクロール中に出てくることも、タップで出ることも、
ビューポートが暴れることもない。そして `readOnly: true` が独立して iOS の ShowKeyboardWidget を抑止する。
**一石二鳥。**

（古い回避策の「内側のtextareaを隠す」は**テキストをコピーできなくなる**ので `domReadOnly` の方が厳密に優れている。）

### 実機での評価

最も信頼できる材料は vscode#255717「iPadOS ネイティブサポートを」（2025-07-14 起票、
27コメント、162リアクション、2026-06-10 まで活動）。実際に日常使いしている人たちのスレッド。

`emaadmanzoor`, 2025-10-15:
> 「iPadの vscode.dev が良くなるだけで極めて満足だ。移動中の主要なプログラミング環境になっているが、
> **ジャンクなスクロール挙動と、突然コピペができなくなること**に苦しんでいる」

`rmchale`, 2025-12-28:
> 「これは強調しきれない。**コピペが頻繁に効かなくなる。**」

両者ともキーボード付きiPadユーザで、両者とも**入力ではなくコピペ**を訴えている —
選択が壊れているという分析と一致する。iOS 固有の実バグもある: vscode#235666 は
iPadOS/iOS Safari **限定**で、コロンを含む行をコピーするとクリップボードがURLエンコードされる
（回避策: `editor.pasteAs.enabled: false`）。

肯定的な報告もある — `blazejhanzel`, 2025-09-22:
> 「Safari でアプリショートカットを作って GitHub Codespace を VS Code Web で開くと実によく動く。
> ズームなしのデフォルトUIでも見栄えが良く、**タッチ操作でシームレスに動く。**」

**「iPad ≒ 不器用だが使える / スマホ ≒ 閲覧専用」が公正な読み。**
そして「ホーム画面に追加」（＝PWA化）は装飾ではなく機能的に効いている —
`isidorn` (2021-04-13) が「アドレスバーを隠せばリストビューとエディタの両方がスクロールできる」と確認している。

**制度的な証拠として最も強いのは GitLab。** Monaco製のWeb IDEを出荷し、壁に当たり、方針転換した
（gitlab#28738）:

> 「Web IDE はモバイルデバイスを十分にサポートしていない。**モバイルをサポートしていない Monaco の上に
> 作られているため。**」

モバイル用には **Ace** ベースの単一ファイルエディタを残した。
強い動機を持つプロダクションチームが「下流では修正不可能」と結論した事例。

### Microsoft の現在の姿勢

**明示的な拒否声明は無く、沈黙で維持されている。**
[monaco-editor README FAQ](https://github.com/microsoft/monaco-editor#faq) は現在もこの通り:

> ❓ **エディタはモバイルブラウザまたはモバイルWebアプリフレームワークでサポートされていますか?**
>
> いいえ。

| Issue | 状態 | 最終活動 |
|---|---|---|
| #246「Any Plan for Mobile」(2016) | **open**, Backlog, 35コメント | **2026-02-11** |
| #1504「mobile (touch) support」 | **open**, Backlog | 2024-12-23 |
| #4860「selection handles on mobile」 | **open** | 2025-12-01 |
| #626, #682 タッチ選択 (2017) | **open** | 2022 |
| #4622 / PR #4623 | クローズ / **unmerged** | 2024-11-10 |

**Monaco のモバイルに関するメンテナの最新発言は2021-03-10で止まっている。**
2025-2026 の活動は全部コミュニティで、メンテナの参加はゼロ。

### xterm.js のタッチ（比較）

破綻の形が違う。**入力は動くが選択が壊れる。**

- **スマホでターミナルに打てる。** xterm.js は本物の `<textarea>` にフォーカスするのでソフトキーボードが開く
  （これがMonacoとの決定的な違い）
- **ただし Android では打った内容が壊れる。** #3600（**Replit が起票**、現在も open）:
  「相当数のAndroidユーザがコンソールへの入力で問題を報告している。具体的には
  **文字が混ざる、文字が重複する、変なテキストになる**」— Monaco の `constconst` と同じGBoard/composition原因
- **選択/コピペは壊れている。** #3727（2022年起票、**最終更新 2026-05-29**):
  「画面をタッチしてテキストを選択することが全くできないので、コピー（と貼り付け）は不可能」
- タッチスクロールは動く。v6 で **VS Code の scrollbar/gesture 層を取り込んだ**ので Monaco と同じ `touch.ts` の慣性コード
- メンテナ `Tyriar`, 2025-07-24: 「タッチサポートの改善は歓迎するが、**これは全く自分の優先事項ではない**」
- 確立された回避パターンは**修飾キーツールバーのラッパ**。`ttyd` に2026年の活発なPR群がある
  （#1494/#1496 フローティング仮想キーボード、#1493 Ctrl/Esc/矢印キーのツールバー、#1499 ビューポート処理）

**結論: スマホでは修飾キーツールバーを足せば短いコマンドには使えるが、選択/コピーは壊れており、
Android の入力は対策なしでは壊れる。**

---

## 2. Theia のモバイル対応状況

### 読み込める。しかしレスポンシブ対応はゼロ

**Theia はスマホ/タブレットのブラウザで読み込まれて動作する。** 白画面でもブロックでもない。
2019-2020 に iPad ユーザ主導でモバイル基礎対応の波があり、実際に着地している
（#6967 meta viewport タグ merged、#7607 iPad フルスクリーン、#7790 iPadでの右クリック、
#8501 Android のバックスペース）。現在の `master` の
`frontend-generator.ts` が生成する `index.html` にもタグが残っている:

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
```

**ただし `manifest` リンクも service worker も無いので Theia は標準では PWA ではない。**
iOS のホーム画面追加でフルスクリーンにはなるが、Android のインストール可能性は得られない
（有効な manifest + 登録済み service worker が必要）。追加自体は簡単だが、今は無い。

**そしてレスポンシブレイアウトの話は一切無い。** `packages/core/src/browser/style/sidepanel.css` には
`@media` クエリも `touch-action` も無く、テーマ用のカスタムプロパティだけ。
狭画面モードもブレークポイントも折りたたみパネルスタックもモバイルメニューも無い。
エピックもロードマップ項目もメンテナのコミットメントも見つからなかった。

**つまり「通常のWEBサイトレベルの動作」は Theia が満たしている基準ではない。**
Theia は固定のデスクトップシェルで、たまたま与えられたサイズで描画される。

### Lumino のタッチ対応は、実は改善されている（2025年の変化）

ここは広く流布している情報が古くなっているので正確に書く。

**Theia が PhosphorJS から Lumino へ移行したのは Theia 1.60、2025-04-10 発表。**
動機はメンテナンスでタッチではなかった（「PhosphorJS は数年間信頼できる基盤だったが、
継続的なメンテナンスの欠如がますます問題を引き起こしていた」）。

だが副産物としてタッチ対応が入った。Lumino [PR #123「Basic Touch Events」](https://github.com/jupyterlab/lumino/pull/123)
が **2021-09-30 に merged**。当初はタッチ→マウスイベント変換だったが、レビュアが
「アプリケーションコードで手動変換するのが正しいアプローチか?」と押し戻し、
メンテナが PointerEvents に誘導した（「より広い抽象化層を選ぶ方が長期的に健全だろう」）。
実機タブレットで検証されてからマージされている。

現在の Lumino ソースで確認:
- `splitpanel.ts` — ハンドルは `pointerdown` → `document` に `pointerup`/`pointermove`。**マウスイベントは無い**
- `tabbar.ts` — `pointerdown`/`pointerleave`/`pointermove`/`pointerup`。加えて
  `Utils.isTouchEvent()` ヘルパ、タッチでの閉じるボタンを遅延させる `_pendingTouchCloseRequest`、
  条件付き `preventDefault()`

**帰結: Theia 1.60 以降、スプリッタのドラッグとタブのドラッグ/クローズはタッチで動く。**
Theia #3557 の「タッチインタフェースからIDEのパネルをリサイズする方法が無い」という主張は
**Lumino移行の6年半前のもので、もう古い。** ここを前提に計画しないこと。

（注意点として #15612 は 1.60 のリグレッションで、VS Code webview パネルを開くと
ポインタイベントを奪ってサイド/ボトムのスプリッタがドラッグできなくなる。
ポインタイベント配線がまだ新しく粗いことの証拠。）

### Jupyter の先例が決定的

「Lumino をスマホで動くようにしたのか、それとも別の簡略フロントエンドを出したのか」という問いへの答えは
**前者を試して撤回し、後者を出した。** 時系列:

| 日付 | 出来事 |
|---|---|
| 2017-11-23 | jupyterlab#3275「JupyterLab をモバイルフレンドリーに」起票 |
| **2020-05-25** | **PR #8456 merged** —`MOBILE_QUERY = 'only screen and (max-width: 760px)'`、`JupyterFrontEnd` に `format` 属性と `formatChanged` シグナル、throttle付きリサイズ。マッチしたら **DockPanel を single-document モードに切り替えてステータスバーを隠す**。まさに欲しかった「狭画面モード」 |
| 2021-01-06 | #9567 — ユーザが嫌がった。760px がハードコードだったので、デスクトップで画面分割すると勝手にIDEが再編成された |
| **2021-02-19** | **PR #9831 で自動切り替えを撤回。** 理由: 「既存の自動切り替え挙動はデスクトップユーザにとって破壊的で、**レスポンシブレイアウト・モバイルプラットフォーム・シンプルインタフェースという別々の問題を混同していた**」 |
| 2021-02-24 | #9871 で 4.0 マイルストーンに再提案。核心の指摘: 「JupyterLab は現在 `mobile` モードとシンプルモードを同一視している」 |
| — | **4.0 はこれ無しで出荷。** 現在の `main` の `shell.ts` に `MOBILE_QUERY` もメディアクエリも幅検出も無い。#13675（レスポンシブ+PWA）は `status:Needs Discussion` で今も open |
| — | **Notebook 7 が実際のモバイル解になった。** 公式ドキュメント: 「Notebook 7 はモバイルデバイスで自動的によりコンパクトなレイアウトに切り替わる」 |

**そして最も重要な実装詳細: Notebook 7 のシェルは `DockPanel` を使っていない。**
`BoxLayout({ direction: 'top-to-bottom' })` + 2つの `SplitPanel` + 素の `Panel` +
折りたたみボトムパネル用の `TabPanelSvg` で構成されている。
**同じ Lumino プリミティブ、同じ Jupyter Server、同じプラグインシステム、ほぼ同じ拡張 —
だがドッキングシェルではなく手書きの簡易シェル。**

そして Notebook 7 は**モバイルCIテストを持っている**（#7278/#7371 で flaky なモバイルUIテストを修正）。
JupyterLab にはモバイルモードが無い。**この対比が答え。**

**デプロイ形態も参考になる:** JupyterLab が `/lab`、Notebook 7 が `/tree`、
NbClassic が `/nbclassic/tree` — 3つ全部が1つの Jupyter Server から同時に配信される。
これがまさに「プライマリのデスクトップクライアント + セカンダリのモバイルクライアント、
バックエンドは1つ」のパターンで、既にプロダクションで実証済み。

### 業界全体が7年間出荷していない

| | 状況 |
|---|---|
| **Theia** #3557 | 2018-11-20 起票、**現在も open**。#14040「Androidで使えるようにする」も open, `help wanted` |
| **Microsoft** vscode#85254「Web: Mobile Safari support」 | **2019-11-21 起票、6年以上 Backlog のまま open** |
| Microsoft #256181（タッチターゲット拡大/狭画面レイアウト） | 2025-07-16 起票、**Backlog** |
| **Coder** code-server | 明示的な先送り。メンテナ `code-asher`: 「我々は VS Code web をラップしているだけなので、モバイルサポートの質問は上流の方が良い答えを得られるかもしれない」。上流へのパッチを最小化する方針なので彼らは作らない |

**Theia / Microsoft / Coder の3者がそれぞれ5〜7年この要望を抱えて誰も出荷していない。**
これが「レスポンシブなワークベンチは自分が見落としている小さな作業量ではない」ことの最強の証拠。

### そして Microsoft が今まさに同じ結論に向かっている

**vscode#302363（2026-03-17 起票、`roblourens` にアサイン、現在も open）は
この運用イメージそのもの。** vscode.dev 上のモバイル「Agent Supervisor」ビューの要望で、
Remote Tunnels 経由でエージェントを監督するために:
エージェントの状態、**大きなタッチフレンドリーな承認/拒否ボタンを持つ permission-request カード**、
アクションのタイムライン、追加指示用のチャット入力。

起票時の言葉:
> 「フルのデスクトップエディタUIが小さい画面にレンダリングされる」ので **「スマホでは使えない」**
> 「開発者は画面を常に見ている必要はない — だが操作を承認する必要はある」

提案されていた選択肢は「Chatパネルへのレスポンシブブレークポイント」「新しいモバイル `webviewView`」
「web workbench の代替レイアウトモード」。**つまり Microsoft も同じ問題を、同じ形で認識している。**

---

## 3. 先行事例が収束したUIパターン

モバイル面を実際に出荷したツールは、独立に全部同じ形に着地している:

> **スクロールするチャットトランスクリプトを背骨とし、折りたたまれたツールコールカードをインラインに置く。
> カードをタップで展開。差分は unified・単一カラム・ファイル毎・既定で折りたたみ。
> 承認はインライン（またはグローバルキュー）。ターミナルは有るとしても読み取り専用。
> エージェントがブロックしたら push 通知。**

**誰もIDEレイアウトを作っていない。誰も side-by-side 差分をやっていない。誰もgitグラフを出していない。**
「縦方向に並ぶ折りたたみパネル」という要件は、実在するものより*むしろ構造化されている* —
出荷済みのツールはほぼ1本の長いトランスクリプトなので。**妥協ではなく改善。**

### 主要な実装

| ツール | 接続方式 | UI | ターミナル | 差分 |
|---|---|---|---|---|
| **Claude Code Remote Control** | **送信HTTPSのみ、inboundポートを開かない。** API に登録してポーリング。QRコードでペアリング。トランスクリプトは Anthropic サーバに保存される（これがクロスデバイス同期と再接続の仕組み） | Claude モバイルアプリ内 + `claude.ai/code`。`@` でローカルプロジェクトのファイルパス補完。承認、画像添付、サブエージェント進捗、一部スラッシュコマンド | **無し** | **ドキュメントに記載が無い**（視覚的差分レビューは*Desktop*アプリに帰属）。トランスクリプトのみと見るべき |
| **Nimbalyst** (MIT) | **QRコードに鍵材を載せてペアリング、鍵はサーバに届かない。** メッセージ毎に AES-256-GCM（各自のIV）。リレーは暗号文を保存・転送するだけで読めない | タッチ最適化kanban（状態別色分け）→ プロジェクト → **専用モバイル差分ビューア**: **ファイル間をスワイプ**、**関数へピンチズーム**、**変更単位でタップ承認/却下 + エージェントへのコメント** | **無し（意図的）** | ○ unified 赤緑 |
| **Omnara** (Apache-2.0) | ローカルエージェント → **クラウドAPIサーバ → PostgreSQL** → モバイルへ同期。e2e暗号化の主張は無い | アクティビティフィード、状態、インライン質問応答、リモート起動、**Apple Watch**。**localhost ライブプレビュー**（VPN/SSHトンネル不要） | v1.4.5で後付け | v1.9.0で後付け |
| **mux** (Coder, AGPL-3.0) | LAN/VPN + bearer token or GitHub Device Flow | **この中で最も良く設計されたレスポンシブWeb UI** | | |
| **siteboon/claudecodeui** (AGPL-3.0) | | React+Vite+Tailwind+CodeMirror、明示的にレスポンシブ。チャット/ファイルエクスプローラ/**gitパネル**/シェル。**全ツールが既定で無効**で手動オプトイン（リモート面の良い安全既定） | ○ | ○ |

### ACP モバイルクライアントが既に4つ存在する ← 重要

全部OSS。**kjp-core が ACP を WebSocket で話せば、これらが無料で繋がる。**

| | プラットフォーム | ライセンス | 接続 |
|---|---|---|---|
| **Agmente** (rebornix / VS Codeチーム) | iOS | MIT | 直接 `wss://`、bearer token or Cloudflare Access |
| **Ferngeist** | Android | MIT | ローカルゲートウェイデーモンが認証済みWS 1本を公開。ngrok/CF Tunnel でリモート |
| **Happy / Happier** | iOS, Android, Web | MIT | **リレー + e2e暗号化 (TweetNaCl)**、ゼロ知識 |
| **Mobvibe** | iOS, Android, Web | Apache-2.0 | 暗号化リレー。**初回起動時に ACP Registry と照合してインストール済みエージェントを自動検出** |

**Ferngeist のドキュメントが ACP エコシステム最大の実務上の制約を突いている:**

> 「ほとんどの ACP エージェントは `stdio` トランスポートしかサポートしていない —
> まず WebSocket ブリッジでラップせよ」

**kjp-core がネイティブにそのブリッジになるべき。** これで書かなくて済むモバイルクライアントが4つ。

### 最良のアイデア: Happier の Inbox

**全セッション・全マシンを横断する、permission request / user-action prompt /
承認待ちアクション / 未読セッションのグローバルな注意センター。**
承認は「安全にルーティングされ、間違ったサーバに黙って適用されることはない」。

インラインのみの承認モデルは、セッションが N 個あるとブロックしているものを探す作業になる。
**パネルスタックが複数の並行セッションを前提にしている以上、グローバルキューが必須。**

### Push 通知の収束点: プレゼンス抑制

- **Anthropic**: `/config` に「Claudeが判断したとき」と「操作が必要なとき」の2トグル。
  **接続中のターミナルで入力中/フォーカス中は抑制される。**
  `CLAUDE_CLIENT_PRESENCE_FILE` で画面ロック連動に拡張できる
- **Nimbalyst**: 「通知はデスクトップから離れているときだけスマホに届く」

**kjp-core はターミナルとプライマリクライアントの接続状態を所有しているので、
これを誰よりも正確に実装できる。** プライマリがフォーカスされているかを権威的に知っている。

盗む価値のあるもう1つ: **Anthropic のデスクトップ側ナッジ。**
ターンが長引くと入力欄の上に「まだ作業中 — スマホから確認」が出る。
permission プロンプトが連続すると「スマホからツール呼び出しを承認」が出る。
**デスクトップが、スマホを使うと助かるちょうどその瞬間に、使い方を教えてくる。**（レート制限付きで煩くない）

### モバイルでのgitグラフ: 誰もやっていない

Happier がソース管理の*状態*とworktree切り替え、mux が「git divergence 可視化」（デスクトップ中心）、
Mobvibe が「git changes preview」、Omnara が worktree サポート。
**コミットグラフをモバイルに出しているツールは1つも無い。完全に後回しでよい。**

---

## 4. セカンダリクライアントの設計

### 構成

Jupyter のパス別マルチフロントエンドを踏襲する。

```
kjp-core デーモン (Theia backend + 自前API拡張)
  ├── /        → プライマリ: Theia ワークベンチ (Electron / デスクトップブラウザ)
  ├── /m       → セカンダリ: 軽量モバイルクライアント（別実装）
  └── /acp     → ACP over WebSocket（Agmente/Ferngeist/Happy/Mobvibe が繋がる）
```

**Theia のワークベンチをモバイルに載せない。** 理由:

1. **縦積み折りたたみリストは素のHTML/CSSなら週末仕事**（`<details>` かごく単純なアコーディオン）で、
   **Theia の設定では達成できない。** シェルは `DockPanel` + `SidePanelHandler` + `BoxLayout` で
   スタック/アコーディオンモードが無い。カスタム `ApplicationShell` を書くことになり、
   その時点で新しいフロントエンドを書いたのと同じだが、Theia の内部と 1.27 型の破壊的変更に結合してしまう
2. **Monaco と xterm.js のモバイル問題を完全に回避できる。** 差分はHTML、エージェント出力はDOM、
   ターミナルログは `<pre>`、指示入力は `<textarea>`。全項目が自明にレスポンシブになる
3. **バンドルサイズ。** アコーディオンを描くために数MBのワークベンチを送ることになる
4. **Jupyter が実証済み**（否定的結果も含めて）。Lumino シェルをレスポンシブにするのを試して
   8ヶ月後に撤回した。これは我々が誘惑されうるアプローチへの警告

### ⚠️ 設計の訂正: Theia のバックエンドプロトコルは使えない

これは [architecture.md](architecture.md) への実質的な訂正。

**Theia のフロントエンド↔バックエンドプロトコルは内部実装詳細で、手書きクライアントから話すべきではない。**

- ドキュメントのページ名は「JSON-RPC」だが、**#10514 (2021-12) で transport が socket.io に移行**し、
  その上に Theia 独自の多重化チャネルフレーミングが乗っている（リソース効率のため単一ソケットを共有）
- **RPC層は Theia 1.27 で書き直され、それ以前の方式を使う全拡張が壊れた。**
  外部消費者向けのバージョニングや互換性の話は存在しない
- 両端で Inversify を前提にしている
- **Theia 自身のドキュメントが正解を示している:** 「フロントエンドとバックエンドの通信には
  どのプロトコルも使える。バックエンドは自分のエンドポイントを登録・公開でき、
  フロントエンドはそこにアクセスできる」

→ **現実的な構成: 自前のバージョン付き WS/HTTP エンドポイントを公開する Theia backend 拡張を書き、
その内部で Theia の注入済みサービス（`FileService`、terminal、SCM、task、LSPプロキシ）を
通常の Inversify DI で消費する。** Theia のサービス実装は使えるが、そのワイヤフォーマットには依存しない。

使える足場が1つある: **`@theia/plugin-ext-headless`** — バックエンド専用のプラグインAPI。
ここのプラグインは、フロントエンド接続毎にホストを起こす `@theia/plugin-ext` と違って、
**全フロントエンドで共有される1つのバックエンドホストプロセスに住む。**
これがまさに必要なスコープ。公式の意図も「それらのサービスが全接続フロントエンドで共有される、
あるいはCLIのようなヘッドレスシナリオに供する場合」と書かれている。

（なお `@theia/collaboration` / Eclipse Open Collaboration Tools は**これではない。**
ホストが自分のセッションをゲストに共有する Live Share 型の P2P ライブ*共有*プロトコルで、
マルチクライアント対単一バックエンドのプロトコルではない。かつ beta 警告付き。）

### パネル構成 — 3種類、全部 `type="single"` アコーディオン、全部 lazy mount

**1. Approvals / Inbox — 最上部に固定、常に最初。**
Happier の Inbox をそのまま採る。全セッション・全マシンを横断する保留中の permission request を1リストに。
**各項目にセッションとマシンを表示**して、間違った対象に承認しないようにする。
大きなタッチターゲットで Approve / Deny / 理由付きDeny。
**このパネルがクライアントの存在理由。**

**2. 差分パネル — 変更ファイル毎に1つ。**
ヘッダはパス + `+N/−M`。既定で折りたたみ。
`@git-diff-view/react` を unified モード、`diffViewWrap` オン、`@git-diff-view/shiki` でトークン化。
~300行で打ち切って「もっと見る」。
**Nimbalyst の2つの良いアイデアを入れる: ファイル間スワイプ と ピンチズーム**
（長い行に対して reflow ではなく zoom を逃げ道にするのは賢い）。
差別化したければ hunk 単位の承認/却下+コメント。

**3. ログパネル — エージェント出力ストリームとターミナルログ。**
`anser` → Reactスパン → 仮想化リスト、末尾追従（手動で上にスクロールしたら解除）。
**読み取り専用。xterm.js は使わない。**

加えて最下部に **composer**: テキスト、キュー済みプロンプト、画像添付、
**デバイス間のドラフト同期**（Nimbalyst にある。スマホで考え始めてデスクで書き終えられる小さいが効く機能）。

### ライブラリ選定

| 用途 | 選択 | ライセンス | 備考 |
|---|---|---|---|
| **差分描画** | **`@git-diff-view/react`** | **MIT** | ~15kb、unified+split、`@git-diff-view/shiki` or `@git-diff-view/lowlight`、web worker対応、**`diffViewWrap` で行折り返しをトグル**（スマホでは必須）。⚠️ 第三者記事の「仮想スクロール内蔵」は repo ドキュメントで未確認 → **アコーディオン側で仮想化する前提で設計する** |
| 差分（代替） | `react-diff-view` | MIT | refractor トークン、**web workerでのトークン化**が中型機で効く。仮想化なし。2.2MB/375ファイルで**約26秒**とメンテナ自身が報告 |
| **ANSIログ** | **`anser`** | **MIT** | **HTMLではなくJSONトークン配列を出力できる** → `dangerouslySetInnerHTML` なしで自前Reactスパンに描ける。XSS安全 + ネイティブスクロール + 行ウィンドウ化と統合しやすい |
| ANSI（代替） | `ansi_up` | MIT | 依存ゼロ単一ファイル。`escape_html: true` 既定。**不完全なエスケープシーケンスをバッファする**のでチャンク追記しながらtailできる |
| **使わない** | `xterm.js` を読み取り専用で | MIT | 自前レンダラと内部ビューポートを持つので**モバイルではページのスクロールコンテナと喧嘩する**。重い。「読み取り専用モード」は入力処理のために作られたものの入力ハンドラを潰すハック。**本物のインタラクティブPTYパネルを後で足すときだけ使う** |
| 使わない | `ansi-to-html` | MIT | **最終公開が約5年前** |
| **アコーディオン** | **素の `<details>`/`<summary>`** | — | **ここから始める。** JSゼロ、a11yとキーボード対応が無料、ネイティブのモバイル挙動、**開くまで子がレンダリングされない = lazy mount が無料** |
| アコーディオン（必要なら） | **Base UI Accordion** | MIT | v1.0 (2025-12)。**2026-07 時点で shadcn/ui の新規プロジェクト既定**。高さアニメーション・制御state・単一オープン強制が要るとき |
| ストリーミング強調 | `@shikijs/stream` | MIT | トークンストリームを逐次ハイライトし、既定で*確定*トークンのみ出す。**LLM出力専用に作られている** |
| モバイルでのMonaco（使うなら） | `{ readOnly: true, domReadOnly: true }` | | 固定高のペインに独自スクロール領域を与える。`100vh` ではなく `visualViewport`/`dvh`。`user-scalable=no` を付けない（ピンチズームを残す）。`onMouseDown` ではなく `onMouseUp`/`onDidChangeCursorPosition` を使う（#5047） |

### mux から採るレスポンシブ規約（CI ゲートにする）

mux のコントリビュータガイドがモバイル検証を**必須化**している。そのまま採用する:

- **全パネルを 375px 幅で検証する**
- **パネル内部のサイズ指定はビューポートのメディアクエリではなく CSS `@container` クエリを使う** —
  同じツールカードがデスクトップのサイドバーでもスマホのスタックでも正しく描画される。
  **折りたたみパネル構成にはこれが正解で、ハードルールにすべき**
- Storybook のビューポートを **390 / 744 / 1200 / 1900** に固定
- グリッドセルは `minmax(0,1fr)`（切り詰められるように）
- `whitespace-nowrap` が兄弟を飢えさせるパターンに注意
- 注意点: ピクセルスナップショットはタッチをエミュレートしないので `pointer: coarse` は別途契約が必要

### トランスポート

**Nimbalyst 方式を採る:** リレー（ホスト型 or セルフホスト）+ **鍵材をQRに載せたペアリング**、
メッセージ毎 AES-256-GCM、リレーは暗号文のみ。

- mux の LAN/VPN 方式より優れている（モバイル回線で壊れない）
- Omnara の平文クラウド方式より優れている（デーモンがファイルシステムを所有しているのだから
  トランスクリプトを平文で流すべきでない）
- Tailscale `serve` も引き続き有効な選択肢（[architecture.md](architecture.md) 参照）。
  **QRペアリング+暗号化リレーは「Tailscaleを入れたくない人向けの導線」として並置する**

**認証の注意点（Theia #5810 由来）:** iPad Safari が WebSocket upgrade リクエストに
HTTP basic 認証ヘッダを正しく載せないため、nginx リバースプロキシ配下で
Theia がローディングスピナーで止まった事例がある。
**モバイルクライアントの認証方式は、WS upgrade でブラウザ供給の認証情報に依存してはいけない。**

### 明示的に作らないもの

**side-by-side 差分、コードエディタ、インタラクティブなターミナル、コミットグラフ。**
この調査対象でこの4つ全部をモバイルに持つツールはゼロ、大半は1つも持たず、
Nimbalyst がこれらを省いた理由がそのままこの要件と一致している。

---

## 5. 実機で確認すべきこと（エミュレータでは分からない）

monaco-editor#4914 は物理iPhoneでのみ再現したバグなので、以下は実機で確認する必要がある。

| | なぜ |
|---|---|
| **今の Theia ビルドを実機のスマホで開き、AIチャットビューが使えるか見る** | **10分で最大の未知が潰れる。** Theia のAI/chatビューは React（Monacoではない）なので、ワークベンチの他の部分より既に要件に近い可能性がある |
| Chrome Android + EditContext で日本語IMEが実際に正しいか | #528（`こんにちは` → `んにちはこ`）は2021年にクローズ済みだが未検証。EditContext で改善しているはずだが確認していない |
| Monaco DiffEditor のインラインウィジェット（revert矢印等）のタップターゲットサイズ | タッチ用のissueが1件も無いので推測。親指で押せるかは未確認 |
| ダブルタップ単語選択 + ネイティブCopyで実用に足るか | 足りるならモバイルでのコピー要件が満たせる |
| Theia 1.60+ のタッチスプリッタドラッグが実際に快適か | Lumino のコードは確認したが実機では試していない |

---

## 出典

**Monaco タッチ**
[monaco-editor README FAQ](https://github.com/microsoft/monaco-editor#faq) ·
[#246 Any Plan for Mobile](https://github.com/microsoft/monaco-editor/issues/246) ·
[#1504 mobile (touch) support](https://github.com/microsoft/monaco-editor/issues/1504) ·
[#1143 Readonly view with mobile](https://github.com/microsoft/monaco-editor/issues/1143) ·
[#626 Unable to perform text selection using touch screen](https://github.com/microsoft/monaco-editor/issues/626) ·
[#4860 Enabling text selection handles on mobile](https://github.com/microsoft/monaco-editor/issues/4860) ·
[#4622 Add Touch Selection Support](https://github.com/microsoft/monaco-editor/issues/4622) ·
[PR #4623 (unmerged)](https://github.com/microsoft/monaco-editor/pull/4623) ·
[#528 Japanese IME not working on Android Chrome](https://github.com/microsoft/monaco-editor/issues/528) ·
[#2261 space bar duplicates words on android](https://github.com/microsoft/monaco-editor/issues/2261) ·
[#4880 Scrolling on mobile always consumes wheel](https://github.com/microsoft/monaco-editor/issues/4880) ·
[#4348 alwaysConsumeMouseWheel does not work on mobile](https://github.com/microsoft/monaco-editor/issues/4348) ·
[#5047 mousedown not supported for mobile](https://github.com/microsoft/monaco-editor/issues/5047) ·
[pointerHandler.ts](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/controller/pointerHandler.ts) ·
[touch.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/touch.ts) ·
[iPadShowKeyboard.ts](https://github.com/microsoft/vscode/blob/main/src/vs/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.ts) ·
[vscode#207699 EditContext](https://github.com/microsoft/vscode/issues/207699) ·
[caniuse EditContext](https://caniuse.com/mdn-api_editcontext) ·
[vscode#255717 iPadOS support](https://github.com/microsoft/vscode/issues/255717) ·
[vscode#235666 Safari copy/paste URL encoding](https://github.com/microsoft/vscode/issues/235666) ·
[vscode#302363 mobile Agent Supervisor view](https://github.com/microsoft/vscode/issues/302363) ·
[vscode#85254 Web: Mobile Safari support](https://github.com/microsoft/vscode/issues/85254) ·
[gitlab#28738 Web IDE desktop-only](https://gitlab.com/gitlab-org/gitlab/-/issues/28738) ·
[gitlab#28217 Touch selections in Web IDE on iPad](https://gitlab.com/gitlab-org/gitlab/-/issues/28217) ·
[Marijn Haverbeke — CodeMirror 6 Status Update](https://marijnhaverbeke.nl/blog/codemirror-6-progress.html) ·
[Replit — Betting on CodeMirror](https://replit.com/blog/codemirror)

**xterm.js タッチ**
[#5377 Limited touch support](https://github.com/xtermjs/xterm.js/issues/5377) ·
[#3727 Copy and paste do not work on touch devices](https://github.com/xtermjs/xterm.js/issues/3727) ·
[#3600 Erratic text output on Chrome Android](https://github.com/xtermjs/xterm.js/issues/3600) ·
[#2403 Accommodate predictive keyboard](https://github.com/xtermjs/xterm.js/issues/2403) ·
[ttyd PR#1496 mobile virtual keyboard](https://github.com/tsl0922/ttyd/pull/1496)

**Theia / Lumino / Jupyter**
[theia#3557 Better support for touch interfaces](https://github.com/eclipse-theia/theia/issues/3557) ·
[theia#6967 [mobile] Add meta viewport tag](https://github.com/eclipse-theia/theia/pull/6967) ·
[theia#14040 Make theia-ide available on android](https://github.com/eclipse-theia/theia/issues/14040) ·
[theia#5810 iPad Safari WS upgrade auth](https://github.com/eclipse-theia/theia/issues/5810) ·
[theia#15612 Cannot resize side panel when webview opened](https://github.com/eclipse-theia/theia/issues/15612) ·
[theia#10514 Refactor communication layer to use socket.io](https://github.com/eclipse-theia/theia/pull/10514) ·
[theia#3927 layout restoration across all clients](https://github.com/eclipse-theia/theia/issues/3927) ·
[Theia 1.60 Release (Phosphor→Lumino)](https://eclipsesource.com/blogs/2025/04/10/eclipse-theia-1-60-release-news-and-noteworthy/) ·
[Theia Communication via RPC](https://theia-ide.org/docs/json_rpc/) ·
[@theia/plugin-ext-headless](https://www.npmjs.com/package/@theia/plugin-ext-headless) ·
[lumino PR#123 Basic Touch Events](https://github.com/jupyterlab/lumino/pull/123) ·
[jupyterlab#8456 Incrementally improve mobile UX](https://github.com/jupyterlab/jupyterlab/pull/8456) ·
[jupyterlab#9567 Customize/disable mobile layout threshold](https://github.com/jupyterlab/jupyterlab/issues/9567) ·
[jupyterlab#9831 revert mobile auto-switching](https://github.com/jupyterlab/jupyterlab/pull/9831) ·
[jupyterlab#9871 Responsive design for simple and default modes](https://github.com/jupyterlab/jupyterlab/issues/9871) ·
[jupyterlab#13675 Responsive web design + PWA](https://github.com/jupyterlab/jupyterlab/issues/13675) ·
[New features in Notebook 7](https://jupyter-notebook.readthedocs.io/en/v7.0.6/notebook_7_features.html) ·
[jupyter/notebook#7817 container queries for side panel resizes](https://github.com/jupyter/notebook/pull/7817) ·
[coder/code-server iPad docs](https://coder.com/docs/code-server/ipad) ·
[Coder — coding on an iPad for two weeks](https://coder.com/blog/i-developed-on-an-ipad-for-two-weeks) ·
[code-server discussion #7037](https://github.com/coder/code-server/discussions/7037)

**モバイルエージェントクライアント**
[Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control) ·
[Nimbalyst](https://github.com/nimbalyst/nimbalyst) ·
[Nimbalyst Mobile](https://nimbalyst.com/mobile/) ·
[Omnara](https://github.com/omnara-ai/omnara) ·
[ACP clients registry](https://agentclientprotocol.com/get-started/clients) ·
[Agmente](https://github.com/rebornix/agmente) ·
[Ferngeist](https://github.com/arafatamim/Ferngeist) ·
[Happy](https://github.com/slopus/happy) ·
[Happier](https://github.com/happier-dev/happier) ·
[Mobvibe](https://github.com/Eric-Song-Nop/mobvibe) ·
[coder/mux](https://github.com/coder/mux) ·
[mux AGENTS.md](https://github.com/coder/mux/blob/main/docs/AGENTS.md) ·
[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)

**ライブラリ**
[git-diff-view](https://github.com/MrWangJustToDo/git-diff-view) ·
[react-diff-view](https://github.com/otakustay/react-diff-view) ·
[anser](https://github.com/IonicaBizau/anser) ·
[ansi_up](https://github.com/drudru/ansi_up) ·
[shiki-stream](https://github.com/antfu/shiki-stream) ·
[Base UI](https://base-ui.com)
