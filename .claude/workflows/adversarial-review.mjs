// SPDX-License-Identifier: MIT
//
// 独立したレビュアーを並列で走らせる敵対的レビュー。
//
// なぜこれが要るか（実際に起きたこと）:
//   自己検査（テスト + 突然変異 + 実測）は強いが、**自分が設計したものは
//   自分が思いつかなかった穴を思いつけない。** 過去のレビューが見つけたのは
//   まさにその類だった:
//     - 読み取り専用デーモンからの任意コード実行が2経路（core.fsmonitor / merge driver）
//     - 認証前の1パケット DoS
//     - 描画が総文字数に対して二次（12,000行で54秒）
//     - 衝突予測が {clean:false, conflicts:[]} という嘘を返す
//   さらに、認証を入れた4日後に「Cookie に実行トークンを入れていて、
//   Cookie はポートで分離されないので他のローカルサービスに渡る」を
//   **聞かれて初めて**見つけた。だから体制にする。
//
// 使い方:
//   /review                      → 直近のレビュー以降を見る（既定）
//   args = { range: 'b1874a0..HEAD', focus: '認証' }
//
// ⚠️ レビュアーは**読むだけ**。修正はしない（誰がどう直したかを追えなくなる）。

export const meta = {
    name: 'adversarial-review',
    description: '独立したレビュアーを並列で走らせ、指摘を敵対的に検証して報告する',
    whenToUse: '実装をまとめてコミットした後、次の機能に進む前。特に認証・実行・リポジトリ外の読み取りに触ったとき',
    phases: [
        { title: 'Review', detail: '観点ごとに独立して読む（互いの結果を見ない）' },
        { title: 'Verify', detail: '各指摘を別のエージェントが反証しようとする' },
        { title: 'Synthesize', detail: '生き残った指摘を重大度順にまとめる' },
    ],
};

const range = args?.range ?? 'b1874a0..HEAD';
const extraFocus = args?.focus ? `\n\n**特に見てほしい点**: ${args.focus}` : '';
// ⚠️ **モデルを args で選べるようにする。** 既定はセッションのモデルを継ぐ（省略）。
//    観点を変えても同じモデルで揃えたいとき（例: 全観点を fable で）に指定する。
const MODEL = args?.model ?? undefined;

// このリポジトリの流儀。レビュアーに毎回渡す（知らないと的が外れる）
const CONTEXT = `
あなたは kjp-edit（N 個のエージェントの git worktree を1画面で見るローカルツール）の
**敵対的レビュアー**です。作者ではありません。作者の意図を汲まず、**壊れる形を探して**ください。

まず読むもの:
- CLAUDE.md（このリポジトリの規則。過去に踏んだ事故が全部書いてある）
- v0/README.md（機能と capability の説明）
- docs/auth-ordering.md, docs/agent-observation.md（認可と観測の設計判断）
- git diff ${range} で変更範囲を確認する

このリポジトリの価値基準（ここを外した指摘は価値が低い）:
- **嘘をつかないこと。** 「clean=false なのに conflicts=[]」「停止しましたと言って
  停止していない」「省略したのに告知しない」は最も重い欠陥
- **主張ではなく証拠。** 「〜かもしれない」ではなく、**再現手順と観測値**を出す
- **落ちない検査は無意味。** テストがあっても、守りを外して落ちないなら穴
- 依存パッケージゼロ。Node 標準ライブラリのみ
- 既定は読み取り専用。書き込み（--allow-write）/ 実行（--allow-exec）/
  活動観測（--watch-agents）/ 発話（--allow-transcript-text）は別 capability

⚠️ **ファイルを変更しないでください。** 読んで報告するだけです。
⚠️ 実験でサーバを起動したら**必ず止めてください**（ポートを塞ぐ事故がある）。
⚠️ 既に docs/review-*.md に記録済みの既知の弱点は、**再発していない限り**報告不要。
`;

const FINDING_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
        findings: {
            type: 'array',
            maxItems: 8,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['severity', 'title', 'where', 'why', 'repro'],
                properties: {
                    severity: { type: 'string', enum: ['BLOCKING', 'SERIOUS', 'MINOR'] },
                    title: { type: 'string', maxLength: 120 },
                    where: { type: 'string', description: 'file:line の形' },
                    why: { type: 'string', description: '何が壊れるか。影響を具体的に' },
                    repro: { type: 'string', description: '再現手順、または観測した値' },
                    measured: { type: 'boolean', description: '実際に再現・計測したか' },
                    fix: { type: 'string', description: '直し方の案（任意）' },
                },
            },
        },
    },
};

const VERDICT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['refuted', 'reason'],
    properties: {
        refuted: { type: 'boolean', description: '反証できた（指摘は誤り）なら true' },
        reason: { type: 'string' },
        severityAdjust: { type: 'string', enum: ['BLOCKING', 'SERIOUS', 'MINOR', 'keep'] },
    },
};

// 観点。**互いの結果を見せない**（同じ穴を全員が見つけて他が抜ける形を避ける）
const DIMENSIONS = [
    {
        key: 'auth',
        prompt: `**観点: 認証と認可。**

見るもの: v0/server.mjs の authed() / cookieSecret() / tokenMatches() /
secretMatches() / requireMutation() / requireExec() / hostAllowed() / siteAllowed()、
?token= のブートストラップ、/api/v0/session。

疑うこと（例。これに限らない）:
- 判定の順序（Host → Sec-Fetch-Site → 認証）を入れ替えると何が通るか
- Cookie の性質（ポート分離が無い、SameSite の効き方、同一サイト判定の範囲）。
  トンネルのホスト名は *.ts.net。**ts.net が Public Suffix List にあるかを確認し**、
  無いなら Sec-Fetch-Site: same-site で他人のノードのページが何をできるか
- トークンが URL / 履歴 / Referer / ログ / プロセス一覧（--token）に残る経路
- 認証を通す3経路（Cookie / ヘッダ / クエリ）のどれかで意図しないものが通らないか
- --no-auth / --require-auth / --allow-host の組み合わせで穴が開く並びはないか`,
    },
    {
        key: 'pairing',
        prompt: `**観点: 端末の承認となりすまし（\`docs/device-approval.md\`。新しい capability）。**

見るもの: v0/devices.mjs 全体（DeviceBook: request / claim / match / revoke / list /
current / pairCode / normalizeCode）、v0/devicekey.mjs（pickCredential /
canMutateWith）、v0/server.mjs の /api/v0/pair/* の5経路（request / status /
claim / list / revoke / cancel）と announceCode / clearCodeFile / deviceMatches /
pairingWhy / authed() への device の合流、v0/app.html の登録 UI と鍵の枠、
scripts/serve.mjs の --pair。

背景と約束:
- 承認の根拠は「**母艦でしか読めない合言葉を読めたこと**」。合言葉はデーモンの
  stdout と ~/.kjp-edit/pair-code（0600）にだけ出て、**要求した端末には返さない**
- 🚨 **peer アドレスも Host も「母艦にいること」を証明しない**（実測で撤回済み。
  tailscale serve はループバックに繋ぎ直す）。だから根拠を合言葉の出口に置いた
- 端末の鍵は localStorage（Cookie に入れない）。**実行は通すが生トークンの
  払い出しは通さない**（/api/v0/session と /pair/list /pair/revoke は tokenMatches のみ）
- 合言葉の照合は tokenWall（記録 + 遅延 + 混雑の門）+ 試行5回で要求ごと無効

**なりすましを主眼に、疑うこと（これに限らない。壊れる形を探す）:**
- **他人の端末になりすます。** 別の端末が出した承認要求を、id / 合言葉 / タイミングの
  どれかを細工して横取りできないか。claim の id 照合（sameString）、要求が1件だけの
  保持、pending の上書き、status が漏らす情報。**要求Aの最中に要求Bを割り込ませて
  合言葉を掏り替える**窓
- **母艦になりすます / 合言葉の出口を回り込む。** 応答・status・Cookie・監査ログ・
  エラーメッセージ・タイミングのどれかから合言葉が漏れないか。pair-code ファイルの
  権限（Windows は ACL で 0600 が効かない — その差で読めないか）、消し忘れ、
  古い合言葉の再利用。announceCode が stdout に出す形と、それを読める相手
- **合言葉の推測可能性。** pairCode の乱数源（rejection sampling の限界値、
  createRandomBytes か Math.random か）、30種8文字の分布に偏りが無いか、
  試行5回の数え方（並列に投げたときに5を超えないか、要求を作り直せば無限か）
- **capability の昇格。** 承認した端末が (a) 生トークンを回収する、(b) 別の端末を
  承認/失効/一覧する、(c) 読み取りしか許していないデーモンで実行に届く、経路。
  authed() に device を合流させたことで、pair 以外の経路の判定が緩まないか
- **鍵の取り違え（画面側）。** pickCredential の優先順位（URL > 貼った > 端末 >
  保存済み URL）で、弱い鍵が強い鍵になりすます / 失効した端末の鍵に閉じ込められて
  読み取りまで塞ぐ / 別オリジンの localStorage を読む経路
- **DoS となりすましの合わせ技。** 誰でも /pair/request を積めると母艦の合言葉が
  上書きされ続ける。--require-auth / --allow-host / --devices-file の無い構成で
  経路が開く並び。Sec-Fetch-Site: same-site（別ポートのページ）で何ができるか
- **各門を外して落ちる変異が実在するか。** scripts/mutate.mjs の pair-* を数え、
  守りがあるのに変異が無い箇所を挙げる（実データ: ~/.kjp-edit/devices.json を
  読んで良い。実際の hash / label / 失効の形を見て確認する）`,
    },
    {
        key: 'exec-session',
        prompt: `**観点: 実行セッションの寿命と資源。**

見るもの: v0/execsession.mjs 全体、v0/server.mjs の streamSession() /
startExecSweeper() / /api/v0/exec の3経路。

背景: **クライアント切断で子プロセスを殺すのをやめた**（#17）。代わりに
同時数の上限・絶対上限・切断後の猶予・終了後の保持・終了時の後始末で縛っている。

疑うこと:
- 取り残しの経路が残っていないか（枠が返らない / 台帳から消えない / 子が残る）
- 競合: 同時に来た要求、sweep と exit の同時発火、finish の二重呼び出し
- 別の worktree / 別のセッションの出力が混ざる経路はないか
- リングバッファの上限計算（バイト数と件数）、通番の連続性、
  from を細工したときの挙動（負値 / 巨大値 / 非数）
- セッション id を知った相手にできること（kill / input / stream）と、
  id が漏れる経路
- サーバ終了時の後始末が効かない条件（Windows は既知。他にあるか）`,
    },
    {
        key: 'stdin',
        prompt: `**観点: 標準入力の書き込み経路（#18）。**

見るもの: v0/server.mjs の /api/v0/exec/<id>/input、readJson()、
v0/app.html の write() / chatLine() / makeChatFilter()。

疑うこと:
- 上限（64KB）の効き方。連続で送ったときの累積に上限はあるか
- 書き込み先が意図したセッションであることの保証
- EPIPE / 子が死んだ直後 / stdin が閉じた後の扱い
- 入力がリングバッファに残り購読者全員に流れる設計の影響
  （パスワードを打った場合に何が起きるか）
- 監査に本文を残していないか（バイト数だけのはず）
- makeChatFilter が stream-json を取りこぼす形はないか（黙って消えると
  「応答が来ていない」に見える）`,
    },
    {
        key: 'transcript',
        prompt: `**観点: リポジトリ外の読み取り（活動観測 / L2）。**

見るもの: v0/transcript.mjs 全体、v0/server.mjs の collectAgents 呼び出し。

背景: ~/.claude/projects/ のセッション記録を読む。**自由文を出さない**ことが本体で、
二重の許可リスト（レコード種別 + フィールド）にしてある。T5（ツールの結果・
thinking）はどのフラグでも出さない。

疑うこと:
- **許可リストの抜け。** 自由文が payload に出る経路が他に無いか
  （実データを見て確認してほしい。~/.claude/projects/ を読んで良い）
- enumValue / isoTime / toolName の検証を通り抜ける値
- パス処理（relativeInside）で他プロジェクトのパスが出る形
- 読む量とコスト（末尾 256KB / 先頭 16KB の前提が崩れる場合）
- 記録が壊れている / 途中で切れている / 巨大な1行のときの挙動`,
    },
    {
        key: 'ops-scripts',
        prompt: `**観点: 運用スクリプトと起動時の判断。**

見るもの: scripts/serve.mjs, scripts/autostart.mjs,
v0/server.mjs の parseArgs() と起動時の警告・拒否。

疑うこと:
- HKCU の Run キーに書く文字列の組み立て（引用、空白、注入）
- --allow-host / capability / 観測フラグの引き継ぎ漏れ
  （**手元では気付けず再起動後だけ壊れる**形のバグを既に1件出している）
- ポート探索、二重起動判定、--status のプロセス照合の誤判定
- 起動を拒否すべき組み合わせを通していないか、その逆
- --token-file の権限と置き場所、リポジトリ内判定`,
    },
    {
        key: 'mutation',
        prompt: `**観点: 作業ツリーを書き換える経路（checkout / merge）。**

見るもの: v0/server.mjs の /api/v0/merge と /api/v0/checkout、requireMutation()、
mergePreview() / mergeDriverNames() / sequencerState() / worktreeStatus()、
v0/mergeplan.mjs、v0/app.html の取り込みの導線。

背景: **POST /api/v0/merge は2つ目の mutation 経路**（衝突を作りうる最初の操作）。
門は「認可 → isSafeRef → 既知の worktree → bare/prunable → シーケンサ →
dirty → merge driver → 衝突予測 → hooks 無効化」の順に並んでいる。
「画面からは衝突しないと分かっている取り込みだけ行う」が約束。

疑うこと:
- **門の順序。** 認可より前に副作用（本文の読み込み・git の起動・一時ディレクトリ）が
  起きないか。CLAUDE.md には「門をフォールバックより後ろに置いて消えた」実例がある
- **TOCTOU。** merge-tree で予測した後、実際の \`git merge\` までに
  作業ツリー / ブランチ / index が変わる窓。**同じ worktree に2本同時**に来たとき
- **リポジトリ設定の任意コードが走る経路。** core.hooksPath を空にしても
  gitattributes の filter/clean/smudge、textconv、core.fsmonitor、alias、
  submodule の設定は残る。merge driver の検出（mergeDriverNames）が見ていない
  設定の置き場所（$GIT_DIR/info/attributes、core.attributesFile、~/.gitattributes、
  macro attribute、linked worktree の info/）はないか
- detached HEAD / shortBranch が null / from が 'HEAD' に落ちるときの挙動
- **各門を外したときに落ちるテストが実在するか。** scripts/mutate.mjs に
  merge の門を外す変異が何件あるか数え、無い門を挙げてほしい
  （CLAUDE.md: merge に checkout と同じ文言の門ができた瞬間に変異の置換先がずれた）
- 監査ログ（auditExec）が実行の前に書かれているか、失敗・中断で何が残るか
- fast-forward でない merge が**別のエージェントの作業を巻き込む**形はないか`,
    },
    {
        key: 'monitor',
        prompt: `**観点: セッション監視盤と、画面に出す文字列（#18 の続き）。**

見るもの: v0/server.mjs の state payload の execSessions（requireAuth との条件式）、
v0/app.html の監視盤、v0/chatfilter.mjs、v0/argv.mjs。

背景: **全 worktree の全セッションを1画面に並べ、その行から直接 stdin を送れる**
（1cec85b）。約束が3つ増えている:
1. 監視盤は **--exec が要る**。読み取り用トークン（token-read）では出さない
2. **自分が組み立てた構造データを画面にそのまま流さない**（0027647）
3. **告知は種別ごとに1回だけ出し、残りは数えて合計を出す。捨てない**（7a1923a）

疑うこと:
- **1 の分界が本当に成立しているか。** requireAuth が false のとき（ループバックのみ +
  --exec）に何が出るか。--write だけのデーモンに監視盤が現れない保証はどこか。
  read で認証した要求と exec で認証した要求を payload が区別しているか
- **「最後の出力」はコマンドの出力そのもの** = T5 相当。
  --watch-agents の「自由文を1文字も通さない」という不変条件と衝突しないか。
  「自分が起動したものだから別」という論理が全経路で成立しているか
- 別の worktree / 別のセッションの行が混ざる、id を知った相手にできること
- **3 が再び破れる形。** 種別が多い / 種別が増える / 合計が合わない /
  告知自身がトリムで消える（一度踏んでいる）
- argv や引数の clip と、clip したことの告知（切れた値を実行できると誤解させないか）
- chatfilter の未知 type・改行で終わらない末尾行・control_response の扱いが
  **全経路で**守られているか（「解釈できない行は出す」と書いてある）
- 監視盤の更新間隔と払い出し量（v0/README.md に書いた値）が実測と合うか。
  worktree と セッションが増えたときの payload サイズと git の起動数`,
    },
    {
        key: 'tests',
        prompt: `**観点: テストが本当に守りを検証しているか（偽陽性の探索）。**

見るもの: v0/*.test.mjs、scripts/mutate.mjs、scripts/verify.mjs、v0/layout-check.mjs。

背景: このリポジトリは過去に**緑なのに守れていないテスト**を2件作っている
（core.fsmonitor はフックが起動していなかった / pathspec は入口しか見ていなかった）。

疑うこと:
- **assert しているつもりで assert していない**テスト
  （常に真になる条件、届いていない攻撃、走っていないテスト）
- 変異の pattern が実際にそのテストに当たっているか、gone が一意か
- 守りがあるのに対応する変異が無い箇所（= 外しても誰も気付かない）
- verify.mjs / layout-check.mjs が拾えない範囲
- 「実測した」と書いてあるのに固定されていない主張`,
    },
];

// 🚨 **観点を絞れるようにする（`args.only`）。** 前回はエージェントがセッション上限で
//    失敗し、6観点のうち 2 観点（exec-session / tests）が**1件も走らなかった**。
//    全部やり直すと費用が4倍になるので、抜けた観点だけ走らせ直せる形にする。
//    ⚠️ **絞ったことは必ず告知する**（黙って部分実行すると「全部見た」と読める）。
const only = Array.isArray(args?.only) ? args.only
    : (typeof args?.only === 'string' ? args.only.split(',').map(s => s.trim()) : null);
const targetDims = only ? DIMENSIONS.filter(d => only.includes(d.key)) : DIMENSIONS;
if (only) {
    const unknown = only.filter(k => !DIMENSIONS.some(d => d.key === k));
    if (unknown.length) throw new Error(`そんな観点はありません: ${unknown.join(', ')}`);
}

phase('Review');
if (only) {
    log(`⚠ 部分レビュー: ${targetDims.length}/${DIMENSIONS.length} 観点だけ走らせます`
        + `（${targetDims.map(d => d.key).join(', ')}）。他の観点は見ていません`);
} else {
    log(`範囲 ${range} を ${DIMENSIONS.length} 観点で並列にレビューします`);
}

const perDimension = await pipeline(
    targetDims,
    d => agent(`${CONTEXT}\n\n${d.prompt}${extraFocus}\n\n`
        + '重大度の基準: BLOCKING = 秘密の漏洩 / 任意コード実行 / データ破壊 / '
        + '嘘の表示。SERIOUS = 資源の取り残し・誤検出・守りの抜け。MINOR = その他。\n'
        + '**思いつきを並べないでください。** 再現できたものを優先し、'
        + 'できなかったものは measured:false にしてください。'
        + '指摘が無ければ空配列で構いません（無理に埋めない）。',
    { label: `review:${d.key}`, phase: 'Review', schema: FINDING_SCHEMA, model: MODEL }),
    (res, d) => {
        const found = (res?.findings ?? []).filter(f => f.severity !== 'MINOR');
        const minor = (res?.findings ?? []).length - found.length;
        if (minor) log(`${d.key}: MINOR ${minor} 件は検証を省略しました`);
        if (!found.length) return [];
        // 重大な順に、1観点あたり最大3件まで検証する（打ち切ったら告知する）
        const rank = { BLOCKING: 0, SERIOUS: 1 };
        const sorted = [...found].sort((a, b) => rank[a.severity] - rank[b.severity]);
        const take = sorted.slice(0, 3);
        if (sorted.length > take.length) {
            log(`${d.key}: 検証は上位 ${take.length} 件に絞りました（${sorted.length} 件中）`);
        }
        return parallel(take.map(f => () =>
            agent(`${CONTEXT}\n\n**あなたの仕事は、以下の指摘を反証することです。**\n`
                + `指摘: [${f.severity}] ${f.title}\n場所: ${f.where}\n`
                + `理由: ${f.why}\n再現: ${f.repro}\n\n`
                + '実際にコードを読み、可能なら再現を試して、'
                + '**成り立たない理由を探してください。** 既に他の守りで防がれている、'
                + '前提が誤っている、そのコード経路に到達できない、などです。\n'
                + '判断に迷うなら refuted:false（指摘は残す）にしてください。'
                + '重大度が過大／過小だと思う場合は severityAdjust で直してください。',
            { label: `verify:${d.key}`, phase: 'Verify', schema: VERDICT_SCHEMA, model: MODEL })
                .then(v => ({ dimension: d.key, finding: f, verdict: v }))));
    },
);

phase('Synthesize');
const all = perDimension.flat().filter(Boolean);
const survived = all.filter(x => x.verdict && !x.verdict.refuted).map(x => ({
    dimension: x.dimension,
    ...x.finding,
    severity: x.verdict.severityAdjust && x.verdict.severityAdjust !== 'keep'
        ? x.verdict.severityAdjust : x.finding.severity,
    verifyNote: x.verdict.reason,
}));
const refuted = all.filter(x => x.verdict?.refuted);
log(`検証 ${all.length} 件 → 生き残り ${survived.length} 件 / 反証 ${refuted.length} 件`);

const rank = { BLOCKING: 0, SERIOUS: 1, MINOR: 2 };
survived.sort((a, b) => rank[a.severity] - rank[b.severity]);

return {
    range,
    // 🚨 どの観点を見たかを結果に入れる（部分実行を全体と読み違えないため）
    dimensions: targetDims.map(d => d.key),
    partial: only ? { seen: targetDims.map(d => d.key), total: DIMENSIONS.length } : null,
    confirmed: survived,
    refuted: refuted.map(x => ({
        dimension: x.dimension, title: x.finding.title, reason: x.verdict.reason,
    })),
    counts: {
        blocking: survived.filter(f => f.severity === 'BLOCKING').length,
        serious: survived.filter(f => f.severity === 'SERIOUS').length,
        minor: survived.filter(f => f.severity === 'MINOR').length,
    },
};
