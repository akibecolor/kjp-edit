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
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
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
    // origin/HEAD / log）+ 1本あたり 3（status / rev-list / diff）
    // + 衝突予測の候補ペア数（merge-tree 1回ずつ）。
    // 1本あたり1プロセス分だけ余裕を持たせる。
    const budget = worktrees * 4 + 6 + (s.stats.conflictPairs ?? 0);
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

// ---------------------------------------------------------------------------
// /api/v0/diff と /api/v0/blob。ネットワーク越しの値を git に渡す唯一の経路なので、
// 「読めるべきものが読める」と「読めてはいけないものが読めない」の両方を見る。
// ---------------------------------------------------------------------------

test('diff: 日本語＋空白のファイル名の差分が取れる', async () => {
    const p = '日本語フォルダ/テスト ファイル-a.txt';
    const q = new URLSearchParams({ base: 'main', ref: 'agent-a', path: p });
    const res = await fetch(`${baseUrl}/api/v0/diff?${q}`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.binary, false);
    // ファイル追加なので +++ 側にパスが出る。クォートされていないこと
    assert.match(d.text, /\+\+\+ b\/日本語フォルダ\/テスト ファイル-a\.txt/);
    assert.match(d.text, /^\+ok$/m, `追加行が無い: ${d.text}`);
});

test('blob: 追跡されている内容が読める', async () => {
    // ⚠️ only-a.txt を使わないこと。乗っ取り検出テストが agent-a に
    //    コミットを積んで内容を変えるので、実行順序に依存して落ちる（実際に落ちた）。
    //    shared.txt はどのテストも書き換えない。
    const q = new URLSearchParams({ ref: 'agent-a', path: 'shared.txt' });
    const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.binary, false);
    assert.equal(d.tooLarge, false);
    assert.equal(d.text, 'touched by a\n');
});

test('🔒 blob: リポジトリ外へ抜けようとする path を拒否する', async () => {
    for (const bad of [
        '../../../../../../Windows/win.ini',
        '..\\..\\..\\Windows\\win.ini',
        '/etc/passwd',
        'C:/Windows/win.ini',
        '--output=/tmp/pwned',
    ]) {
        const q = new URLSearchParams({ ref: 'agent-a', path: bad });
        const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
        assert.equal(res.status, 400, `拒否されていない: ${bad}`);
        const d = await res.json();
        assert.ok(d.error, `error が返っていない: ${bad}`);
        // 中身が漏れていないこと
        assert.equal(d.text, undefined, `中身が返っている: ${bad}`);
    }
});

test('🔒 diff: ref にオプションやリビジョン式を渡せない', async () => {
    for (const bad of ['--output=/tmp/x', 'main~1', 'main^{tree}', 'a b', 'x..y']) {
        const q = new URLSearchParams({ base: 'main', ref: bad, path: 'only-a.txt' });
        const res = await fetch(`${baseUrl}/api/v0/diff?${q}`);
        assert.equal(res.status, 400, `拒否されていない: ${bad}`);
    }
});

test('blob: 未追跡のファイルは読めない（git オブジェクト経由なので）', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-b`);
    await writeFile(join(wt, 'secret-untracked.txt'), 'トップシークレット\n', 'utf8');
    const q = new URLSearchParams({ ref: 'agent-b', path: 'secret-untracked.txt' });
    const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
    assert.equal(res.status, 400, '未追跡ファイルが読めてしまっている');
    const d = await res.json();
    assert.match(d.error, /見つかりません/);
    await rm(join(wt, 'secret-untracked.txt'), { force: true });
});

// TOCTOU 対策。size と text が別オブジェクトのものにならないよう、
// 先に不変の OID へ解決してから読む。payload に oid が出ることで検証できる。
test('blob: 不変の OID に解決してから読む（size と text が同じオブジェクト）', async () => {
    const q = new URLSearchParams({ ref: 'agent-a', path: 'shared.txt' });
    const d = await (await fetch(`${baseUrl}/api/v0/blob?${q}`)).json();
    assert.match(d.oid ?? '', /^[0-9a-f]{40,64}$/, `OID が返っていない: ${JSON.stringify(d)}`);
    // git が同じ OID を返すこと
    const expect = (await g(['rev-parse', 'agent-a:shared.txt'], repo)).trim();
    assert.equal(d.oid, expect);
    // size は読んだバイト数そのもの（別問い合わせではない）
    assert.equal(d.size, Buffer.byteLength(d.text, 'utf8'));
});

test('blob: 存在しない path は 400 で、500 にしない', async () => {
    const q = new URLSearchParams({ ref: 'agent-a', path: 'no/such/file.txt' });
    const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /見つかりません/);
});

// ---------------------------------------------------------------------------
// 🔒 DNS rebinding。127.0.0.1 バインドと CORS では防げない攻撃なので、
//    Host 検証が効いていることを固定する。認証より先に必要な保護。
// ---------------------------------------------------------------------------

/**
 * ⚠️ fetch（undici）は Host ヘッダを上書きできない（forbidden header）。
 *    黙って既定の Host が送られるので、fetch で書いたテストは
 *    「攻撃が防がれた」ではなく「攻撃を送れていない」を見てしまう（実際に踏んだ）。
 *    Host を検証するテストは生の node:http で送る。
 */
function rawGet(urlStr, headers = {}) {
    const u = new URL(urlStr);
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            hostname: u.hostname, port: u.port, path: u.pathname + u.search,
            method: 'GET', headers,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('🔒 Host が攻撃者のドメインのリクエストを拒否する（DNS rebinding）', async () => {
    const port = Number(new URL(baseUrl).port);
    for (const host of ['evil.example', 'attacker.test:1234', 'kjp.evil.example']) {
        const res = await rawGet(`${baseUrl}/api/v0/state`, { host });
        assert.equal(res.status, 403, `Host: ${host} が通ってしまった`);
        assert.doesNotMatch(res.body, /worktree/, `403 なのに中身が漏れている: ${host}`);
    }
    // 正しい Host は通る
    const ok = await rawGet(`${baseUrl}/api/v0/state`, { host: `127.0.0.1:${port}` });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /worktrees/);
});

test('🔒 ループバックでもポートが違う Host は拒否する', async () => {
    const res = await rawGet(`${baseUrl}/api/v0/state`, { host: '127.0.0.1:1' });
    assert.equal(res.status, 403);
});

test('🔒 別サイトからの参照（Sec-Fetch-Site: cross-site）を拒否する', async () => {
    const res = await fetch(`${baseUrl}/api/v0/state`, {
        headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(res.status, 403);
    // 同一オリジンと直接ナビゲーションは通る
    for (const site of ['same-origin', 'none']) {
        const ok = await fetch(`${baseUrl}/api/v0/state`, { headers: { 'sec-fetch-site': site } });
        assert.equal(ok.status, 200, `${site} が拒否されている`);
    }
});

test('🔒 diff / blob / layout も同じ Host 検証を通る（経路ごとの取りこぼしが無い）', async () => {
    const paths = [
        '/api/v0/blob?ref=agent-a&path=shared.txt',
        '/api/v0/diff?base=main&ref=agent-a&path=shared.txt',
        '/layout',
        '/',
    ];
    for (const p of paths) {
        const res = await rawGet(`${baseUrl}${p}`, { host: 'evil.example' });
        assert.equal(res.status, 403, `${p} が Host 検証を通っていない`);
    }
});

test('--allow-host で指定したホスト名だけは通る（トンネル用）', async () => {
    const child = spawn(
        process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-host', 'box.tail-scale.ts.net'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } },
    );
    child.stdout.setEncoding('utf8');
    try {
        const url = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (m) { clearTimeout(t); resolve(m[0]); }
            });
            child.on('error', reject);
        });
        const ok = await rawGet(`${url}/api/v0/state`, { host: 'box.tail-scale.ts.net' });
        assert.equal(ok.status, 200, '許可したホスト名が通らない');
        const no = await rawGet(`${url}/api/v0/state`, { host: 'evil.example' });
        assert.equal(no.status, 403, '許可していないホスト名が通ってしまった');
    } finally {
        child.kill();
    }
});

// ---------------------------------------------------------------------------
// 🔒 書き込み（checkout）。関門の4条件すべてと、シーケンサ停止中の拒否を固定する。
//    docs/auth-ordering.md の 1〜4 段。
// ---------------------------------------------------------------------------

// 「同じファイルを触っている」は代理指標。実際に衝突するかを merge-tree で見る。
// ---------------------------------------------------------------------------
// 非機能要件（応答時間）の線。docs/performance.md に根拠と実測値がある。
//
// ⚠️ 壁時計の assert は CI のノイズで揺れるので、**精度は spawn 数で、
//    桁違いの劣化だけを壁時計で**見る。2段構えにする理由:
//    厳しい壁時計は flaky になり、緩い壁時計だけでは 3倍の劣化を見逃す。
// ---------------------------------------------------------------------------

test('応答時間: 収集が桁違いに遅くなっていない', async () => {
    // 一度温めてから測る（初回は Node の JIT とファイルキャッシュで遅い）
    await fetch(`${baseUrl}/api/v0/state?fresh=1`);
    const runs = [];
    for (let i = 0; i < 5; i++) {
        const t0 = process.hrtime.bigint();
        const res = await fetch(`${baseUrl}/api/v0/state?fresh=1`);
        await res.json();
        runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const median = [...runs].sort((a, b) => a - b)[2];
    // 手元の実測は 3 worktree で中央 195ms。CI は遅いので 10 倍を天井にする。
    // これは「桁違いの劣化」を捕まえるための線で、性能目標そのものではない
    // （目標は docs/performance.md、精度の担保は gitSpawns のテスト）。
    assert.ok(median < 2000,
        `収集の中央値が ${median.toFixed(0)}ms（天井 2000ms）。`
        + ' ループの中で git 呼び出しを増やしていないか確認する');
});

test('応答時間: キャッシュ経由は収集より明確に速い', async () => {
    await fetch(`${baseUrl}/api/v0/state?fresh=1`);
    const t0 = process.hrtime.bigint();
    await (await fetch(`${baseUrl}/api/v0/state`)).json();
    const cached = Number(process.hrtime.bigint() - t0) / 1e6;
    // 手元では 1-2ms。TTL キャッシュが壊れて毎回収集していたら数百 ms になる
    assert.ok(cached < 100,
        `キャッシュ経由が ${cached.toFixed(0)}ms。TTL キャッシュが効いていない可能性`);
});

test('取り込み順序の提案が payload に入り、塊の中身が衝突しない', async () => {
    const s = await state();
    assert.ok(s.mergePlan, 'mergePlan が無い');
    const bad = new Set((s.conflicts ?? []).filter(c => !c.clean)
        .map(c => [c.a, c.b].sort().join('|')));
    const b = s.mergePlan.batch;
    for (let i = 0; i < b.length; i++) {
        for (let j = i + 1; j < b.length; j++) {
            assert.ok(!bad.has([b[i], b[j]].sort().join('|')),
                `提案の塊に衝突ペアが入っている: ${b[i]} × ${b[j]}`);
        }
    }
    // agent-a と agent-b は衝突するので、両方が塊に入ることは無い
    const names = n => s.worktrees.find(w => w.branch === n).name;
    const both = b.includes(names('agent-a')) && b.includes(names('agent-b'));
    assert.equal(both, false, '衝突する2本が同じ塊に入っている');
});

test('衝突予測: 実際に衝突するペアを検出する', async () => {
    const s = await state();
    assert.ok(Array.isArray(s.conflicts), 'conflicts が payload に無い');
    const names = n => s.worktrees.find(w => w.branch === n).name;
    const pair = s.conflicts.find(c =>
        [c.a, c.b].sort().join('|') === [names('agent-a'), names('agent-b')].sort().join('|'));
    assert.ok(pair, `agent-a × agent-b のペアが無い: ${JSON.stringify(s.conflicts)}`);
    // 両方が shared.txt を別内容で追加しているので add/add で衝突する
    assert.equal(pair.clean, false, 'きれいにマージできると判定されている');
    assert.ok(pair.files.includes('shared.txt'),
        `衝突ファイルに shared.txt が無い: ${JSON.stringify(pair.files)}`);
    // 日本語＋空白のパスがクォートされずに返る（別名なので衝突しない）
    for (const f of pair.files) {
        assert.ok(!f.includes('\\3'), `8進エスケープが残っている: ${f}`);
        assert.ok(!f.startsWith('"'), `クォートが残っている: ${f}`);
    }
});

test('衝突予測: 作業ツリーと ref に触らない', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const before = await Promise.all([
        g(['status', '--porcelain'], repo),
        g(['rev-parse', 'agent-a', 'agent-b', 'main'], repo),
        g(['status', '--porcelain'], join(repo, '..', `${stem}-wt-a`)),
    ]);
    await state();   // 衝突予測を走らせる
    const after = await Promise.all([
        g(['status', '--porcelain'], repo),
        g(['rev-parse', 'agent-a', 'agent-b', 'main'], repo),
        g(['status', '--porcelain'], join(repo, '..', `${stem}-wt-a`)),
    ]);
    assert.deepEqual(after, before,
        'merge-tree が作業ツリーか ref を変えている（--write-tree は object だけを書くはず）');
});

test('localBranches はローカルブランチだけで、remote-tracking を含まない', async () => {
    const s = await state();
    assert.ok(Array.isArray(s.localBranches), 'localBranches が無い');
    // 日本語ブランチ名（スラッシュ入り）が入っている
    assert.ok(s.localBranches.includes('機能/新規'),
        `機能/新規 が無い: ${JSON.stringify(s.localBranches)}`);
    assert.ok(s.localBranches.includes('main'));
    // ⚠️ remote-tracking が混ざると checkout 候補に出て detached HEAD になる
    for (const r of s.localBranches) {
        assert.doesNotMatch(r, /^refs\//, `完全な refname が漏れている: ${r}`);
        assert.ok(!r.startsWith('origin/'), `remote-tracking が混ざっている: ${r}`);
    }
});

test('🔒 --allow-write なしでは checkout の経路が存在しない', async () => {
    const res = await fetch(`${baseUrl}/api/v0/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worktree: repo, ref: 'main' }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /--allow-write/);
});

test('🔒 --allow-write なしでは session がトークンを返さない', async () => {
    const res = await fetch(`${baseUrl}/api/v0/session`);
    const d = await res.json();
    assert.equal(d.allowWrite, false);
    assert.equal(d.token, null);
});

/** 書き込み有効のサーバを立てる。呼び出し側が kill する。 */
async function startWritable(extra = []) {
    const child = spawn(
        process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-write', ...extra],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } },
    );
    child.stdout.setEncoding('utf8');
    const url = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('起動しなかった')), 15000);
        let buf = '';
        child.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m) { clearTimeout(t); resolve(m[0]); }
        });
        child.on('error', reject);
    });
    const s = await (await fetch(`${url}/api/v0/session`)).json();
    return { child, url, session: s };
}

test('🔒 checkout の関門: token / method / Sec-Fetch-Site をそれぞれ要求する', async () => {
    const { child, url, session } = await startWritable();
    try {
        assert.equal(session.allowWrite, true);
        assert.ok(session.token && session.token.length >= 20, 'トークンが返っていない');
        const wtPath = (await (await fetch(`${url}/api/v0/state?fresh=1`)).json())
            .worktrees.find(w => w.branch === 'agent-b').path;
        const body = JSON.stringify({ worktree: wtPath, ref: 'main' });
        const H = session.tokenHeader;

        // トークン無し
        let r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body,
        });
        assert.equal(r.status, 403, 'トークン無しが通った');
        assert.match((await r.json()).error, /token/i);

        // トークンが違う
        r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST', headers: { 'content-type': 'application/json', [H]: 'wrong' }, body,
        });
        assert.equal(r.status, 403, '誤ったトークンが通った');

        // GET では副作用を起こさない
        r = await fetch(`${url}/api/v0/checkout`, { headers: { [H]: session.token } });
        assert.equal(r.status, 405, 'GET が通った');

        // 別サイト起点
        r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                [H]: session.token, 'sec-fetch-site': 'cross-site',
            },
            body,
        });
        assert.equal(r.status, 403, 'cross-site が通った');

        // Host が攻撃者ドメイン（入口の検証が書き込み経路にも効く）
        r = await rawGet(`${url}/api/v0/checkout`, { host: 'evil.example' });
        assert.equal(r.status, 403);
    } finally {
        child.kill();
    }
});

test('🔒 checkout は既知の worktree 以外を cwd にしない', async () => {
    const { child, url, session } = await startWritable();
    try {
        for (const bad of [tmpdir(), `${repo}-not-a-worktree`, '']) {
            const r = await fetch(`${url}/api/v0/checkout`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
                body: JSON.stringify({ worktree: bad, ref: 'main' }),
            });
            assert.equal(r.status, 400, `既知でない worktree が通った: ${bad}`);
            assert.match((await r.json()).error, /既知の worktree ではありません/);
        }
    } finally {
        child.kill();
    }
});

test('checkout が実際にブランチを切り替える', async () => {
    const { child, url, session } = await startWritable();
    try {
        // ⚠️ このフィクスチャの worktree は agent-a / agent-b の2本だけ。
        //    agent-c はスクリーンショット用の別フィクスチャにしか無い。
        const wt = (await (await fetch(`${url}/api/v0/state?fresh=1`)).json())
            .worktrees.find(w => w.branch === 'agent-b');
        const post = ref => fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
            body: JSON.stringify({ worktree: wt.path, ref }),
        });
        // ⚠️ レスポンスボディは1回しか読めない。assert のメッセージの中で
        //    await r.json() を書くとテンプレートリテラルが先に評価されて body を
        //    消費し、後続の r.json() が "Body is unusable" で落ちる（実際に踏んだ）。
        // E7 日本語ブランチ名へ切り替える
        let r = await post('機能/新規');
        let d = await r.json();
        assert.equal(r.status, 200, `切り替え失敗: ${JSON.stringify(d)}`);
        assert.equal(d.branch, '機能/新規');
        // payload にも反映されている（キャッシュを捨てていること）
        const s2 = await (await fetch(`${url}/api/v0/state?fresh=1`)).json();
        assert.equal(s2.worktrees.find(w => w.path === wt.path).branch, '機能/新規');
        // 戻す
        r = await post('agent-b');
        d = await r.json();
        assert.equal(r.status, 200, `戻せなかった: ${JSON.stringify(d)}`);
        assert.equal(d.branch, 'agent-b');
    } finally {
        child.kill();
    }
});

test('🚨 checkout はシーケンサ停止中を拒否する（git は通してしまう操作）', async () => {
    const { child, url, session } = await startWritable();
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-a`);
    try {
        // ⚠️ setup に `rebase -i` + GIT_SEQUENCE_EDITOR を使わないこと。
        //    エディタと todo の書き換えに依存するので CI で停止しないことがあり、
        //    「ガードが効かなかった」と「setup が失敗した」の区別が付かなくなる
        //    （実際に windows CI だけで落ちた）。
        //    衝突するマージなら外部エディタを介さず決定的に MERGE_HEAD が残る。
        //    agent-a と agent-b は shared.txt を別内容で追加しているので add/add 衝突になる。
        await g(['merge', 'agent-b'], wt).catch(() => {});   // 衝突するので非0 で正常

        // 前提条件そのものを検証する。これが無いと assert が何を見たのか分からない。
        const st = await (await fetch(`${url}/api/v0/state?fresh=1`)).json();
        const target = st.worktrees.find(w => w.path.endsWith('-wt-a'));
        assert.ok(target, 'agent-a の worktree が payload に無い');
        assert.equal(target.sequencer.merging, true,
            'setup 失敗: MERGE_HEAD が残っていない。テストの前提が成立していない');

        const r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
            body: JSON.stringify({ worktree: wt, ref: 'main' }),
        });
        const d = await r.json();
        assert.equal(r.status, 409, `マージ未コミット中の checkout が通ってしまった: ${JSON.stringify(d)}`);
        assert.match(d.error, /マージ未コミット/);
        assert.match(d.error, /MERGE_HEAD/, '危険の説明が入っていない');
    } finally {
        child.kill();
        await g(['merge', '--abort'], wt).catch(() => {});
        await g(['checkout', '-q', '--force', 'agent-a'], wt).catch(() => {});
    }
});

// ---------------------------------------------------------------------------
// 🔒 実行（/api/v0/exec）。「遠隔から実行できる」は定義上そのまま RCE なので、
//    扉（capability + token + method + Sec-Fetch-Site + Host）を全部固定する。
// ---------------------------------------------------------------------------

const EXEC_TOKEN = 'test-token-for-exec-0123456789abcdef';

/** 実行有効のサーバを立てる。呼び出し側が kill する。 */
async function startExec(extra = []) {
    const child = spawn(
        process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token', EXEC_TOKEN, ...extra],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const url = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('起動しなかった')), 15000);
        let buf = '';
        child.stdout.on('data', d => {
            buf += d;
            const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m) { clearTimeout(t); resolve(m[0]); }
        });
        child.on('error', reject);
    });
    return { child, url };
}

/** ndjson を全部読んでイベント配列にする */
async function readExec(url, bodyObj, headers = {}) {
    const res = await fetch(`${url}/api/v0/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN, ...headers },
        body: JSON.stringify(bodyObj),
    });
    if (!res.ok) return { status: res.status, error: (await res.json()).error, events: [] };
    const text = await res.text();
    const events = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    return { status: res.status, events };
}

test('🔒 --allow-exec なしでは exec の経路が存在しない', async () => {
    const res = await fetch(`${baseUrl}/api/v0/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worktree: repo, argv: ['git', 'status'] }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /--allow-exec/);
});

test('🔒 --allow-exec は 24 文字以上の --token 無しでは起動を拒否する', async () => {
    for (const extra of [[], ['--token', 'short']]) {
        const child = spawn(process.execPath,
            [SERVER, '--repo', repo, '--port', '0', '--allow-exec', ...extra],
            { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
        child.stderr.setEncoding('utf8');
        let err = '';
        child.stderr.on('data', d => { err += d; });
        const code = await new Promise(r => child.on('close', r));
        assert.equal(code, 1, `起動してしまった: token=${extra[1] ?? 'なし'}`);
        assert.match(err, /--token/);
    }
});

test('🔒 exec の関門: token / method / Sec-Fetch-Site / Host', async () => {
    const { child, url } = await startExec();
    try {
        const body = JSON.stringify({ worktree: repo, argv: ['git', '--version'] });
        const J = { 'content-type': 'application/json' };

        let r = await fetch(`${url}/api/v0/exec`, { method: 'POST', headers: J, body });
        assert.equal(r.status, 403, 'トークン無しが通った');

        r = await fetch(`${url}/api/v0/exec`,
            { method: 'POST', headers: { ...J, 'x-kjp-token': 'wrong-but-long-enough-value-xx' }, body });
        assert.equal(r.status, 403, '誤ったトークンが通った');

        r = await fetch(`${url}/api/v0/exec`, { headers: { 'x-kjp-token': EXEC_TOKEN } });
        assert.equal(r.status, 405, 'GET が通った');

        r = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { ...J, 'x-kjp-token': EXEC_TOKEN, 'sec-fetch-site': 'cross-site' },
            body,
        });
        assert.equal(r.status, 403, 'cross-site が通った');

        const raw = await rawGet(`${url}/api/v0/exec`, { host: 'evil.example' });
        assert.equal(raw.status, 403, 'Host 検証を通っていない');
    } finally {
        child.kill();
    }
});

test('🔒 exec は既知の worktree 以外を cwd にしない', async () => {
    const { child, url } = await startExec();
    try {
        for (const bad of [tmpdir(), '', `${repo}-nope`]) {
            const r = await readExec(url, { worktree: bad, argv: ['git', '--version'] });
            assert.equal(r.status, 400, `既知でない worktree が通った: ${bad}`);
        }
        // argv の検証
        for (const bad of [null, [], 'git status', ['git\0x']]) {
            const r = await readExec(url, { worktree: repo, argv: bad });
            assert.equal(r.status, 400, `不正な argv が通った: ${JSON.stringify(bad)}`);
        }
    } finally {
        child.kill();
    }
});

test('exec が出力を流し、終了コードを返す', async () => {
    const { child, url } = await startExec();
    try {
        const ok = await readExec(url, { worktree: repo, argv: ['git', '--version'] });
        assert.equal(ok.status, 200);
        const out = ok.events.filter(e => e.t === 'out').map(e => e.d).join('');
        assert.match(out, /git version/);
        const exit = ok.events.at(-1);
        assert.equal(exit.t, 'exit');
        assert.equal(exit.code, 0);

        // 非 0 の終了コードも伝わる
        const bad = await readExec(url, { worktree: repo, argv: ['git', 'rev-parse', 'no-such-ref'] });
        assert.equal(bad.status, 200);
        assert.notEqual(bad.events.at(-1).code, 0, '失敗の終了コードが伝わっていない');
        assert.ok(bad.events.some(e => e.t === 'err'), 'stderr が流れていない');
    } finally {
        child.kill();
    }
});

test('exec: 3バイト文字が chunk 境界で割れない', async () => {
    const { child, url } = await startExec();
    try {
        // 日本語を大量に出力させ、UTF-8 の境界越えを起こす
        const script = 'process.stdout.write("あいうえお漢字テスト".repeat(4000))';
        const r = await readExec(url, {
            worktree: repo, argv: [process.execPath, '-e', script],
        });
        assert.equal(r.status, 200);
        const out = r.events.filter(e => e.t === 'out').map(e => e.d).join('');
        assert.equal(out, 'あいうえお漢字テスト'.repeat(4000));
        assert.ok(!out.includes('�'), '置換文字が混ざっている（chunk 境界で割れた）');
    } finally {
        child.kill();
    }
});

test('exec: 上限時間を超えたら停止する', async () => {
    const { child, url } = await startExec(['--exec-timeout', '1']);
    try {
        const r = await readExec(url, {
            worktree: repo, argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        });
        assert.equal(r.status, 200);
        const exit = r.events.at(-1);
        assert.equal(exit.t, 'exit');
        assert.ok(r.events.some(e => e.t === 'err' && /上限時間/.test(e.d)),
            `上限で止めた形跡が無い: ${JSON.stringify(r.events)}`);
    } finally {
        child.kill();
    }
});

// ⚠️ 取り残した子プロセスはこのプロジェクトが実際に事故を起こした種類
//    （検証用サーバを残してポートを塞いだ / chrome を53個残した）。
//    クライアントが切れたら殺すことをテストで固定する。
test('exec: クライアントが切断したら子プロセスを殺す', async () => {
    const { child, url } = await startExec();
    const beacon = join(repo, 'exec-beacon.txt');
    try {
        // 100ms ごとにファイルへ追記し続ける子プロセス
        const script = 'const fs=require("fs");'
            + 'setInterval(()=>{try{fs.appendFileSync(process.argv[1],"x")}catch(e){}},100);'
            + 'process.stdout.write("started\\n");';
        const ac = new AbortController();
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo, argv: [process.execPath, '-e', script, beacon],
            }),
            signal: ac.signal,
        });
        // 最初の出力を待って、走り始めたことを確認する
        const reader = res.body.getReader();
        await reader.read();
        await new Promise(r => setTimeout(r, 400));

        const { readFileSync } = await import('node:fs');
        const before = readFileSync(beacon, 'utf8').length;
        assert.ok(before > 0, '子プロセスが動いていない（テストの前提が崩れている）');

        // 切断する
        ac.abort();
        await new Promise(r => setTimeout(r, 900));
        const afterAbort = readFileSync(beacon, 'utf8').length;
        await new Promise(r => setTimeout(r, 900));
        const later = readFileSync(beacon, 'utf8').length;

        assert.equal(later, afterAbort,
            `切断後もファイルが増え続けている（子プロセスが残っている）: ${afterAbort} → ${later}`);
    } finally {
        child.kill();
        await rm(beacon, { force: true });
    }
});

// 🚨 レビュアの指摘: 既存の「切断で子を殺す」テストは直接の子（node -e）しか見て
//    いなかった。Windows では libuv の job object が node 経由の孫まで巻き込むので、
//    その形では**永久に緑**だった。中間に cmd/sh を挟むと孫が残り、しかも孫が stdio を
//    握って `close` が来ないので枠が戻らず、8回のタイムアウトで exec が死んでいた。
test('🚨 exec: 中間シェルを挟んだ孫プロセスも殺し、枠を返す', async () => {
    const { child, url } = await startExec(['--exec-timeout', '2']);
    const beacon = join(repo, 'grandchild-beacon.txt');
    const script = join(repo, 'grandchild.mjs');
    try {
        await writeFile(script,
            'import {appendFileSync} from "node:fs";'
            + 'setInterval(()=>{try{appendFileSync(process.argv[2],"x")}catch(e){}},100);',
            'utf8');
        // 中間にシェルを挟む = Windows で npm test を動かす唯一の形
        const argv = process.platform === 'win32'
            ? ['cmd', '/c', process.execPath, script, beacon]
            : ['sh', '-c', `"${process.execPath}" "${script}" "${beacon}" & wait`];

        const r = await readExec(url, { worktree: repo, argv });
        // (a) 応答が完結する（exit が来る）。孫が stdio を握っていても閉じること
        assert.equal(r.status, 200);
        assert.equal(r.events.at(-1)?.t, 'exit',
            `応答が完結していない（close 待ちで固まっている）: ${JSON.stringify(r.events.slice(-3))}`);

        // (b) 孫が止まっている
        const { readFileSync } = await import('node:fs');
        await new Promise(res => setTimeout(res, 700));
        const a = readFileSync(beacon, 'utf8').length;
        await new Promise(res => setTimeout(res, 900));
        const b = readFileSync(beacon, 'utf8').length;
        assert.equal(b, a, `孫プロセスが生き残っている: ${a} → ${b}`);

        // (c) 枠が返っている（返らないと8回で exec が死ぬ）
        const ok = await readExec(url, { worktree: repo, argv: ['git', '--version'] });
        assert.equal(ok.status, 200, '枠が返っていない（429 になった）');
    } finally {
        child.kill();
        await rm(beacon, { force: true });
        await rm(script, { force: true });
    }
});

// 🚨 レビュアの指摘: 検査と予約の間に await があり、上限8に対して24本走った。
test('🚨 exec: 同時実行の上限が実際に効く', async () => {
    const { child, url } = await startExec();
    const controllers = [];
    try {
        const N = 14;
        const results = await Promise.all(Array.from({ length: N }, () => {
            const ac = new AbortController();
            controllers.push(ac);
            return fetch(`${url}/api/v0/exec`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
                body: JSON.stringify({
                    worktree: repo,
                    argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
                }),
                signal: ac.signal,
            }).then(res => res.status).catch(() => 0);
        }));
        const accepted = results.filter(s => s === 200).length;
        const rejected = results.filter(s => s === 429).length;
        assert.ok(accepted <= 8, `上限 8 を超えて受理された: ${accepted} 本`);
        assert.ok(rejected >= N - 8, `429 が足りない（上限が効いていない）: 受理 ${accepted} / 拒否 ${rejected}`);
    } finally {
        for (const ac of controllers) ac.abort();
        await new Promise(r => setTimeout(r, 1200));
        child.kill();
    }
});

test('🔒 exec: bare worktree では実行しない', async () => {
    const { child, url } = await startExec();
    try {
        // bare worktree は smoke のフィクスチャに無いので、無効な worktree で
        // 経路が閉じていることだけ確認する（bare の網羅は unit 側の責務）
        const r = await readExec(url, { worktree: `${repo}-bare-nope`, argv: ['git', '--version'] });
        assert.equal(r.status, 400);
    } finally {
        child.kill();
    }
});

test('🔒 --exec-timeout に数値でない値を渡したら起動を拒否する', async () => {
    for (const bad of ['abc', '0', '-5']) {
        const child = spawn(process.execPath,
            [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token', EXEC_TOKEN,
                '--exec-timeout', bad],
            { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
        child.stderr.setEncoding('utf8');
        let err = '';
        child.stderr.on('data', d => { err += d; });
        const code = await new Promise(r => child.on('close', r));
        assert.equal(code, 1, `不正な値で起動してしまった: ${bad}`);
        assert.match(err, /--exec-timeout/);
    }
});

test('🔒 --audit-log でリポジトリ外に監査ログを出せる', async () => {
    const outside = join(repo, '..', `${repo.split(/[\\/]/).pop()}-audit.jsonl`);
    const { child, url } = await startExec(['--audit-log', outside]);
    try {
        await readExec(url, { worktree: repo, argv: ['git', '--version'] });
        const { readFile } = await import('node:fs/promises');
        const log = await readFile(outside, 'utf8');
        // ⚠️ 生の正規表現で `git --version` を探してはいけない。
        //    JSON の中は ["git","--version"] なのでその文字列は現れない。
        //    行を JSON として読んで argv を比べる（最初これで自分のテストを落とした）。
        const lines = log.split('\n').filter(Boolean).map(l => JSON.parse(l));
        assert.ok(lines.some(e => e.argv?.join(' ') === 'git --version'),
            `外部の監査ログに記録が無い: ${log.slice(0, 200)}`);
        // 既定の場所には書かれていない（切り替わっていること）
        const { existsSync } = await import('node:fs');
        const def = join(repo, '.git', 'kjp-exec-audit.jsonl');
        const before = existsSync(def) ? (await readFile(def, 'utf8')).length : 0;
        await readExec(url, { worktree: repo, argv: ['git', 'rev-parse', 'HEAD'] });
        const after = existsSync(def) ? (await readFile(def, 'utf8')).length : 0;
        assert.equal(after, before, '既定の場所にも書かれている（切り替わっていない）');
    } finally {
        child.kill();
        await rm(outside, { force: true });
    }
});

test('checkout: hex を渡すと detached を警告する（黙って ok:true にしない）', async () => {
    const { child, url, session } = await startWritable();
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-b`);
    try {
        const oid = (await g(['rev-parse', 'main'], repo)).trim();
        const r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
            body: JSON.stringify({ worktree: wt, ref: oid }),
        });
        const d = await r.json();
        assert.equal(r.status, 200, `hex での checkout が失敗: ${JSON.stringify(d)}`);
        assert.equal(d.detached, true, 'detached が報告されていない');
        assert.match(d.warning ?? '', /detached HEAD/, '警告が無い');
    } finally {
        child.kill();
        await g(['checkout', '--force', 'agent-b'], wt).catch(() => {});
    }
});

test('exec の監査ログが書かれる', async () => {
    const { child, url } = await startExec();
    try {
        await readExec(url, { worktree: repo, argv: ['git', '--version'] });
        const { readFile } = await import('node:fs/promises');
        const log = await readFile(join(repo, '.git', 'kjp-exec-audit.jsonl'), 'utf8');
        const lines = log.split('\n').filter(Boolean).map(l => JSON.parse(l));
        assert.ok(lines.some(e => e.event === 'start' && e.argv.join(' ') === 'git --version'),
            '開始が記録されていない');
        const exit = lines.find(e => e.event === 'exit' && e.argv.join(' ') === 'git --version');
        assert.ok(exit, '終了が記録されていない');
        assert.equal(exit.code, 0);
        assert.ok(exit.at, 'タイムスタンプが無い');
    } finally {
        child.kill();
    }
});

// ---------------------------------------------------------------------------
// 敵対的レビューで実証された穴の回帰テスト。
// いずれも「テストが緑のまま通り抜けていた」ものなので、まず落ちる形で書く。
// ---------------------------------------------------------------------------

/** 生ソケットで任意の request-target を送る（fetch では不正な target を送れない） */
function rawTarget(urlStr, target) {
    const u = new URL(urlStr);
    return new Promise((resolve, reject) => {
        const sock = netConnect({ host: u.hostname, port: Number(u.port) }, () => {
            sock.write(`GET ${target} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`);
        });
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', d => { buf += d; });
        sock.on('close', () => resolve(buf));
        sock.on('error', reject);
        setTimeout(() => { sock.destroy(); resolve(buf); }, 3000);
    });
}

// 🚨 認可の手前にある同期例外はプロセスを殺す。1パケットで無認証 DoS だった。
test('🚨 不正な request-target でデーモンが落ちない（認証前 DoS）', async () => {
    for (const target of ['//[', '//%zz', 'http://', 'http://[', '//[::1']) {
        const body = await rawTarget(baseUrl, target);
        assert.match(body, /^HTTP\/1\.1 400/, `400 が返っていない: ${target}`);
        // 直後に正常なリクエストが通る = プロセスが生きている（これが本題）
        const after = await fetch(`${baseUrl}/api/v0/state`);
        assert.equal(after.status, 200, `${target} の後にデーモンが死んでいる`);
    }
});

test('🔒 blob: reflog 経由（@{…}）で捨てたコミットを読めない', async () => {
    for (const bad of ['agent-a@{1}', 'main@{upstream}', '@', 'HEAD@{0}']) {
        const q = new URLSearchParams({ ref: bad, path: 'shared.txt' });
        const res = await fetch(`${baseUrl}/api/v0/blob?${q}`);
        assert.equal(res.status, 400, `reflog 式が通った: ${bad}`);
        // ⚠️ 400 だけを見てはいけない。**拒否理由**を確認する。
        //    reflog に該当エントリが無い / そのパスが古いコミットに無い場合も
        //    「見つかりません」で 400 になるので、検証を外しても緑のまま通り抜ける
        //    （突然変異テストで実際に survive した）。
        const d = await res.json();
        assert.match(d.error, /ref が不正です/,
            `入口の検証ではなく git 側の失敗で 400 になっている: ${bad} → ${d.error}`);
    }
});

test('🔒 diff: pathspec magic で他のファイルを含む差分を取れない', async () => {
    for (const bad of [':(exclude)shared.txt', ':!shared.txt', ':/shared.txt']) {
        const q = new URLSearchParams({ base: 'main', ref: 'agent-a', path: bad });
        const res = await fetch(`${baseUrl}/api/v0/diff?${q}`);
        assert.equal(res.status, 400, `pathspec magic が通った: ${bad}`);
    }
});

// 🚨 読み取り専用でも観測対象の設定由来のコマンドが動いていた。
test('🚨 読み取り専用の経路がリポジトリ設定のコマンドを実行しない（core.fsmonitor）', async () => {
    const marker = join(repo, 'fsmonitor-ran.txt').replace(/\\/g, '/');
    const hook = join(repo, 'fsmon.sh').replace(/\\/g, '/');
    // ⚠️ フックは **シェルスクリプト**で書く。git は fsmonitor を sh 経由で起動するので、
    //    `node <空白を含むパス> <script>` を設定すると**クォート不足で起動に失敗し、
    //    発火しないので「守れている」と誤判定する**（実際にこの偽陽性を作った）。
    //    実測: sh スクリプトなら発火 / -c core.fsmonitor=false で発火しない。
    //    CLAUDE.md の「スクリプトは .mjs のみ」はプロジェクトのスクリプトの規則で、
    //    ここは git のフック機構を再現するためのテストフィクスチャなので .sh が必要。
    await writeFile(hook, `#!/bin/sh\nprintf ran >> "${marker}"\n`, 'utf8');
    // ⚠️ 実行ビットを立てる。**Linux では実行できないフックは起動しない**ので、
    //    立て忘れると「発火しないから守れている」という偽陽性になる
    //    （ubuntu CI の突然変異テストで survive して発覚。Windows は exec ビットの
    //     概念が無いので手元では気付けなかった。プラットフォーム固有の偽陽性）。
    const { chmod } = await import('node:fs/promises');
    await chmod(hook, 0o755);
    await g(['config', 'core.fsmonitor', hook], repo);
    try {
        await fetch(`${baseUrl}/api/v0/state?fresh=1`);
        await new Promise(r => setTimeout(r, 300));
        const { existsSync } = await import('node:fs');
        assert.equal(existsSync(marker), false,
            'core.fsmonitor のコマンドが実行された（読み取り専用のはずの経路）');
    } finally {
        await g(['config', '--unset', 'core.fsmonitor'], repo).catch(() => {});
        await rm(hook, { force: true });
        await rm(marker, { force: true });
    }
});

test('🚨 checkout: オプション名のブランチで未コミットの変更が破棄されない', async () => {
    const { child, url, session } = await startWritable();
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-b`);
    const file = join(wt, 'only-b.txt');
    try {
        // git update-ref なら `--force` という名前の ref を作れてしまう
        const oid = (await g(['rev-parse', 'main'], repo)).trim();
        await g(['update-ref', 'refs/heads/--force', oid], repo);

        const { readFileSync } = await import('node:fs');
        await writeFile(file, '大事な未コミットの作業\n', 'utf8');
        const before = readFileSync(file, 'utf8');

        const r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
            body: JSON.stringify({ worktree: wt, ref: '--force' }),
        });
        assert.equal(r.status, 400, 'オプション名の ref が通った');
        assert.equal(readFileSync(file, 'utf8'), before,
            '未コミットの変更が破棄された（オプション注入が成立している）');
    } finally {
        child.kill();
        await g(['update-ref', '-d', 'refs/heads/--force'], repo).catch(() => {});
        await g(['checkout', '--force', 'agent-b'], wt).catch(() => {});
        await rm(file, { force: true }).catch(() => {});
        await g(['checkout', '--force', 'agent-b'], wt).catch(() => {});
    }
});

// 🚨 CHERRY_PICK_HEAD が消えても sequencer/todo は残る。
//    これを取りこぼすと v0 自身の checkout で「残りが切り替え先にリプレイ」される。
test('🚨 checkout: sequencer/todo が残っている状態を拒否する', async () => {
    const { child, url, session } = await startWritable();
    const stem = repo.split(/[\\/]/).pop();
    const wt = join(repo, '..', `${stem}-wt-a`);
    try {
        // ⚠️ フィクスチャの agent-b は main から1コミットしか無いので、
        //    cherry-pick 用に2コミット持つブランチをここで作る。
        //    1つ目が衝突して停止し、2つ目が sequencer/todo に残るのが必要な形。
        await g(['checkout', '-q', '-b', 'seq-src', 'main'], repo);
        // shared.txt は agent-a も追加しているので add/add で衝突する
        await writeFile(join(repo, 'shared.txt'), 'from seq-src\n', 'utf8');
        await g(['add', '-A'], repo);
        await g(['commit', '-q', '-m', 'seq: 衝突する1つ目'], repo);
        await writeFile(join(repo, 'seq-second.txt'), 'second\n', 'utf8');
        await g(['add', '-A'], repo);
        await g(['commit', '-q', '-m', 'seq: 残る2つ目'], repo);
        await g(['checkout', '-q', 'main'], repo);

        const list = (await g(['rev-list', '--reverse', 'main..seq-src'], repo))
            .trim().split('\n').filter(Boolean);
        assert.equal(list.length, 2, `cherry-pick 対象が2件でない: ${list.length}`);
        await g(['cherry-pick', ...list], wt).catch(() => {});   // 衝突するので非0
        // --continue ではなく手で commit する → CHERRY_PICK_HEAD は消えるが todo は残る
        await g(['checkout', '--theirs', '.'], wt).catch(() => {});
        await g(['add', '-A'], wt).catch(() => {});
        await g(['commit', '--no-edit'], wt).catch(() => {});

        const st = await (await fetch(`${url}/api/v0/state?fresh=1`)).json();
        const target = st.worktrees.find(w => w.path.endsWith('-wt-a'));
        assert.equal(target.sequencer.sequencing, true,
            'setup 失敗: sequencer/todo が残っていない。前提が成立していない');
        assert.ok(target.warnings.some(w => w.code === 'sequencer-todo-left'),
            `警告が出ていない: ${JSON.stringify(target.warnings)}`);

        const r = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [session.tokenHeader]: session.token },
            body: JSON.stringify({ worktree: wt, ref: 'main' }),
        });
        const d = await r.json();
        assert.equal(r.status, 409, `sequencer 残留中の checkout が通った: ${JSON.stringify(d)}`);
        assert.match(d.error, /sequencer/);
    } finally {
        child.kill();
        await g(['cherry-pick', '--quit'], wt).catch(() => {});
        await g(['reset', '--hard', 'agent-a'], wt).catch(() => {});
        await g(['checkout', '--force', 'agent-a'], wt).catch(() => {});
        await g(['checkout', '-q', '--force', 'main'], repo).catch(() => {});
        await g(['branch', '-D', 'seq-src'], repo).catch(() => {});
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
