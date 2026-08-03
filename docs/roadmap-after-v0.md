# v0 以降の優先度

⚠️ **「優先度が低い」と「不要」を混同しないこと。**
私（アシスタント）が一度これを取り違えて「ローンチに要らないもの: エディタの編集機能、
ビューア、checkout 以外の git 操作」と書き、しかもそれを利用者の判断として書いた。
実際に言われたのは「**優先度は案外低い**」で、しかも「**env 編集とかはあるけど**」と
実在する用途が添えられていた。**後回しは撤回可能、不要は撤回されにくい**ので、
ここに区別を残す。

---

## ローンチの定義

**「毎日開いて、世話をしなくても動いている状態」。**
個人用ツールなので公開作業は既に済んでいる（MIT・GitHub）。
`docs/scope.md` の問い「自分はこれを実際に見るか」に答えが出る状態にすること。

---

## ローンチ前（これが揃えばローンチ）

**進行中の課題は GitHub issue で追う。**
この表は「どの塊が終わったか」だけを持つ（個別の内容を二重管理しない）。

| | 内容 | 状態 |
|---|---|---|
| **L1 運用** | ランチャ（`scripts/serve.mjs`）/ 自動起動（`scripts/autostart.mjs`）/ トークンの永続化 / スマホ実機での確認 | **完了**（`docs/daily-use.md`。実機確認済み） |
| **L2 エージェント活動の観測** | セッション記録の読み取り。`--watch-agents` / `--allow-transcript-text` | **完了**（`docs/agent-observation.md`） |
| **L3 残っている弱点** | [#1](https://github.com/akibecolor/kjp-edit/issues/1) 合成パス / [#2](https://github.com/akibecolor/kjp-edit/issues/2) submodule の false positive / [#3](https://github.com/akibecolor/kjp-edit/issues/3) クライアント描画の性能線 / [#4](https://github.com/akibecolor/kjp-edit/issues/4) ファイラのラベル | 未着手 |
| **ローンチ判定** | [#5](https://github.com/akibecolor/kjp-edit/issues/5) 数日使って「自分はこれを実際に見るか」に答える | 観察中 |

---

## ローンチ後（後回し。**不要ではない**）

優先度の低い順ではなく、**着手条件つき**で並べる。
それぞれ issue にしてある（着手条件を issue 側に書いた）:

| | issue |
|---|---|
| 未追跡ファイル（`.env`）の編集 | [#11](https://github.com/akibecolor/kjp-edit/issues/11) |
| ビューア | [#12](https://github.com/akibecolor/kjp-edit/issues/12) |
| checkout 以外の git 操作 | [#13](https://github.com/akibecolor/kjp-edit/issues/13) |
| PTY | [#14](https://github.com/akibecolor/kjp-edit/issues/14) |
| Theia に進むか | [#15](https://github.com/akibecolor/kjp-edit/issues/15) |

その他: [#6](https://github.com/akibecolor/kjp-edit/issues/6) T5 を出せるようにする前提（認可）、
[#7](https://github.com/akibecolor/kjp-edit/issues/7) 自動起動が観測フラグを引き継がない、
[#8](https://github.com/akibecolor/kjp-edit/issues/8) 自動起動の macOS / Linux 対応、
[#9](https://github.com/akibecolor/kjp-edit/issues/9) 待機の理由が記録から読めるか、
[#10](https://github.com/akibecolor/kjp-edit/issues/10) `isSidechain` の未確認。

### エディタの編集機能

**判断**: 後回し。**ただし `.env` の編集のような狭い用途は実在する。**
エージェントがコードを書くので「コードを書くためのエディタ」は要らないが、
**エージェントに書かせるべきでないファイル**（秘密、ローカル設定）は人が触る。

**着手条件**: 遠隔で `.env` を直したい場面に実際に出会ったら。
**設計上の注意**: 現状の読み取りは `git cat-file` 経由で
「追跡されているもの」に限定している。`.env` は通常**未追跡**なので、
この経路では読めない＝書き込みも別設計になる。
未追跡ファイルを触れるようにするのは `docs/review-write-exec.md` で
守っている不変条件を破るので、`--allow-edit`（既定オフ）+ 対象の allowlist が要る。

### ビューア（埋め込みブラウザ、リッチ Markdown）

**判断**: 後回し。元の要件（最初の会話）に含まれていた。
**着手条件**: 「エージェントが作った成果物（README・生成物・localhost の
プレビュー）をその場で見たい」が実際に不便になったら。
**設計上の注意**: `docs/hosting.md` と `docs/viewer.md` に調査がある。
別オリジンからの配信が前提なので、v0 の単一オリジン構成とは噛み合わない。

### checkout 以外の git 操作（commit / stage / fetch / merge / rebase）

**判断**: 後回し。今は CLI と lazygit に任せている（`docs/scope.md` の判断）。
**着手条件**: 衝突予測と順序提案を使って「じゃあこの順でマージする」まで
来たときに、**画面から実行できないのが不便**になったら。
**設計上の注意**: `requireMutation()` を通せば経路は足せる。
ただし `merge` は衝突を作りうるので、**シーケンサ拒否と同じ思想の
ガード**（この状態で実行すると何が起きるかを先に見せる）が必要。

### PTY（対話ターミナル）

**判断**: 保留。**L2 で足りるかどうかで決まる。**
L2 が「止まっていることは分かるが理由が分からない」で不便なら、そこが着手点。
**コスト**: `node-pty` はネイティブアドオンで依存ゼロを破る。
`claude -p` で非対話実行はできるので、エージェントを動かすためには要らない。

### Theia に進むか

**判断**: 保留。`docs/scope.md` の凍結された判断。
**着手条件**: v0 を数日使って「これは要るが v0 の作りでは無理」と分かったら。
設計は `docs/architecture.md` の D1〜D7 に凍結してある。

---

## 記録として

この表の「後回し」は**いつでも繰り上げられる**。
逆に、ここに書いていないものを勝手に「要らない」と決めないこと。
