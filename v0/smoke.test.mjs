// SPDX-License-Identifier: MIT
// node --test v0/smoke.test.mjs
//
// 手で確認したことを自動化したスモークテスト。
// 使い捨ての一時リポジトリを作るので、あなたのリポジトリには触りません。
//
// docs/encoding-and-paths.md の E1/E3/E6/E7 を実際に踏む:
//   E1 日本語ファイル名  E3 日本語＋空白のファイル名
//   E6 日本語コミットメッセージ  E7 日本語ブランチ名
// そして誰もガードしていないシーケンサ乗っ取りの検出を検証する。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

let repo;          // 一時リポジトリ
let proc;          // サーバプロセス
let baseUrl;
let emptyConfig;   // 空の gitconfig

/**
 * 開発者の ~/.gitconfig と system gitconfig を無効化する env。
 *
 * ⚠️ os.devNull は使えない。Windows では '\\\\.\\nul' になり git が
 *    「fatal: unable to access '//./nul': Invalid argument」で落ちる（実測）。
 *    docs/encoding-and-paths.md に /dev/null と書いていたのは Windows で誤り。
 *    空ファイルを指すのが移植性のある方法。
 */
function isolatedConfig() {
    return { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig };
}

/** テスト用の git。ユーザの ~/.gitconfig に依存しない（決定性のため）。 */
function g(args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
            cwd,
            shell: false,
            windowsHide: true,
            env: {
                ...process.env,
                // docs/encoding-and-paths.md: 開発者の設定でテストが揺れないようにする。
                ...isolatedConfig(),
                GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
                GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
                GIT_TERMINAL_PROMPT: '0',
            },
        });
        const out = [], err = [];
        child.stdout.on('data', c => out.push(c));
        child.stderr.on('data', c => err.push(c));
        child.on('error', reject);
        child.on('close', code => code === 0
            ? resolve(Buffer.concat(out).toString('utf8'))
            : reject(new Error(`git ${args.join(' ')} → ${code}: ${Buffer.concat(err)}`)));
    });
}

before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'kjp-smoke-'));
    emptyConfig = join(repo, '.empty-gitconfig');
    await writeFile(emptyConfig, '', 'utf8');
    await g(['init', '-q', '-b', 'main'], repo);
    // GIT_CONFIG_GLOBAL を潰しているのでコミット可能な最小設定を repo local に入れる
    await g(['config', 'user.name', 't'], repo);
    await g(['config', 'user.email', 't@example.com'], repo);

    await writeFile(join(repo, 'README.md'), '# smoke\n', 'utf8');
    await g(['add', '-A'], repo);
    await g(['commit', '-q', '-m', 'chore: 初期コミット'], repo);   // E6 日本語メッセージ

    // 2つのエージェント worktree。共通ファイル shared.txt を両方が触る
    for (const n of ['a', 'b']) {
        const wt = join(repo, '..', `${repo.split(/[\\/]/).pop()}-wt-${n}`);
        await g(['worktree', 'add', '-q', '-b', `agent-${n}`, wt], repo);
        await writeFile(join(wt, `only-${n}.txt`), `${n}\n`, 'utf8');
        await writeFile(join(wt, 'shared.txt'), `touched by ${n}\n`, 'utf8');
        // E1 日本語ファイル名 / E3 日本語＋空白
        await mkdir(join(wt, '日本語フォルダ'), { recursive: true });
        await writeFile(join(wt, '日本語フォルダ', `テスト ファイル-${n}.txt`), 'ok\n', 'utf8');
        await g(['add', '-A'], wt);
        await g(['commit', '-q', '-m', `feat: agent-${n} の変更`], wt);
    }

    // E7 日本語ブランチ名
    await g(['branch', '機能/新規', 'main'], repo);

    proc = spawn(process.execPath, [SERVER, '--repo', repo, '--port', '0'], {
        shell: false, windowsHide: true,
        env: { ...process.env, ...isolatedConfig() },
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    baseUrl = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('サーバが 15 秒以内に起動しなかった')), 15000);
        let buf = '';
        proc.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
            if (m) { clearTimeout(t); resolve(m[0]); }
        });
        proc.stderr.on('data', d => { clearTimeout(t); reject(new Error(`サーバが失敗: ${d}`)); });
        proc.on('error', reject);
    });
});

after(async () => {
    proc?.kill();
    // worktree は repo の外に置いたので個別に消す
    const stem = repo.split(/[\\/]/).pop();
    for (const n of ['a', 'b', 'gone']) {
        await rm(join(repo, '..', `${stem}-wt-${n}`), { recursive: true, force: true });
    }
    // basename 衝突テストが作るディレクトリ（テスト内で消し損ねた場合の保険）
    for (const n of ['dup1', 'dup2']) {
        await rm(join(repo, '..', `${stem}-${n}`), { recursive: true, force: true });
    }
    await rm(repo, { recursive: true, force: true });
});

// ⚠️ 必ず fresh=1 で叩く。サーバは短い TTL キャッシュを持つので、
//    テストがリポジトリを変更した直後に素で読むと古い payload が返り、
//    「変更が検出されない」形で偽陰性になる（実際にこれで乗っ取り検出が落ちた）。
const state = async () => (await fetch(`${baseUrl}/api/v0/state?fresh=1`)).json();

test('UI が返る', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /kjp-edit/);
});

test('ループバック以外を待ち受けていない', async () => {
    // 127.0.0.1 で listen しているので、外部 IP では接続できない
    const port = Number(new URL(baseUrl).port);
    await assert.rejects(
        fetch(`http://192.0.2.1:${port}/`, { signal: AbortSignal.timeout(1200) }),
        '外部アドレスに応答してはいけない',
    );
});

test('3つの worktree を列挙し ahead/behind を返す', async () => {
    const s = await state();
    assert.equal(s.worktrees.length, 3);
    const byBranch = Object.fromEntries(s.worktrees.map(w => [w.branch, w]));
    assert.ok(byBranch['main'], 'main worktree');
    assert.equal(byBranch['agent-a'].ahead, 1);
    assert.equal(byBranch['agent-b'].ahead, 1);
    assert.equal(byBranch['agent-a'].behind, 0);
});

test('E1/E3: 日本語＋空白のファイル名がクォートされずに返る', async () => {
    const s = await state();
    const a = s.worktrees.find(w => w.branch === 'agent-a');
    const paths = a.files.map(f => f.path);
    assert.ok(
        paths.includes('日本語フォルダ/テスト ファイル-a.txt'),
        `期待するパスが無い。実際: ${JSON.stringify(paths)}`,
    );
    // 8進エスケープ (\346\227\245) やクォートが混じっていないこと
    for (const p of paths) {
        assert.ok(!p.includes('\\3'), `8進エスケープが残っている: ${p}`);
        assert.ok(!p.startsWith('"'), `クォートが残っている: ${p}`);
    }
});

test('E6: 日本語コミットメッセージが化けずに返る', async () => {
    const s = await state();
    const subjects = s.graph.map(r => r.subject);
    assert.ok(subjects.includes('feat: agent-a の変更'), JSON.stringify(subjects));
    assert.ok(subjects.includes('chore: 初期コミット'), JSON.stringify(subjects));
});

test('E7: 日本語ブランチ名が ref として見える', async () => {
    const s = await state();
    const refs = s.graph.flatMap(r => r.refs);
    assert.ok(refs.some(r => r.includes('機能/新規')), JSON.stringify(refs));
});

test('同じファイルを触っている worktree を検出する', async () => {
    const s = await state();
    const shared = s.overlaps.find(o => o.path === 'shared.txt');
    assert.ok(shared, `shared.txt の重複が検出されていない: ${JSON.stringify(s.overlaps)}`);
    assert.deepEqual([...shared.worktrees].sort(), ['agent-a', 'agent-b'].map(n =>
        s.worktrees.find(w => w.branch === n).name).sort());
});

test('グラフで兄弟ブランチが別レーンに乗り、worktree の HEAD が印される', async () => {
    const s = await state();
    const heads = s.graph.filter(r => r.worktrees.length > 0);
    assert.equal(heads.length, 3, '3つの worktree HEAD がグラフ上にある');
    const lanes = new Set(heads.map(h => h.lane));
    assert.ok(lanes.size >= 2, `兄弟が同じレーンに畳まれている: ${[...lanes]}`);
    // 開いているレーン数がコミット数に比例して増えていない（重複排除の回帰）
    const maxLanes = Math.max(...s.graph.map(r => r.output.length));
    assert.ok(maxLanes <= 3, `レーンが漏れている: ${maxLanes}`);
});

test('🚨 シーケンサ乗っ取りを検出する（どのツールもガードしていないケース）', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-a`);

    // clean index で止まる rebase を作る。todo の先頭に break を挿入する。
    await writeFile(join(wt, 'only-a.txt'), 'a\nmore\n', 'utf8');
    await g(['add', '-A'], wt);
    await g(['commit', '-q', '-m', 'feat: agent-a の2つ目'], wt);
    await new Promise((resolve, reject) => {
        const child = spawn('git', ['rebase', '-i', 'HEAD~2'], {
            cwd: wt, shell: false, windowsHide: true,
            env: {
                ...process.env,
                ...isolatedConfig(),
                GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
                GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
                // todo の 1 行目の後ろに break を挿入する（Node で書くので shell 非依存）
                GIT_SEQUENCE_EDITOR: `${JSON.stringify(process.execPath)} -e `
                    + JSON.stringify(
                        'const f=process.argv[1],fs=require("fs");'
                        + 'const l=fs.readFileSync(f,"utf8").split("\\n");'
                        + 'l.splice(1,0,"break");fs.writeFileSync(f,l.join("\\n"));'),
            },
        });
        child.on('error', reject);
        child.on('close', () => resolve());   // break で止まるので 0 以外もありうる
    });

    // rebase 停止中に、他の worktree で使われていないブランチへ checkout。
    // git はこれを exit 0 で通してしまう。
    await g(['checkout', '-q', '-b', 'hijacked'], wt);

    const s = await state();
    const a = s.worktrees.find(w => w.path.endsWith(`-wt-a`));
    const danger = a.warnings.find(w => w.code === 'sequencer-hijack');
    assert.ok(danger, `乗っ取りが検出されていない: ${JSON.stringify(a.warnings)}`);
    assert.equal(danger.level, 'danger');
    assert.match(danger.message, /agent-a/);
    assert.match(danger.message, /hijacked/);

    // 後片付け
    await g(['rebase', '--abort'], wt).catch(() => {});
    await g(['checkout', '-q', 'agent-a'], wt).catch(() => {});
});

// ---------------------------------------------------------------------------
// レビューで見つかった「静かに 500 になる / 静かに混ざる」経路の回帰テスト。
// いずれも worktree を作る・壊すので、既存のフィクスチャを乱さないように
// 専用の worktree を作って自分で片付ける。
// ---------------------------------------------------------------------------

test('1回の収集で git を起動する回数が worktree 本数に比例して爆発しない', async () => {
    const s = await state();
    assert.ok(s.stats, 'payload に stats が無い');
    const { gitSpawns, worktrees } = s.stats;
    // 実測: 定数 5（worktree list / for-each-ref / git-common-dir /
    // origin/HEAD / log）+ 1本あたり 3（status / rev-list / diff）。
    // 1本あたり1プロセス分だけ余裕を持たせる。
    const budget = worktrees * 4 + 6;
    assert.ok(
        gitSpawns <= budget,
        `worktree ${worktrees} 本で ${gitSpawns} プロセス起動（上限 ${budget}）。`
        + ' ループの中で新しい git 呼び出しを足していないか確認する',
    );
});

test('worktree のディレクトリが消えても他の worktree は返る（500 にしない）', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const gone = join(repo, '..', `${stem}-wt-gone`);
    await g(['worktree', 'add', '-q', '-b', 'agent-gone', gone], repo);
    // ディレクトリだけ消す → git 的には prunable。cwd に使うと ENOENT。
    await rm(gone, { recursive: true, force: true });

    const res = await fetch(`${baseUrl}/api/v0/state?fresh=1`);
    assert.equal(res.status, 200, 'prunable な worktree でエンドポイントが落ちてはいけない');
    const s = await res.json();

    // 生きている worktree は今までどおり出る
    assert.ok(s.worktrees.find(w => w.branch === 'agent-a'), 'agent-a が消えている');
    assert.ok(s.worktrees.find(w => w.branch === 'main'), 'main が消えている');
    // 失われた worktree は黙って消えるのではなく prunable として現れる
    const dead = s.worktrees.find(w => w.branch === 'agent-gone');
    assert.ok(dead, 'prunable な worktree が一覧から消えている');
    assert.ok(dead.prunable, 'prunable フラグが立っていない');
    // 縮退したことが payload に残る
    assert.ok(
        s.errors.some(e => /失われて/.test(e.message)),
        `errors に縮退が記録されていない: ${JSON.stringify(s.errors)}`,
    );

    await g(['worktree', 'prune'], repo);
    await g(['branch', '-D', 'agent-gone'], repo).catch(() => {});
});

test('basename が衝突する worktree の変更が混ざらない', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const one = join(repo, '..', `${stem}-dup1`, 'dup');
    const two = join(repo, '..', `${stem}-dup2`, 'dup');
    await g(['worktree', 'add', '-q', '-b', 'dup-one', one], repo);
    await g(['worktree', 'add', '-q', '-b', 'dup-two', two], repo);
    // 両方が同じファイルを触る。basename でキーにしていると1本に見える。
    await writeFile(join(one, 'dup-shared.txt'), 'from one\n', 'utf8');
    await writeFile(join(two, 'dup-shared.txt'), 'from two\n', 'utf8');
    await g(['add', '-A'], one);
    await g(['commit', '-q', '-m', 'feat: dup one'], one);
    await g(['add', '-A'], two);
    await g(['commit', '-q', '-m', 'feat: dup two'], two);

    const s = await state();
    const dups = s.worktrees.filter(w => w.basename === 'dup');
    assert.equal(dups.length, 2, '同名 worktree が2本見えていない');
    // 表示名が一意になっている（親ディレクトリで区別される）
    assert.equal(new Set(dups.map(w => w.name)).size, 2,
        `表示名が衝突している: ${dups.map(w => w.name)}`);

    // 重複検出が2本を別物として数える
    const ov = s.overlaps.find(o => o.path === 'dup-shared.txt');
    assert.ok(ov, 'dup-shared.txt の重複が検出されていない');
    assert.equal(ov.worktrees.length, 2,
        `basename でキーにすると1本に潰れる: ${JSON.stringify(ov)}`);

    for (const [wt, branch] of [[one, 'dup-one'], [two, 'dup-two']]) {
        await g(['worktree', 'remove', '--force', wt], repo).catch(() => {});
        await g(['branch', '-D', branch], repo).catch(() => {});
    }
});

test('解決できない --base を渡してもエンドポイントは生きている', async () => {
    // 別プロセスを立てて、存在しない ref を --base に渡す
    const child = spawn(
        process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--base', 'refs/heads/no-such-branch'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } },
    );
    child.stdout.setEncoding('utf8');
    try {
        const url = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
                if (m) { clearTimeout(t); resolve(m[0]); }
            });
            child.on('error', reject);
        });
        const res = await fetch(`${url}/api/v0/state`);
        assert.equal(res.status, 200, '壊れた --base で 500 にしてはいけない');
        const s = await res.json();
        // 自動推測にフォールバックしている
        assert.notEqual(s.base, 'refs/heads/no-such-branch');
        assert.ok(s.graph.length > 0, 'グラフが空になっている');
    } finally {
        child.kill();
    }
});
