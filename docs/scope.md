# スコープの決定（2026-08-01）

## 決めたこと

| | |
|---|---|
| **誰のために** | **自分が使う道具。** OSS 公開はするが（MIT）、他人の乗り換えを目的にしない |
| **次の一手** | **薄いレイヤーを先に作って検証する。** Theia/Electron へのコミットは保留 |

## これが変えること

**差別化の議論が終わります。** [s0-verification.md](s0-verification.md) と
[review-2.md](review-2.md) で3回崩壊した「差別化」は、自分用の道具には不要でした。
既存ツールが機能を持っていることは**脅威ではなく朗報**です:

| 見つけたもの | 以前の扱い | 今の扱い |
|---|---|---|
| **lazygit**（MIT）が interactive rebase / commit split / reflog undo を全部持つ | 差別化の崩壊 | **使う。**履歴編集を自作しない |
| **`clash`**（MIT）が全 worktree のコンフリクトマトリクスを作る | 差別化の崩壊 | **依存にする。**`git merge-tree` を叩き直さない |
| **VS Code** が `toggleMaximizeEditorGroup` を持つ | Phase 2 の合格線が消えた | 気にしない |
| **jj** がシーケンサと stash を構造的に消す | 主張3項目の消滅 | **将来 jj に移る選択肢が増えた**というだけ |

**残る問いは1つだけです: 今日、自分に無いものは何か。**

今日ある: Claude Code（worktree・subagent・hook がネイティブ）、任意のエディタ、git CLI、
lazygit と clash（入れれば）。

**今日無い:**
1. **N 個の並行エージェントセッションとそのブランチと差分を1画面で見る手段** —
   Claude Code の `agent-view` は行を並べるだけで、グラフもクロス比較も無い
2. **全 worktree を跨いだ1枚のコミットグラフ** — 誰も持っていない
3. **別端末（スマホ）からの観測** — `mux` のみで AGPL
4. **統合** — ターミナル5枚とブラウザと lazygit を開き分けたくない

## v0 のスコープ（数日、`v0/` ディレクトリ）

**作るもの:** `127.0.0.1` にバインドする小さな Node デーモン + 単一ページの Web UI。
**依存パッケージゼロ**（Node 標準ライブラリのみ）でインストール手順を無くす。

- 全 worktree とそのブランチ・HEAD を列挙
- **全 worktree の HEAD を含む1枚のコミットグラフ**（スイムレーン描画）
- worktree 毎の base との差分（変更ファイル一覧、ahead/behind）
- 別端末から見られる（ユーザが既に持つトンネル経由）

**作らないもの:** エディタ、ターミナル、Electron、Theia、認証、書き込み操作。
**読み取り専用。**

## v0 が答える問い

1. **自分はこれを実際に見るか。** ← 本当のテスト
2. 統合グラフは有用か、それとも worktree 毎に lazygit を開けば足りるか
3. ここから*操作*したくなるか、それとも観測だけで足りるか

## 無駄にならない理由

v0 が有用なら、**そのグラフがそのまま IDE のコミットグラフパネルになり、
デーモンがそのまま kjp-core になります。**
[architecture.md](architecture.md) の D1〜D7、[encoding-and-paths.md](encoding-and-paths.md) の
git 起動レシピ、[licensing.md](licensing.md) の遵守事項は v0 から適用します。

有用でなければ、**数日で止められます。**

## 既存ドキュメントの位置づけ

| | 状態 |
|---|---|
| [encoding-and-paths.md](encoding-and-paths.md) | **v0 から適用。**git 起動レシピとエージェント規則はそのまま使う |
| [licensing.md](licensing.md) | **確定。**MIT + EPL 遵守（Theia を採るなら） |
| [architecture.md](architecture.md) D1/D2 | **v0 に適用。**デーモン + クライアント、サーバ権威 |
| [development.md](development.md) | **v0 では簡略版。**テスト4層のうち層1（ユニット）と検証コマンドだけ |
| [research.md](research.md) / [spikes.md](spikes.md) / [secondary-client.md](secondary-client.md) / [viewer.md](viewer.md) / [roadmap.md](roadmap.md) | **IDE に進む場合の設計。今は凍結。** |
| [s0-verification.md](s0-verification.md) / [review-2.md](review-2.md) / [review-findings.md](review-findings.md) | **記録。**判断の経緯として保存 |
| [hosting.md](hosting.md) | リモート化する段階で参照 |
