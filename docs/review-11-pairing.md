# レビュー11: 端末の承認となりすまし（fable / 9観点並列）

範囲 `542a3ff..HEAD`（端末承認の実装一式）。`.claude/workflows/adversarial-review.mjs` を
**fable** で実行し、なりすまし（母艦・端末・鍵の三方向）を最優先に指定した。
19 エージェント / 9観点。**確定 9件（BLOCKING 0 / SERIOUS 6 / MINOR 3）、反証 1件。**

**なりすましの核は破れなかった:** 端末が別の端末の承認を横取りする経路
（id + 合言葉の二重束縛、合言葉が母艦にしか出ない）、弱い鍵が強い鍵に直接なりすます経路は
再現できなかった。確定したのは**可用性**と**表示の正直さ**、そして
**この機能が露出させた既存のゲートの穴**。作者（実装者）が自分で確認して真と判断した。

## 確定した指摘

### 🔴 A. `goodTokens` が提示値を丸ごと覚える → #63 の「痕跡ゼロ・無遅延の総当たり」が復活（SERIOUS / 既存）
- `v0/server.mjs:1457` `tokenWall` の `goodTokens.remember(vals)` が**一致した値だけでなく提示値を全部**覚える。
  読み取り側の `rememberGoodSecret:1472` は `filter` で絞っているのに、実行側に絞りが無い。
  `failtracker.mjs` の `remember` の docstring 自身が「提示された値を全部覚えてはいけない」と禁じている。
- 正規の exec 保有者のブラウザは `/api/v0/state` を叩くたびに
  `x-kjp-token:<execToken>` と `Cookie:kjp_auth=<readSecret>` を同時に送る（実測で確認）。
  `presentedTokenAudited:1324` → `tokenWall` の compare=true で **readSecret が goodTokens に昇格**する。
- 以後 readSecret を提示した要求は `goodTokens.has` で `tokenWall`/`gateMutation` の
  混雑の門・監査（`mutationFails.note`）・遅延を**全て素通り**する。readSecret は
  Cookie（ポート分離なし）・案内 URL に載る = 広く出回る値。
- exec トークンは 256bit なので当てて RCE には至らない（そこは未計測）。**穴はゲート回避と監査痕跡の消失**。
  #48/#63 が立てた「唯一の壁には下限・記録・遅延を必ず付ける／混雑の門を非一致値に素通りさせない」を破る。
- **直し:** `remember` を一致値だけに絞る（`compare` がどの値で通ったかを返し、その値だけ覚える）。
  変異 `goodtokens-remember-unfiltered`（絞りを外す）を smoke で KILLED にする。
- ⚠️ **pairing 由来ではなく既存のバグ**。レビューが露出させた。

### 🟠 B. `--write + --allow-host` で承認した端末を失効できない（SERIOUS / 不変条件5の破れ）
- `request`/`claim` は read 認証と壁だけで通る（`allowWrite`/`allowExec` を見ない）。
  端末の鍵は `gateMutation:1567-1568` の `deviceMatches` で **checkout を通る**。
  しかし `list`/`revoke`/`cancel` は `gateExec:2761` = `--allow-exec` 必須。
- → `--write --allow-host` では checkout 権を持つ長寿命の鍵を発行できるのに、tool から失効できない
  （`devices.json` の手書き改変は doc が禁じている）。`docs/device-approval.md` の不変条件5を実装が破る。
- **直し:** `list`/`revoke`/`cancel` を `gateExec` ではなく「`--allow-write` 以上 + 生トークン」で通す。
  pairing が有効な構成（`devicesFile && requireAuth`）では失効経路が必ず在ることを smoke で固定。

### 🟠 C. `serve.mjs --pair` は token-exec だけで認証 → 非 exec デーモンで「動いていない」と嘘表示（SERIOUS）
- `--pair` は `~/.kjp-edit/token-exec` だけでデーモンに問い合わせる（`serve.mjs:252`）。
  `--write`/読み取り専用では token-exec が無く（`serveargs.mjs:202`）、`askDaemon()` が null →
  デーモンが**現に走っていても**「⚠ デーモンが動いていないので台帳から読みます」「✖ 失効は
  動いているときだけ」と表示する。`--stop` の「停止しました」嘘と同型の**稼働状態の偽装**。
- **直し:** capability に応じて token-exec / token-write / token-read を順に試す。
  少なくとも「動いているが管理トークンを持っていない」と「動いていない」を区別する（「分からない」と「無い」を分ける）。

### 🟠 D. 期限切れの合言葉ファイルが残り、`--pair` が死んだ合言葉を「まだ使える（5分で切れます）」と嘘表示（SERIOUS）
- `clearCodeFile()` の呼び出しは approved(2730)/too-many(2741)/cancel(2775) の3経路だけ。
  **TTL 期限切れ・起動時・終了時に消す経路が無い**（`clearCodeFile` の自コメントは
  「期限切れのあと」も消すと約束していて、コードが約束を破っている）。
- 5分放置後、`--pair` はファイルの値を無条件に「🔑 合言葉: … 5分で切れます」と出す。
  人がそれを端末に入れても `claim` は 409（`current()==null`）。**必ず拒否されるので fail-safe**
  だが「言われた通りに入れたのに通らない、原因不明」= この repo が最も嫌う失敗。
- **直し:** (a) 期限切れ遷移で `clearCodeFile()` を呼ぶ、または (b) `--pair` はデーモンの
  `pending` を真実とし、無ければファイルの合言葉を出さない。期限切れ掃除を外す変異を1件足す。

### 🟠 E. 読み取り鍵だけで端末登録を恒久的に妨害できる（SERIOUS + 関連 MINOR ×2）
- `/api/v0/pair/request` に**固有のレート制限が無い**（`server.mjs:2691`）。read 認証済みの値は
  `goodSecrets` に載って入口の混雑門も素通り（`2413-2414`）。`request()` は pending を**無条件上書き**（`devices.mjs:160`）。
- 広く出回る read 鍵を持つ相手が `/pair/request` を連打すると: (a) 正規端末の pending が毎回上書きされ
  **母艦は新しい端末を一度も承認できない**（登録機能そのものの DoS）、(b) announce が stdout を
  「登録を要求されました」で埋め、母艦が本物の合言葉行を読めない、(c) pair-code を攻撃者の知らない値で回し続ける。
- 関連 MINOR: 同じ無制限性で **監査ログを回転させて exec/kill/pair-claimed の記録を消せる**
  （2世代 rename、~8MB / 約5.5万 request で押し出す）。「監査は事故を後から追う唯一の記録」への攻撃。
- **昇格は不可**（id+code 二重束縛、code は母艦のみ）。純粋な妨害＋なりすまし表示。
- **直し:** `request` に peer 単位のレート制限（`authFails.note` 相当の遅延、または直近 announce からの最小間隔）。
  既存の期限内 pending があれば新規要求を保留/拒否。announce の stdout 連打にも下限間隔。

### 🟠 F. checkout の post-checkout フック警告が `core.hooksPath` を見ない（SERIOUS / 未計測 / 既存）
- 「checkout は post-checkout を起動するので `--allow-write` は実質コード実行」を**止めずに知らせる**のが設計判断。
  その唯一の防御が payload の security 警告だが、`existsSync(join(common,'hooks',<name>))`（`server.mjs:646`）で
  **既定フックディレクトリしか見ない**。`git checkout` は `core.hooksPath` があればそちらを起動するのに読まない。
- merge は `-c core.hooksPath=<空>` で無効化するので安全だが、checkout は無効化せず告知に頼る = **非対称**。
  クローンした悪意リポジトリが `core.hooksPath` をツリー内の追跡ファイルに向ければ、
  checkout で in-tree フックが走り、かつ「実質コード実行」警告は**一言も出ない**。
- **直し:** 警告の検査に `core.hooksPath` を反映（`git config --get core.hooksPath` を解決）。
  または checkout も merge と同様に既定でフックを無効化し、必要なら明示フラグでオプトイン。
- ⚠️ **pairing 由来ではなく既存**。未計測（measured=false）。

### 🟡 G. 端末の鍵と生トークンの分界・失効の封じ込めは exec 有効時は実質無効（MINOR / 正直さ）
- `docs/device-approval.md:95-97,145-146` と `server.mjs:1564-1566` のコメントは「端末の鍵は
  生トークンの払い出しを通さない → 承認の連鎖を作らない」「失効したらその端末だけが通らなくなる」と宣言。
  だが端末の鍵は `gateExec` を通る = **RCE**。`POST /api/v0/exec argv=['cat','~/.kjp-edit/token-exec']` で
  生トークンをディスクから回収でき、以後 list/revoke/session/兄弟端末の発行が全部通る。
- つまり HTTP 層で引いた「端末の鍵 < 生トークン」の分界は **exec が有効な限り効果ゼロ**。
  失効も exec を一度使った端末には封じ込めにならない（運用者が「切った」と誤認）。
- **これはコードのバグではなく（exec = RCE は定義どおり）、コメントと doc が嘘をついている**のが問題。
  分界が本当に効くのは `--write` のみの構成（RCE でトークン回収できない）で、
  **その構成こそ失効が壊れている**（指摘 B）。この2つは一緒に直す。
- **直し:** doc とコメントを事実に揃える。「exec 有効時、端末の鍵は生トークンと同等（回収可能）。
  分界と失効の封じ込めが成立するのは `--write` のみの構成」と明記。

## 反証された指摘（残さない）
- （auth）「`/pair/claim` が exec/checkout/merge と同じ壁を共有している」→ 構造は事実だが
  「read 鍵 → exec 可用性への**新規**昇格」は成立しない。read 鍵で同じ壁に届く経路は claim 以前から
  `/api/v0/exec` に誤りトークンを投げれば存在し、claim は新しい capability を与えていない。
  claim を実行クラスの壁に置くのは正しい分類（設計コメント 2662-2663 が意図どおり）。

## 直した結果（全件・変異つき。verify 8段緑 / smoke 192）

利用者の判断: **B+C+G は「登録を --allow-exec 必須にする」**、**F は「merge と同様フックを既定で無効化」**。

| 指摘 | 直し方 | 変異（KILLED） |
|---|---|---|
| **A** | `tokenWall` の `remember` を一致値だけに絞る（`tokenMatches\|\|deviceMatches`）。読み取り側 `rememberGoodSecret` と対称に | `goodtokens-remember-unfiltered` |
| **B+G** | `pairingWhy()` で登録を `--allow-exec` 必須に。doc とコメントを「分界は封じ込めではなく多層の1枚目。exec 有効時は端末の鍵＝生トークン」と正直に書き直し | `pair-allows-without-exec` |
| **C** | `serve.mjs --pair` が「動いていない」と「動いているが管理トークンが無い」を区別 | （表示ロジック。B の変異が経路を固定） |
| **D** | `/pair` ハンドラ入口で live な pending が無ければ合言葉ファイルを掃く。`--pair` は先にデーモンへ聞いてから読む | `pair-code-not-swept-on-expiry` |
| **E** | `/pair/request` を `makeFailTracker`（free=5 の即時バースト→指数遅延→監査集約）で絞る | `pair-request-unmetered` |
| **F** | checkout に `-c core.hooksPath=<空>` を付けてフック無効化（merge と対称）。警告は「フックは抑止するが smudge/clean は走りうる」と正直に | `checkout-runs-hooks` |

### 直しながら見つけた訂正（正直に残す）
- **A はレビュアーが一部過大評価していた。** `gateMutation` では `mutationFails.note`（監査＋遅延）は
  `trusted` に関わらず走るので、「痕跡ゼロ」は `gateMutation` 経路では成立しない。**痕跡ゼロが真なのは
  `presentedTokenAudited:1316` の短絡経路（/state・/session）だけ**。テストはそちら（/session）を撃つ形に直した。
  修正（remember の絞り込み）は正しく、mutant で固定した。
- **既存の変異2件がこの修正でずれた（STALE）**ので直した: `exec-capability`（`if (!opts.allowExec)` が
  pairingWhy にも増えた）、`merge-no-hooks`（checkout も同じ `core.hooksPath=${emptyHooks}` を使うように
  なった）。どちらも「写した瞬間に守りが未検証になる」型で、インデント込みで一意化した。

### 残余（正直に）
- **F**: フックは止めたが gitattributes の smudge/clean は checkout で走りうる。信頼できない ref の
  checkout は依然として実質コード実行になりえる（payload の警告でそう告げている。LFS 等を壊すので
  smudge まで一律無効化はしない）。
- **E**: 読み取り鍵を持つ相手は登録を「遅延」できる（乗っ取りはできない — 合言葉は母艦にしか出ない）。
