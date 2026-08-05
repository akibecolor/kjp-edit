// SPDX-License-Identifier: MIT
// node --test v0/transcript.test.mjs
//
// この機能は「出してはいけないものを出さない」ことが本体なので、
// そこを固定するテストを最初に置く。
// 実際のレコード形は 2026-08-03 に実測したものに合わせている
// （docs/agent-observation.md「何が使えるか」）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, repoRelative, readTail, collectAgents, LIMITS } from './transcript.mjs';
import { relativeInside } from './git.mjs';

const SECRET = 'INJECT-SECRET-12345';
const WT = process.platform === 'win32' ? 'C:/wt/agent-a' : '/wt/agent-a';
const NOW = Date.parse('2026-08-03T00:00:00.000Z');
const ago = ms => new Date(NOW - ms).toISOString();

/**
 * 秘密を**あらゆる入口**に仕込んだ記録。
 * 除外方式では必ずどれかが漏れる形にしてある。
 *
 * ⚠️ 記録は追記なので**古い順**に並べる（実物と同じ形にしないと、
 *    「新しい順に出す」の期待値を自分で間違える。過去に4回やっている）。
 */
function poisoned() {
    let t = 9000;
    const at = () => ago((t -= 500));   // 下に行くほど新しい
    return [
        { type: 'mode', mode: 'normal', sessionId: 's1' },
        { type: 'permission-mode', permissionMode: 'auto', sessionId: 's1' },
        // message の外にある自由文
        { type: 'last-prompt', lastPrompt: `前回 ${SECRET}`, sessionId: 's1' },
        { type: 'custom-title', customTitle: SECRET, sessionId: 's1' },
        { type: 'queue-operation', operation: 'add', content: SECRET,
            timestamp: at(), sessionId: 's1' },
        // ツールの結果 — 入口その3（ファイルの中身のスナップショット）
        { type: 'file-history-snapshot', messageId: 'm1', isSnapshotUpdate: false,
            snapshot: { 'v0/git.mjs': SECRET } },
        { type: 'file-history-delta', messageId: 'm2', snapshotMessageId: 'm1',
            trackingPath: `/etc/${SECRET}`, backup: { content: SECRET }, timestamp: at() },
        { type: 'attachment', timestamp: at(), cwd: WT, attachment: { content: SECRET } },
        // ツールの結果 — 入口その2（トップレベル）
        { type: 'user', timestamp: at(), sessionId: 's1', cwd: WT,
            toolUseResult: { stdout: SECRET, stderr: '', interrupted: false },
            message: { content: [{ type: 'tool_result', content: 'ok' }] } },
        // ツールの結果 — 入口その1
        { type: 'user', timestamp: at(), sessionId: 's1', cwd: WT,
            message: { content: [{ type: 'tool_result', content: `出力 ${SECRET}` }] } },
        // thinking（T5 扱い。allowText でも出さない）
        { type: 'assistant', timestamp: at(), sessionId: 's1', cwd: WT,
            message: { content: [{ type: 'thinking', thinking: `内心 ${SECRET}` }] } },
        // 発話（T3/T4）— user が先、assistant が後
        { type: 'user', timestamp: at(), sessionId: 's1', cwd: WT,
            message: { content: `お願い ${SECRET}` } },
        { type: 'assistant', timestamp: at(), sessionId: 's1', cwd: WT,
            message: { content: [{ type: 'text', text: `私の考え ${SECRET}` }] } },
        // ツール入力（パス以外は自由文）
        { type: 'assistant', timestamp: at(), sessionId: 's1', cwd: WT,
            message: { content: [{ type: 'tool_use', name: 'Bash',
                input: { command: `echo ${SECRET}`, description: SECRET } }] } },
        { type: 'assistant', timestamp: at(), sessionId: 's1', cwd: WT,
            message: { content: [{ type: 'tool_use', name: 'Edit',
                input: { file_path: `${WT}/v0/git.mjs`, old_string: SECRET, new_string: SECRET } }] } },
        { type: 'assistant', timestamp: at(), sessionId: 's1', cwd: WT,
            message: { content: [{ type: 'tool_use', name: 'Write',
                input: { file_path: `${WT}/v0/new.mjs`, content: SECRET } }] } },
    ].map(r => JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// 🚨 本体: 自由文が1文字も漏れないこと
// ---------------------------------------------------------------------------

test('🚨 既定では自由文が payload に1文字も入らない', () => {
    const s = summarize(poisoned(), { worktreePath: WT, now: NOW, allowText: false });
    const json = JSON.stringify(s);
    assert.ok(!json.includes(SECRET),
        `自由文が漏れている。許可リストが効いていない:\n${json.slice(0, 600)}`);
    // それでも観測はできている（何も出ないのでは意味が無い）
    assert.equal(s.state, 'active');
    assert.deepEqual(s.toolCounts, { Bash: 1, Edit: 1, Write: 1 });
    assert.equal(s.mode, 'normal');
    assert.equal(s.permissionMode, 'auto');
    assert.ok(s.talk >= 2, `発話の件数は数えるべき: ${s.talk}`);
    assert.equal(s.text.length, 0, '本文は入れない');
    assert.deepEqual(s.recent.map(r => r.path),
        ['v0/new.mjs', 'v0/git.mjs', null], 'パスは出す（新しい順）');
});

test('🚨 --allow-transcript-text でもツール結果と thinking は出さない', () => {
    const s = summarize(poisoned(), { worktreePath: WT, now: NOW, allowText: true });
    const json = JSON.stringify(s);
    // 出て良いのは「発話」と「コマンド行」だけ。件数で確かめる
    const hits = json.split(SECRET).length - 1;
    // ⚠️ 期待値は **2**。`user` の文字列 content は出さなくなった
    //    （ツールの結果と形で区別できないので T5 が漏れる。4回目のレビュー）。
    //    出て良いのは `text` ブロック1件 + Bash の command 1件だけ。
    assert.equal(hits, 2,
        `漏れているものがある（期待: text 1件 + command 1件 = 2。実際 ${hits}）:\n${json}`);
    assert.deepEqual(s.text.map(t => t.role), ['assistant'],
        '文字列 content の user を出している（T5 が漏れる）');
    assert.equal(s.recent.find(r => r.tool === 'Bash').command, `echo ${SECRET}`);
    // thinking / tool_result / snapshot / backup / attachment /
    // lastPrompt / customTitle / queue-operation / description /
    // old_string / new_string / Write の content は入っていない
    for (const [name, probe] of [
        ['thinking', '内心'], ['tool_result', '出力'], ['toolUseResult', 'stdout'],
        ['snapshot', 'snapshot'], ['backup', 'backup'], ['attachment', 'attachment'],
        ['lastPrompt', '前回'], ['queue-operation', 'operation'],
        ['description', 'description'], ['old_string', 'old_string'],
    ]) {
        assert.ok(!json.includes(probe), `${name} が payload に入っている`);
    }
});

// 🚨 4回目のレビュー（BLOCKING）: `user` の content は文字列でも来るが、
//    それは「プロンプト」だけでなく**ツールの結果（コマンド出力）でも文字列**。
//    形から区別できないので出すと T5 が漏れる。しかも同じ画面に
//    「ツールの結果は出しません」と書いてある = 嘘になる。
test('🚨 文字列の content は allowText でも本文を出さない（T5 が漏れる）', () => {
    const lines = [
        // 実物では tool_result が文字列 content で来ることがある
        { type: 'user', timestamp: ago(200), cwd: WT, sessionId: 's',
            toolUseResult: { stdout: SECRET, stderr: '' },
            message: { content: `コマンドの出力です ${SECRET}` } },
        // 本物のプロンプトも同じ形で来る（区別できない）
        { type: 'user', timestamp: ago(100), cwd: WT, sessionId: 's',
            message: { content: `お願い ${SECRET}` } },
    ].map(r => JSON.stringify(r));
    const s = summarize(lines, { worktreePath: WT, now: NOW, allowText: true });
    assert.ok(!JSON.stringify(s).includes(SECRET),
        '文字列 content から本文が漏れている（ツール結果と区別できない）');
    assert.equal(s.talk, 2, '件数は数えるべき（何も見えないのでは観測にならない）');
    assert.deepEqual(s.text, []);
});

test('🚨 Edit / Write の中身は allowText でも出さない（command だけが自由文）', () => {
    const s = summarize(poisoned(), { worktreePath: WT, now: NOW, allowText: true });
    const withText = s.recent.filter(r => r.command !== undefined);
    assert.deepEqual(withText.map(r => r.tool), ['Bash'],
        'command を持てるのは Bash / PowerShell だけ');
});

// ---------------------------------------------------------------------------
// 列挙値の縛り
// ---------------------------------------------------------------------------

// ⚠️ mode / permissionMode / ツール名は「記録の中の文字列」なので、
//    そのまま払い出すと形式が変わったときに自由文が通る。
test('列挙値として通らない形の mode / ツール名は落とす', () => {
    const lines = [
        { type: 'mode', mode: `normal ${SECRET} これは長い自由文かもしれない`, sessionId: 's' },
        { type: 'permission-mode', permissionMode: `auto ${SECRET}`, sessionId: 's' },
        { type: 'assistant', timestamp: ago(100), cwd: WT, sessionId: 's',
            message: { content: [{ type: 'tool_use', name: `Bash ${SECRET}`, input: {} }] } },
    ].map(r => JSON.stringify(r));
    const s = summarize(lines, { worktreePath: WT, now: NOW, allowText: false });
    assert.equal(s.mode, null, '空白入りの mode を通した');
    assert.equal(s.permissionMode, null);
    assert.deepEqual(s.toolCounts, {}, '空白入りのツール名を通した');
    assert.ok(!JSON.stringify(s).includes(SECRET));
});

test('壊れた timestamp は落とす（自由文の抜け道にしない）', () => {
    const lines = [JSON.stringify({
        type: 'assistant', timestamp: SECRET, cwd: WT, sessionId: 's',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    })];
    const s = summarize(lines, { worktreePath: WT, now: NOW });
    assert.ok(!JSON.stringify(s).includes(SECRET));
    assert.equal(s.recent[0].at, null);
    assert.equal(s.state, 'none', '時刻が読めないなら状態も断定しない');
});

// ---------------------------------------------------------------------------
// パス
// ---------------------------------------------------------------------------

test('リポジトリ外のパスは出さず「外」と印を付ける', () => {
    const outsidePath = process.platform === 'win32' ? 'C:/other/secret.env' : '/other/secret.env';
    const lines = [JSON.stringify({
        type: 'assistant', timestamp: ago(100), cwd: WT, sessionId: 's',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: outsidePath } }] },
    })];
    const s = summarize(lines, { worktreePath: WT, now: NOW });
    assert.equal(s.recent[0].path, null, 'リポジトリ外のパスを出した');
    assert.equal(s.recent[0].outside, true, '外を触ったことは伝える');
    assert.ok(!JSON.stringify(s).includes('secret.env'));
});

/**
 * 🚨 **パスは自由文の通り道なので、長さで縛る。**
 *
 * `isSafeRepoPath` は空白・改行・任意の Unicode を 4096 文字まで通すので、
 * `--watch-agents` だけで recent 12件 × 4096 ≒ 48KB の任意テキストが、
 * 発話用のフラグ（`--allow-transcript-text`）を経由せずに出ていた。
 * 引き金は実在する: 読んだ README や Web ページのインジェクションが
 * `Read("<repo>/<秘密>")` を1回呼ばせれば、失敗した read でも tool_use として残る（#38）。
 */
test('🚨 長いパスは切って、切ったことを伝える（自由文の通り道を縛る）', () => {
    const rec = tail => [JSON.stringify({
        type: 'assistant', timestamp: ago(100), cwd: WT, sessionId: 's',
        message: { content: [{ type: 'tool_use', name: 'Read',
            input: { file_path: `${WT}/${tail}` } }] },
    })];

    const long = summarize(rec(`${'A'.repeat(300)}${SECRET}`), { worktreePath: WT, now: NOW });
    const r = long.recent[0];
    assert.ok(r.path.length <= LIMITS.pathChars + 1,
        `パスが上限を超えて出ている: ${r.path.length} 文字`);
    assert.equal(r.pathClipped, true, '切ったことを payload に残していない');
    assert.ok(!JSON.stringify(long).includes(SECRET),
        '長いパスの末尾に置いた秘密がそのまま出ている（上限が効いていない）');
    // ⚠️ 切ったパスは**別のファイルを指すか何も指さない**。開ける扱いにしてはいけない
    assert.ok(r.path.endsWith('…'), '省略の印が付いていない');

    // 上限内なら切らない（普通のパスに省略の印を付けてしまわない）
    const shortOne = summarize(rec('v0/git.mjs'), { worktreePath: WT, now: NOW }).recent[0];
    assert.equal(shortOne.path, 'v0/git.mjs');
    assert.equal(shortOne.pathClipped, false);

    // 📓 **残るリスクを明示する。** 上限内のパスは出る = ファイル名に入れた文字列は出る。
    //    `git ls-files` と照合すれば消せるが、worktree ごとに git 呼び出しが増えるので
    //    採らない（CLAUDE.md）。`docs/agent-observation.md` にこの残りを書いた。
    const shortSecret = summarize(rec(`${SECRET}.md`), { worktreePath: WT, now: NOW });
    assert.ok(JSON.stringify(shortSecret).includes(SECRET),
        '短いパスは出る前提で文書を書いている。挙動が変わったら文書も直すこと');
});

// 🚨 これが種別の許可リストの本当の理由。
//    記録の形式は Claude Code の内部形式で、**フィールドもレコード種別も増える**。
//    増えた種別が message.content を持っていたら、除外方式では黙って本文が漏れる。
//    許可リストなら「知らない種別は見ない」で済む。
test('🚨 知らないレコード種別は message.content を持っていても見ない', () => {
    const lines = [JSON.stringify({
        // 将来増えるかもしれない種別。中身の形は assistant と同じ
        type: 'some-future-record-type',
        timestamp: ago(100), cwd: WT, sessionId: 's',
        message: { content: [
            { type: 'text', text: `未来の本文 ${SECRET}` },
            { type: 'tool_use', name: 'Bash', input: { command: `echo ${SECRET}` } },
        ] },
    })];
    // 自由文を出す設定でも、知らない種別は走査しない
    const s = summarize(lines, { worktreePath: WT, now: NOW, allowText: true });
    assert.ok(!JSON.stringify(s).includes(SECRET),
        '知らない種別を走査している（許可リストが効いていない）');
    assert.deepEqual(s.toolCounts, {});
    assert.equal(s.scanned, 0);
});

// 🚨 表記が違うと「中にあるファイルを外と判定」して**見失う**。
//    これは漏れではないが、観測ツールとしては致命的に役に立たなくなる。
//    ~/.claude の記録には realpath される前のパスが入りうる。
test('🚨 symlink / junction 越しのパスでも worktree 相対に丸められる', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kjp-tr-link-'));
    try {
        const real = join(dir, 'wt');
        await mkdir(real);
        const link = join(dir, 'link');
        try {
            const { symlink } = await import('node:fs/promises');
            await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            return;   // 権限が無い環境
        }
        const lines = [JSON.stringify({
            type: 'assistant', timestamp: ago(100), cwd: link, sessionId: 's',
            message: { content: [{ type: 'tool_use', name: 'Edit',
                // 記録側は link 経由、worktree 側は実体
                input: { file_path: join(link, 'v0', 'git.mjs') } }] },
        })];
        const s = summarize(lines, { worktreePath: real, now: NOW });
        assert.equal(s.recent[0].path, 'v0/git.mjs',
            'symlink 越しのパスを見失っている（path.relative では ../.. になる）');
        assert.equal(s.recent[0].outside, false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('大文字小文字は保つ（git はパスを区別するので小文字化してはいけない）', () => {
    const base = process.platform === 'win32' ? 'C:/wt/a' : '/wt/a';
    assert.equal(repoRelative(base, `${base}/v0/Git.MJS`), 'v0/Git.MJS');
});

test('repoRelative: 区切り文字を / に揃え、外は null', () => {
    const base = process.platform === 'win32' ? 'C:/wt/a' : '/wt/a';
    assert.equal(repoRelative(base, `${base}/v0/git.mjs`), 'v0/git.mjs');
    assert.equal(repoRelative(base, base), null, '基準そのものはパスではない');
    assert.equal(repoRelative(base, process.platform === 'win32' ? 'C:/wt/b/x' : '/wt/b/x'), null);
    assert.equal(repoRelative(base, null), null);
});

// ---------------------------------------------------------------------------
// 壊れた入力・上限
// ---------------------------------------------------------------------------

test('書き込み途中の行で落ちず、落とした件数を報告する', () => {
    const lines = [
        '{"type":"assistant","timestamp"',      // 途中で切れている
        'not json at all',
        JSON.stringify({ type: 'assistant', timestamp: ago(10), cwd: WT, sessionId: 's',
            message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
    ];
    const s = summarize(lines, { worktreePath: WT, now: NOW });
    assert.equal(s.dropped, 2);
    assert.equal(s.toolCounts.Bash, 1);
});

test('件数の上限で打ち切る', () => {
    const many = [];
    for (let i = 0; i < 100; i++) {
        many.push(JSON.stringify({ type: 'assistant', timestamp: ago(i * 10), cwd: WT, sessionId: 's',
            message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }));
    }
    const s = summarize(many, { worktreePath: WT, now: NOW });
    assert.equal(s.recent.length, LIMITS.maxRecent);
    assert.equal(s.toolCounts.Bash, 100, '件数は上限を超えても数える');
});

test('状態は経過時間で決まる（古い記録を「動いている」と言わない）', () => {
    const mk = ms => [JSON.stringify({ type: 'assistant', timestamp: ago(ms), cwd: WT, sessionId: 's',
        message: { content: [{ type: 'text', text: 'x' }] } })];
    assert.equal(summarize(mk(1000), { worktreePath: WT, now: NOW }).state, 'active');
    assert.equal(summarize(mk(10 * 60 * 1000), { worktreePath: WT, now: NOW }).state, 'idle');
    assert.equal(summarize(mk(3 * 24 * 3600 * 1000), { worktreePath: WT, now: NOW }).state, 'stale');
    assert.equal(summarize([], { worktreePath: WT, now: NOW }).state, 'none');
});

// ---------------------------------------------------------------------------
// fs 側
// ---------------------------------------------------------------------------

test('readTail: 末尾だけ読み、先頭の不完全な行を捨てる', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kjp-tr-'));
    try {
        const f = join(dir, 's.jsonl');
        const rows = [];
        for (let i = 0; i < 500; i++) rows.push(JSON.stringify({ n: i, pad: 'x'.repeat(200) }));
        await writeFile(f, `${rows.join('\n')}\n`, 'utf8');
        const { lines, truncated, bytes } = await readTail(f, 4096);
        assert.equal(truncated, true);
        assert.ok(bytes <= 4096);
        // 残った行は全て完全な JSON
        for (const l of lines) {
            if (!l.trim()) continue;
            JSON.parse(l);   // throw したら失敗
        }
        // 全部読める大きさなら truncated=false で1行目も残る
        const all = await readTail(f, 10 * 1024 * 1024);
        assert.equal(all.truncated, false);
        assert.equal(JSON.parse(all.lines[0]).n, 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('collectAgents: cwd で worktree に対応付け、無関係な記録は無視する', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kjp-proj-'));
    const wtRoot = await mkdtemp(join(tmpdir(), 'kjp-wt-'));
    try {
        const wtA = join(wtRoot, 'agent-a');
        const wtB = join(wtRoot, 'agent-b');
        await mkdir(wtA); await mkdir(wtB);

        const rec = (cwd, tool) => JSON.stringify({
            type: 'assistant', timestamp: ago(1000), cwd, sessionId: 'sx',
            message: { content: [{ type: 'tool_use', name: tool, input: {} }] },
        });
        // A の記録
        const dA = join(root, 'proj-a'); await mkdir(dA);
        await writeFile(join(dA, 'a.jsonl'), `${rec(wtA, 'Edit')}\n`, 'utf8');
        // 他プロジェクトの記録（無視されるべき）
        const dX = join(root, 'proj-x'); await mkdir(dX);
        await writeFile(join(dX, 'x.jsonl'),
            `${rec(join(wtRoot, 'somewhere-else'), 'Bash')}\n`, 'utf8');
        // .jsonl 以外は開かない
        await writeFile(join(dX, 'notes.txt'), SECRET, 'utf8');

        const worktrees = [{ path: wtA, label: 'agent-a' }, { path: wtB, label: 'agent-b' }];
        const { agents, errors } = await collectAgents(worktrees, { root, now: NOW });
        assert.deepEqual(errors, [], `errors を汚している: ${JSON.stringify(errors)}`);
        const a = agents.find(x => x.name === 'agent-a');
        const b = agents.find(x => x.name === 'agent-b');
        assert.equal(a.toolCounts.Edit, 1);
        assert.equal(a.state, 'active');
        // 記録が無いのはエラーではない
        assert.equal(b.state, 'none');
        assert.equal(b.session, null);
        assert.ok(!JSON.stringify(agents).includes(SECRET), '.jsonl 以外を読んでいる');
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(wtRoot, { recursive: true, force: true });
    }
});

/**
 * 🚨 **cwd が最新の1本から読めなくても諦めない（#36）。**
 *
 * 実データに引き金がある: cwd を1つも持たない 112B の `teleported-from` スタブが
 * 3本あり、同じディレクトリに 182MB の実セッションが同居している。
 * スタブが後から書かれれば mtime が最新になり、**そのプロジェクトの観測が死ぬ**。
 * しかも `errors` は空なので告知が一切無く、UI は稼働中のエージェントに
 * 「走らせた記録がありません」と断言する。
 */
test('🚨 最新の記録に cwd が無くても、次の候補と広い窓で見つける（記録なしと嘘をつかない）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kjp-cwd-'));
    const wtRoot = await mkdtemp(join(tmpdir(), 'kjp-cwdwt-'));
    try {
        const wt = join(wtRoot, 'agent-a');
        await mkdir(wt);
        const live = JSON.stringify({
            type: 'assistant', timestamp: ago(20_000), cwd: wt, sessionId: 's1',
            message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
        });

        // (A) 最新が cwd を持たないスタブ。実セッションは1本古い方
        const dA = join(root, 'proj-a'); await mkdir(dA);
        await writeFile(join(dA, 'real.jsonl'), `${live}\n`, 'utf8');
        // ⚠️ mtime を確実に新しくする（同一 ms だと順序が決まらない）
        await new Promise(r => setTimeout(r, 30));
        await writeFile(join(dA, 'stub.jsonl'),
            `${JSON.stringify({ type: 'teleported-from', sessionId: 's0' })}\n`, 'utf8');

        const worktrees = [{ path: wt, label: 'agent-a' }];
        const a = (await collectAgents(worktrees, { root, now: NOW }))
            .agents.find(x => x.name === 'agent-a');
        assert.equal(a.state, 'active',
            'cwd を持たないスタブが最新だと観測が死ぬ（次の候補を試していない）');
        assert.equal(a.toolCounts.Edit, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(wtRoot, { recursive: true, force: true });
    }
});

test('🚨 先頭レコードが窓より大きくても cwd を見つける（黙って捨てない）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kjp-head-'));
    const wtRoot = await mkdtemp(join(tmpdir(), 'kjp-headwt-'));
    try {
        const wt = join(wtRoot, 'agent-a');
        await mkdir(wt);
        const dir = join(root, 'proj'); await mkdir(dir);
        // 先頭レコードが headBytes（16KB）を超える。cwd はその**後ろ**の行にある
        const fat = JSON.stringify({
            type: 'file-history-snapshot', messageId: 'm', snapshot: { x: 'A'.repeat(40_000) },
        });
        const live = JSON.stringify({
            type: 'assistant', timestamp: ago(5000), cwd: wt, sessionId: 's1',
            message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
        });
        await writeFile(join(dir, 's.jsonl'), `${fat}\n${live}\n`, 'utf8');

        const { agents, errors } = await collectAgents([{ path: wt, label: 'agent-a' }],
            { root, now: NOW });
        const a = agents.find(x => x.name === 'agent-a');
        assert.equal(a.state, 'active',
            `先頭 16KB に cwd が入らないと丸ごと捨てている: ${JSON.stringify(errors)}`);
        assert.equal(a.toolCounts.Read, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(wtRoot, { recursive: true, force: true });
    }
});

/**
 * 🚨 **窓が全部「知らない種別」でも「記録なし」と言わない（#37）。**
 *
 * 完全な行は取れている（`needMore:false` / `tooBigToRead:false`）ので #27 の救済に
 * 乗らず、`lastActivityAt:null` → UI は 5秒前に Edit を書いたエージェントに
 * 「走らせた記録がありません」と表示していた。実データで
 * **許可リスト外の type が 304KB 連続する箇所**があり、既定の窓（256KB）を超える。
 */
test('🚨 末尾が全部「知らない種別」でも読み直し、駄目なら抽出できないと伝える', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kjp-unk-'));
    const wtRoot = await mkdtemp(join(tmpdir(), 'kjp-unkwt-'));
    try {
        const wt = join(wtRoot, 'agent-a');
        await mkdir(wt);
        const live = JSON.stringify({
            type: 'assistant', timestamp: ago(5000), cwd: wt, sessionId: 's1',
            message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
        });
        // 許可リスト外の行で末尾の窓（256KB）を埋める
        const junk = JSON.stringify({
            type: 'file-history-snapshot', messageId: 'm', snapshot: { x: 'B'.repeat(20_000) },
        });
        const filler = `${junk}\n`.repeat(20);   // 約 400KB

        // (A) 広げれば届く → 抽出できる
        const dA = join(root, 'proj-a'); await mkdir(dA);
        await writeFile(join(dA, 's.jsonl'), `${live}\n${filler}`, 'utf8');
        const a = (await collectAgents([{ path: wt, label: 'agent-a' }], { root, now: NOW }))
            .agents.find(x => x.name === 'agent-a');
        assert.equal(a.state, 'active',
            '窓の外に活動があるのに「記録なし」にしている（広げて読み直していない）');
        assert.equal(a.toolCounts.Edit, 1);

        // (B) 上限まで広げても知らない種別だけ → 「抽出できなかった」と言う
        const root2 = await mkdtemp(join(tmpdir(), 'kjp-unk2-'));
        try {
            const dB = join(root2, 'proj-b'); await mkdir(dB);
            // cwd は持つが、活動として読める行が1本も無い
            await writeFile(join(dB, 's.jsonl'),
                `${JSON.stringify({ type: 'attachment', cwd: wt, attachment: { content: 'x' } })}\n`,
                'utf8');
            const r = await collectAgents([{ path: wt, label: 'agent-a' }], { root: root2, now: NOW });
            const b = r.agents.find(x => x.name === 'agent-a');
            assert.equal(b.state, 'none');
            assert.equal(b.noneReason, 'no-known-records',
                '「記録が無い」と「抽出できなかった」を区別していない');
            assert.ok(r.errors.some(e => /抽出できませんでした/.test(e.message)),
                `告知が無い（黙って「記録なし」になる）: ${JSON.stringify(r.errors)}`);
        } finally {
            await rm(root2, { recursive: true, force: true });
        }
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(wtRoot, { recursive: true, force: true });
    }
});

// 🚨 #27: 実データには 1.25MB / 776KB の**1レコード**が実在する
//    （大きい tool_result / file-history）。256KB では完全な行が0本になり、
//    以前は state='none' → 稼働中のエージェントに「記録がありません」と表示していた。
test('🚨 巨大な1レコードでも読み直して、記録なしと嘘をつかない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kjp-big-'));
    const wtRoot = await mkdtemp(join(tmpdir(), 'kjp-bigwt-'));
    try {
        const wt = join(wtRoot, 'agent-a');
        await mkdir(wt);
        const dir = join(root, 'proj'); await mkdir(dir);
        // 700KB の tool_result を持つレコード（256KB では1行も完成しない）
        const huge = JSON.stringify({
            type: 'user', timestamp: ago(5000), cwd: wt, sessionId: 'sx',
            toolUseResult: { stdout: 'x'.repeat(700 * 1024), stderr: '' },
            message: { content: [{ type: 'tool_result', content: 'ok' }] },
        });
        const act = JSON.stringify({
            type: 'assistant', timestamp: ago(1000), cwd: wt, sessionId: 'sx',
            message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
        });
        // 末尾が「巨大レコード → 小さい活動」の順。256KB だと巨大レコードの
        // 途中から始まるので、先頭の不完全行を捨てた結果 act だけ残る…はずが
        // 巨大レコードが末尾に近いと1行も残らない形を作る
        await writeFile(join(dir, 'sx.jsonl'), `${act}\n${huge}\n`, 'utf8');

        const worktrees = [{ path: wt, label: 'agent-a' }];
        const { agents, errors } = await collectAgents(worktrees, { root, now: NOW });
        const a = agents[0];
        // 読み直して活動が見えるか、少なくとも「読めなかった」と分かること。
        // **黙って none にするのは駄目**
        const honest = a.state !== 'none' || a.tooBigToRead === true
            || errors.some(e => /読めません/.test(e.message));
        assert.ok(honest,
            `巨大レコードで黙って「記録なし」になっている: ${JSON.stringify(a)}`);
        // 読み直したなら活動が見える
        if (!a.tooBigToRead) {
            assert.equal(a.state, 'active', '読み直しても活動が見えない');
            assert.equal(a.toolCounts.Edit, 1);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(wtRoot, { recursive: true, force: true });
    }
});

test('🚨 上限まで読んでも1行も取れなければ「読めなかった」と伝える（記録なしにしない）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kjp-big2-'));
    const wtRoot = await mkdtemp(join(tmpdir(), 'kjp-bigwt2-'));
    try {
        const wt = join(wtRoot, 'agent-a');
        await mkdir(wt);
        const dir = join(root, 'proj'); await mkdir(dir);
        // 先頭に cwd を持つ小さい行、そのあと**改行の無い**巨大な塊
        const head = JSON.stringify({ type: 'assistant', timestamp: ago(1000), cwd: wt, sessionId: 's' });
        await writeFile(join(dir, 's.jsonl'), `${head}\n${'y'.repeat(200 * 1024)}`, 'utf8');
        const { agents, errors } = await collectAgents([{ path: wt, label: 'agent-a' }], {
            root, now: NOW,
            limits: { ...LIMITS, tailBytes: 4096, tailMaxBytes: 16 * 1024 },
        });
        const a = agents[0];
        assert.ok(a.tooBigToRead === true || a.state !== 'none',
            `黙って「記録なし」になっている: ${JSON.stringify(a)}`);
        if (a.tooBigToRead) {
            assert.ok(errors.some(e => /読めません/.test(e.message)),
                '理由が errors に出ていない');
        }
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(wtRoot, { recursive: true, force: true });
    }
});

// 🚨 #28: サブエージェントの記録は `<sessionId>/subagents/agent-*.jsonl` にあり、
//    親のファイルには出ない。`isSidechain` は実データ4本すべてで0件だった。
//    その結果、親がサブを走らせている間は「待機 N分」と表示されていた（嘘）。
test('🚨 サブエージェントの活動を数え、親を「待機」と嘘表示しない', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kjp-sub-'));
    const wtRoot = await mkdtemp(join(tmpdir(), 'kjp-subwt-'));
    try {
        const wt = join(wtRoot, 'agent-a');
        await mkdir(wt);
        const dir = join(root, 'proj'); await mkdir(dir);
        // 親の最後の活動は 30 分前（このままなら idle = 「待機」）
        const old = new Date(NOW - 30 * 60 * 1000).toISOString();
        await writeFile(join(dir, 'sx.jsonl'), `${JSON.stringify({
            type: 'assistant', timestamp: old, cwd: wt, sessionId: 'sx',
            message: { content: [{ type: 'tool_use', name: 'Task', input: {} }] },
        })}\n`, 'utf8');
        // サブエージェントの記録（中身は読まれないので空でよい）。**今書いた**
        const subDir = join(dir, 'sx', 'subagents');
        await mkdir(subDir, { recursive: true });
        await writeFile(join(subDir, 'agent-a1.jsonl'), '{}\n', 'utf8');
        await writeFile(join(subDir, 'agent-a2.jsonl'), '{}\n', 'utf8');
        // workflows の下も1階層見る
        const wfDir = join(subDir, 'workflows', 'wf_1');
        await mkdir(wfDir, { recursive: true });
        await writeFile(join(wfDir, 'agent-b1.jsonl'), '{}\n', 'utf8');

        const { agents } = await collectAgents([{ path: wt, label: 'agent-a' }], {
            root, now: Date.now(),   // mtime は実時刻なので now も実時刻で見る
        });
        const a = agents[0];
        assert.ok(a.subagents, 'サブエージェントを数えていない');
        assert.equal(a.subagents.total, 3, `件数が合わない: ${JSON.stringify(a.subagents)}`);
        assert.equal(a.subagents.active, 3, '直近に書かれたサブを稼働と見ていない');
        assert.equal(a.sidechains, 3, 'sidechains が常に 0 のまま');
        // 🚨 ここが本体: 親が30分前でも、サブが動いていれば稼働中
        assert.equal(a.state, 'active',
            `サブが動いているのに「${a.state}」と表示している（親の追記が止まるだけ）`);
        assert.equal(a.activityFrom, 'subagent', '最後の活動の出所が分からない');
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(wtRoot, { recursive: true, force: true });
    }
});

test('collectAgents: 記録の場所が無ければ理由を errors に出す（黙って消えない）', async () => {
    const { agents, errors } = await collectAgents([{ path: WT, label: 'a' }], {
        root: join(tmpdir(), 'kjp-does-not-exist-9c1f'), now: NOW,
    });
    assert.deepEqual(agents, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /読めません/);
});

/**
 * 🚨 **相対パスをデーモンの cwd で解決してはいけない（7回目のレビュー）。**
 *
 * 記録側のパスは相対のことがある（Grep / Glob の `path` など）。
 * `realpathSync.native()` は**サーバプロセスの cwd** を基準に解決するので、
 * (a) 触っていないファイルを「触った」と表示し、
 * (b) worktree 内のファイルを「(リポジトリ外)」と表示する、という2つの嘘が出る。
 * レコードには `cwd` が入っていて所有者判定に使っているのに、解決には使っていなかった。
 */
test('🚨 相対パスはレコードの cwd で解決し、分からなければ「不明」と言う', () => {
    const rec = (input, cwd) => [JSON.stringify({
        type: 'assistant', timestamp: ago(1000), cwd, sessionId: 's',
        message: { content: [{ type: 'tool_use', name: 'Grep', input }] },
    })];

    // cwd があれば worktree 相対に解決できる
    const withCwd = summarize(rec({ path: 'v0/git.mjs' }, WT), { worktreePath: WT, now: NOW });
    assert.equal(withCwd.recent[0].path, 'v0/git.mjs');
    assert.equal(withCwd.recent[0].outside, false);
    assert.equal(withCwd.recent[0].pathUnresolved, false);

    // cwd が無ければ **「外」と断言せず不明にする**（デーモンの cwd で解決しない）
    const noCwd = summarize(rec({ path: 'v0/git.mjs' }, undefined), { worktreePath: WT, now: NOW });
    assert.equal(noCwd.recent[0].path, null, 'デーモンの cwd で解決している');
    assert.equal(noCwd.recent[0].outside, false, '「外」と断言してはいけない');
    assert.equal(noCwd.recent[0].pathUnresolved, true, '不明であることを伝えていない');

    // 別プロジェクトの cwd を基準にした相対パスは「外」になる（漏らさない）
    const other = process.platform === 'win32' ? 'C:/other/proj' : '/other/proj';
    const outside = summarize(rec({ path: 'secret.env' }, other), { worktreePath: WT, now: NOW });
    assert.equal(outside.recent[0].path, null);
    assert.equal(outside.recent[0].outside, true);
});

/**
 * 🚨 **元表記の段数が足りないときは「外」と言う（7回目のレビュー）。**
 *
 * junction / symlink がリポジトリの**中の深い場所**を指していて、記録が外側の綴りを
 * 使っていると、解決後の残り段数が元表記の段数を上回り、`orig.slice(-depth)` が
 * **リポジトリ外の親ディレクトリ名を巻き込む**。それが `isSafeRepoPath` を通るので
 * `outside:false` で payload に載り、「外のパスは出さない」が破れる。
 */
test('🚨 relativeInside: 元表記の段数が足りなければ null（外）を返す', () => {
    // 解決後に段数が増える形を直接作る（正規化で段が増える = 元表記が短い）
    // ⚠️ 実際の junction を作らずに不変条件だけ確かめる: 中にあると判定されたなら、
    //    返る相対パスの段数は**元表記の段数以下**でなければならない
    const cases = [
        [WT, `${WT}/a/b/c.txt`],
        [WT, `${WT}/a.txt`],
        [WT, WT],
    ];
    for (const [parent, child] of cases) {
        const rel = relativeInside(parent, child);
        if (rel === null || rel === '') continue;
        const origSegs = child.split(/[\/]/).filter(Boolean).length;
        assert.ok(rel.split('/').length <= origSegs,
            `元表記より段数が多い相対パスを返した: ${rel} (from ${child})`);
        // 外の名前を巻き込んでいないこと
        assert.ok(!rel.includes('..'), `.. が入っている: ${rel}`);
    }
});

/**
 * 🚨 **1ファイルの読み取り失敗でプロジェクト丸ごとを捨てない（7回目のレビュー）。**
 *
 * `try` が readdir のループの**外**にあったので、`stat()` が1つでも投げると
 * （消えた最中 / 権限 / ロック）**プロジェクトディレクトリ全体**を無告知で捨てていた。
 * 結果、5秒前に Edit を書いたエージェントに「記録がありません」と断言する。
 * #27 / #36 / #37 で3回潰した型が、まだここに残っていた。
 */
test('🚨 1ファイルが読めなくてもプロジェクトを捨てない（告知はする）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kjp-drop-'));
    const wtRoot = await mkdtemp(join(tmpdir(), 'kjp-dropwt-'));
    try {
        const wt = join(wtRoot, 'agent-a');
        await mkdir(wt);
        const dir = join(root, 'proj');
        await mkdir(dir);
        const live = JSON.stringify({
            type: 'assistant', timestamp: ago(3000), cwd: wt, sessionId: 's1',
            message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
        });
        await writeFile(join(dir, 'real.jsonl'), `${live}\n`, 'utf8');
        // ⚠️ **読めない `.jsonl` を作る。** 消したファイルの名前を readdir が返す形は
        //    移植可能に作れないので、**ディレクトリを `.jsonl` という名前で作る**
        //    （`stat` は通るが `isFile()` が false になる形ではなく、
        //     `open` が EISDIR で落ちる形を作りたいので、後段の失敗も一緒に確かめる）。
        await writeFile(join(dir, 'broken.jsonl'), 'x\n', 'utf8');

        // ⚠️ **stat が投げるファイルを移植可能に作れない**（symlink は Windows で EPERM、
        //    ディレクトリは stat が成功する）。検査専用の継ぎ目で1本だけ投げさせる。
        const statFn = async q => {
            if (String(q).endsWith('broken.jsonl')) throw new Error('EACCES（検査で注入）');
            const { stat } = await import('node:fs/promises');
            return stat(q);
        };
        const r = await collectAgents([{ path: wt, label: 'agent-a' }], { root, now: NOW, statFn });
        const a = r.agents.find(x => x.name === 'agent-a');
        assert.equal(a.state, 'active',
            `1本読めないだけでプロジェクトを捨てている: ${JSON.stringify(r.errors)}`);
        assert.equal(a.toolCounts.Edit, 1);
        // 🚨 読めなかったことは**黙って飲まない**（件数で告知する）
        assert.ok(r.errors.some(e => /読めなかった/.test(e.message)),
            `読めなかったファイルの告知が無い: ${JSON.stringify(r.errors)}`);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(wtRoot, { recursive: true, force: true });
    }
});
