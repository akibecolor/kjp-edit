# kjp-edit

エージェント開発のための、OSS・ローカルファーストな統合開発環境。

エディタ・ファイラ・ターミナル・**コミットグラフ**が1つのアプリに統合され、
すべてのパネルが単一のレイアウトツリー上のタイルとして縦横に無限にネストできる。
コアはヘッドレスデーモンなので、**同じ生きたセッションをデスクトップと別端末の両方から**開ける。
エージェントは ACP (Agent Client Protocol) 経由で差し替え可能。

## なぜ作るのか

エージェント開発の実務は「複数エージェントを並列に走らせ、それぞれの差分をレビューし、
汚い履歴を人間がレビュー可能な形に整形して統合する」という作業だが、2026年8月時点で
これを1つのアプリで完結できるツールは存在しない。

- オーケストレータ勢 (Conductor / Vibe Kanban / claude-squad / ccmanager / uzi) は
  **エディタを持たず**「Open in VS Code」に投げる
- エディタを持つ勢 (Nimbalyst / Async) は **コミットグラフを持たない**
- **履歴編集UI**(interactive rebase / squash / split / fixup / reflog救出) を
  グラフ中心で提供するツールは1つもない ← エージェントが生む大量の雑な履歴を
  整形するのが日常作業なのに、ここが完全に空白
- 「同じローカルセッションを別端末から」を実現しているのは `coder/mux` のみ (AGPL-3.0)

詳細は [docs/research.md](docs/research.md) のギャップ分析を参照。

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
