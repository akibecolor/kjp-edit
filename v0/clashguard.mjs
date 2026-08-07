// SPDX-License-Identifier: MIT
//
// 編集を始める前の「触ってよいか」の判定（#59）。
//
// `POST /api/v0/clash` の応答を、`PreToolUse` フックの許可判定に翻訳する。
// **純関数**にしてあるのは、ここが「安全側に倒れているか」を
// ネットワークもデーモンも無しに固定するため（`clashguard.test.mjs`）。
//
// 🚨 **「調べられなかった」を「衝突なし」と言わない。**
//    デーモンが落ちている / ref が解決できない / merge-tree が落ちた、は
//    すべて `ask`（人間に聞く）であって `allow` ではない。
//    観測ツールが黙って通すのは、見えていないのに「見た」と言うのと同じ。

/** フックの判定。Claude Code の permissionDecision と同じ語彙にしてある。 */
export const ALLOW = 'allow';
export const DENY = 'deny';
export const ASK = 'ask';

/**
 * 🚨 **「判定できなかった」ときの既定を、名前を付けて1箇所に置く。**
 *
 * ここを `ALLOW` にすると、デーモンが落ちているだけで**黙って全部通る**。
 * 判定の分岐に埋め込むと「安全側に倒れているか」がコードから読めなくなるので、
 * 定数にして突然変異の的にしてある（`clash-daemon-down-allows` / `clash-undecided-allows`）。
 */
const UNREACHABLE = ASK;   // 問い合わせられなかった
const UNDECIDED = ASK;     // 問い合わせたが、一部を判定できなかった

/**
 * @param {object} input
 * @param {null|object} input.answer  `/api/v0/clash` の応答（取れなければ null）
 * @param {null|string} input.error   問い合わせ自体が失敗した理由
 * @param {string[]} input.paths      これから触るリポジトリ相対パス
 * @returns {{decision: 'allow'|'deny'|'ask', reason: string}}
 */
export function decide({ answer, error, paths = [] }) {
    // 1. 問い合わせられなかった → **allow にしない**
    if (error || !answer) {
        return {
            decision: UNREACHABLE,
            reason: `衝突を確認できませんでした（${error ?? '応答がありません'}）。`
                + ' kjp-edit のデーモンが動いていない可能性があります。'
                + ' 「衝突なし」と判定したわけではありません。',
        };
    }
    // 2. 一部でも判定できなかった組がある → 安全側
    if (answer.decided !== true) {
        const why = (answer.unknown ?? []).map(u => `${u.worktree}: ${u.why}`).join(' / ');
        return {
            decision: UNDECIDED,
            reason: `一部の worktree を判定できませんでした（${why || '理由不明'}）。`
                + ' 衝突が無いとは言えません。',
        };
    }
    // 3. 自分の worktree がシーケンサの途中で止まっている → 乗っ取りになる
    const self = answer.self;
    const stopped = self && (self.rebasing || self.merging || self.cherryPicking
        || self.reverting || self.bisecting || self.sequencing);
    if (stopped) {
        return {
            decision: DENY,
            reason: `この worktree は ${sequencerName(self)} の途中で止まっています。`
                + ' ここで編集すると --continue が意図しない内容を取り込みます'
                + '（--abort するか、解決してから続けてください）。',
        };
    }
    // 4. これから触るパスが、他の worktree の変更と衝突する
    const want = new Set(paths);
    const hits = (answer.conflicts ?? [])
        .filter(c => want.size === 0 || want.has(c.path));
    if (hits.length) {
        const lines = hits.slice(0, 5).map(c =>
            `${c.path}（${c.branch ?? c.worktree}）`);
        const more = hits.length > lines.length ? ` ほか${hits.length - lines.length}件` : '';
        return {
            decision: DENY,
            reason: `他の worktree と衝突します: ${lines.join(', ')}${more}。`
                + ' 先に取り込むか、担当を分けてください。',
        };
    }
    return { decision: ALLOW, reason: '衝突は見つかりませんでした。' };
}

/** 止まっているシーケンサの名前（表示用） */
export function sequencerName(seq) {
    if (seq.rebasing) return 'rebase';
    if (seq.merging) return 'merge';
    if (seq.cherryPicking) return 'cherry-pick';
    if (seq.reverting) return 'revert';
    if (seq.bisecting) return 'bisect';
    return 'sequencer';
}

/**
 * `PreToolUse` の入力から「触るパス」を取り出す。
 *
 * ⚠️ **知らないツールを「パス無し」として通さない。** パスが取れないツールは
 *    `null` を返し、呼ぶ側が「絞り込めない = worktree 全体で見る」に倒す。
 *    空配列を返すと「どこも触らない」と読めてしまう（同じ型の事故）。
 */
export function touchedPaths(toolName, toolInput) {
    const i = toolInput ?? {};
    if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
        const p = i.file_path ?? i.notebook_path;
        return typeof p === 'string' && p ? [p] : null;
    }
    if (toolName === 'MultiEdit') {
        return typeof i.file_path === 'string' && i.file_path ? [i.file_path] : null;
    }
    return null;
}
