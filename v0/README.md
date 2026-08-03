# kjp-edit v0

**N 個のエージェントの worktree を1画面で見るローカルデーモン。**
依存パッケージゼロ（Node 標準ライブラリのみ）。
**既定は読み取り専用**で、checkout（`--allow-write`）と
任意コマンドの実行（`--allow-exec`）はそれぞれ明示的に有効化します。

```bash
node scripts/serve.mjs                # ← 普段はこれ（手順は docs/daily-use.md）
node scripts/serve.mjs --watch        # + エージェントの活動を観測する
node scripts/serve.mjs --status       # 動いているものを一覧 / --stop で止める
node scripts/autostart.mjs install    # ログオン時に自動起動（既定は読み取り専用）
```
→ http://127.0.0.1:7749

`serve.mjs` は**二重起動しない**（同じリポジトリなら URL を出して終わる）、
サブディレクトリからでも**リポジトリのルートを自動で見つける**、
ポートが埋まっていたら**空きを探して必ず表示する**、`--exec` では
**トークンを `~/.kjp-edit/token` に永続化する**（毎回貼り直さない）。

素のサーバを直接叩く場合:

```bash
node v0/server.mjs                    # カレントのリポジトリを見る
node v0/server.mjs --repo /path/to/r  # 別のリポジトリ（サブディレクトリでもルートに正規化される）
node v0/server.mjs --port 7749 --limit 300 --base main
```

```bash
node scripts/verify.mjs               # 構文 + unit + smoke + レイアウト
```

## なぜこれを先に作ったか

[../docs/scope.md](../docs/scope.md) の通り、**自分が使う道具**として、
**IDE にコミットする前に一番価値のある仮説だけを検証する**ため。

3回「差別化」を立てて3回崩壊させた（[../docs/s0-verification.md](../docs/s0-verification.md)）末に、
検証を生き延びたのは**「今日、自分に無いもの」**だけでした:

1. **N 個の並行エージェントの worktree を1画面で見る手段**
2. **全 worktree を跨いだ1枚のコミットグラフ** — 誰も持っていない
3. **同じファイルを複数の worktree が触っていることの検出**
4. **シーケンサ乗っ取りの警告** — 14以上のツールで誰もやっていない

**v0 が答える問い: 自分はこれを実際に見るか。** 見なければ数日で止められます。

## 見えるもの

| | |
|---|---|
| **Worktree カード** | ブランチ、base からの ahead/behind、dirty 状態、変更ファイル一覧 |
| **統合グラフ** | 全 worktree の HEAD を含む1枚のスイムレーングラフ。HEAD は白抜きの丸で強調 |
| **ファイル重複** | 2つ以上の worktree が触っているファイル |
| **🔍 衝突予測** | 候補ペアを `git merge-tree` で**実際にマージしてみて**衝突するかを出す。作業ツリーには触らない |
| **取り込み順序の提案** | 衝突グラフの独立集合を貪欲に取る。**追加の git 呼び出しは0、AI も使わない**。仮説であって保証ではない |
| **🚨 警告** | シーケンサ乗っ取りと `MERGE_HEAD` の消失リスク |
| **エージェントの活動**（`--watch-agents`） | 稼働中 / 待機 / 記録なし、直近のツールと触ったパス、件数。**既定オフ**（リポジトリ外の記録を読むため） |

## シーケンサ乗っ取りとは

git は **clean index の rebase が停止している最中に `checkout` / `commit` / `merge` を
exit 0 で通します。** その後の `rebase --continue` は**別のブランチにリプレイします。**
実際に再現して検出を確認済み:

```
rebase 対象: refs/heads/agent-a
git checkout -b hijacked → exit=0        ← git は止めない
HEAD は今: hijacked
しかし rebase 対象は: refs/heads/agent-a

[DANGER] rebase は refs/heads/agent-a に対して進行中だが
         HEAD は refs/heads/hijacked を指している。
         このまま rebase --continue すると間違ったブランチにリプレイされる。
```

同様に `git checkout -b` は解決済み未コミットのマージの **`MERGE_HEAD` を無警告で削除**し、
次の commit を単一親にします（マージの内容は残るが関係が消える）。

## 別端末（スマホ）から見る

UI は縦に積む折り畳みパネルで、各セクションは畳んだままでも要約が読めます
（`WORKTREES 6 本 · dirty 1 · prunable 1`）。開閉状態は `localStorage` に残ります。

390px 幅で実測して確認していること（`node v0/layout-check.mjs`）:

| | |
|---|---|
| 横スクロール | 出ない（`bodyScrollWidth == bodyClientWidth`） |
| worktree HEAD バッジ | **必ず見える。**これが消えるとこのツールの意味が無くなる |
| ブランチ ref バッジ | 700px 以下では隠す。390px では1〜2文字に潰れて情報にならないため |
| worktree カード | 1列に積む |
| 変更ファイル一覧 | カード内でスクロール |

### 🔒 トンネルの注意

このサーバは**認証を持ちません。**外から届かせる場合、
**トンネルをループバックで終端させ、トンネル側で認証してください。**

```bash
tailscale serve --bg 7749
# トンネル経由の Host は 127.0.0.1 ではなくなるので、明示的に許可する
node scripts/serve.mjs --allow-host box.your-tailnet.ts.net
```

手順とスマホ側の確認項目は [../docs/daily-use.md](../docs/daily-use.md) にあります
（**実機での確認はまだしていません**）。

**`--allow-host` を指定しない限り、ループバック以外の Host は 403 です。**
これは DNS rebinding を防ぐためで、`127.0.0.1` バインドと CORS では防げません
（攻撃者のページが自分のドメインを `127.0.0.1` に貼り替えると、
そのページのオリジン自体が `127.0.0.1` になって同一オリジン扱いで通ってしまう。
止められるのは Host ヘッダの検証だけ）。
攻撃者は自分の持たないホスト名を Host に入れさせられないので、
オプトインしても rebinding は防げたままです。

**`cloudflared` の quick tunnel（`trycloudflare.com`）を使わないこと。**
URL を知っている誰でも無認証でリポジトリの中身が読めます
（[../docs/hosting.md](../docs/hosting.md) の §2 に調査結果）。

## 設計上の約束

- 🔒 **`127.0.0.1` のみにバインド。認証は持たない。**
  外から届かせるならトンネル（`tailscale serve` 等）をループバックで終端させる。
  **`0.0.0.0` にバインドしないこと**（[../docs/architecture.md](../docs/architecture.md) D1）
- **既定は読み取り専用。** ただし衝突予測の `git merge-tree --write-tree` は
  **オブジェクトDB に loose object を書く**（ref / index / 作業ツリーには触らない。gc で回収される）。
  「書き込みは一切しない」とは言わない
- 書き込みと実行は capability を分けて明示的に有効化する
  （[../docs/auth-ordering.md](../docs/auth-ordering.md)）
- **git は `spawn(gitPath, argvArray)` で shell を使わない。**
  `-z` / `core.quotepath=false` / `i18n.logOutputEncoding=UTF-8` /
  `GIT_TERMINAL_PROMPT=0` を毎回渡す
  （[../docs/encoding-and-paths.md](../docs/encoding-and-paths.md) の「正典のレシピ」）
- **パスの内部正規形は NFC**（macOS の境界で正規化）

## 構成

| | |
|---|---|
| `git.mjs` | git の起動と解析。worktree 列挙、log、diff、シーケンサ状態検出 |
| `swimlanes.mjs` | レーン割当。VS Code の `scmHistory.ts`（MIT）を参考に再実装 |
| `swimlanes.test.mjs` | 回帰テスト。実際に踏んだバグを固定 |
| `server.mjs` | HTTP + `/api/v0/state`（+ `--layout-probe` で検査用の `/__probe`） |
| `app.html` | **統合 UI**（`/` と `/layout` が返す）。広い画面はドック、狭い画面は縦積み |
| `smoke.test.mjs` | 一時リポジトリを作って端から端まで検証 |
| `layout-check.mjs` | 実ブラウザで 390 / 768 / 1280px を測る。ブラウザが無ければスキップ |

| `ndjson.mjs` | 行区切り JSON のストリーム読み。**ブラウザと unit テストで共有** |
| `ndjson.test.mjs` | 行割れ・マルチバイト割れの回帰テスト |
| `mergeplan.mjs` / `.test.mjs` | 取り込み順序の提案（純関数）と unit テスト9件 |

### エンドポイント

| | |
|---|---|
| `/api/v0/state` | 全状態。`?fresh=1` で TTL キャッシュを無視。`stats.gitSpawns` に git の起動回数（定数5 + worktree 1本あたり3） |
| `/api/v0/diff?base=&ref=&path=` | 1ファイルの unified diff |
| `/api/v0/blob?ref=&path=` | ファイルの中身。512KB 超は `tooLarge`、NUL 混入は `binary` |
| `/api/v0/session` | 書き込み可否とトークン（同一オリジンにのみ返す） |
| `POST /api/v0/checkout` | ブランチ切り替え。**`--allow-write` が必要** |
| `POST /api/v0/exec` | 任意コマンドの実行。出力を行区切り JSON で流す。**`--allow-exec` が必要** |
| `/layout` | `/` の別名（互換のため） |

### 書き込み（既定オフ）

```bash
node v0/server.mjs --allow-write
```

**`--allow-write` を付けない限り、書き込みの経路は 403 です。**
有効にすると worktree カードに checkout が出ます
（切り替え先は「他の worktree が使っていないブランチ」だけを候補にします。
git は使用中のブランチを拒否するので、出しても必ず失敗する選択肢になるため）。

🚨 **checkout はシーケンサ停止中を拒否します。**
rebase / マージ未コミット / cherry-pick / revert / bisect の進行中は 409。
git はこれを exit 0 で通しますが、続きの `rebase --continue` は
**別のブランチにリプレイ**し、`MERGE_HEAD` は無警告で消えます。

副作用のある操作は `requireMutation()` を必ず通ります
（`--allow-write` / POST / `Sec-Fetch-Site: same-origin` / `X-Kjp-Token`）。
順序と理由は [../docs/auth-ordering.md](../docs/auth-ordering.md)。

### 実行（既定オフ、書き込みとは別の capability）

```bash
TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
node v0/server.mjs --allow-exec --token "$TOKEN"
```

`POST /api/v0/exec` に `{worktree, argv}` を送ると、出力が行区切り JSON で流れます
（`{"t":"out"|"err","d":"..."}` … `{"t":"exit","code":0}`）。

**PTY は使っていません。** Node 標準に PTY は無く、`node-pty` は依存を増やします。
そして **Claude Code は `claude -p "..."` で非対話実行できる**ので、
エージェントを遠隔から動かすのに PTY は不要です。

| | |
|---|---|
| `--allow-exec` | 既定オフ。**24文字以上の `--token` か `--token-file` が無いと起動しません**（有効化を必ず意識的な操作にするため） |
| `--token-file` | 無ければ 0600 で生成し、あれば読む（再起動でトークンが変わらない）。**リポジトリの中を指すと起動を拒否します**（コミットされるため）。`scripts/serve.mjs --exec` は `~/.kjp-edit/token` を自動で渡します |

### エージェントの活動観測（既定オフ、書き込み・実行とも別の capability）

```bash
node v0/server.mjs --watch-agents            # 状態・ツール名・パス・件数
node v0/server.mjs --allow-transcript-text   # + 発話とコマンド行
```

Claude Code のセッション記録（`~/.claude/projects/`）を読みます。
**これは読み取りの範囲を広げる変更**（`git cat-file` 経由のみ、という
不変条件を破る）なので、`--allow-write` に相乗りさせず別のフラグにしています。

| | |
|---|---|
| 読む場所 | `~/.claude/projects/` のみ。`.jsonl` 以外は開かない |
| 読む量 | 最新1本の**末尾 256KB だけ**（実測で 24MB の記録があった） |
| git の起動 | **増えません**（fs だけ。スモークテストで固定） |
| 既定で出るもの | 状態・経過時間・ツール名・件数・**worktree 相対のパス**・`permissionMode` |
| `--allow-transcript-text` で増えるもの | 発話（切り詰め）と `Bash` / `PowerShell` のコマンド行 |
| **どちらでも出さないもの** | **ツールの結果**（読んだファイルの中身・コマンド出力）、`thinking`、`Edit`/`Write` の内容、`message` 外の自由文 |

🚨 **抽出は許可リスト方式です。** ツールの結果には入口が5つあり
（`tool_result` / `toolUseResult` / `file-history-snapshot` /
`file-history-delta` / `attachment`）、形式は Claude Code の内部形式なので
フィールドは増えます。除外方式だと増えた瞬間に黙って漏れます。
判断の経緯と T5 を開けるための条件は
[../docs/agent-observation.md](../docs/agent-observation.md)。
| cwd | 既知の worktree のみ |
| shell | 使いません（`argv` 配列で受けます） |
| 監査 | `<GIT_DIR>/kjp-exec-audit.jsonl` に start / exit を追記 |
| 上限 | 既定 600 秒（`--exec-timeout`）／同時 8 本 |
| 切断 | クライアントが切れたら子プロセスを殺します |

🚨 **これは定義上そのまま remote code execution です。**
機能と脆弱性を分けるのは実装ではなく**誰が引けるか**だけです。
**トンネルは必ずループバックで終端し、トンネル側で認証してください。**
`tailscale funnel` / `trycloudflare.com` / 広い `--allow-host` のどれか1つで、
「トンネルに届く相手 = このマシンでコードを実行できる相手」になります。

🔒 **`diff` / `blob` は追跡されている内容だけを返します。**
`git cat-file` / `git diff` 経由で読むので、fs には触りません。
つまり**リポジトリ外のファイルも、未追跡の `.env` も読めません**
（スモークテストで固定してあります）。
`path` は `..` / 絶対パス / ドライブレター / 先頭 `-` / NUL を拒否、
`ref` はリビジョン式（`~` `^` `..`）と空白を拒否します。

## 実装中に踏んだバグ（回帰テスト済み）

1. **`%D`（refs）が空だと NUL が3連続し、`\0\0` でのレコード分割が1つずれて
   以降の全フィールドがシフトした。** → レコード区切りは改行、フィールド区切りは NUL にした
2. **output レーンを ID で重複排除しないと、同一コミットに2本開いたまま1本しか消費されず
   残り続けた**（16コミットで13レーン）
3. **しかし重複排除を `lane` の割当にも適用すると兄弟ブランチが同じレーンになった**
   （agent-a と agent-b が両方 lane 0）。
   「どこに点を描くか」と「下にどのレーンが続くか」は別の概念

## 次に判断すること

v0 を数日使ってから:

- **見る**なら → 操作（checkout / マージ順序の提案）を足すか、IDE に進むか
- **見ない**なら → 何が足りなかったかを記録して止める

グラフとデーモンは、IDE に進む場合そのままコミットグラフパネルと kjp-core になります
（[../docs/architecture.md](../docs/architecture.md)）。

MIT — [../docs/licensing.md](../docs/licensing.md)

## 応答時間

実測と引いた線は [../docs/performance.md](../docs/performance.md)。
要点: **支配要因はプロセス起動**（1回 5〜7ms）。
worktree 10本までを想定し、fresh 収集 p95 < 1000ms を目標にしている
（実測は 3本で 195ms、7本で 244ms）。
線を守る仕組みは「増やさないこと」そのもので、
`stats.gitSpawns` をテストが上限で固定している。
