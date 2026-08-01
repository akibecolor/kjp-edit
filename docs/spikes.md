# Phase 0 スパイク実施手順

Theia **1.74.0**（2026-07-31リリース、`@lumino/widgets` 2.7.5 ピン）のソースを読んで確定した内容。
すべてソース実物で検証済み。行番号はドリフトする。

## 先に結論

| | 判定 | 一行 |
|---|---|---|
| **S1: シェルのサブクラス化** | **○ できる** | `@theia/toolbar` が in-tree で同じことをやっている（~95行）。全レイアウトメソッドが `protected` |
| **S1: ズーム意味論** | **◎ 既に実装済み** | `doToggleMaximized` が D3 ルール1をそのままやっている。ゲートを広げるだけ |
| **S1: 単一統合ツリー** | **× 硬いブロッカー2つ** | `Area` が閉じた union、`LayoutData` が非対称。サブクラスからは届かない |
| **S1: focus parent** | **× 今は表現不可能** | ツリー体系が2つあり共通ノード型が無い |
| **S2: バックエンドを器にする** | **○ できる** | `@theia/ai-mcp-server` が in-tree の証拠。FS/ターミナル/タスクは root シングルトン |
| **S2: ターミナル永続化** | **○ 構造的に保証されている** | `ProcessManager` が root シングルトン。`attach(id)` + 1MB リングバッファでリプレイ |
| **S2: デーモンが git を所有** | **× Theia 経由では不可** | git は connection-scoped なプラグインホスト内の `vscode.git` にしか存在しない |
| **S2: Electron が既存バックエンドに接続** | **△ 非公式だが ~15行** | フロントエンドは既に `?port=NNN` で繋いでいて、fork したかどうかを知らない |

---

# S1: レイアウト

## 1-A. `ApplicationShell` はサブクラスで置換できる（確定）

`frontend-application-module.ts:175-177`:
```ts
bind(ApplicationShellOptions).toConstantValue({});
bind(ApplicationShell).toSelf().inSingletonScope();
bind(SidePanelHandlerFactory).toAutoFactory(SidePanelHandler);
bind(SidePanelHandler).toSelf();
```

インタフェース+シンボルは無く、**具象クラスがトークンでもある。**
Theia 自身の `doc/coding-guidelines.md:105` がそのコストを説明している:

> 「クラスを注入トークンと型の両方に使うと、採用者はサブクラス化を強制される。
> そのクラスに代入可能な型にしか rebind できないからだ。[…] `private` または `protected`
> メンバを持つクラスは名前的に型付けされるので、構造的に同一な独立クラスは代入*できない* —
> サブクラスだけが可能。」

`ApplicationShell` は `private readonly tracker` などを持つので名前的型付け。
**→ サブクラスのみ。ゼロから書いたシェルは型が合わない。**

**良いニュース: 注入される依存はすべて `protected`**（`dockPanelRendererFactory`, `statusBar`,
`sidePanelHandlerFactory`, `splitPositionHandler`, `applicationStateService`, `corePreferences`,
`saveableService`, `secondaryWindowHandler`, `windowService`, `TheiaDockPanel.Factory`）。
サブクラスから全部触れる。

**レイアウト構築メソッドは全部 `protected`:**

| メソッド | 行 |
|---|---|
| `init()` (`@postConstruct`) | 341 |
| `createMainPanel()` | 590 |
| `createBottomPanel()` | 689 |
| `createTopPanel()` | 717 |
| `createBoxLayout()` | 727 |
| `createSplitLayout()` | 741 |
| **`createLayout()`** | 760 |
| `getAreaPanelFor()` / `findPanel()` | 1829 / 1836 |
| **`doToggleMaximized()`** | **public** 2188 |

`createLayout` の JSDoc が招待状になっている（`:756`）:
> 「アプリケーションシェルのレイアウトを組み立てる。**メインエリアとサイドパネルの配置を変えるには
> このメソッドをオーバーライドせよ。**」

**噛まれる `private` メンバ:** `tracker`（`FocusTracker<Widget>`）、`onCurrentChanged`、
`onActiveChanged`、`findWidgetForNode`、`checkActivation`。
**フォーカス/アクティベーションの*ポリシー*はサブクラスから上書きできない。**
`track()` は `protected` なので追加はできる。i3 風の focus parent にはこれが効いてくる（1-D）。

### in-tree の正典サンプル

`packages/toolbar/src/browser/application-shell-with-toolbar-override.ts` が**まさにこれをやっている:**

```ts
@injectable()
export class ApplicationShellWithToolbarOverride extends ApplicationShell {
    @inject(ToolbarFactory) protected readonly toolbarFactory: () => Toolbar;
    protected toolbar: Toolbar;

    @postConstruct()
    protected override init(): void { this.doInit(); }

    protected async doInit(): Promise<void> {
        this.toolbar = this.toolbarFactory();
        this.toolbar.id = 'main-toolbar';
        super.init();                      // super.init() を手で呼ぶ
        await this.toolbarPreferences.ready;
        this.tryShowToolbar();
        this.onDidToggleMaximized(() => this.tryShowToolbar());
    }

    protected override createLayout(): Layout {
        const bottomSplitLayout = this.createSplitLayout(
            [this.mainPanel, this.bottomPanel], [1, 0], { orientation: 'vertical', spacing: 0 });
        const panelForBottomArea = new TheiaSplitPanel({ layout: bottomSplitLayout });
        panelForBottomArea.id = 'theia-bottom-split-panel';
        const leftRightSplitLayout = this.createSplitLayout(
            [this.leftPanelHandler.container, panelForBottomArea, this.rightPanelHandler.container],
            [0, 1, 0], { orientation: 'horizontal', spacing: 0 });
        const panelForSideAreas = new TheiaSplitPanel({ layout: leftRightSplitLayout });
        panelForSideAreas.id = 'theia-left-right-split-panel';
        return this.createBoxLayout(
            [this.topPanel, this.toolbar, panelForSideAreas, this.statusBar],  // toolbar を挿入
            [0, 0, 1, 0], { direction: 'top-to-bottom', spacing: 0 });
    }
}

export const bindToolbarApplicationShell = (bind, rebind, unbind): void => {
    bind(ApplicationShellWithToolbarOverride).toSelf().inSingletonScope();
    rebind(ApplicationShell).toService(ApplicationShellWithToolbarOverride);
};
```

**約95行、`init()` と `createLayout()` のオーバーライドだけ、他は一切変更なし。**

### 呼び出し側は触らなくてよい

- **68ファイル**が `@inject(ApplicationShell)` を持つ
- **111ファイル / 448箇所**が `ApplicationShell` に言及（大半は `.WidgetOptions` / `.Area`）

全部が*トークン* `ApplicationShell` を解決するので、`rebind(...).toService(MyShell)` が透過的に
全部を差し替える。`FrontendApplication`（`get shell()`）も含む。**呼び出し側の変更ゼロ。**

⚠️ **唯一の実務的制約: `@theia/toolbar` が既に rebind スロットを占有している。**
製品でツールバーを使うなら `ApplicationShellWithToolbarOverride` を継承すること。
（`toolbar-content-hover-widget-patcher.ts:28,39` にサブクラスへの `instanceof` がある。）

### 他の先行事例

- **Arduino IDE 2.x**（実運用、OSS）: `rebind(TheiaApplicationShell).to(ApplicationShell)` で
  `addWidget`（挿入位置）、`doRevealWidget`、`handleEvent`（ドラッグ全面禁止）、`createTopPanel`、
  `saveAll` をオーバーライド。**ただし `createLayout` は触っていない** — box/split 構造はそのまま。
  DnD 要件のために `DockPanel.prototype.handleEvent` を Lumino のプロトタイプに
  モンキーパッチしている（拡張の継ぎ目が足りなかった証拠）
- **Eclipse Che / che-theia: 検証済みでゼロ。** 全ツリーを grep して9行3ファイル、
  すべて素の `@inject(ApplicationShell)` 消費者。シェルを触っていない
- **theia-blueprint: 検証済みでゼロ。** ブランディングと製品設定のみ
- **`examples/api-samples`: シェル/レイアウトのサンプルは無い。** `@theia/toolbar` が事実上のサンプル
- ST / Samsung / TI / Arm / Google Cloud Shell はクローズドソースで確認不可
  （1.74 の changelog に TI と ST が貢献者として出てくるので、上流化が彼らの戦略と見える）

## 1-B. ◎ ズーム意味論は既に実装されている

**これが今回最大の発見。** `application-shell.ts:2187-2237`:

```ts
protected unmaximize: (() => void) | undefined;

doToggleMaximized(area: TheiaDockPanel): void {
    if (this.unmaximize) { this.unmaximize(); this.unmaximize = undefined; return; }

    const parent = area.parent as SplitPanel;
    const layout = area.parent?.layout as SplitLayout;
    const sizes = layout.relativeSizes().slice();        // ← サイズを記憶
    const stretch = SplitPanel.getStretch(area);
    const index = parent.widgets.indexOf(area);
    parent.layout?.removeWidget(area);                   // ← ツリーから外す

    this.maximizedElement.style.display = 'block';
    area.addClass(MAXIMIZED_CLASS);
    UnsafeWidgetUtilities.attach(area, this.maximizedElement);   // ← 固定オーバーレイに再親付け
    area.fit();

    this.unmaximize = () => {
        area.removeClass(MAXIMIZED_CLASS);
        if (area.isAttached) { UnsafeWidgetUtilities.detach(area); }
        parent?.insertWidget(index, area);                // ← 厳密に復元
        SplitPanel.setStretch(area, stretch);
        layout.setRelativeSizes(sizes);                   // ← サイズを復元
        parent.fit();
    };
}
```

オーバーレイのホストはコンストラクタで作られる（`:306-314`）:
```ts
this.maximizedElement = this.node.ownerDocument.createElement('div');
this.maximizedElement.style.position = 'fixed';
this.maximizedElement.style.zIndex = '2000';
```

**[architecture.md](architecture.md) D3 のルール1「ズームは1ノードに対するビュー変換であり、
どこのサイズにも触らない。可逆なジオメトリ交換」は、Theia の既存の実装戦略そのものだった。**
親の `SplitLayout` から detach し、`(index, stretch, relativeSizes)` を記憶し、
`position:fixed; z-index:2000` の div に attach し、トグルで厳密復元する。
`UnsafeWidgetUtilities.attach/detach` がレイアウト抜きの再親付けを可能にする Lumino の抜け道。

**つまり `maximizedElement` + `unmaximize` が我々の `zoomedNodeId` のホストとして既に存在する。**
両方 `protected` なのでサブクラスから触れる。`doToggleMaximized` は `public`。

既存の周辺:
- `MAXIMIZED_CLASS = 'theia-maximized'`（エクスポート済み）
- `readonly onDidToggleMaximized: Event<Widget>`
- コマンド `core.toggleMaximized`、**キーバインド `alt+m`**
- タブのダブルクリックで最大化（`workbench.tab.maximize` 設定）

### 広げるべきゲート（2箇所だけ）

`:2162-2173`:
```ts
canToggleMaximized(widget = this.currentWidget): boolean {
    const area = widget && this.getAreaFor(widget);
    return area === 'main' || area === 'bottom';        // ← 制限1
}
toggleMaximized(widget = this.currentWidget): void {
    const area = widget && this.getAreaPanelFor(widget);
    if (area instanceof TheiaDockPanel && (area === this.mainPanel || area === this.bottomPanel)) {
        this.doToggleMaximized(area);                    // ← 制限2: エリア単位のみ
        this.revealWidget(widget!.id);
    }
}
```

1. **`main` / `bottom` のみ。** サイドパネルは除外
2. **エリア単位のみ。** 単一タブやメインエリア内のサブ split は最大化できない

両方 `public` メソッドで `getAreaPanelFor`/`findPanel` は `protected` なので**サブクラスで自明に外せる。**

⚠️ ただし `doToggleMaximized` は `area.parent` が `SplitLayout` を持つ `SplitPanel` である前提。
`mainPanel`/`bottomPanel` では真だが、**サイドパネルの親は `createContainer()` 由来の `BoxPanel` なので偽。**
素朴にサイドパネルを渡すと `layout.relativeSizes()` が `BoxLayout` に存在せず復元パスが壊れる。
**これは実行して確かめる（下記 Step 5）。**

**関連 issue: [#14511「Add Maximize icon to all views」](https://github.com/eclipse-theia/theia/issues/14511)**
が2024-11から open、リンクされたPRもアサインも無い。**まさに欲しいものを要求していて、競合PRが無い。**

## 1-C. × 単一統合ツリーの硬いブロッカー2つ

### ブロッカー1: `ApplicationShell.Area` は閉じた union

`application-shell.ts:2247-2271`:
```ts
export type Area = 'main' | 'top' | 'left' | 'right' | 'bottom' | 'secondaryWindow';

export function isValidArea(area?: unknown): area is ApplicationShell.Area {
    const areas = ['main', 'top', 'left', 'right', 'bottom', 'secondaryWindow'];  // ← 2回目のハードコード
    return typeof area === 'string' && areas.includes(area);
}
```

enum ではなく string-literal union で、リストが `isValidArea` の中に**2度目にハードコード**されている。
ルーティングは `addWidget`（`:1004-1040`）の `switch` で終端が:
```ts
default:
    throw new Error('Unexpected area: ' + options?.area);
```
同じ throw が `getWidgets`、`expandPanel`、`collapsePanel`、`resize` にもある。

**未知のエリア → 実行時 throw。エリア集合は閉じている。**
サブクラスで `addWidget`/`getWidgets`/`getAreaFor`/`expandPanel`/`collapsePanel`/`resize` を
全部オーバーライドすれば広げられるが、**エクスポートされた `type Area` と `isValidArea` は
111ファイルと `@theia/plugin-ext` が消費しているので、外部から*型*を広げられない。**

**これが「単一統合レイアウトツリー」に対する最大の構造的反論: Theia の公開APIはエリアキーであってツリーキーではない。**

（1つだけ公式の継ぎ目がある: `WidgetAreaResolver`（`:184-188`）。
ただし**既存エリア間で再ルーティングするだけでエリアを追加しない。**）

### ブロッカー2: `LayoutData` が非対称

`application-shell.ts:2358-2381`:
```ts
export interface LayoutData {
    version?: string | ApplicationShellLayoutVersion,
    mainPanel?: DockPanel.ILayoutConfig;          // ← 完全な Lumino ツリー
    bottomPanel?: BottomPanelLayoutData;          // ← config?: DockPanel.ILayoutConfig
    leftPanel?: SidePanel.LayoutData;             // ← { type:'sidepanel', items?: WidgetItem[], size? } フラット
    rightPanel?: SidePanel.LayoutData;
    activeWidgetId?: string;
}
```

**スキーマに非対称性が明示されている。main/bottom は完全な `DockPanel.ILayoutConfig` ツリーを得るが、
left/right は `expanded: boolean` 1個のフラットな `items[]`。分割されたサイドパネルは表現できない。**
これだけでレイアウトバージョンのバンプが強制される。

`applicationShellLayoutVersion = 5.0`（union は `6.0` を予約しているが未使用）。
古いレイアウト → `ApplicationShellLayoutMigration` を昇順実行、届かなければ throw して
デフォルトレイアウトにフォールバック。新しいレイアウト → 警告して**とにかくロードを試みる**。

### 1-D. × focus parent は今は表現不可能

**`focusParent` の出現箇所はリポジトリ全体でゼロ。**
Theia のナビゲーション語彙は *エリア → タブバー → タブ* の平坦な3階層で、
**「現在のフォーカスを含む split ノード」という概念が無い。**

コンテナツリーは `DockPanel` の*内側にだけ*存在する。
`lumino/docklayout.ts` の `saveLayout()` はスナップショットを返すが:
```ts
export interface ISplitAreaConfig { type:'split-area'; orientation; children: AreaConfig[]; sizes: number[] }
export interface ITabAreaConfig  { type:'tab-area'; widgets: Widget[]; currentIndex: number }
```
**`AreaConfig` は children を持つが parent ポインタが無い。**
ライブのツリーには parent があるが `private _root` の中で、
`Private.SplitLayoutNode` / `Private.TabLayoutNode` は非エクスポート。
つまり `(dockPanel.layout as any)['_root']` に手を突っ込むことになる
（Theia 自身も `this['_onCurrentChanged']` などで同種のハックをやっている）。

**決定的な問題: メインエリアのタブから `mainPanel` を越えてシェルの外側構造へ、
同じノード型で登っていけない。** `shell.mainPanel.parent` は `TheiaSplitPanel` で
その `.layout` は `SplitLayout` — `Private.SplitLayoutNode` とは別の抽象。
**ツリー体系が2つあり、両方を跨ぐ共通ノード型が無い。**

## 1-E. 🆕 Theia 1.74 の `PerspectiveService` が話を変える

1.74.0 の changelog: **`[core] implemented perspectives + AI First perspective`
([#17832](https://github.com/eclipse-theia/theia/pull/17832))**

`packages/core/src/browser/perspective-service.ts`:
```ts
export interface PerspectiveDescriptor {
    id: string;
    label: string;
    viewPlacements: Map<string, ApplicationShell.Area>;   // ウィジェットID → エリア
    chromeOptions?: PerspectiveChromeOptions;            // { collapseAreas?: ('left'|'right'|'bottom')[] }
    primaryViews?: Partial<Record<ApplicationShell.Area, string>>;
    onActivate?(shell: ApplicationShell): void;
}
export const PerspectiveContribution = Symbol('PerspectiveContribution');
```

`doSwitchPerspective` のパターン:
```ts
this.savedLayouts.set(this.activePerspectiveId, this.shell.getLayoutData());
this.widgetAreaResolver.setActivePlacementMap(descriptor.viewPlacements);
const savedLayout = this.savedLayouts.get(id);
if (savedLayout) { await this.shell.setLayoutData(savedLayout); }
else { await this.applyViewPlacements(descriptor); }
```

**つまり 1.74 における*公式*の「別の配置を得る方法」は、シェルをサブクラス化するのではなく
`getLayoutData()`/`setLayoutData()` で `LayoutData` を差し替えることになった。**
（[Discussion #12672「Perspectives like in the Eclipse IDE」](https://github.com/eclipse-theia/theia/discussions/12672)
での以前の回答から立場が変わっている。）

**Step 8 でこれを評価する。** perspectives + `WidgetAreaResolver` + 一般化した
`doToggleMaximized` で製品要件が足りるなら、**シェルのサブクラス化は `createLayout` の変更だけに留められる。**

## 1-F. レイアウト保存はクライアント毎の localStorage

```ts
bind(LocalStorageService).toSelf().inSingletonScope();
bind(StorageService).toService(LocalStorageService);
```
キーは browser で `theia:<pathname>:layout` と `theia:<pathname>:perspective-layouts`、
Electron で `theia:layout`。**サーバ側には何も無い。**
これは D2/D5 の「レイアウトは共有しない」方針と一致するので望ましい。

⚠️ **実務上の罠: 古い `layout` が `createLayout` の変更を黙って隠す。**
`restoreLayout` が構築した構造の上に `setLayoutData` を走らせるので。
**実験の間は devtools で `localStorage.clear()` か `reset.layout` コマンドを毎回実行する。**

## S1 スパイク手順（8ステップ、1〜2日）

### Step 0（30分）— 捨てる拡張を用意する
```bash
npx theia-extension-generator my-shell-spike   # または examples/api-samples をコピー
```
Theia 1.74.0 に合わせる。
**PASS:** アプリが起動する。**FAIL:** 何より先にツーリングを直す。

### Step 1（45分）★— 最小のオーバーライドで rebind が効くことを証明する

参照: `packages/toolbar/src/browser/application-shell-with-toolbar-override.ts`

`src/browser/spike-shell.ts`:
```ts
import { ApplicationShell, Layout, TheiaSplitPanel } from '@theia/core/lib/browser';
import { injectable, postConstruct, interfaces } from '@theia/core/shared/inversify';

@injectable()
export class SpikeShell extends ApplicationShell {
    @postConstruct()
    protected override init(): void {
        console.warn('[SPIKE] SpikeShell.init');
        super.init();
    }

    protected override createLayout(): Layout {
        console.warn('[SPIKE] createLayout');
        // 意図的に見て分かる逸脱: left | right | main（メインを右端に）
        const bottomSplitLayout = this.createSplitLayout(
            [this.mainPanel, this.bottomPanel], [1, 0], { orientation: 'vertical', spacing: 0 });
        const panelForBottomArea = new TheiaSplitPanel({ layout: bottomSplitLayout });
        panelForBottomArea.id = 'theia-bottom-split-panel';

        const leftRightSplitLayout = this.createSplitLayout(
            [this.leftPanelHandler.container, this.rightPanelHandler.container, panelForBottomArea],
            [0, 0, 1], { orientation: 'horizontal', spacing: 0 });
        const panelForSideAreas = new TheiaSplitPanel({ layout: leftRightSplitLayout });
        panelForSideAreas.id = 'theia-left-right-split-panel';

        return this.createBoxLayout(
            [this.topPanel, panelForSideAreas, this.statusBar], [0, 1, 0],
            { direction: 'top-to-bottom', spacing: 0 });
    }
}

export const bindSpikeShell = (bind: interfaces.Bind, rebind: interfaces.Rebind): void => {
    bind(SpikeShell).toSelf().inSingletonScope();
    rebind(ApplicationShell).toService(SpikeShell);
};
```

**リロード前に必ず devtools で `localStorage.clear()`**（さもないと保存済み layout が隠す）。

**PASS:** `[SPIKE]` ログが両方出て、Explorer と Outline がエディタの**左**に来てエディタが右に押される。
**FAIL:** ログが出ない → モジュールのロード順、または `@theia/toolbar` が既に rebind している
（その場合 `ApplicationShellWithToolbarOverride` を継承する）。
**このステップ単独で「シェルをサブクラス化できるか」が答えになる。予想は PASS。**

### Step 2（30分）— 下流が壊れないことを確認する
```bash
grep -rn "inject(ApplicationShell)" node_modules/@theia/*/lib --include=*.js | wc -l   # ~68
grep -rn "instanceof ApplicationShell" node_modules/@theia/*/lib
```
操作確認: ファイルを開く / `workbench.action.splitEditorRight` / ターミナルを開く /
ボトムパネルをトグル / プラグインのツリービューを開く / `alt+m`。
**PASS:** コンソールエラー無しで5つ全部動く。予想は PASS。

### Step 3（2時間）★— サイドエリアは `multiple-document` を生き延びるか

`side-panel-handler.ts:190-203` が制限の実体:
```ts
protected createSidePanel(): TheiaDockPanel {
    const sidePanel = this.dockPanelFactory({
        mode: 'single-document'          // ← ここ
    });
```
`createSidePanel` は **`protected`** なのでオーバーライド可能。
そして Lumino の `mode` は**実行時に設定可能なアクセサ**（`dockpanel.ts:181-211`）。

**最速の探り方 — rebind すらせず devtools で:**
```js
shell.leftPanelHandler.dockPanel.mode = 'multiple-document'
```
その後 Explorer を開き、Outline を左パネルにドラッグして Explorer の*下*にドロップしてみる。

**PASS:** 2つのビューが左パネルに縦に並んで両方見えたまま。
**PARTIAL（予想）:** 描画はされるが (a) `SideTabBar` を複製するLumino自身のタブバーが
パネル内に二重に出る、および/または (b) `refresh()` が走るたびに split が1ビューに戻る。
**FAIL:** `refresh()`/`expand()` が例外を投げる。

**ソースからの予想は PARTIAL。** `SidePanelHandler` は**硬い不変条件の上に建っている:**
```ts
// refresh() :477-540
const hideDockPanel = currentTitle === null;      // 「現在のタブが無い」== 「パネルが畳まれている」
dockPanel.setHidden(hideDockPanel);
if (currentTitle) { dockPanel.selectWidget(currentTitle.owner); }   // ← 1ウィジェットに強制する
```
ドキュメントコメント（`:66-71`）も明言している:
> 「ウィジェットの可視性はタブ選択によって完全に制御される。ウィジェットはタブバーの
> `currentTitle` を設定することで表示され、パネルはそのプロパティを `null` にすることで隠される。」

壊れるものの一覧:
1. **`refresh()` の `selectWidget`** が毎回選択を単一のcurrentTitleに引き戻す
2. **タブバーが dock panel の外側にある。** `createContainer()` が `this.tabBar` を
   `contentPanel` とは別の `sidebarContainer` に置く。`multiple-document` では
   Lumino が**自前の**タブバーを内側に描くので**タブUIが二重になる**
3. `TheiaDockPanel.addWidget` のモード依存の早期リターンが効かなくなり、re-add が no-op ではなく*移動*になる
4. `SidePanelHandler.addWidget` が position を一切通していない（`SidePanel.WidgetOptions` は `rank?` だけ）
5. `expand(id)`/`collapse()` が単一選択の概念
6. **`getLayoutData()` が `{type:'sidepanel', items[], size}` を返す** — ツリーを保持できない（ブロッカー2）
7. `SideTabBar` が `allowDeselect: false, insertBehavior: 'none'` で単一選択向けにチューンされている
8. `initSidebarVisibleKeyContext()` が左パネル全体の show/hide を単位と仮定してモンキーパッチしている

**→ `mode` の変更は1行だが、限界は mode ではない。
`SidePanelHandler` を「フォークする」工数として見積もること。「オプションを渡す」ではない。**
**このステップは2時間でタイムボックスする。成果物は動く split パネルではなく*観察*。**

### Step 4（45分）★— エリア語彙が閉じていることを確認する（6番目のエリア案を殺す）

devtools で:
```js
shell.addWidget(someWidget, { area: 'sidecar' })
```
**期待: `Error: Unexpected area: sidecar`**

**決定ゲート: 統合ツリー設計に新しいエリア名が必要なら、ここで止まる。**
エクスポートされた `type Area` をフォークし、`ApplicationShell` を参照する111ファイルに
触ることになる。→ `WidgetAreaResolver` / `PerspectiveService`（既存6エリア間の再ルーティング）に
方針転換する。

### Step 5（1.5時間）★— 既存の最大化機構を任意サブツリーのズームに流用する

`SpikeShell` に:
```ts
override canToggleMaximized(widget = this.currentWidget): boolean {
    return !!widget;                      // 元: area === 'main' || area === 'bottom'
}
override toggleMaximized(widget = this.currentWidget): void {
    const panel = widget && this['findPanel'](widget);   // protected findPanel(), :1836
    if (panel instanceof TheiaDockPanel) {
        this.doToggleMaximized(panel);    // public, :2188
        this.revealWidget(widget!.id);
    }
}
```
Explorer をフォーカスして `alt+m`。

**PASS:** 左 dock パネルが `theia-maximized` の固定オーバーレイでウィンドウを埋め、
もう一度 `alt+m` でサイドパネル幅が変わらずに復元する。
**期待される FAIL:** `doToggleMaximized` 内の
`const layout = area.parent?.layout as SplitLayout; layout.relativeSizes()` で例外。
サイドパネルの親が `createContainer()` 由来の `BoxPanel` で `SplitPanel` ではないから。
**この形で失敗するなら良い結果** — 一般化すべき正確な6行が分かる
（`(index, stretch, sizes)` の記憶/復元で `BoxLayout` と `SplitLayout` を分岐させる）。

**「サイズに触らない」の検証:** 最大化前に
`shell['leftPanelHandler'].dockPanel.node.getBoundingClientRect().width` を記録し、
復元後に一致することを確認する。`unmaximize()` が記憶した配列で `setRelativeSizes(sizes)` を呼ぶので一致するはず。

### Step 6（1時間）★★— focus parent が表現可能かを確かめる（go/no-go）

エディタを3分割（右、次に下）してから devtools で:
```js
const cfg = shell.mainPanel.saveLayout();
JSON.stringify(cfg, (k, v) => k === 'widgets' ? v.map(w => w.id) : v, 2)
// ライブのprivateツリー:
shell.mainPanel.layout['_root']
shell.mainPanel.layout['_root'].children?.[0].parent === shell.mainPanel.layout['_root']
```
**PASS:** `cfg.main` が入れ子の `{type:'split-area', orientation, children, sizes}` になっていて、
かつ `layout['_root']` が歩ける `.parent`/`.children` を露出している。
**FAIL:** 本番バンドルで `_root` がマングルされている → 毎回 `saveLayout()` から再導出する制約になる。

**そして決定的なチェック: メインエリアのタブから `mainPanel` を越えてシェルの外側構造へ、
同じノード型で登れるか。** `shell.mainPanel.parent` は `TheiaSplitPanel` でその `.layout` は
`SplitLayout` — `Private.SplitLayoutNode` とは別の抽象。
**予想: 登れない。ツリー体系が2つあり共通ノード型が無い。**
**確認できたら「単一統合レイアウトツリー」は `createLayout` + `SidePanelHandler` + `Area` API の
書き換えであってサブクラス化ではない。ここが go/no-go。**

### Step 7（1時間）— 直列化が変更を生き延びるか

レイアウトを変えた状態で配置を作り、ページをリロードしてコンソールを見る。
**PASS:** `Layout version … is behind/ahead` 警告も `Initializing the default layout instead` も無く、配置が復元する。
**区別すべき FAIL:**
- `Layout version X is behind current layout version 5` → 形を変えたので
  `ApplicationShellLayoutMigration` と `applicationShellLayoutVersion` のバンプが必要（現在 5.0、union は 6.0 を予約）
- **サイドパネルの split が黙って平坦化される** → `SidePanel.LayoutData` がツリーを保持できないことの確認。
  **ブロッカー2の実証。** 統合ツリーの永続化には `SidePanel.LayoutData` を
  `DockPanel.ILayoutConfig` に置き換えてバージョンをバンプする必要がある

`localStorage.getItem('theia:' + location.pathname + ':layout')` で実際に書かれた内容を見る。

### Step 8（1時間）★— コミット前に安い代替を評価する

`packages/core/src/browser/perspective-service.ts` を読み、`PerspectiveContribution` を登録して
`viewPlacements` で Outline を `'left'`、Explorer を `'right'` に置き、
`chromeOptions.collapseAreas: ['bottom']` を付けて切り替える。

**PASS:** ウィジェットが移動し、`getLayoutData()`/`setLayoutData()` が往復し、`alt+m` も動く。
**決定:** perspectives + `WidgetAreaResolver` + 一般化した `doToggleMaximized`（Step 5）で
実際の製品要件が足りるなら、**シェルをサブクラス化しない。**
サブクラス化は `createLayout` の変更だけに留める（Step 1 のパターン、~95行、`@theia/toolbar` の前例）。

---

# S2: バックエンドをデーモンの器にする

## 2-A. ○ 自前エンドポイントは公式の拡張点

`packages/core/src/node/backend-application.ts` — **Express 4 が現役**
（`"express": "^4.22.2"`、`@theia/core/shared/express` として再エクスポート）。

```ts
export const BackendApplicationContribution = Symbol('BackendApplicationContribution');
export interface BackendApplicationContribution {
    initialize?(): MaybePromise<void>;
    /** バックエンドアプリの初期化完了後に呼ばれる。Express アプリを起動前に設定するために使う。
     *  例えば追加のエンドポイントを提供するため。 */
    configure?(app: express.Application): MaybePromise<void>;
    onStart?(server: http.Server | https.Server): MaybePromise<void>;
    onStop?(app?: express.Application): MaybePromise<void>;
}
```

そして:
```ts
/* Allow any number of websocket servers.  */
server.setMaxListeners(0);
```
**このコメントが追加WSサーバをアタッチしてよいという青信号。**

### in-tree の証拠

**`packages/ai-mcp-server/src/node/mcp-theia-server-impl.ts` が最良の前例** —
手書きのプロトコルサーバ丸ごとが Theia の Express アプリに乗っている:
```ts
@injectable()
export class MCPTheiaServerImpl implements MCPTheiaServer, BackendApplicationContribution {
    async configure?(app: express.Application): Promise<void> { this.httpApp = app; await this.start(); }
    protected setupHttpEndpoints(app: express.Application): void {
        app.all('/mcp', async (req, res) => { await this.handleStreamableHttpRequest(req, res); });
    }
}
```
MCP の `StreamableHTTPServerTransport` を Theia 自身の Express アプリでルートスコープで動かしている。

他の参考: `metrics-backend-application-contribution.ts`（最小形）、
`file-download-endpoint.ts`（Router + auth guard）、
`mini-browser-endpoint.ts`（vhost 付きサブパスマウント）。

## 2-B. ○ バックエンドに存在するサービス

| | 状況 |
|---|---|
| **`FileService`** | **フロントエンド専用。** `packages/filesystem/src/browser/` にしかない |
| **`DiskFileSystemProvider`** | **サーバ側で直接注入可能。** URI ベースの完全なFS API: `stat`, `access`, `fsPath`, `readdir`, `readFile`, `readFileStream`, `writeFile`, `open/close/read/write`, `mkdir`, `delete`, `rename`, `copy`, `watch`, `updateFile`。**デーモンはこれを使う** |
| ファイル監視 | `FileSystemWatcherService`（Parcel ベース、`--no-cluster` でなければ**子プロセス**として spawn） |
| **`ProcessManager` / `ITerminalServer` / `IShellTerminalServer`** | **バックエンドrootシングルトン。全フロントエンド接続で共有。** `ConnectionContainerModule` ではない素の root `ContainerModule` |
| **`TaskServer`** | root シングルトン、マルチクライアント対応（`client.onDidCloseConnection(() => taskServer.disconnectClient(client))`） |
| **git** | **存在しない。下記 2-D** |
| **LSP プロキシ** | **存在しない。** `languages` パッケージが無い。言語サーバは接続毎のプラグインホスト内で VS Code 拡張が spawn する |

## 2-C. ○ ターミナル永続化は構造的に保証されている

`ProcessManager` が root シングルトンなので**ターミナルプロセスは接続に所有されておらず、
フロントエンドの切断を生き延びる。**

プロトコルに reattach が明記されている（`base-terminal-protocol.ts`）:
```ts
export interface IBaseTerminalServer extends RpcServer<IBaseTerminalClient> {
    create(options: object): Promise<number>;
    attach(id: number): Promise<number>;
    onAttachAttempted(id: number): Promise<void>;
    resize(id: number, cols: number, rows: number): Promise<void>;
    close(id: number): Promise<void>;
}
```
フロント側は `storeState()` で `terminalId` を localStorage に入れ、
`restoreState()` → `start(state.terminalId)` → `shellTerminalServer.attach(id)` で復帰する。
**出力のリプレイは `MultiRingBuffer`**（`{ size: 1048576 }` = 1MB、
ソースに `/* 1MB size, TODO should be a user preference. */` とある）。

**`terminal.integrated.enablePersistentSessions` 相当の設定は無い。**
`terminal-preferences.ts` の全キーを列挙して確認した。永続性は構造的（root スコープの `ProcessManager`）+
ターミナルIDがフロントの localStorage に入っていること、で成立している。

**代わりに効くノブがバックエンド設定にある:**
```ts
/** フロントエンドが切断した後、再接続のために接続コンテキストを保持する時間(ms)。 */
readonly frontendConnectionTimeout?: number;
```
```ts
if (timeout === 0 || isMarkedForClose) { this.closeConnection(frontEndId, evt); }
else if (timeout > 0) { setTimeout(() => this.closeConnection(...), timeout); }
else { /* timeout < 0: never close the back end */ }
```
**`FRONTEND_CONNECTION_TIMEOUT=-1` で接続コンテキストを絶対に破棄しない。**
未文書だがソースに明示されていて、デーモンに直接有用。
（`theia-ide/applications/browser/package.json` は `"frontendConnectionTimeout": 3000` +
フロントの `"reloadOnReconnect": true` を設定している。）

## 2-D. × デーモンが git を所有する経路が Theia には無い ← 設計に影響

正直な答え:

- **`@theia/git` は完全に削除された** — changelog:
  `[git] removed @theia/git extension code entirely (deprecated since v1.58.0) #17148`
- **`packages/scm/src/node/scm-backend-module.ts` は文字通り設定だけ:**
  ```ts
  export default new ContainerModule(bind => { bindScmPreferences(bind); });
  ```
- `packages/scm-extra/src/` には `browser/` しかない

**→ git は connection-scoped なプラグインホスト内の `vscode.git` としてのみ存在し、
VS Code 拡張API（`extensions.getExtension('vscode.git').getAPI(1)`）経由でしか到達できない。
バックエンドDIから呼べるgitサービスも、RPC経路も、何も無い。**

さらに悪いことに、**headless プラグインは headless プラグインだけをホストする*別の*
プラグインホストプロセスで走るので、そこからも `vscode.git` に到達できない。**

**→ デーモンが git を所有するなら自分で `git` をシェルアウトする**
（`@theia/process` の `RawProcessFactory` 経由など）。
**幸い [research.md](research.md) の時点で既に「`git log --topo-order` をシェルアウトする」と
決めていたので設計変更は要らない。ただし理由が変わった** —
「10万コミットで正しくて速いから」だけでなく「**Theia には他の選択肢が無いから**」でもある。
そして `@theia/scm` の SCM ビューと Theia 1.71 のコミットDAGは
**プラグインホスト内の `vscode.git` に駆動されている**ので、
我々の git エンジンと共存させる設計を最初に決める必要がある。

## 2-E. △ Electron が既存バックエンドに接続する

### 今の起動の仕組み

`packages/core/src/electron-main/electron-main-application.ts`:
```ts
protected async startBackend(): Promise<number> {
    const noBackendFork = process.argv.indexOf('--no-cluster') !== -1;
    if (noBackendFork) { dynamicRequire(this.globals.THEIA_BACKEND_MAIN_PATH); ... }
    else {
        const backendProcess = fork(this.globals.THEIA_BACKEND_MAIN_PATH, ...);
        return new Promise((resolve) => {
            backendProcess.on('message', (address: AddressInfo) => { resolve(address.port); });
        });
    }
}
```
エフェメラルポート確定: `const DEFAULT_PORT = environment.electron.is() ? 0 : 3000;`

### 公式サポートは無い（確定）

`THEIA_*` 環境変数で redirect するものは存在しない。
issue [#174](https://github.com/eclipse-theia/theia/issues/174)（2017）と
[#2056](https://github.com/eclipse-theia/theia/issues/2056) がまさにこれを要求して**未実装**。
`#2056` はチームが JSON-RPC のバージョンスキューリスクを挙げてクローズ。

**`@theia/remote` は助けにならない。** README の通り、リモート側で**新しいバックエンドを
プロビジョニングして spawn** し（Node とバックエンドをコピーして）、それをプロキシするもの。
「既に走っているバックエンドにアタッチする」サポートはゼロ。`@theia/dev-container` も同じ。

### しかし ~15行のオーバーライドで済む（フロントエンドは既に対応している）

2つの事実が味方する。

```ts
// electron-main-application.ts
protected async createWindowUri(params: WindowSearchParams = {}): Promise<URI> {
    if (!('port' in params)) { params.port = (await this.backendPort).toString(); }
    ...
    return FileUri.create(this.globals.THEIA_FRONTEND_HTML_PATH).withQuery(query);
}
```
```ts
// browser/endpoint.ts
get host(): string {
    if (this.options.host) { return this.options.host; }
    if (this.location.host) { return this.location.host; }
    return 'localhost:' + this.port;
}
protected get port(): string { return this.getSearchParam('port', '3000'); }
```

Electron のレンダラは `file://.../index.html?port=NNN` をロードするので `location.host` が空で、
フロントエンドは `localhost:<クエリのport>` に繋ぐ。
**フロントエンドは、そのバックエンドを自分が fork したかどうかを知らない。**

```ts
// my-ext/src/electron-main/attach-backend-module.ts
@injectable()
export class AttachingElectronMainApplication extends ElectronMainApplication {
    protected override async startBackend(): Promise<number> {
        const existing = process.env.KJP_DAEMON_PORT;
        if (existing) { return Number(existing); }   // fork しない。attachElectronSecurityToken() は走る
        return super.startBackend();
    }
}
export default new ContainerModule((bind, unbind, isBound, rebind) => {
    bind(AttachingElectronMainApplication).toSelf().inSingletonScope();
    rebind(ElectronMainApplication).toService(AttachingElectronMainApplication);
});
```
（`"theiaExtensions": [{ "electronMain": "lib/electron-main/attach-backend-module" }]`）

**気をつけるのはセキュリティトークンだけ:**
```ts
// electron-node/token/electron-token-validator.ts
allowRequest(request: http.IncomingMessage): boolean {
    if (!this.electronSecurityToken) { return true; }   // ← 環境変数が無ければ全許可
    ...
}
```
長寿命デーモンは Electron main が生成するのと**同じ** `ElectronSecurityToken` 環境変数値で
起動する必要がある（未設定なら検査が無効化される — スパイクには十分、出荷には不可）。
そして Electron モードでは browser connection-token が自己無効化するので**唯一のゲートがこれ。**

**判定: 非公式だが ~15行・低リスク・プロトコル変更なし。**
リスクは `startBackend()` が `protected` で将来リファクタされうること（年単位で安定してはいる）。

## 2-F. ⚠️ プラグインホストは接続毎（コストを認識する）

| 階層 | バインド元 | 寿命 | 例 |
|---|---|---|---|
| **root / バックエンドグローバル** | 素の `ContainerModule` | プロセス | `ProcessManager`, `ITerminalServer`, `TaskServer`, `DiskFileSystemProvider`, `MCPTheiaServerImpl`, headless プラグインホスト |
| **接続毎** | `ConnectionContainerModule.create(...)` | フロントエンドのソケット + 猶予 | **`HostedPluginProcess`, `HostedPluginSupport`, `HostedPluginServer`** |

**→ ブラウザタブ2つ = fork されたプラグインホストプロセス2つ = 全VS Code拡張のコピー2つ、
言語サーバ2つ、`vscode.git` のコピー2つ。**

既知の issue:
- [#10526](https://github.com/eclipse-theia/theia/issues/10526):
  「複数のブラウザウィンドウはバックエンドで同じプラグインプロセスを共有すらせず、
  同じ Theia アプリの完全に別のインスタンスのように振る舞う。バックエンド経由で
  一部のシングルトンを共有する点だけが違う」
- [#6412](https://github.com/eclipse-theia/theia/issues/6412): タブ毎に Java LS プロセスが増えてCPU高負荷
- [#7682](https://github.com/eclipse-theia/theia/issues/7682): タブAで開いたターミナルウィジェットがタブBに無い

**→ ワークベンチ + 軽量モバイルクライアントには問題ないが、
モバイルクライアントがプラグインホストを必要とする設計にしてはいけない。**（D5 と一致）

### 🎯 デーモンが存在する理由の最も強い実証

**ターミナルIDはブラウザの localStorage に住んでいる。**
別のブラウザから開くと、プロセスは生きているのに**誰もそのIDを知らないのでターミナルが見えない。**
**この登録簿をデーモンが所有する必要がある。** これがスパイク Step 6-3 で実際に観察できる。

⚠️ **副作用として認識すべきこと:** `ProcessManager` は1つの root シングルトンで整数ID空間も1つ。
`IShellTerminalServer.attach(id)` は**所有権チェックを一切しない**（`this.processManager.get(id)` だけ）。
**どの接続クライアントでも（モバイルクライアントでも）他のクライアントが作ったどのターミナルにもアタッチできる。**
「スマホがデスクトップで開いたターミナルにアタッチする」には*機能*だが、
クロスクライアント分離の穴でもあるので意図的に決めること。
（`DispatchingBaseTerminalClient` はターミナルの exit/error イベントを**全**登録クライアントにファンアウトする。）

## 2-G. ⚠️ セキュリティゲート（**1.73.0** で追加。1.74 ではない）

🛑 **訂正:** 当初この節を「1.74 の新しいゲート」と書いていたが**誤り。
PR #17701 は 2026-06-23 マージ、マイルストーン 1.73.0**（1.73.0 は 2026-06-25 公開、
1.74.0 は 2026-07-31）。CVE 修正のバージョン境界を間違えると脆弱な系列をピンすることになる。

🛑 **そして Theia には 2026-07-03 公開の High 級アドバイザリが2件あり、
両方 1.73.0 で修正されている。`>= 1.73.0` をハードフロアにする:**

| GHSA | CVSS | 内容 |
|---|---|---|
| **GHSA-78g8-vm3p-97c6** | **8.8** | Cross-Origin WebSocket Access To Shell-Terminal Enables Command Execution And Output Exfiltration。根本原因は **`@theia/core` の WebSocket origin 検証が fail-open**（`Origin` ヘッダが無い場合、または `THEIA_HOSTS` 未設定＝既定の場合に接続を受理）+ **socket.io 統合が信頼できる `Origin` をクライアント供給の `fix-origin` ヘッダで置き換えていた** |
| **GHSA-2m57-xxmh-v696** | **8.5** | `/services/request-service` RPC 経由の SSRF と localhost レスポンス開示。`BackendRequestFacade` の宛先URLが検証もallowlistもされていない典型的なSSRF |

**1件目はこの製品の脅威モデルそのもの。** `THEIA_HOSTS` を明示的に設定し、
既定に依存しないこと。両CVEをスパイクの回帰テストにする。
（別途 CVE-2021-34435 mini-browser RCE 8.8、CVE-2019-17636 8.1、
CVE-2021-41038 webview postMessage ハイジャックもある。）

`packages/core/src/node/hosting/browser-connection-token.ts`:
```ts
export const BROWSER_TOKEN_COOKIE_NAME = 'theia-connection-token';
/** ブラウザデプロイでは、サーバが起動時にランダムトークンを生成し
 *  最初のページロードで `SameSite=Strict; HttpOnly` クッキーとして設定する。
 *  WebSocket のアップグレードは常に検証される。Electron デプロイではスキップされる。 */
allowWsUpgrade(request: http.IncomingMessage): MaybePromise<boolean> {
    if (environment.electron.is()) { return true; }
    const token = this.getTokenFromCookie(request);
    if (token) { return this.isTokenValid(token); }
    return false;   // クッキー無し = 拒否
}
```
changelog:
> WebSocket 接続は `THEIA_HOSTS` が未設定のとき既定で same-origin 検証を強制し、
> `SameSite=Strict` の接続トークンクッキーを要求するようになった。#17701

**帰結2つ:**
1. **ネイティブのモバイルクライアントは、先にHTTP GETしてクッキーを拾って再送しない限り
   Theia の socket.io プロトコルを話せない。→ 自前のプレーンWSプロトコルを持つ実質的な論拠。**
2. **自前の `/api/v0/ws` アップグレードハンドラは `WsRequestValidator` を完全にバイパスする
   = 既定で認証が無い。そこは自分の責任。**
   HTTPルートには `@inject(HttpConnectionValidator)` + `validateRequest` をミドルウェアとして
   使えるが、ブラウザクッキー持ちしか通さないのでネイティブクライアント用に独自の bearer 方式が必要。

## S2 スパイク手順（1〜2日）

前提: Node ≥ 22、`node-pty` 用のビルドツール。

### Step 0（45分、大半がダウンロード）— browser-app を動かす
```bash
git clone https://github.com/eclipse-theia/theia-ide.git && cd theia-ide
git checkout v1.74.0
yarn
yarn download:plugins
yarn --cwd applications/browser build
yarn --cwd applications/browser start
```
`http://localhost:3000` を開く。
**FAIL:** ネイティブリビルド問題 → `yarn --cwd applications/browser rebuild`

スパイク中ずっと有用: `FRONTEND_CONNECTION_TIMEOUT=-1 yarn --cwd applications/browser start`

### Step 1（10分）— 1バックエンドに2クライアント
`http://localhost:3000` を **Chrome と Firefox** で開く
（**同一ブラウザの2タブは localStorage を共有して結果を汚すので別ブラウザで**）。
各々でターミナルを開いて `echo $$`。その後 `ps aux | grep plugin-host`。

**PASS:** 両方のワークベンチが機能し、独立したターミナルが2つ。
**期待される観察（買っているコスト）: `plugin-host` プロセスが2つ。** 1つなら 2-F を読み直す。

### Step 2（2〜3時間）★— `GET /api/v0/ping` とプレーンWS `/api/v0/ws`

拡張 `theia-extensions/daemon-api/` の `package.json`:
```json
{ "name": "daemon-api-ext", "version": "0.0.0",
  "dependencies": { "@theia/core": "1.74.0", "@theia/filesystem": "1.74.0", "@theia/terminal": "1.74.0" },
  "theiaExtensions": [ { "backend": "lib/node/daemon-api-backend-module" } ] }
```

`src/node/daemon-api-endpoint.ts`:
```ts
import * as http from 'http';
import * as https from 'https';
import * as express from '@theia/core/shared/express';
import * as WebSocket from '@theia/core/shared/ws';   // ws は既に依存で再エクスポート済み
import { inject, injectable } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { DiskFileSystemProvider } from '@theia/filesystem/lib/node/disk-file-system-provider';
import { IShellTerminalServer } from '@theia/terminal/lib/common/shell-terminal-protocol';
import URI from '@theia/core/lib/common/uri';

@injectable()
export class DaemonApiEndpoint implements BackendApplicationContribution {
    @inject(ILogger) protected readonly logger: ILogger;
    // どちらもバックエンドrootのシングルトン/サービス — RPC なしで直接注入できる
    @inject(DiskFileSystemProvider) protected readonly fs: DiskFileSystemProvider;
    @inject(IShellTerminalServer) protected readonly terminals: IShellTerminalServer;

    protected wss?: WebSocket.Server;

    configure(app: express.Application): void {
        const router = express.Router();
        router.get('/ping', (_req, res) => res.json({ pong: Date.now(), pid: process.pid }));
        // フロントエンド無しでバックエンドサービスに到達できる証明:
        router.get('/stat', async (req, res) => {
            try { res.json(await this.fs.stat(new URI(String(req.query.uri)))); }
            catch (e) { res.status(404).json({ error: String(e) }); }
        });
        router.post('/terminals', async (_req, res) => {
            const id = await this.terminals.create({} as any);
            res.json({ id });
        });
        app.use('/m', express.static(require('path').resolve(__dirname, '../../mobile-dist')));
        app.use('/api/v0', express.json(), router);
    }

    onStart(server: http.Server | https.Server): void {
        // noServer + 自前の 'upgrade' リスナ => ハンドシェイクを完全に制御する
        this.wss = new WebSocket.Server({ noServer: true });
        this.wss.on('connection', ws => {
            ws.on('message', data => ws.send(JSON.stringify({ echo: data.toString() })));
            ws.send(JSON.stringify({ hello: 'daemon', pid: process.pid }));
        });
        server.on('upgrade', (req, socket, head) => {
            const { pathname } = new URL(req.url ?? '/', 'http://localhost');
            if (pathname !== '/api/v0/ws') { return; }   // 他は socket.io/engine.io に譲る
            this.wss!.handleUpgrade(req, socket as any, head, ws => this.wss!.emit('connection', ws, req));
        });
    }

    onStop(): void { this.wss?.close(); }
}
```

`src/node/daemon-api-backend-module.ts`:
```ts
export default new ContainerModule(bind => {
    bind(DaemonApiEndpoint).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(DaemonApiEndpoint);
});
```

`applications/browser/package.json` の dependencies に `"daemon-api-ext": "0.0.0"` を追加して再ビルド。

**PASS:** `curl -s localhost:3000/api/v0/ping` が JSON を返す。
**FAIL:** ログに `no BackendApplicationServer is set...` → 静的配信を壊した。
拡張が拾われない → `theiaExtensions.backend` のパスか依存エントリが間違っている。

### Step 3（30分）★★— フロントエンドゼロでバックエンドサービスに到達できるか

**ブラウザを閉じた状態で:**
```bash
curl -s "localhost:3000/api/v0/stat?uri=file:///tmp"
curl -sX POST localhost:3000/api/v0/terminals
```
**PASS:** `/stat` が `Stat` を返し、`/terminals` がIDを返して `ps` に新しいシェルが見える。

**これがスパイク全体で最も重要な観察。** `DiskFileSystemProvider` と `IShellTerminalServer` が
root スコープでフロントエンド非依存であること = 「Theia のバックエンドを
我々のデーモンの器にする」が成立することの証明。
どちらかが接続スコープのバインディング欠如で throw するなら設計を練り直す。

### Step 4（20分）⚠️★— socket.io がプレーンWSを生かしてくれるか（唯一の未検証リスク）
```bash
npx wscat -c ws://localhost:3000/api/v0/ws
# 何か打つ → 5秒以上待つ → もう一度打つ
```
**PASS:** 5秒超えても接続が生きていてエコーが返る。
**FAIL:** ハンドシェイクの約1秒後にソケットが死ぬ → engine.io の `destroyUpgrade` に殺された。
対処を順に: (a) 自前の `'upgrade'` リスナを `WebsocketEndpoint.onStart` より**先に**登録する
（`initialize()` でフックを仕込む）、(b) socket.io 構築時に `{ destroyUpgrade: false }` を渡す
（`WebsocketEndpoint` の rebind が必要）、(c) 自前の `http.Server`/ポートで動かす
（`@theia/remote` がやっていること）。

**これがこのレポートでソースから確定できなかった唯一の項目なので早い段階に置いてある。**

併せて、**非ブラウザクライアントから Theia 自身のソケットを叩いて拒否されることを確認する:**
```bash
wscat -c "ws://localhost:3000/socket.io/?EIO=4&transport=websocket"
```
`theia-connection-token` クッキーが無いので**拒否されるのが正しい。**
これが「ネイティブモバイルクライアントは Theia のプロトコルを話そうとするべきでない」（2-G）の確認。

### Step 5（30分）— `/m` に2つ目のフロントエンド
最速版: `mkdir -p applications/browser/lib/frontend/m` して `index.html` を置くだけ →
`http://localhost:3000/m/`。**コードゼロ**で、既定の `express.static(lib/frontend)` が配信し、
gzip 事前ハンドラも `lib/frontend/<url>.gz` を解決するので効く。

本番版: Step 2 の `app.use('/m', express.static(...))`。
2つ目のバンドルのビルドは、生成された bundler 設定に既に多エントリの前例がある
（`'secondary-window': './src-gen/frontend/secondary-index.js'`）。
`applications/browser/esbuild.mjs` に自分のエントリを追加する。
（changelog が「webpack は esbuild に置き換えられて将来削除される」と言っているので **esbuild を選ぶ**。）

### Step 6（1時間）★★— ターミナル永続化を3段階でテスト

`FRONTEND_CONNECTION_TIMEOUT=-1` で始めて、プロセスの生存を接続コンテキストの破棄と切り分ける。

1. **F5 リロード。** ターミナルで `sleep 999 &`、`echo $$` でPIDを記録。リロード。
   **PASS:** 同じターミナルウィジェットがスクロールバック付きで同じPIDで戻る。
   **FAIL:** コンソールに `Failed attaching to terminal id N, the terminal is most likely gone`
2. **ブラウザを完全に閉じて再度開く**（同じブラウザなので localStorage は残る）。
   **PASS:** 再アタッチしてPIDが変わらない。`ps` でシェルが一度も死んでいないことを確認 —
   `ProcessManager` が root スコープだから
3. **別のブラウザ（またはプライベートウィンドウ）。**
   **期待される設計上のFAIL: ターミナルが復元されない** — IDが*別の*ブラウザの localStorage にあった。
   プロセスは生きているが誰もIDを知らない。

   ここで `GET /api/v0/terminals` を追加して `ProcessManager` を列挙し、
   その孤児が一覧に出てアタッチできることを確認する。
   **これがデーモンが埋める具体的なギャップであり、設計全体の最も強い単独の論拠。**
4. `FRONTEND_CONNECTION_TIMEOUT=0` と `3000` で 1 を繰り返し、
   タイムアウトより速い/遅いリロードで `reloadOnReconnect` の挙動を見る

### Step 7（2〜3時間、最後にやる）★— Electron が走っているバックエンドに繋ぐ
```bash
yarn --cwd applications/electron build
```
2-E の `AttachingElectronMainApplication` を `electronMain` モジュールとして追加。
```bash
# ターミナル1: デーモン（テストには普通の browser ターゲットのバックエンドでよい）
yarn --cwd applications/browser start --port 4000
# ターミナル2:
KJP_DAEMON_PORT=4000 yarn --cwd applications/electron start
```
**PASS:** Electron ウィンドウがワークベンチをロードし、`ps` に Electron が fork した `main.js` が
**無い** — バックエンド1つ、フロントエンド2つ（Electron + ブラウザタブ）でターミナルを共有。
**FAIL 1:** WS upgrade が403 → `ElectronSecurityToken` の不一致。

🛑 **ここで絶対にやってはいけない対処が2つある**（レビューで指摘。詳細は
[review-findings.md](review-findings.md) A1）:

- **`ElectronSecurityToken` を未設定にする** — `electron-token-validator.ts` は
  `if (!this.electronSecurityToken) { return true; }` なので検査が全許可になる
- **`THEIA_ELECTRON_VERSION` を設定してデーモンに自分を Electron だと思わせる** —
  `browser-connection-token.ts` の `allowWsUpgrade()` は
  `if (environment.electron.is()) { return true; }` で始まるので、
  **そのデーモンに繋ぐ*すべての*ブラウザフロントエンド（`/` も `/m` も）に対して
  クッキーゲートと same-origin 検証が無効化される**

そして `ws-request-validators.ts` の集約は**fail-open**（どれかが明示的に `false` を
返さない限り `true`）なので、この2つを組み合わせると
**`/services/shell-terminal` を含む全 RPC が任意オリジンに開放される。**
これは公開済みの **GHSA-78g8-vm3p-97c6（CVSS 8.8、1.73.0 で修正済み）**
「Cross-Origin WebSocket Access To Shell-Terminal Enables Command Execution
And Output Exfiltration」を設定で再現する行為。

**正しい対処:** **デーモン側が `ElectronSecurityToken` を生成し、
それを Electron main に渡す**（逆方向にする）。`THEIA_HOSTS` を明示的に設定する。
そして**3つのゲートのどれかが allow-all に解決したら listen を拒否する起動時アサーション**を入れる。
**FAIL 2:** ウィンドウが白く、コンソールが `localhost:3000` に繋いでいる →
`?port=` クエリが `Endpoint` に届いていない。

---

## ソースから確定できなかった項目

| 項目 | なぜ |
|---|---|
| **engine.io の `destroyUpgrade` が外部の `'upgrade'` ハンドラをどう扱うか** | **S2 最大の未知。** engine.io の実装からの推論で、Theia のソースからは確定できない。S2 Step 4 を早い位置に置いた理由 |
| プレーンな `ws` サーバを主 `http.Server` にアタッチする in-tree の例 | `ws` は依存で再エクスポート済み、`setMaxListeners(0)` も明示的に存在するが、**リポジトリ内に実例が無い。** 構造上サポートされているが実証されてはいない |
| すべての実行時挙動（S1全体） | ソースを読んだだけで何も実行していない。特に S1 Step 3（PARTIAL予想）と Step 5（`BoxLayout` での `relativeSizes()`） |
| `plugin-ext-headless` が「安定」か | 安定性の注記も `@experimental` も deprecation も無い。`// As yet there is no default API namespace...` のコメントが残っていることからの推論 |
| `startBackend()` オーバーライドが将来のバージョンを生き延びるか | `protected` で公式の拡張の継ぎ目ではあるが「既存バックエンドにアタッチする」公式APIではなく、#174/#2056 でメンテナは一度もコミットしていない |
| クローズドソースの Theia 製品のシェル改変 | ST / Samsung / TI / Arm / Google Cloud Shell は非公開 |
| Lumino の行番号 | `main` から読んだ。ピンされた `2.7.5` とは行番号が違う可能性（`ILayoutConfig` は年単位で安定） |
| `applicationShellLayoutVersion = 5.0` vs union の `6.0` | 見つかった通りに記載。なぜ `6.0` が宣言されて未使用なのかは追っていない |

## 出典

[theia master](https://github.com/eclipse-theia/theia) ·
[application-shell.ts](https://github.com/eclipse-theia/theia/blob/master/packages/core/src/browser/shell/application-shell.ts) ·
[side-panel-handler.ts](https://github.com/eclipse-theia/theia/blob/master/packages/core/src/browser/shell/side-panel-handler.ts) ·
[application-shell-with-toolbar-override.ts](https://github.com/eclipse-theia/theia/blob/master/packages/toolbar/src/browser/application-shell-with-toolbar-override.ts) ·
[backend-application.ts](https://github.com/eclipse-theia/theia/blob/master/packages/core/src/node/backend-application.ts) ·
[plugin-ext-headless README](https://github.com/eclipse-theia/theia/tree/master/packages/plugin-ext-headless) ·
[PR #17832 perspectives](https://github.com/eclipse-theia/theia/pull/17832) ·
[#14511 Maximize icon on all views](https://github.com/eclipse-theia/theia/issues/14511) ·
[#174 remote backend in electron](https://github.com/eclipse-theia/theia/issues/174) ·
[#2056 electron remote backend](https://github.com/eclipse-theia/theia/issues/2056) ·
[#10526 multi window](https://github.com/eclipse-theia/theia/issues/10526) ·
[#6412 multi-tab LS CPU](https://github.com/eclipse-theia/theia/issues/6412) ·
[#7682 widget state across tabs](https://github.com/eclipse-theia/theia/issues/7682) ·
[#13290 headless plugin docs](https://github.com/eclipse-theia/theia/issues/13290) ·
[Discussion #12672 Perspectives](https://github.com/eclipse-theia/theia/discussions/12672) ·
[Arduino IDE](https://github.com/arduino/arduino-ide) ·
[theia-ide blueprint](https://github.com/eclipse-theia/theia-ide) ·
[Theia Architecture](https://theia-ide.org/docs/architecture/) ·
[doc/coding-guidelines.md](https://github.com/eclipse-theia/theia/blob/master/doc/coding-guidelines.md)
