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
    assert.equal(hits, 3,
        `漏れているものがある（期待: text 2件 + command 1件 = 3。実際 ${hits}）:\n${json}`);
    // 新しい順なので assistant（後に書かれた方）が先
    assert.deepEqual(s.text.map(t => t.role), ['assistant', 'user']);
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

test('collectAgents: 記録の場所が無ければ理由を errors に出す（黙って消えない）', async () => {
    const { agents, errors } = await collectAgents([{ path: WT, label: 'a' }], {
        root: join(tmpdir(), 'kjp-does-not-exist-9c1f'), now: NOW,
    });
    assert.deepEqual(agents, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /読めません/);
});
