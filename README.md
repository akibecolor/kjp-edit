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
| [docs/architecture.md](docs/architecture.md) | 設計 — デーモン/クライアント分離、レイアウトツリー、リモート、セキュリティ |
| [docs/roadmap.md](docs/roadmap.md) | 検証スパイクと段階的な実装計画 |

## 現在の状態

**設計フェーズ。** コードはまだ無い。
まず [docs/roadmap.md](docs/roadmap.md) の Phase 0 スパイクで技術選定を確定させる。

## ライセンス

未確定。Eclipse Theia をベースにする場合、Theia 由来ファイルの改変部分は
EPL-2.0 での公開義務が生じる (詳細は research.md)。
