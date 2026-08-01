# kjp-edit

エージェント開発のための、OSS・ローカルファーストな統合開発環境。

エディタ・ファイラ・ターミナル・**コミットグラフ**が1つのアプリに統合され、
パネルは縦横にネストできるタイルとして扱える。
コアはヘッドレスデーモンなので、**同じワークスペース状態をデスクトップと別端末の両方から**扱える。
エージェントは ACP (Agent Client Protocol) 経由で差し替え可能。

## なぜ作るのか

**「N 個のエージェントが N 個の git worktree で並行に動く」ことを前提にした
git の安全性と統合を提供するツールが無いから。**

⚠️ **この理由は2回書き直しています。** 最初は「レイアウト」、次は「グラフ中心の履歴編集」を
差別化としましたが、**どちらも検証で否定されました**（前者は Theia コアのフォークが必要、
後者は lazygit と GitUp が既に全項目実装済み）。
経緯は [docs/review-2.md](docs/review-2.md)、3回目の検証結果は
[docs/s0-verification.md](docs/s0-verification.md)。

**14以上のツールで「無い」ことを確認できた項目:**

- **シーケンサ乗っ取りのガード** — git は `rebase -i` が `break` で止まっている最中でも
  `checkout` / `commit` / `merge` を **exit 0** で通し、その後の `rebase --continue` が
  **別のブランチにリプレイ**する。`checkout -b` は解決済み未コミットのマージの
  **`MERGE_HEAD` を無警告で削除**して単一親コミットにする。**これを止めるツールが1つも無い**
- **共有 `refs/stash` の認識** — `stash@{N}` は他の worktree の push でずれる。全ツールで0件
- **全 worktree の HEAD を1枚のグラフに描く** — 誰もやっていない
- **マージ順序の推奨** — `clash` が「まだできない」と明記、他は皆無
- **並行安全な git 実行** — `GIT_OPTIONAL_LOCKS=0`、`gc.auto=0`、read→decide→write を跨ぐロック。
  この分野で最強の既存実装がプロセス内の `threading.Lock()`
- **統合** — `clash` は CLI+TUI、GitUp は macOS 専用スタンドアロン、lazygit はエディタの横に置く TUI

**正直に降ろしたもの:** グラフ + 履歴編集（lazygit / GitUp が実装済み）、
クロスworktreeのコンフリクト予測（[`clash`](https://github.com/clash-sh/clash) がやっている
— MIT なので**敵にせず依存として取り込む**）、単一レイアウトツリー（Theia の `Area` が閉じた union）。

詳細は [docs/s0-verification.md](docs/s0-verification.md)。

## ドキュメント

| | |
|---|---|
| [docs/research.md](docs/research.md) | 実現可能性調査 — ベース候補の比較、部品の棚卸し、先行事例とギャップ分析 |
| [docs/architecture.md](docs/architecture.md) | 設計 — D1〜D7 の判断、レイアウトツリー、リモート、セキュリティ |
| [docs/secondary-client.md](docs/secondary-client.md) | モバイル/セカンダリ設計 — Monaco のタッチ非対応の実レベル、Theia のモバイル状況、先行事例が収束したUIパターン |
| [docs/viewer.md](docs/viewer.md) | ビューアパネル — 埋め込みブラウザ（iframe vs WebContentsView）、リッチMarkdown、図、データビューア |
| [docs/roadmap.md](docs/roadmap.md) | 検証スパイクと段階的な実装計画 |
| [docs/spikes.md](docs/spikes.md) | **Phase 0 スパイクの実施手順** — Theia 1.74.0 のソースを読んで確定したファイルパス・DIシンボル・コードスケッチ付き |
| [docs/hosting.md](docs/hosting.md) | ホスティング設計 — Cloudflare Workers/DO を暗号化リレーにする4段のはしご、費用、ToS、代替比較 |
| 🔴 [docs/review-findings.md](docs/review-findings.md) | **敵対的レビューの結果** — 別エージェント2体による矛盾・セキュリティ・証拠の質の指摘。BLOCKING 7件 |
| ⭐ [docs/decisions.md](docs/decisions.md) | **決定記録** — レビューを受けた4つの決定と裏取り調査 |
| 🔴 [docs/review-2.md](docs/review-2.md) | **第2回レビュー** — 決定に対する再レビュー。BLOCKING 8件 |
| ⭐ [docs/s0-verification.md](docs/s0-verification.md) | **差別化の検証結果（S0）** — 主張を立てる前に反証を試みた。`clash` という反例と、残った防御可能な差別化 |
| [docs/licensing.md](docs/licensing.md) | **MIT で行ける**（条件つき）。前例比較、コピー禁止リスト、Phase 1 で追加するファイル |
| [docs/development.md](docs/development.md) | **開発体制** — テスト4層、検証ゲート4段、スモークシナリオ、オーケストレーション、CI |

## 現在の状態

**設計フェーズ。** コードはまだ無い。
決定1〜4は [docs/decisions.md](docs/decisions.md) で確定済み。
まず [docs/roadmap.md](docs/roadmap.md) の Phase 0 スパイクで技術選定を確定させる。

## ライセンス

未確定。Eclipse Theia をベースにする場合、Theia 由来ファイルの改変部分は
EPL-2.0 での公開義務が生じる (詳細は research.md)。
