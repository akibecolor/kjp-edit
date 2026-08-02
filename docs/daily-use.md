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
node scripts/autostart.mjs install --repo C:/Users/akico/Documents/kjp-editor
node scripts/autostart.mjs uninstall
```

**既定は読み取り専用で登録する。** `--write` / `--exec` を明示しない限り
capability は付けない（ログオンのたびに立ち上がるものに黙って権限を持たせない）。

⚠️ **`schtasks /SC ONLOGON` は使えない。** 管理者権限を要求され
「アクセスが拒否されました」で失敗する（実測）。代わりに **HKCU の Run キー**を使う
（ユーザ単位・管理者不要。実測で確認）。

⚠️ **ログオン時にコンソール窓が出る。** 窓を消すには `.vbs` が必要になるので、
`.mjs` のみという規則（`CLAUDE.md`）を守る方を採った。
ローカルのデーモンなので、窓が見えて閉じられるのは利点でもある。

Windows 以外は未対応（手順だけ出す）。

---

## 別端末（スマホ）から見る

**⚠️ この節は実機で未検証。** 私（アシスタント）の環境からはあなたのスマホに
届かないので、ここだけは手を動かしてもらう必要がある。

### 手順

1. 母艦とスマホの両方に Tailscale を入れてログインする（同じ Tailnet に入れる）
2. 母艦で:

```bash
tailscale serve --bg 7749
tailscale status            # 母艦のホスト名（box.xxxx.ts.net）を確認
```

3. **そのホスト名を明示的に許可して起動し直す**:

```bash
node scripts/serve.mjs --allow-host box.xxxx.ts.net
```

4. スマホのブラウザで `https://box.xxxx.ts.net/` を開く

### 確認してほしいこと

- [ ] 開ける（403 にならない）
- [ ] worktree カードとグラフが出る
- [ ] `⌂ <worktree名>` のバッジが読める（潰れていない）
- [ ] 横スクロールが出ない
- [ ] 折り畳みの開閉が指で操作できる

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
