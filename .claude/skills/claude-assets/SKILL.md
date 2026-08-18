---
name: claude-assets
description: skill / subagent / workflow / hook / MCP のどれを作るか迷ったとき、または新しく作る・直す・捨てるとき。置き場所と frontmatter の正典、選び方、増やしすぎないための規則。
when_to_use: 「skill を作りたい」「agent を追加したい」「/コマンドにしたい」「MCP を繋ぎたい」「.claude/ が散らかってきた」と言われたとき
---

# Claude の資産（skill / agent / tool）を作って運用する

**目的は「増やすこと」ではなく「増えすぎないこと」。**
作る前に **§1 の選び方**で「そもそも作るのか / どれを作るのか」を決める。

⚠️ 仕様は 2026-08-18 に公式ドキュメントから取得したもの
（`code.claude.com/docs/en/skills` / `/sub-agents` / `/mcp`）。
**推測で frontmatter を書かない。** 疑ったら再取得する。

---

## 1. どれを作るか（ここで大半は「作らない」に着地する）

| 作りたいもの | 正解 | 理由 |
|---|---|---|
| **毎回同じ指示を貼っている** | **skill** | 本文は使うときだけ読み込まれる。CLAUDE.md に書くと常時コストになる |
| **CLAUDE.md の一節が「手順」に育った** | **skill** に移す | CLAUDE.md は**事実**、skill は**手順** |
| **別視点で検証させたい / 文脈を汚したくない** | **subagent** | 独立した context。実装者と別の目で見る |
| **同じ検証を N 観点で並列に回したい** | **workflow**（`.claude/workflows/*.mjs`） | 決定的な制御フロー（並列・ループ・分岐）が要るとき |
| **毎回機械的に必ず走らせたい** | **hook**（`settings.json`） | モデルの判断に任せない。このリポジトリの `Stop` → `verify.mjs` がその例 |
| **外部サービスのデータを貼っている** | **MCP** | issue tracker / DB など |
| **人間も CI も叩く決まった処理** | **ただの `scripts/*.mjs`** | ⚠️ **Claude 資産にしない。** `verify.mjs` / `mutate.mjs` がこれ |

🚨 **作らない方がよいもの:**
- 1回しか使わない手順（そのとき書けばよい）
- 既存の skill に2〜3行足せば済むもの（**新規より追記**）
- 「あると便利そう」だけで、実際に困った場面が無いもの
  （`/spec-first` の「着手条件」と同じ考え方。**実際に困ってから作る**）

## 2. 置き場所（公式仕様）

| 種類 | プロジェクト | 個人 | 備考 |
|---|---|---|---|
| skill | `.claude/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` | **`/<name>` の名前はディレクトリ名から決まる**（`name:` ではない） |
| subagent | `.claude/agents/<name>.md` | `~/.claude/agents/<name>.md` | 再帰的に走査される |
| command | `.claude/commands/<name>.md` | — | **skill に統合済み**。新規は skill で作る |
| MCP | `.mcp.json`（プロジェクト・**共有**） | `~/.claude.json`（local / user・**非共有**） | `claude mcp add --scope project\|local\|user` |
| workflow | `.claude/workflows/<name>.mjs` | — | `Workflow` ツールが読む。skill/agent とは別物 |

⚠️ **このリポジトリの方針: 原則プロジェクト側に置く。** 流儀（docs/ の型、変異テスト、
fable の使い方）に依存するものが多く、他プロジェクトに持ち出すと嘘になるため。
個人側に置くのは「どのリポジトリでも同じやり方をするもの」だけ。

## 3. frontmatter の正典

### skill（`SKILL.md`）

```yaml
---
name: spec-first                    # 表示名。省略時はディレクトリ名
description: いつ使うかを1文で        # Claude が「使うか」を決める材料。最重要
when_to_use: 「〜したい」と言われたとき  # 引き金になる言い回し。description に追記される
disable-model-invocation: true      # 自動で読ませない（/name でだけ使う）
user-invocable: false               # 逆に「Claude だけが使う」
allowed-tools: Read Grep            # そのターンだけ許可（次の発言で消える）
context: fork                       # subagent の文脈で走らせる
model: fable                        # そのあいだのモデル
---
```

🚨 **`description` + `when_to_use` は合わせて 1,536 文字で切られる**（一覧に載る部分）。
**先頭に「いつ使うか」を書く。** 何をするかは本文でよい。

### subagent（`.claude/agents/<name>.md`）

```yaml
---
name: verifier          # 必須。小文字とハイフン。`:` は使えない
description: いつ委譲するか  # 必須。**"proactively" と書くと自動委譲されやすい**
tools: Read, Grep, Glob, Bash   # 省略すると継承。**絞る方が安全**
disallowedTools: Write, Edit    # 先に適用されてから tools が解決される
model: inherit          # sonnet / opus / haiku / fable / inherit（既定）
---
```

⚠️ subagent は `AskUserQuestion` / `Workflow` / `ExitPlanMode` 等を**継承しない**
（聞き返せない）。**判断が要る仕事を投げない。**

## 4. 書き方（このリポジトリの流儀）

- **本文は短く。** 一度読み込まれるとターンをまたいで残る = 恒久的なコスト
- **「なぜ」より「何をするか」。** ただし**このリポジトリで実際に起きた事故**は書く価値がある
  （`spec-first` が「凍結しなかったら40分後に嘘を書いた」を根拠に持っているのが例）
- 🚨 **主張を書いたら、それを測る手段を書く。** 「〜すること」だけの skill は守られない
- ⚠️ **日本語でよい**（ドキュメントと UI 文字列は日本語、というリポジトリ規則に従う）。
  ただし `name` とディレクトリ名は**純 ASCII**

## 5. 作ったあとに必ずやること

1. **frontmatter が壊れていないか確かめる**（`---` で挟まれているか、`name`/`description` があるか）
2. **実際に呼んでみる**（skill なら `/name`、subagent なら「〜 subagent を使って」）
   🚨 **置いただけで動くと思わない。** 呼ばれなければ存在しないのと同じ
3. **CLAUDE.md から入口を張るか決める。**
   skill は**呼ばれないと読まれない**ので、「いつ使うか」を常時読まれる側に1〜2行置く
   （`spec-first` はそうした。全部やると CLAUDE.md が膨れるので、**規律に関わるものだけ**）
4. **コミットする**（`.claude/` はバージョン管理に入れる。チームと自分の再現性のため）

## 6. 増えすぎないための棚卸し

**実装コミットが溜まったとき、または「散らかってきた」と感じたときに見る:**

```bash
find .claude -type f | sort          # 何があるか
ls scripts/*.mjs                     # Claude 資産にすべきでないもの（ただの道具）
```

問いは3つだけ:

1. **最後に使ったのはいつか。** 一度も使っていないものは**消す**
   （残すと「あるのに使われない」= 次に読む人が迷う）
2. **2つが同じことを言っていないか。** 重なったら**片方に寄せる**
3. **CLAUDE.md と食い違っていないか。** 食い違いは**どちらかが必ず嘘**

⚠️ **消すのを惜しまない。** このリポジトリは「測っても差が出ない守りは置かない」を
コードで実践している。Claude 資産にも同じ規則を当てる。

## 7. 今あるもの（2026-08-18 時点）

| | 種類 | 何のため |
|---|---|---|
| `spec-first` | skill | 中くらい以上の開発を、要件凍結から始める |
| `claude-assets` | skill | これ。資産を作る・直す・捨てる |
| `verifier` | subagent | 実装の主張を反証する（別の目） |
| `adversarial-review.mjs` | workflow | 9観点の敵対的レビュー（並列 + 反証） |
| `Stop` → `verify.mjs` | hook | 応答の終わりに必ず検査を走らせる |

⚠️ **`scripts/*.mjs`（11本）は Claude 資産ではない。** 人間も CI も叩く道具なので、
skill 化しないこと（`verify.mjs` / `mutate.mjs` / `serve.mjs` など）。
