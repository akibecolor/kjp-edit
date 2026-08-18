---
name: claude-assets
description: このリポジトリの Claude 資産（skill / agent / workflow / hook）を作る・直す・捨てるとき。何が今あるか、何を Claude 資産にしないか。
when_to_use: 「skill を作りたい」「agent を追加したい」「.claude/ が散らかってきた」と言われたとき
---

# Claude の資産（このリポジトリ版）

⚠️ **一般的な選び方・置き場所・frontmatter の正典は個人側の
`~/.claude/skills/claude-assets/SKILL.md` にある**（同名なのでこちらが優先 = **これが読まれる**）。
ここには**このリポジトリ固有のこと**だけを書く。重複させない。

## 今あるもの

| | 種類 | 何のため |
|---|---|---|
| `spec-first` | skill（プロジェクト） | 要件凍結の**このリポジトリでの具体形**（fable / docs / 変異 / verify） |
| `claude-assets` | skill（プロジェクト） | これ |
| `verifier` | subagent | 実装の主張を**反証**する。3回の差別化崩壊が根拠なのでここに置く |
| `adversarial-review.mjs` | workflow | 9観点の敵対的レビュー（並列 + 反証）。観点が kjp-edit の設計判断そのもの |
| `Stop` → `verify.mjs` | hook（`settings.json`） | 応答の終わりに必ず9段の検査を走らせる |

## 🚨 Claude 資産にしないもの

**`scripts/*.mjs`（11本）は道具であって Claude 資産ではない。**
`verify.mjs` / `mutate.mjs` / `serve.mjs` / `precheck.mjs` などは
**人間も CI も叩く**ので、skill 化・agent 化しないこと。
（skill にすると「Claude 経由でしか正しく動かない道具」ができて、CI と乖離する）

## 個人側に上げてよいか（判断）

このリポジトリの資産は**流儀に強く依存**している:
依存パッケージゼロ、変異テスト、`docs/review-*.md` の失敗史、9段の verify、
Windows + msys2 の罠。**これらを本文に含むものは個人側に上げない**（他プロジェクトで嘘になる）。

- ✅ 上げた: 一般的な手順（要件凍結の型 / 資産の選び方と frontmatter の正典）
- ❌ 上げない: `verifier`（失敗史が根拠）、`adversarial-review.mjs`（観点が固有）、
  `Stop` フック（コマンドが固有）、CLAUDE.md

⚠️ 他プロジェクトで似た仕組みが欲しくなったら、**そのとき骨を抜いて個人側に作る**。
先回りして一般化しない（使われない資産が増えるだけ）。
