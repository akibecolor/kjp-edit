# 毎日使うための手順（L1）

`docs/scope.md` の問い「**自分はこれを実際に見るか**」に答えるには、
まず「毎回コマンドを打たなくても動いている」状態が要る。そのための足回り。

---

## 起動

```bash
node scripts/serve.mjs              # カレントのリポジトリを読み取り専用で
node scripts/serve.mjs --write      # checkout も
node scripts/serve.mjs --exec       # 任意コマンドの実行も（🚨 遠隔コード実行）
node scripts/serve.mjs --status     # 動いているものを一覧
node scripts/serve.mjs --stop       # 止める
```

素の `node v0/server.mjs` で困っていたことを吸収している:

| 困っていたこと | どうしたか |
|---|---|
| 既に動いていると `EADDRINUSE` で落ちる | **同じリポジトリを見ているなら URL を出して終わる**（二重起動しない） |
| サブディレクトリから起動すると失敗する | `rev-parse --show-toplevel` でリポジトリのルートを自動で見つける |
| ポートが埋まっていると起動できない | 空きを探す。ただし**黙って変えず必ず表示する** |
| 実行を使うたびトークンを貼り直す | `--exec` のとき `~/.kjp-edit/token` に永続化する |

⚠️ `--repo` にサブディレクトリを渡した場合も**ルートに正規化する**。
これをしないと `merge-tree` が cwd 相対で衝突パスを返して `../shared.txt` になり、
`isSafeRepoPath` が弾いて UI から開けなくなる（レビュー指摘）。

### 状態の置き場所

`~/.kjp-edit/`（リポジトリの外）:

| | |
|---|---|
| `token` | 実行用トークン。0600 で作る |
| `exec-audit.jsonl` | 実行の監査ログ。**リポジトリ内だと実行した相手が消せる**ので外に置く |
| `last.json` | 最後に起動した設定（参考情報） |

⚠️ `--token-file` を**リポジトリの中に置こうとすると起動を拒否する**（コミットされるため）。

---

## 自動起動

```bash
node scripts/autostart.mjs status
node scripts/autostart.mjs install --repo C:/Users/akico/Documents/kjp-editor \
    --allow-host fractal2.tail73c198.ts.net
node scripts/autostart.mjs uninstall
```

**既定は読み取り専用で登録する。** `--write` / `--exec` を明示しない限り
capability は付けない（ログオンのたびに立ち上がるものに黙って権限を持たせない）。

⚠️ **`--allow-host` を渡し忘れると「再起動後だけ 403」になる。**
手元のループバックでは正常に見えるので気付けず、**スマホから見たときに初めて
分かる形で壊れる**。登録内容は `status` で確認できる（`Host 許可: …` が出る）。

登録した文字列が Windows に実行されたときに本当に効くかは実測した
（`CreateProcess` と同じ解釈で起動し、ループバック 200 /
許可した Host 200 / 無関係な Host 403）。**`cmd /c` で試すと Node の
引数クォートが二重にかかって別物になる**ので、そこで判定しないこと。

⚠️ **`schtasks /SC ONLOGON` は使えない。** 管理者権限を要求され
「アクセスが拒否されました」で失敗する（実測）。代わりに **HKCU の Run キー**を使う
（ユーザ単位・管理者不要。実測で確認）。

⚠️ **ログオン時にコンソール窓が出る。** 窓を消すには `.vbs` が必要になるので、
`.mjs` のみという規則（`CLAUDE.md`）を守る方を採った。
ローカルのデーモンなので、窓が見えて閉じられるのは利点でもある。

Windows 以外は未対応（手順だけ出す）。

---

## 別端末（スマホ）から見る

**実機（Android / Chrome）で確認済み。** この環境の実値:

| | |
|---|---|
| tailnet | `tail73c198.ts.net`（aki.color@gmail.com） |
| 母艦 | `fractal2.tail73c198.ts.net` / 100.73.18.61 |
| 開くアドレス | `https://fractal2.tail73c198.ts.net/` |

### 手順

1. 母艦とスマホの**両方に Tailscale アプリ**を入れ、**同じアカウント**でログインする
2. 母艦で:

```bash
tailscale serve --bg 7749
tailscale serve status      # ← 開くべき https URL がそのまま出る（一番確実）
```

3. **そのホスト名を明示的に許可して起動し直す**:

```bash
node scripts/serve.mjs --allow-host fractal2.tail73c198.ts.net
```

4. スマホのブラウザでそのアドレスを開く

### つまずいた点（実際に踏んだ）

- **`tailscale serve` は tailnet 側で機能を有効化しないと動かない。**
  `Serve is not enabled on your tailnet` と有効化 URL を出して**待ち続ける**
  （プロセスが残るので、有効化してから実行し直す）
- 🚨 **ブラウザで Tailscale の Web にログインしても、その端末は tailnet に参加しない。**
  管理コンソールを操作できるだけ。**アプリを入れて接続トグルを ON** にしないと
  `*.ts.net` は名前解決すらできない（`serve` は tailnet only）。
  「有効化ページは開けたのにアプリで見れない」で1往復した。
  参加できているかは母艦の `tailscale status` の peer で確認する
- **アカウントが違うと別の tailnet になる。** 同じ tailnet に入らない

### 確認したこと（実機）

- [x] 開ける（403 にならない）
- [x] worktree カード3枚とグラフ（48 commits）が出る
- [x] `⌂ kjp-editor` のバッジと `main` / `agent-a` / `agent-b` が読める
- [x] 横スクロールが出ない（長い件名は `…` で切れる）
- [x] 折り畳みの開閉が指で操作できる

母艦側からは経路そのものも実測した:

| | |
|---|---|
| ループバック | 200 |
| 許可した Host | 200 |
| 🔒 無関係な Host（`attacker.example.com`） | **403** |
| 🔒 許可 Host に前置き（`evil-fractal2.…`） | **403** |
| 実トンネル越し `https://fractal2.tail73c198.ts.net` | 200 |

### 認証（2026-08-04 から）

`--allow-host` を付けると**読み取りにもトークンが必要**になる。
`scripts/serve.mjs` が `~/.kjp-edit/token` に永続化するので、
**スマホでは最初の1回だけ `?token=...` 付きの URL を開く**（Cookie が焼かれる）。
起動時にその URL が表示される。

実トンネル越しに確認済み:

| | |
|---|---|
| 無認証 | **401** |
| `?token=` で開く | 302 → `/`（URL からトークンが落ちる） |
| Cookie 付き | 200 |
| 誤った Cookie | **401** |

### なぜ `--allow-host` が必要か

**トンネル経由の Host はループバックではなくなる。** 既定ではループバック以外の
Host を 403 で拒否している。これは DNS rebinding を防ぐためで、
`127.0.0.1` バインドと CORS では防げない（`docs/auth-ordering.md`）。
攻撃者は自分の持たないホスト名を Host に入れさせられないので、
オプトインしても rebinding は防げたまま。

### やってはいけないこと

- **`tailscale funnel`**（公開される）
- **`cloudflared` の quick tunnel（`trycloudflare.com`）** — URL を知れば誰でも読める
- **`--allow-host` に広いものを指定する**
- **`--exec` を付けた状態で上のいずれかをやる** → 遠隔コード実行になる

---

## 何が「ローンチ」か

これが揃った状態で数日使って、`docs/scope.md` の問いに答える:

- **見る** → 次は L2（エージェント活動の観測、`docs/agent-observation.md`）か Theia の判断
- **見ない** → 何が足りなかったかを記録して止める

残りの優先度は `docs/roadmap-after-v0.md`。
