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
    // ⚠️ 以前は worktrees*4 で1本あたり1 spawn ぶん緩かった（doc の式は 3N）。
    //    「ループの中で git を増やす回帰」を捕まえる精度が甘くなるので式に寄せる。
    //    +1 は merge driver の列挙（候補ペアがあるときだけ走る）。
    const pairs = s.stats.conflictPairs ?? 0;
    const budget = worktrees * 3 + 6 + pairs + (pairs ? 1 : 0);
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
        // トークンの案内も同じ塊で出るので banner ごと受け取る。
        // ⚠️ **stderr を捨てない。** 捨てると CI で「起動しなかった」だけが残り
        //    原因が消える（実際に1往復無駄にした）。
        let banner = '';
        let errOut = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', d => { errOut += d; });
        const url = await new Promise((resolve, reject) => {
            const fail = () => reject(new Error(`起動しなかった\n  stdout: ${banner.trim() || '(空)'}`
                + `\n  stderr: ${errOut.trim() || '(空)'}`));
            const t = setTimeout(fail, 30000);
            child.stdout.on('data', d => {
                banner += d;
                const m = banner.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (m) { clearTimeout(t); setTimeout(() => resolve(m[0]), 400); }
            });
            child.on('error', e => { clearTimeout(t); reject(e); });
            child.on('exit', () => setTimeout(() => { clearTimeout(t); fail(); }, 50));
        });
        // ⚠️ --allow-host を付けると**認証が既定で必須になる**ので、
        //    許可したホスト名でもトークンが無ければ 401。
        //    「Host が通る」と「操作してよい」は別の判定であることを固定する。
        const noTok = await rawGet(`${url}/api/v0/state`, { host: 'box.tail-scale.ts.net' });
        assert.equal(noTok.status, 401, 'トンネル用のホスト名が無認証で通ってしまった');

        const token = /\?token=([A-Za-z0-9_-]+)/.exec(banner)?.[1];
        assert.ok(token, `トークンが案内に出ていない: ${banner}`);
        const ok = await rawGet(`${url}/api/v0/state`,
            { host: 'box.tail-scale.ts.net', 'x-kjp-token': token });
        assert.equal(ok.status, 200, '許可したホスト名 + トークンが通らない');

        // 🔒 Host の判定は認証より手前。**正しいトークンでも Host が違えば 403。**
        //    順序が逆だと、トークンを持つ相手が任意の Host で入れてしまう
        //    （rebinding 対策が認証の後ろに回ると意味が薄れる）
        const no = await rawGet(`${url}/api/v0/state`,
            { host: 'evil.example', 'x-kjp-token': token });
        assert.equal(no.status, 403, '許可していないホスト名がトークン付きで通ってしまった');
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
    // ⚠️ `files` は `{path, synthetic, ...}` の配列（#1 で合成パスに印を付けた）
    const paths = pair.files.map(f => (typeof f === 'string' ? f : f.path));
    assert.ok(paths.includes('shared.txt'),
        `衝突ファイルに shared.txt が無い: ${JSON.stringify(pair.files)}`);
    // 日本語＋空白のパスがクォートされずに返る（別名なので衝突しない）
    for (const f of paths) {
        assert.ok(!f.includes('\\3'), `8進エスケープが残っている: ${f}`);
        assert.ok(!f.startsWith('"'), `クォートが残っている: ${f}`);
    }
});

// 🚨 core.fsmonitor と同じクラスの穴。コミット済みの .gitattributes と
//    .git/config の merge driver で、/api/v0/state を1回叩くだけで
//    任意コマンドが走っていた（--allow-write 不要）。
test('🚨 衝突予測が custom merge driver を実行しない', async () => {
    const marker = join(repo, 'driver-ran.txt').replace(/\\/g, '/');
    const hook = join(repo, 'driver.sh').replace(/\\/g, '/');
    const stem = repo.split(/[\\/]/).pop();
    try {
        // フックは sh スクリプト + 実行ビット（Linux では exec ビットが無いと起動しない）
        await writeFile(hook, `#!/bin/sh\nprintf ran >> "${marker}"\nexit 1\n`, 'utf8');
        const { chmod } = await import('node:fs/promises');
        await chmod(hook, 0o755);
        // .gitattributes を **コミットする**（in-tree の属性が読まれる）
        await writeFile(join(repo, '.gitattributes'), 'shared.txt merge=evil\n', 'utf8');
        await g(['add', '-A'], repo);
        await g(['commit', '-q', '-m', 'chore: merge driver のテスト用'], repo);
        await g(['config', 'merge.evil.name', 'demo'], repo);
        await g(['config', 'merge.evil.driver', `${hook} %A %O %B`], repo);

        // agent-a と agent-b は shared.txt を別内容で持つので driver が呼ばれる状況
        const s = await state();
        await new Promise(r => setTimeout(r, 400));
        const { existsSync } = await import('node:fs');
        assert.equal(existsSync(marker), false,
            'merge driver が実行された（読み取り経路から任意コード実行）');
        // 無効化したことを利用者に伝えている
        assert.ok(s.errors.some(e => /merge driver/.test(e.message)),
            `driver を無効化した旨が errors に無い: ${JSON.stringify(s.errors)}`);
    } finally {
        await g(['config', '--unset', 'merge.evil.driver'], repo).catch(() => {});
        await g(['config', '--unset', 'merge.evil.name'], repo).catch(() => {});
        await rm(hook, { force: true });
        await rm(marker, { force: true });
        await rm(join(repo, '.gitattributes'), { force: true });
        await g(['add', '-A'], repo).catch(() => {});
        await g(['commit', '-q', '-m', 'chore: merge driver のテスト後片付け'], repo).catch(() => {});
        // 他のテストのために base を元に戻す（main が2コミット進んだ）
        await g(['worktree', 'prune'], repo).catch(() => {});
        void stem;
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

/**
 * 書き込み有効のサーバを立てる。呼び出し側が kill する。
 *
 * ⚠️ **トークンは `--token` で渡して固定する。** 以前は
 *    `/api/v0/session` を無認証で叩いて貰っていたが、その経路は塞いだ
 *    （Cookie を持つ相手が実行トークンを取り戻せる穴だった。4回目のレビュー）。
 */
const WRITE_TOKEN = 'smoke-write-token-0123456789abcdef';
async function startWritable(extra = []) {
    const child = spawn(
        process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-write', '--token', WRITE_TOKEN, ...extra],
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
    // トークン本体を提示して capability を確認する（Cookie では返らない）
    const s = await (await fetch(`${url}/api/v0/session`, {
        headers: { 'x-kjp-token': WRITE_TOKEN },
    })).json();
    assert.equal(s.token, WRITE_TOKEN, 'トークンを提示したのに返ってこない');
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
// 🚨 #17 で挙動を**意図的に変えた**。以前は「切断で必ず殺す」だったが、
//    モバイルブラウザはタブを積極的に停止するので、スマホから投げた
//    `npm test` がその瞬間に死んでいた。今は「切断では殺さず、猶予を過ぎたら殺す」。
//    ここでは新しい契約の3点すべてを固定する:
//      1. 切断しても走り続ける
//      2. 再購読で切断中の出力が貰える
//      3. 猶予を過ぎたら確実に死ぬ（取り残しの経路を作っていない）
test('🚨 exec: 切断しても走り続け、再購読で追いつき、猶予を過ぎたら死ぬ', async () => {
    // 猶予を2秒にして決定的に測る（既定は5分）
    const { child, url } = await startExec(['--exec-detached-grace', '2']);
    const beacon = join(repo, 'exec-beacon.txt');
    const { readFileSync } = await import('node:fs');
    const size = () => { try { return readFileSync(beacon, 'utf8').length; } catch { return 0; } };
    try {
        // 100ms ごとにファイルへ追記し、同時に標準出力にも書き続ける
        const script = 'const fs=require("fs");let i=0;'
            + 'setInterval(()=>{i++;try{fs.appendFileSync(process.argv[1],"x")}catch(e){};'
            + 'process.stdout.write("tick"+i+"\\n")},100);';
        const ac = new AbortController();
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo, argv: [process.execPath, '-e', script, beacon],
            }),
            signal: ac.signal,
        });
        // 1行目は必ず session（再接続先の id を知る唯一の手段）
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let sessionId = null, lastSeq = 0;
        while (sessionId === null) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            for (const line of buf.split('\n').slice(0, -1)) {
                if (!line.trim()) continue;
                const r = JSON.parse(line);
                if (r.t === 'session') sessionId = r.id;
                if (typeof r.n === 'number') lastSeq = Math.max(lastSeq, r.n);
            }
            buf = buf.slice(buf.lastIndexOf('\n') + 1);
        }
        assert.ok(sessionId, '1行目に session が来ない（再接続先の id を知る手段が無い）');
        assert.match(sessionId, /^[0-9a-f]{16}$/);

        // 走り始めたことを確認して切断する
        while (size() === 0) await new Promise(r => setTimeout(r, 50));
        ac.abort();
        const atAbort = size();

        // 1. 切断しても走り続ける（ファイルが増え続ける）
        await new Promise(r => setTimeout(r, 700));
        const afterAbort = size();
        assert.ok(afterAbort > atAbort,
            `切断で殺されている（${atAbort} → ${afterAbort}）。#17 の目的が失われている`);

        // 2. 再購読で切断中の出力が貰える
        const re = await fetch(`${url}/api/v0/exec/${sessionId}/stream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({ from: lastSeq }),
        });
        assert.equal(re.status, 200, '再購読できない');
        const rr = re.body.getReader();
        let rbuf = '';
        const got = [];
        while (got.length < 3) {
            const { value, done } = await rr.read();
            if (done) break;
            rbuf += dec.decode(value, { stream: true });
            for (const line of rbuf.split('\n').slice(0, -1)) {
                if (line.trim()) got.push(JSON.parse(line));
            }
            rbuf = rbuf.slice(rbuf.lastIndexOf('\n') + 1);
        }
        assert.equal(got[0].t, 'session');
        assert.equal(got[0].state, 'running', '再購読したのに running でない');
        const outs = got.filter(r => r.t === 'out');
        assert.ok(outs.length > 0, '切断中の出力が再生されない');
        assert.ok(outs.every(r => r.n > lastSeq),
            `既に見た分が重複して送られている: ${JSON.stringify(outs.map(r => r.n))}`);
        try { await rr.cancel(); } catch { /* 既に閉じている */ }

        // 3. 猶予（2秒）を過ぎたら死ぬ。ここが効かないと取り残しが戻る
        const beforeGrace = size();
        // 猶予 2s + sweep の周期 1s + 余裕
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 200));
            const a = size();
            await new Promise(r => setTimeout(r, 400));
            if (size() === a && a > beforeGrace) break;
        }
        const s1 = size();
        await new Promise(r => setTimeout(r, 800));
        assert.equal(size(), s1,
            `猶予を過ぎても子プロセスが生きている（${s1} → ${size()}）。取り残しの経路が戻っている`);
    } finally {
        child.kill();
        await rm(beacon, { force: true });
    }
});

test('🚨 exec: 明示的な kill で止まり、監査に残る', async () => {
    const { child, url } = await startExec();
    const beacon = join(repo, 'exec-kill-beacon.txt');
    const { readFileSync } = await import('node:fs');
    const size = () => { try { return readFileSync(beacon, 'utf8').length; } catch { return 0; } };
    try {
        const script = 'const fs=require("fs");'
            + 'setInterval(()=>{try{fs.appendFileSync(process.argv[1],"x")}catch(e){}},100);'
            + 'process.stdout.write("go\\n");';
        const ac = new AbortController();
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo, argv: [process.execPath, '-e', script, beacon], keepAlive: true,
            }),
            signal: ac.signal,
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const first = JSON.parse(dec.decode((await reader.read()).value).split('\n')[0]);
        assert.equal(first.t, 'session');
        assert.equal(first.keepAlive, true, 'keepAlive が反映されていない');
        assert.equal(first.detachedGraceMs, null, 'keepAlive なのに猶予が出ている');

        while (size() === 0) await new Promise(r => setTimeout(r, 50));
        ac.abort();

        // keepAlive なので切断だけでは死なない
        await new Promise(r => setTimeout(r, 600));
        const a = size();
        await new Promise(r => setTimeout(r, 600));
        assert.ok(size() > a, 'keepAlive なのに切断で死んでいる');

        // 明示的に止める
        const k = await fetch(`${url}/api/v0/exec/${first.id}/kill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        });
        assert.equal(k.status, 200);
        assert.equal((await k.json()).ok, true);

        await new Promise(r => setTimeout(r, 600));
        const s1 = size();
        await new Promise(r => setTimeout(r, 600));
        assert.equal(size(), s1, `kill が効いていない（${s1} → ${size()}）`);

        // 監査に残る（何を止めたか後から辿れる）
        const { readFile: rf } = await import('node:fs/promises');
        const auditRaw = await rf(join(repo, '.git', 'kjp-exec-audit.jsonl'), 'utf8');
        const events = auditRaw.trim().split('\n').map(l => JSON.parse(l))
            .filter(e => e.session === first.id);
        const kinds = events.map(e => e.event);
        for (const want of ['start', 'detach', 'kill']) {
            assert.ok(kinds.includes(want), `監査に ${want} が無い: ${kinds.join(',')}`);
        }
    } finally {
        child.kill();
        await rm(beacon, { force: true });
    }
});

// 🚨 切断で殺さなくなったので、**サーバ終了時の後始末が唯一の最後の砦**になった。
//    ここが効かないと、サーバを止めるたびに孫が残る。
//
// ⚠️ Windows では検証できない。`child.kill('SIGTERM')` は TerminateProcess に
//    なるので `process.on('SIGTERM')` ハンドラが**そもそも走らない**
//    （= Windows ではこの守り自体が効かない。既知の限界として記録する）。
test('🚨 exec: サーバを SIGTERM で止めたら孫プロセスも残さない', {
    skip: process.platform === 'win32'
        ? 'Windows は SIGTERM が TerminateProcess になりハンドラが走らない（既知の限界）'
        : false,
}, async () => {
    const { child, url } = await startExec();
    const beacon = join(repo, 'shutdown-beacon.txt');
    const { readFileSync } = await import('node:fs');
    const size = () => { try { return readFileSync(beacon, 'utf8').length; } catch { return 0; } };
    try {
        // 中間に sh を挟む。直接の子だけを殺す実装では孫が残る形
        const inner = 'const fs=require("fs");'
            + 'setInterval(()=>{try{fs.appendFileSync(process.argv[1],"x")}catch(e){}},100);';
        const ac = new AbortController();
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo,
                argv: ['sh', '-c', `${process.execPath} -e '${inner}' "$1"`, 'sh', beacon],
            }),
            signal: ac.signal,
        });
        await res.body.getReader().read();
        while (size() === 0) await new Promise(r => setTimeout(r, 50));

        // サーバを止める（切断ではなく、サーバ自身の終了）
        child.kill('SIGTERM');
        await Promise.race([
            new Promise(r => child.on('exit', r)),
            new Promise(r => setTimeout(r, 5000)),
        ]);
        await new Promise(r => setTimeout(r, 700));
        const s1 = size();
        await new Promise(r => setTimeout(r, 700));
        assert.equal(size(), s1,
            `サーバを止めても孫が走り続けている（${s1} → ${size()}）`);
        ac.abort();
    } finally {
        child.kill('SIGKILL');
        await rm(beacon, { force: true });
    }
});

// ---------------------------------------------------------------------------
// #18 標準入力（会話コンソールの土台）
//
// ⚠️ サーバは中身を解釈しない。`claude` の stream-json の1行を組み立てるのは
//    クライアントの仕事。ここでは「汎用の stdin 書き込み」として検証する。
// ---------------------------------------------------------------------------

/** 行ごとに `echo:<行>` を返し、EOF で `eof` を出す子プロセス */
const ECHO_SCRIPT = 'process.stdin.setEncoding("utf8");let b="";'
    + 'process.stdin.on("data",d=>{b+=d;let i;'
    + 'while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);'
    + 'process.stdout.write("echo:"+l+"\\n")}});'
    + 'process.stdin.on("end",()=>{process.stdout.write("eof\\n")});';

/** セッションを1つ作り、id と「行を読む」関数を返す */
async function startSession(url, argv, extra = {}) {
    const ac = new AbortController();
    const res = await fetch(`${url}/api/v0/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        body: JSON.stringify({ worktree: repo, argv, ...extra }),
        signal: ac.signal,
    });
    assert.equal(res.status, 200, `セッションを作れない: ${res.status}`);
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const seen = [];
    /**
     * 条件を満たすレコードが来るまで読む。
     *
     * 🚨 **上限は `Promise.race` で掛ける。** 経過時間をループの先頭で見るだけでは、
     *    `rd.read()` が返らないときに**一度も判定に戻らずハングする**。
     *    ハングすると `node --test` ごと SIGKILL され、要約が出ないので
     *    「落ちた」ではなく「テストが1件も走っていない」に見える
     *    （変異テストが SKIP と誤報し、守りが検証されない）。
     */
    const until = async (pred, limitMs = 15000) => {
        const t0 = Date.now();
        while (!seen.some(pred)) {
            const left = limitMs - (Date.now() - t0);
            if (left <= 0) {
                throw new Error(`条件を満たすレコードが来ない。見えたもの: ${JSON.stringify(seen)}`);
            }
            const r = await Promise.race([
                rd.read(),
                new Promise(res => setTimeout(() => res({ timeout: true }), left)),
            ]);
            if (r.timeout) {
                throw new Error(`${limitMs}ms 待っても条件を満たさない。見えたもの: ${JSON.stringify(seen)}`);
            }
            if (r.done) break;
            buf += dec.decode(r.value, { stream: true });
            const parts = buf.split('\n');
            buf = parts.pop();
            for (const l of parts) if (l.trim()) seen.push(JSON.parse(l));
        }
        return seen;
    };
    await until(r => r.t === 'session');
    const id = seen.find(r => r.t === 'session').id;
    return { id, seen, until, abort: () => ac.abort(), cancel: () => rd.cancel().catch(() => {}) };
}

const sendInput = (url, id, body) => fetch(`${url}/api/v0/exec/${id}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
    body: JSON.stringify(body),
});

test('🚨 exec: 標準入力に書けて、往復し、EOF で閉じられる', async () => {
    const { child, url } = await startExec();
    try {
        const s = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        // 1ターン目
        const r1 = await sendInput(url, s.id, { data: 'hello\n' });
        assert.equal(r1.status, 200);
        assert.equal((await r1.json()).bytes, 6);
        await s.until(r => r.t === 'out' && r.d.includes('echo:hello'));

        // 2ターン目（同じプロセスに続けて送れる = 会話が成立する形）
        await sendInput(url, s.id, { data: 'second\n' });
        await s.until(r => r.t === 'out' && r.d.includes('echo:second'));

        // 入力も記録に残り、購読者に流れる（別端末から見ても何を送ったか分かる）
        const ins = s.seen.filter(r => r.t === 'in');
        assert.deepEqual(ins.map(r => r.d), ['hello\n', 'second\n']);

        // EOF で閉じる
        await sendInput(url, s.id, { eof: true });
        await s.until(r => r.t === 'out' && r.d.includes('eof'));
        await s.until(r => r.t === 'exit');

        // 閉じた後の書き込みは 409（黙って捨てない）
        const after = await sendInput(url, s.id, { data: 'late\n' });
        assert.equal(after.status, 409);
        s.abort();
    } finally { child.kill(); }
});

test('exec: 入力は再接続でも再生される（自分の発言が消えない）', async () => {
    const { child, url } = await startExec();
    try {
        const s = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        await sendInput(url, s.id, { data: 'remembered\n' });
        await s.until(r => r.t === 'out' && r.d.includes('echo:remembered'));
        s.abort();

        const re = await fetch(`${url}/api/v0/exec/${s.id}/stream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({ from: 0 }),
        });
        const rd = re.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        const got = [];
        while (!got.some(r => r.t === 'out' && r.d.includes('echo:remembered'))) {
            const { value, done } = await rd.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split('\n');
            buf = parts.pop();
            for (const l of parts) if (l.trim()) got.push(JSON.parse(l));
        }
        assert.ok(got.some(r => r.t === 'in' && r.d === 'remembered\n'),
            `再接続で入力が再生されない: ${JSON.stringify(got.filter(r => r.t === 'in'))}`);
        await rd.cancel().catch(() => {});
    } finally { child.kill(); }
});

// 🚨 入力は自由文で、秘密が入りうる（パスワードやトークンを打つ場面がある）。
//    T5 と同じ理屈で**本文は監査に残さない**。残すのはバイト数だけ。
test('🚨 exec: 監査ログに入力の本文を残さない（バイト数だけ）', async () => {
    const { child, url } = await startExec();
    const SECRET = 'INPUT-SECRET-31337';
    try {
        const s = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        await sendInput(url, s.id, { data: `${SECRET}\n` });
        await s.until(r => r.t === 'out' && r.d.includes(SECRET));

        const { readFile: rf } = await import('node:fs/promises');
        const raw = await rf(join(repo, '.git', 'kjp-exec-audit.jsonl'), 'utf8');
        assert.ok(!raw.includes(SECRET), '監査ログに入力の本文が残っている');
        const ev = raw.trim().split('\n').map(l => JSON.parse(l))
            .filter(e => e.session === s.id && e.event === 'input');
        assert.equal(ev.length, 1, `input が記録されていない: ${ev.length}`);
        assert.equal(ev[0].bytes, Buffer.byteLength(`${SECRET}\n`, 'utf8'),
            'バイト数が記録されていない（何も分からなくなる）');
        s.abort();
    } finally { child.kill(); }
});

test('🔒 exec: input も関門を通る（トークン無し / 終了後 / 不正な本文）', async () => {
    const { child, url } = await startExec();
    try {
        const s = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        // トークン無し
        const noTok = await fetch(`${url}/api/v0/exec/${s.id}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: 'x\n' }),
        });
        assert.equal(noTok.status, 403, 'トークン無しで標準入力に書けてしまった');
        // GET では書けない（副作用を GET で起こさない）
        const viaGet = await fetch(`${url}/api/v0/exec/${s.id}/input`, {
            headers: { 'x-kjp-token': EXEC_TOKEN },
        });
        assert.notEqual(viaGet.status, 200, 'GET で標準入力に書けてしまった');
        // data も eof も無い
        const empty = await sendInput(url, s.id, { nothing: true });
        assert.equal(empty.status, 400);

        // 終了したセッションには書けない
        await sendInput(url, s.id, { eof: true });
        await s.until(r => r.t === 'exit');
        const done = await sendInput(url, s.id, { data: 'x\n' });
        assert.equal(done.status, 409);
        s.abort();
    } finally { child.kill(); }
});

// 🚨 #26: 1回 64KB を縛っても、相手が読まなければ書いた分は親のメモリに
//    無限に溜まる。README の「上限 1回 64KB」は総量を縛っていないのに
//    縛られているように読めた。しかも溜まっている間も ok:true を返すので
//    画面から滞留が見えなかった。
test('🚨 exec: 標準入力の総量と滞留に上限がある（ok:true で隠さない）', async () => {
    const { child, url } = await startExec();
    try {
        // stdin を**読まない**プロセス
        const s = await startSession(url, [process.execPath, '-e', 'setInterval(()=>{},1000)']);
        let total = 0;
        let stopped = null;
        // 64KB を積み続ける。総量 4MB / 滞留 1MB のどちらかで止まるはず
        for (let i = 0; i < 200; i++) {
            const r = await sendInput(url, s.id, { data: `${'z'.repeat(60 * 1024)}\n` });
            if (r.status === 200) {
                const j = await r.json();
                total = j.totalBytes;
                // 応答が滞留を見せていること（隠さない）
                assert.equal(typeof j.pending, 'number', '滞留が応答に出ていない');
                continue;
            }
            stopped = { status: r.status, error: (await r.json()).error };
            break;
        }
        assert.ok(stopped, `無制限に受け付けている（総量 ${Math.round(total / 1024)}KB）`);
        assert.ok([413, 429].includes(stopped.status),
            `想定外の拒否コード: ${JSON.stringify(stopped)}`);
        assert.match(stopped.error, /上限|読んでいません/);

        // 一覧にも総量と滞留が出る（画面から見える）
        const st = JSON.parse(await (await fetch(`${url}/api/v0/state?fresh=1`)).text());
        const one = st.execSessions.find(x => x.id === s.id);
        assert.ok(one.inputBytes > 0, '総量が一覧に出ていない');
        assert.equal(typeof one.inputPending, 'number', '滞留が一覧に出ていない');
        s.abort();
        await fetch(`${url}/api/v0/exec/${s.id}/kill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
        }).catch(() => {});
    } finally { child.kill(); }
});

test('exec: 大きすぎる入力は拒否する', async () => {
    const { child, url } = await startExec();
    try {
        const s = await startSession(url, [process.execPath, '-e', ECHO_SCRIPT]);
        const big = await sendInput(url, s.id, { data: `${'x'.repeat(80 * 1024)}\n` });
        // ⚠️ 413 で返ること自体が検査対象。以前は req.destroy() していたので
        //    クライアントには『fetch failed』しか見えず、原因が分からなかった
        assert.equal(big.status, 413, '64KB を超える入力が通った（または応答が届いていない）');
        assert.match((await big.json()).error, /大きすぎます/);
        s.abort();
    } finally { child.kill(); }
});

test('🔒 exec: 標準入力の経路も --allow-exec なしでは存在しない', async () => {
    const s = await startAuthServer([]);
    try {
        const r = await fetch(`http://127.0.0.1:${s.port}/api/v0/exec/0123456789abcdef/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: 'x\n' }),
        });
        assert.equal(r.status, 403);
    } finally { s.child.kill(); }
});

// 🚨 4回目のレビュー（BLOCKING）: spawn の失敗は **'error' イベント**で来て
//    'exit' は来ない。以前は finish() を呼ぶ経路が無く、セッションが永久に
//    running のままで枠も返らなかった（起動していないプロセスを「実行中」と表示）。
test('🚨 exec: 起動できないコマンドでもセッションが終端し、枠が返る', async () => {
    const { child, url } = await startExec();
    try {
        // 存在しないコマンド。Windows では拡張子なしの `npm` も同じ経路
        const s = await startSession(url, ['no-such-command-xyz-9c1f']);
        // exit が来ること（来なければ「実行中」の嘘が残る）
        await s.until(r => r.t === 'exit');
        const exit = s.seen.find(r => r.t === 'exit');
        assert.equal(exit.code, null);
        assert.ok(s.seen.some(r => r.t === 'err' && /ENOENT|起動できません|実行エラー/.test(r.d)),
            `理由が出ていない: ${JSON.stringify(s.seen)}`);

        // 台帳でも done になっていること
        const st = JSON.parse((await (await fetch(`${url}/api/v0/state?fresh=1`)).text()));
        const one = st.execSessions.find(x => x.id === s.id);
        assert.equal(one.state, 'done', '起動していないプロセスが running のまま');
        s.abort();

        // 🚨 枠が返ること。上限を超える回数投げても最後まで受理される
        for (let i = 0; i < 10; i++) {
            const r = await fetch(`${url}/api/v0/exec`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
                body: JSON.stringify({ worktree: repo, argv: ['no-such-command-xyz-9c1f'] }),
            });
            assert.equal(r.status, 200, `${i + 1} 回目で枠が尽きた（枠が返っていない）`);
            await r.text();
        }
    } finally { child.kill(); }
});

// 🚨 4回目のレビュー（BLOCKING）: stdin の書き込み失敗は非同期の 'error' で来る。
//    listener が無いと uncaughtException で**デーモンが落ちる**（走っている
//    全セッションが消え、監査に exit が1件も残らない）。
test('🚨 exec: 相手が終わった直後に標準入力へ送ってもデーモンが落ちない', async () => {
    const { child, url } = await startExec();
    let died = null;
    child.on('exit', code => { died = code; });
    try {
        // すぐ終わるが stdin は読まないプロセス
        const s = await startSession(url, [process.execPath, '-e',
            'process.stdout.write("done\\n")']);
        await s.until(r => r.t === 'exit');
        s.abort();

        // 終了後に書く（409 が返るべき。落ちてはいけない）
        const after = await sendInput(url, s.id, { data: 'x'.repeat(40 * 1024) });
        assert.ok([409, 200].includes(after.status), `想定外の応答: ${after.status}`);

        // 走っている相手に大量に書いて、途中で相手が終わる形も試す
        const s2 = await startSession(url, [process.execPath, '-e',
            'setTimeout(()=>process.exit(0),150)']);
        for (let i = 0; i < 6; i++) {
            await sendInput(url, s2.id, { data: `${'y'.repeat(60 * 1024)}\n` }).catch(() => {});
            await new Promise(r => setTimeout(r, 60));
        }
        s2.abort();

        // 🚨 サーバが生きていること（ここが本体）
        await new Promise(r => setTimeout(r, 500));
        assert.equal(died, null, `デーモンが落ちた（exit=${died}）`);
        const alive = await fetch(`${url}/api/v0/state?fresh=1`);
        assert.equal(alive.status, 200, 'サーバが応答しない');
    } finally { child.kill(); }
});

// 🚨 `res.write()` は相手が読まなくてもメモリに積む。ブラウザのタブが停止した
//    まま出力の多いコマンドを走らせると RSS が 72MB → 433MB まで伸びた（レビューで実測）。
//    上限を超えたら**その購読者を切る**（データはリングバッファに残るので再接続で追いつける）。
test('🚨 exec: 読まない購読者は切られ、応答が無制限に溜まらない', async () => {
    const { child, url } = await startExec();
    try {
        // 大量に出力し続けるコマンド。購読側は**1バイトも読まない**
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo,
                argv: [process.execPath, '-e',
                    'const s="x".repeat(64*1024);let i=0;'
                    + 'const t=setInterval(()=>{i++;process.stdout.write(s);'
                    + 'if(i>400)clearInterval(t)},1)'],
            }),
        });
        assert.equal(res.status, 200);
        // ⚠️ **1回だけ読んで、以後まったく読まない。**
        //    ループで読んでしまうと溜まらないので検査にならない（一度そう書いた）。
        //    読まないと undici がソケットから引き取らなくなり、
        //    サーバ側の res に溜まる = タブが停止した状態と同じ。
        const reader = res.body.getReader();
        await reader.read();

        // 監査に「切った」記録が出るまで待つ（固定時間で待たない）
        const { readFile: rf } = await import('node:fs/promises');
        const auditPath = join(repo, '.git', 'kjp-exec-audit.jsonl');
        let sawDrop = false;
        for (let i = 0; i < 120 && !sawDrop; i++) {
            await new Promise(r => setTimeout(r, 250));
            try { sawDrop = /drop-subscriber/.test(await rf(auditPath, 'utf8')); } catch { /* まだ無い */ }
        }
        assert.ok(sawDrop,
            '読まない購読者が切られない（応答が無制限に溜まる）。監査にも残っていない');

        // サーバは生きている（切ったのは購読者だけ）
        const st = JSON.parse(await (await fetch(`${url}/api/v0/state?fresh=1`)).text());
        assert.ok(Array.isArray(st.execSessions), 'サーバが応答しない');

        // ⚠️ **重いテストは自分の後始末をする。** 25MB を吐く子を残すと
        //    後続のテストが CPU / IO を奪われ、**別のテストが「起動しなかった」で
        //    落ちる**（CI で実際に2件落ちた。原因の心当たりはこれ）。
        //    サーバを kill するだけでは、Windows では SIGTERM ハンドラが走らず孫が残る。
        for (const s of st.execSessions.filter(x => x.state === 'running')) {
            await fetch(`${url}/api/v0/exec/${s.id}/kill`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            }).catch(() => {});
        }
    } finally { child.kill(); }
});

test('🔒 exec: 不正なセッション id と知らない id を弾く', async () => {
    const { child, url } = await startExec();
    try {
        const call = (id, path = 'stream') => fetch(`${url}/api/v0/exec/${id}/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: '{}',
        });
        // 形が違うもの（長さ違い・大文字）は 400 で弾く
        for (const bad of ['xyz', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0']) {
            const r = await call(bad);
            assert.equal(r.status, 400, `不正な id が通った: ${bad}`);
        }
        // パス走査は経路に届く前に消える。`..` も `%2e%2e` も new URL() が
        // デコードして正規化するので `/api/v0/stream` になり、どのルートにも当たらない。
        // **「400 で弾いた」ではなく「そもそも届いていない」**ので 404 を期待する。
        for (const bad of ['..', '%2e%2e', '%2E%2E']) {
            const r = await call(bad);
            assert.ok(r.status !== 200, `パス走査が通った: ${bad} → ${r.status}`);
            assert.equal(r.status, 404, `${bad} の扱いが変わった（正規化に頼っている前提が崩れた）`);
        }
        // 形は正しいが存在しない
        const r = await call('0123456789abcdef');
        assert.equal(r.status, 404);
        // 🔒 トークン無しでは経路そのものが無い
        const noTok = await fetch(`${url}/api/v0/exec/0123456789abcdef/kill`, { method: 'POST' });
        assert.equal(noTok.status, 403, 'トークン無しで kill できてしまった');
    } finally { child.kill(); }
});

test('実行セッションの一覧が state に出る（見えない取り残しを作らない）', async () => {
    const { child, url } = await startExec();
    try {
        const ac = new AbortController();
        const res = await fetch(`${url}/api/v0/exec`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({
                worktree: repo,
                // ⚠️ 秘密を argv に書かない。argv は「何を止めるか」の判断に必要なので
                //    一覧に**意図的に出している**。検査したいのは「出力が漏れないこと」
                argv: [process.execPath, '-e',
                    'process.stdout.write(["SECRET","EXEC","OUT","777"].join("-")+"\\n");'
                    + 'setInterval(()=>{},1000)'],
            }),
            signal: ac.signal,
        });
        const reader = res.body.getReader();
        await reader.read();
        await new Promise(r => setTimeout(r, 300));

        const st = await (await fetch(`${url}/api/v0/state?fresh=1`)).text();
        const s = JSON.parse(st);
        assert.ok(Array.isArray(s.execSessions), 'execSessions が出ていない');
        assert.equal(s.execSessions.length, 1);
        const one = s.execSessions[0];
        assert.equal(one.state, 'running');
        assert.equal(one.subscribers, 1);
        assert.ok(one.argv.includes(process.execPath), 'argv が出ていない（何を止めるか判断できない）');
        // ⚠️ 一覧に出力の中身を入れない（state は認証だけで読めるので）
        assert.ok(!st.includes('SECRET-EXEC-OUT-777'), '一覧に出力の中身が漏れている');
        ac.abort();
    } finally { child.kill(); }
});

test('--allow-exec なしでは execSessions が null（経路の存在も見せない）', async () => {
    const s = await startAuthServer([]);
    try {
        const st = JSON.parse((await authGet(s.port, '/api/v0/state?fresh=1')).body);
        assert.equal(st.execSessions, null);
    } finally { s.child.kill(); }
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

// 🚨 このテストは以前「bare worktree は smoke のフィクスチャに無いので、
//    無効な worktree で経路が閉じていることだけ確認する（bare の網羅は
//    unit 側の責務）」と書いていたが、**unit 側に bare のテストは無かった**。
//    つまり `wt.bare` / `wt.prunable` の門は exec も checkout も
//    **外しても全テストが緑**だった（過去2件と同じクラスの偽陽性。#33）。
//    ここで**本物の bare / prunable を作って**4つの門すべてを測る。
test('🚨 exec / checkout: bare と prunable の門が実際に効く', async () => {
    // 実体のある bare worktree と、実体を消した prunable worktree を用意する
    const stem = repo.split(/[\\/]/).pop();
    const bareWt = join(repo, '..', `${stem}-bare-real`);
    const goneWt = join(repo, '..', `${stem}-gone-real`);
    await g(['worktree', 'add', '--detach', goneWt, 'HEAD'], repo);
    // bare worktree は `worktree add` では作れないので、bare clone を追加する
    await g(['clone', '--bare', '--quiet', repo, bareWt], repo);

    const { child, url } = await startExec(['--allow-write']);
    try {
        // prunable にする（実体を消す。git はまだ台帳に持っている）
        await rm(goneWt, { recursive: true, force: true });
        const st = JSON.parse(await (await fetch(`${url}/api/v0/state?fresh=1`)).text());
        const prunable = st.worktrees.find(w => w.prunable);
        assert.ok(prunable, `prunable な worktree が payload に出ていない: `
            + `${JSON.stringify(st.worktrees.map(w => [w.name, w.prunable]))}`);

        // 1. exec は prunable を拒否する（cwd にすると ENOENT で経路が壊れる）
        const e1 = await readExec(url, { worktree: prunable.path, argv: ['git', '--version'] });
        assert.equal(e1.status, 409, 'exec が prunable を通した');

        // 2. checkout も prunable を拒否する
        const c1 = await fetch(`${url}/api/v0/checkout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
            body: JSON.stringify({ worktree: prunable.path, ref: 'main' }),
        });
        assert.equal(c1.status, 409, `checkout が prunable を通した: ${c1.status}`);
        // ⚠️ **理由まで見る。** 門を外しても git 自身が失敗して 409 を返すので、
        //    status だけでは「門が効いた」と「git が拒否した」を区別できない
        //    （最初そう書いて変異が生き残った）
        assert.match((await c1.json()).error, /作業ツリーが失われています/,
            '門ではなく git の失敗で 409 になっている（門を外しても緑になる）');

        // 3・4. bare は「既知の worktree」として出ないので、
        //       bare を cwd にしようとしても allowlist で止まる。
        //       ただし **bare が worktree 一覧に現れる構成**（bare リポジトリを
        //       --repo に渡した場合）では bare の門が唯一の守りになる。
        const bareSrv = spawn(process.execPath,
            [SERVER, '--repo', bareWt, '--port', '0', '--allow-exec',
                '--token', EXEC_TOKEN, '--allow-write'],
            { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
        bareSrv.stdout.setEncoding('utf8');
        bareSrv.stderr.setEncoding('utf8');
        let bnr = '';
        let berr = '';
        bareSrv.stderr.on('data', d => { berr += d; });
        try {
            const bUrl = await Promise.race([
                new Promise((res, rej) => {
                    bareSrv.stdout.on('data', d => {
                        bnr += d;
                        const m = bnr.match(/http:\/\/127\.0\.0\.1:\d+/);
                        if (m) setTimeout(() => res(m[0]), 400);
                    });
                    bareSrv.on('error', rej);
                    bareSrv.on('exit', () => setTimeout(() => rej(new Error(
                        `bare で起動しなかった\n  stdout: ${bnr}\n  stderr: ${berr}`)), 50));
                }),
                new Promise((_, rej) => setTimeout(() => rej(new Error(
                    `bare で起動しなかった\n  stdout: ${bnr}\n  stderr: ${berr}`)), 20000)),
            ]);
            const bst = JSON.parse(await (await fetch(`${bUrl}/api/v0/state?fresh=1`)).text());
            const bare = bst.worktrees.find(w => w.bare);
            assert.ok(bare, `bare な worktree が payload に出ていない: `
                + `${JSON.stringify(bst.worktrees.map(w => [w.name, w.bare]))}`);

            // 3. exec は bare を拒否する（作業ツリーが無い場所で任意コマンドが走る）
            const e2 = await fetch(`${bUrl}/api/v0/exec`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
                body: JSON.stringify({ worktree: bare.path, argv: ['git', '--version'] }),
            });
            assert.equal(e2.status, 400, 'exec が bare を通した（作業ツリーが無い場所で実行）');
            assert.match((await e2.json()).error, /bare/);

            // 4. checkout も bare を拒否する
            const c2 = await fetch(`${bUrl}/api/v0/checkout`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-kjp-token': EXEC_TOKEN },
                body: JSON.stringify({ worktree: bare.path, ref: 'main' }),
            });
            assert.equal(c2.status, 400, 'checkout が bare を通した');
        } finally {
            bareSrv.kill();
        }
    } finally {
        child.kill();
        await g(['worktree', 'prune'], repo).catch(() => {});
        await rm(bareWt, { recursive: true, force: true }).catch(() => {});
        await rm(goneWt, { recursive: true, force: true }).catch(() => {});
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

// 🚨 #1: `merge-tree --name-only` は**実在しないパス**を返す（実測: `thing~B`。
//    file と directory の衝突で git が退避先として作る名前）。それを普通の
//    ファイル名として出すと、押しても `/api/v0/diff` にも `blob` にも無いので
//    **開けない行き止まり**になっていた。判別して理由を添える。
test('🚨 衝突予測: 合成パスを印付けて「開けない理由」を出す', async () => {
    const stem = repo.split(/[\\/]/).pop();
    const wtA = join(repo, '..', `${stem}-synth-a`);
    const wtB = join(repo, '..', `${stem}-synth-b`);
    try {
        // 枝A: thing をディレクトリに / 枝B: thing をファイルに（file/directory 衝突）
        await g(['worktree', 'add', '-b', 'synth-a', wtA, 'main'], repo);
        await mkdir(join(wtA, 'thing'), { recursive: true });
        await writeFile(join(wtA, 'thing', 'inner.txt'), 'from A\n', 'utf8');
        // ⚠️ 候補ペアは「同じパスを触っている」ことで作るので、`thing` だけでは
        //    候補にならない（A は `thing/inner.txt`、B は `thing` で別のパス）。
        //    共通のファイルも衝突させて候補に入れる（候補生成の既知の限界）
        await writeFile(join(wtA, 'shared.txt'), 'A side\n', 'utf8');
        await g(['add', '-A'], wtA);
        await g(['commit', '-q', '-m', 'A: thing はディレクトリ'], wtA);

        await g(['worktree', 'add', '-b', 'synth-b', wtB, 'main'], repo);
        await writeFile(join(wtB, 'thing'), 'from B\n', 'utf8');
        await writeFile(join(wtB, 'shared.txt'), 'B side\n', 'utf8');
        await g(['add', '-A'], wtB);
        await g(['commit', '-q', '-m', 'B: thing はファイル'], wtB);

        const s = JSON.parse(await (await fetch(`${baseUrl}/api/v0/state?fresh=1`)).text());
        const pair = (s.conflicts ?? []).find(c => c.clean === false
            && (c.files ?? []).some(f => /~/.test(typeof f === 'string' ? f : f.path)));
        assert.ok(pair, '合成パスを含む衝突が出ていない'
            + `（conflicts: ${JSON.stringify((s.conflicts ?? []).map(c => [c.a, c.b, c.clean]))}）`);

        const synth = pair.files.find(f => typeof f === 'object' && f.synthetic);
        assert.ok(synth, `合成パスに印が付いていない: ${JSON.stringify(pair.files)}`);
        assert.match(synth.path, /~/);
        assert.equal(synth.of, 'thing', `実体のパスが分からない: ${JSON.stringify(synth)}`);
        assert.match(synth.why, /実在しません/);

        // 普通のファイルは印が付かない（過剰に印を付けていない）
        for (const f of pair.files) {
            if (typeof f !== 'object') continue;
            if (!/~/.test(f.path)) assert.equal(f.synthetic, false, `過剰に印を付けている: ${f.path}`);
        }
    } finally {
        await g(['worktree', 'remove', '--force', wtA], repo).catch(() => {});
        await g(['worktree', 'remove', '--force', wtB], repo).catch(() => {});
        await g(['branch', '-D', 'synth-a'], repo).catch(() => {});
        await g(['branch', '-D', 'synth-b'], repo).catch(() => {});
        await rm(wtA, { recursive: true, force: true }).catch(() => {});
        await rm(wtB, { recursive: true, force: true }).catch(() => {});
    }
});

// ---------------------------------------------------------------------------
// 🔒 読み取り経路の認証（#6 の 1・2）
//
// これが無い間、読み取りを守っていたのは Host 許可 + Sec-Fetch-Site だけで、
// **トンネルに届く相手（tailnet の全端末）は誰でも差分を読めた。**
// 標準入力の経路（#18）を開ける前提なので、ここを固定する。
//
// ⚠️ Host を検証する種類のテストは fetch で書かない。undici は Host を
//    上書きできず黙って既定値を送るので、「防がれた」ではなく
//    「攻撃を送れていない」を見てしまう（実際に偽陽性を出した）。
//    ここは node:http の request() を使う。
// ---------------------------------------------------------------------------

/** 独立したサーバを起動して port と banner を返す */
async function startAuthServer(extra) {
    const child = spawn(process.execPath, [SERVER, '--repo', repo, '--port', '0', ...extra],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let banner = '';
    // 🚨 **stderr を捨てない。** 起動に失敗した理由は stderr に出るので、
    //    捨てると CI で「起動しなかった:」だけが残り**原因が完全に消える**
    //    （実際にそうなって1往復無駄にした）。終了コードも添える。
    let errOut = '';
    let exited = null;
    child.stderr.on('data', d => { errOut += d; });
    child.on('exit', (code, signal) => { exited = `exit=${code} signal=${signal}`; });
    const why = () => `起動しなかった\n  stdout: ${banner.trim() || '(空)'}`
        + `\n  stderr: ${errOut.trim() || '(空)'}\n  ${exited ?? '(まだ生きている)'}`;
    const port = await Promise.race([
        new Promise((res, rej) => {
            child.stdout.on('data', d => {
                banner += d;
                const m = banner.match(/http:\/\/127\.0\.0\.1:(\d+)/);
                // トークンの案内も同じ塊で出るので、少し待って banner を確定させる
                if (m) setTimeout(() => res(Number(m[1])), 400);
            });
            child.on('error', e => rej(new Error(`${why()}\n  spawn: ${e.message}`)));
            // 起動前に落ちたら待たずに失敗させる（20秒待つ意味がない）
            child.on('exit', () => setTimeout(() => rej(new Error(why())), 50));
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(why())), 20000)),
    ]);
    return { child, port, banner: () => banner, stderr: () => errOut };
}

function authGet(port, path, headers = {}) {
    return new Promise(res => {
        const r = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, x => {
            let b = '';
            x.on('data', d => { b += d; });
            x.on('end', () => res({
                code: x.statusCode, body: b,
                setCookie: (x.headers['set-cookie'] ?? []).join(' '),
                location: x.headers.location ?? null,
            }));
        });
        r.on('error', e => res({ code: 0, body: e.message, setCookie: '', location: null }));
        r.end();
    });
}

test('既定（ループバックのみ）では読み取りに認証を要求しない', async () => {
    const s = await startAuthServer([]);
    try {
        assert.equal((await authGet(s.port, '/api/v0/state')).code, 200);
        const sess = JSON.parse((await authGet(s.port, '/api/v0/session')).body);
        assert.equal(sess.requireAuth, false, '既定で認証が要求されている（摩擦を増やしている）');
        assert.ok(!/require-auth/.test(s.banner()), '既定なのに認証の案内が出ている');
    } finally { s.child.kill(); }
});

test('🔒 --require-auth: トークンが無い / 違うと 401、Cookie とヘッダで通る', async () => {
    const s = await startAuthServer(['--require-auth']);
    try {
        const token = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner())?.[1];
        assert.ok(token && token.length >= 24, `起動時にトークン付き URL が出ていない: ${s.banner()}`);

        assert.equal((await authGet(s.port, '/api/v0/state')).code, 401, 'トークン無しが通った');
        assert.equal((await authGet(s.port, '/api/v0/state',
            { 'x-kjp-token': 'wrong-value-0123456789abc' })).code, 401, '誤ったトークンが通った');
        assert.equal((await authGet(s.port, '/api/v0/state', { 'x-kjp-token': token })).code, 200);

        // 🚨 **Cookie には生のトークンを入れない**（ポート分離が無いので
        //    他のローカルサービスに渡る）。ブートストラップが焼いた値だけが通る
        const raw = await authGet(s.port, '/api/v0/state', { cookie: `kjp_auth=${token}` });
        assert.equal(raw.code, 401, 'Cookie に生のトークンを入れて通ってしまった');
        const baked = /kjp_auth=([^;]+)/.exec((await authGet(s.port, `/?token=${token}`)).setCookie)?.[1];
        assert.ok(baked, 'Cookie が焼かれていない');
        assert.equal((await authGet(s.port, '/api/v0/state', { cookie: `kjp_auth=${baked}` })).code, 200,
            '焼かれた Cookie で読めない');

        // 401 の本文でトークンの手掛かりを与えない
        const deny = await authGet(s.port, '/api/v0/state');
        assert.ok(!deny.body.includes(token), '401 の本文にトークンが混ざっている');
    } finally { s.child.kill(); }
});

// 🚨 Cookie はポートで分離されない（RFC 6265）。127.0.0.1 に焼いた Cookie は
//    127.0.0.1 の**他のポート全部**に送られるので、同じブラウザで別のローカル
//    サーバを開くとその中身が渡る。**実行トークンをそこに入れていた**ので、
//    受け取った相手は X-Kjp-Token に詰めるだけで任意コマンドを実行できた。
test('🚨 Cookie の値は実行トークンと別で、実行には使えない', async () => {
    const s = await startAuthServer(['--require-auth', '--allow-exec', '--token', EXEC_TOKEN]);
    try {
        // ⚠️ **リダイレクトしない**（ページの JS が ?token= を読んで
        //    sessionStorage に入れ、URL から消す）。Cookie は同時に焼かれる。
        const boot = await authGet(s.port, '/?token=' + EXEC_TOKEN);
        assert.equal(boot.code, 200, 'リダイレクトすると JS がトークンを見られない');
        const cookieVal = /kjp_auth=([^;]+)/.exec(boot.setCookie)?.[1];
        assert.ok(cookieVal, 'Cookie が焼かれていない');
        assert.notEqual(decodeURIComponent(cookieVal), EXEC_TOKEN,
            'Cookie に実行トークンがそのまま入っている（他のローカルサービスに渡る）');

        // Cookie では読み取りは通る
        assert.equal((await authGet(s.port, '/api/v0/state',
            { cookie: 'kjp_auth=' + cookieVal })).code, 200, 'Cookie で読めない');

        // 🚨 攻撃の実際の形: 他のローカルサービスは **Cookie を受け取っている**ので、
        //    Cookie と「Cookie の値をヘッダに詰めたもの」の両方を送れる。
        //    入口の認証は Cookie で通るが、**実行の関門で止まらなければならない。**
        const asHeader = await fetch('http://127.0.0.1:' + s.port + '/api/v0/exec', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                cookie: 'kjp_auth=' + cookieVal,
                'x-kjp-token': decodeURIComponent(cookieVal),
            },
            body: JSON.stringify({ worktree: repo, argv: ['git', 'status'] }),
        });
        assert.equal(asHeader.status, 403,
            `Cookie の値で実行できてしまった（分離できていない）: ${asHeader.status}`);
        // Cookie を持っていない相手は入口で 401（こちらも通してはいけない）
        const noCookie = await fetch('http://127.0.0.1:' + s.port + '/api/v0/exec', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kjp-token': decodeURIComponent(cookieVal) },
            body: JSON.stringify({ worktree: repo, argv: ['git', 'status'] }),
        });
        assert.equal(noCookie.status, 401);

        // 🚨 **これが4回目のレビューの BLOCKING 本体。**
        //    以前は /api/v0/session が Cookie 認証の要求に実行トークンを返していた。
        //    Cookie はポートで分離されないので、他のポートを開いた相手が
        //    **リクエスト1本多いだけで任意コード実行に到達していた。**
        //    `sameOrigin` は `!site || ...` なので Sec-Fetch-Site を送らない
        //    非ブラウザは素通りで、偽装すら要らなかった。
        const sess = await authGet(s.port, '/api/v0/session', { cookie: 'kjp_auth=' + cookieVal });
        assert.equal(sess.code, 200);
        assert.equal(JSON.parse(sess.body).token, null,
            'Cookie だけの要求に実行トークンを渡している（1本で RCE に到達する）');
        // トークン本体を提示した要求には渡す（ブラウザは ?token= で1回受け取る）
        const withTok = await authGet(s.port, '/api/v0/session', { 'x-kjp-token': EXEC_TOKEN });
        assert.equal(JSON.parse(withTok.body).token, EXEC_TOKEN,
            'トークンを持っている要求にも渡していない（UI が書き込めなくなる）');
    } finally { s.child.kill(); }
});

test('Cookie の値は再起動をまたいで同じ（--token-file なら開き直さなくて済む）', async () => {
    const a = await startAuthServer(['--require-auth', '--token', EXEC_TOKEN]);
    let first;
    try {
        first = /kjp_auth=([^;]+)/.exec((await authGet(a.port, '/?token=' + EXEC_TOKEN)).setCookie)?.[1];
    } finally { a.child.kill(); }
    const b = await startAuthServer(['--require-auth', '--token', EXEC_TOKEN]);
    try {
        const second = /kjp_auth=([^;]+)/.exec((await authGet(b.port, '/?token=' + EXEC_TOKEN)).setCookie)?.[1];
        assert.equal(second, first, '同じトークンなのに Cookie の値が変わった');
        // 前のサーバで焼いた Cookie がそのまま通る
        assert.equal((await authGet(b.port, '/api/v0/state', { cookie: 'kjp_auth=' + first })).code, 200);
    } finally { b.child.kill(); }
});

test('🔒 ?token= は読み取り用の Cookie を焼き、ページ本体を返す', async () => {
    const s = await startAuthServer(['--require-auth']);
    try {
        const token = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner())?.[1];
        const boot = await authGet(s.port, `/?token=${token}`);
        // 🚨 **リダイレクトしない。** 302 で URL からトークンを落としていたので、
        //    ページの JS がトークンを一度も見られず、書き込み用のトークンを
        //    /api/v0/session から取り戻す作りになっていた。それが
        //    「Cookie を持つ相手が実行に到達する」穴の原因（4回目のレビュー）。
        //    今はページが ?token= を読んで sessionStorage に入れ、URL から消す。
        assert.equal(boot.code, 200, 'リダイレクトすると JS がトークンを見られない');
        assert.match(boot.setCookie, /HttpOnly/, 'Cookie が HttpOnly でない');
        assert.match(boot.setCookie, /SameSite=Strict/, 'Cookie が SameSite=Strict でない');
        // ⚠️ Secure を付けると http のループバックで保存されず、ローカルで動かなくなる
        assert.ok(!/Secure/.test(boot.setCookie), 'Secure が付いている');
        // 焼かれるのは読み取り用の別の秘密（実行トークンではない）
        const cookieVal = decodeURIComponent(/kjp_auth=([^;]+)/.exec(boot.setCookie)?.[1] ?? '');
        assert.notEqual(cookieVal, token, 'Cookie に実行トークンが入っている');
        // ページ側がトークンを sessionStorage に入れて URL から消すことの確認。
        // ⚠️ 文字列の有無だけを見ると、実装を消しても他所に同じ語があれば緑になる。
        //    **?token= を読んだ直後に保存する形**を確かめる。
        assert.match(boot.body, /sessionStorage\.setItem\(TOKEN_KEY, t\)/,
            'トークンを sessionStorage に保持していない'
            + '（Cookie 経由でしか取り戻せなくなり、他ポートの相手が実行に到達する）');
        assert.match(boot.body, /history\.replaceState\(null, '', /,
            'URL からトークンを消していない（履歴と Referer に残る）');
        // Cookie ではなく sessionStorage を使う理由がコードに書かれていること
        assert.match(boot.body, /ポート/, '分離の根拠が書かれていない');
    } finally { s.child.kill(); }
});

test('🚨 --require-auth では /api/v0/session が無認証でトークンを払い出さない', async () => {
    const s = await startAuthServer(['--require-auth', '--allow-write']);
    try {
        const token = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner())?.[1];
        // ここが無認証で通ると、読み取りにトークンを要求しても意味が無い
        // （届く相手が誰でも取れるので、トークンは CSRF 対策でしかなくなる）
        const anon = await authGet(s.port, '/api/v0/session');
        assert.equal(anon.code, 401, '無認証でトークンを払い出している');
        assert.ok(!anon.body.includes(token), '401 の本文にトークンが入っている');

        const ok = await authGet(s.port, '/api/v0/session', { 'x-kjp-token': token });
        assert.equal(ok.code, 200);
        assert.equal(JSON.parse(ok.body).token, token, '認証済みにトークンを返していない');
    } finally { s.child.kill(); }
});

test('🔒 --allow-host を付けると認証が既定で必須になる', async () => {
    const s = await startAuthServer(['--allow-host', 'box.example.test']);
    try {
        assert.equal((await authGet(s.port, '/api/v0/state')).code, 401,
            'トンネルを開けたのに無認証で読める');
        assert.match(s.banner(), /require-auth/);
        assert.match(s.banner(), /box\.example\.test\/\?token=/,
            'トンネル用の URL が案内に出ていない');
    } finally { s.child.kill(); }
});

// 🚨 認可より手前の同期例外は async ハンドラの unhandled rejection になり
//    **デーモンを exit 1 で落とす**。`new URL()` で一度直した型を
//    `decodeURIComponent`（Cookie）で再発させた。無認証で撃てる DoS。
test('🚨 壊れた Cookie / ヘッダでデーモンが落ちない（無認証で撃てる DoS）', async () => {
    const s = await startAuthServer(['--require-auth']);
    let died = null;
    s.child.on('exit', c => { died = c; });
    try {
        // 不正なパーセント encoding。decodeURIComponent が URIError を投げる
        for (const bad of ['kjp_auth=%', 'kjp_auth=%zz', 'kjp_auth=%E0%A4', 'kjp_auth=a%',
            'other=%; kjp_auth=%', 'kjp_auth']) {
            const r = await authGet(s.port, '/api/v0/state', { cookie: bad });
            assert.ok([401, 200, 400].includes(r.code),
                `想定外の応答（接続が切れた可能性）: ${bad} → ${r.code} ${r.body}`);
        }
        await new Promise(r => setTimeout(r, 400));
        assert.equal(died, null, `デーモンが落ちた（exit=${died}）`);

        // 落ちていないなら、正常な要求は引き続き通る
        const token = /\?token=([A-Za-z0-9_-]+)/.exec(s.banner())?.[1];
        assert.equal((await authGet(s.port, '/api/v0/state', { 'x-kjp-token': token })).code, 200);
    } finally { s.child.kill(); }
});

test('🔒 --no-auth と --allow-host の併用は起動を拒否する', async () => {
    const child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-host', 'x.test', '--no-auth'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stderr.setEncoding('utf8');
    let err = '';
    child.stderr.on('data', d => { err += d; });
    // ⚠️ 拒否されなかったときにサーバは動き続けるので、素の await にしない
    const code = await Promise.race([
        new Promise(r => child.on('close', r)),
        new Promise(r => setTimeout(() => r('timeout'), 15000)),
    ]);
    try {
        assert.equal(code, 1, `無認証でトンネルに出せてしまった（${code}）`);
        assert.match(err, /併用できません/);
    } finally { child.kill(); }
});

// ---------------------------------------------------------------------------
// L2 エージェントの活動観測
//
// 🚨 この機能は「出してはいけないものを出さない」ことが本体なので、
//    サーバ経路の端から端まで（記録ファイル → payload）で漏れないことを固定する。
//    抽出ロジック単体のテストは v0/transcript.test.mjs。
// ---------------------------------------------------------------------------

const AGENT_SECRET = 'SMOKE-TRANSCRIPT-SECRET-98765';

/**
 * 偽の `~/.claude/projects/` を作る。
 *
 * ⚠️ `os.homedir()` は POSIX で `HOME`、Windows で `USERPROFILE` を見るので、
 *    子プロセスの env を差し替えれば**オプションを増やさずに**隔離できる。
 *    検査用の経路をサーバに足さないための選択（`--layout-probe` を
 *    既定オフにしているのと同じ理屈）。
 */
async function fakeHome(cwdForRecords) {
    const home = await mkdtemp(join(tmpdir(), 'kjp-home-'));
    const dir = join(home, '.claude', 'projects', 'fake-project');
    await mkdir(dir, { recursive: true });
    const rows = [
        { type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'sm1', cwd: cwdForRecords,
            message: { content: [{ type: 'text', text: `発話 ${AGENT_SECRET}` }] } },
        { type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'sm1', cwd: cwdForRecords,
            message: { content: [{ type: 'thinking', thinking: `内心 ${AGENT_SECRET}` }] } },
        { type: 'user', timestamp: new Date().toISOString(), sessionId: 'sm1', cwd: cwdForRecords,
            toolUseResult: { stdout: AGENT_SECRET, stderr: '' },
            message: { content: [{ type: 'tool_result', content: `出力 ${AGENT_SECRET}` }] } },
        { type: 'file-history-snapshot', messageId: 'm1', snapshot: { 'shared.txt': AGENT_SECRET } },
        { type: 'last-prompt', lastPrompt: AGENT_SECRET, sessionId: 'sm1' },
        { type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'sm1', cwd: cwdForRecords,
            message: { content: [{ type: 'tool_use', name: 'Bash',
                input: { command: `echo ${AGENT_SECRET}`, description: AGENT_SECRET } }] } },
        { type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'sm1', cwd: cwdForRecords,
            message: { content: [{ type: 'tool_use', name: 'Edit',
                input: { file_path: join(cwdForRecords, 'shared.txt'), new_string: AGENT_SECRET } }] } },
    ];
    await writeFile(join(dir, 'sm1.jsonl'), `${rows.map(r => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    // ⚠️ .jsonl 以外は開かないことの確認材料
    await writeFile(join(dir, 'notes.txt'), AGENT_SECRET, 'utf8');
    return home;
}

/** 偽 home を持たせたサーバを起動して payload を取る */
async function stateWithFakeHome(extraArgs, home) {
    const child = spawn(process.execPath, [SERVER, '--repo', repo, '--port', '0', ...extraArgs], {
        shell: false, windowsHide: true,
        env: {
            ...process.env, ...isolatedConfig(),
            HOME: home, USERPROFILE: home,
        },
    });
    child.stdout.setEncoding('utf8');
    let banner = '';
    try {
        const url = await Promise.race([
            new Promise((res, rej) => {
                child.stdout.on('data', d => {
                    banner += d;
                    const m = banner.match(/http:\/\/127\.0\.0\.1:\d+/);
                    if (m) res(m[0]);
                });
                child.on('error', rej);
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`起動しなかった: ${banner}`)), 20000)),
        ]);
        const body = await (await fetch(`${url}/api/v0/state?fresh=1`)).text();
        return { body, json: JSON.parse(body), banner };
    } finally {
        child.kill();
    }
}

test('--watch-agents なしでは活動観測の経路が存在しない', async () => {
    const home = await fakeHome(repo);
    try {
        const { json, body } = await stateWithFakeHome([], home);
        assert.equal(json.agents, null, '経路が無いのに agents が入っている');
        assert.equal(json.agentsText, false);
        assert.ok(!body.includes(AGENT_SECRET));
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('🚨 --watch-agents: 活動は見えるが自由文は payload に1文字も入らない', async () => {
    const home = await fakeHome(repo);
    try {
        const { json, body, banner } = await stateWithFakeHome(['--watch-agents'], home);
        // 起動時に必ず告知する（いつリポジトリ外を読み始めたか分かるように）
        assert.match(banner, /活動観測 有効/);
        assert.match(banner, /リポジトリの外/);
        assert.ok(json.agents.length >= 1, 'agents が空');
        // worktree に紐づいていること（path と name が payload の worktree と一致する）
        const wtPaths = new Set(json.worktrees.map(w => w.path));
        for (const a of json.agents) {
            assert.ok(wtPaths.has(a.path), `agents の要素が worktree に紐づいていない: ${a.path}`);
        }
        const main = json.agents.find(a => (a.toolCounts?.Bash ?? 0) > 0);
        assert.ok(main, `活動が対応付けられていない: ${JSON.stringify(json.agents)}`);
        assert.equal(main.toolCounts.Bash, 1);
        assert.equal(main.toolCounts.Edit, 1);
        assert.equal(main.state, 'active');
        assert.ok(main.talk >= 1, '発話の件数は数える');
        assert.deepEqual(main.text, [], '本文は入れない');
        // 🚨 これが本体
        assert.ok(!body.includes(AGENT_SECRET),
            `自由文が payload に漏れている:\n${body.slice(0, 800)}`);
        // パスは出す（差分と同じ情報なので新しく漏れるものではない）
        assert.ok(main.recent.some(r => r.path === 'shared.txt'),
            `パスが出ていない: ${JSON.stringify(main.recent)}`);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('🚨 --allow-transcript-text でも T5（ツール結果・thinking）は出さない', async () => {
    const home = await fakeHome(repo);
    try {
        const { json, body, banner } = await stateWithFakeHome(['--allow-transcript-text'], home);
        assert.match(banner, /発話とコマンド行も出します/);
        assert.equal(json.agentsText, true);
        const main = json.agents.find(a => (a.toolCounts?.Bash ?? 0) > 0);
        // 出て良いのは text（発話1件）と Bash の command だけ = 2箇所
        const hits = body.split(AGENT_SECRET).length - 1;
        assert.equal(hits, 2, `漏れているものがある（期待 2 箇所、実際 ${hits}）`);
        assert.equal(main.text.length, 1);
        assert.equal(main.recent.find(r => r.tool === 'Bash').command, `echo ${AGENT_SECRET}`);
        // Edit の new_string は出さない
        assert.equal(main.recent.find(r => r.tool === 'Edit').command, undefined);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('活動観測は git の起動回数を増やさない（fs だけで読む）', async () => {
    const home = await fakeHome(repo);
    try {
        const off = await stateWithFakeHome([], home);
        const on = await stateWithFakeHome(['--watch-agents'], home);
        assert.equal(on.json.stats.gitSpawns, off.json.stats.gitSpawns,
            '活動観測で git の起動が増えている');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('記録の場所が無ければ理由を errors に出し、観測は無効にしない', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kjp-nohome-'));
    try {
        const { json } = await stateWithFakeHome(['--watch-agents'], home);
        assert.deepEqual(json.agents, []);
        const e = (json.errors ?? []).find(x => x.scope === 'agents');
        assert.ok(e, `理由が出ていない: ${JSON.stringify(json.errors)}`);
        assert.match(e.message, /読めません/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// L1 運用（毎日使うための足回り）
// ---------------------------------------------------------------------------

test('--repo にサブディレクトリを渡すとリポジトリのルートに正規化される', async () => {
    const sub = join(repo, 'sub-dir-for-test');
    await mkdir(sub, { recursive: true });
    const child = spawn(process.execPath, [SERVER, '--repo', sub, '--port', '0'],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    try {
        const { url, banner } = await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (m && /repo:/.test(buf)) { clearTimeout(t); res({ url: m[0], banner: buf }); }
            });
            child.on('error', rej);
        });
        assert.match(banner, /ルートに解決しました/, `正規化のログが無い: ${banner}`);
        const s = await (await fetch(`${url}/api/v0/state?fresh=1`)).json();
        // ⚠️ ルートに正規化しないと merge-tree が cwd 相対で `../shared.txt` を返し、
        //    isSafeRepoPath が弾いて UI から開けなくなる（レビュー指摘）
        for (const c of s.conflicts ?? []) {
            for (const f0 of c.files) {
                const f = typeof f0 === 'string' ? f0 : f0.path;
                assert.ok(!f.startsWith('..'), `衝突パスが cwd 相対になっている: ${f}`);
            }
        }
        assert.ok(s.worktrees.length >= 3, 'worktree が見えていない');
    } finally {
        child.kill();
        await rm(sub, { recursive: true, force: true });
    }
});

test('🔒 --token-file: 無ければ生成し、リポジトリの中は拒否する', async () => {
    const outside = join(repo, '..', `${repo.split(/[\\/]/).pop()}-tok`);
    // (1) 生成される
    let child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token-file', outside],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    try {
        const url = await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                const m = buf.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (m) { clearTimeout(t); res(m[0]); }
            });
            child.on('error', rej);
        });
        const { readFile } = await import('node:fs/promises');
        const tok = (await readFile(outside, 'utf8')).trim();
        assert.ok(tok.length >= 24, `短いトークンが書かれた: ${tok.length} 文字`);
        // そのトークンで実際に通る（提示した要求にだけ返る）
        const s = await (await fetch(`${url}/api/v0/session`, {
            headers: { 'x-kjp-token': tok },
        })).json();
        assert.equal(s.token, tok, 'ファイルのトークンが使われていない');
        // 提示しなければ返らない（Cookie 経由の取り戻しを塞いだ）
        const anon = await (await fetch(`${url}/api/v0/session`)).json();
        assert.equal(anon.token, null, '無認証でトークンを払い出している');
    } finally {
        child.kill();
    }
    // (2) 同じファイルなら再利用される（再起動でトークンが変わらない）
    const { readFile } = await import('node:fs/promises');
    const first = (await readFile(outside, 'utf8')).trim();
    child = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token-file', outside],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    child.stdout.setEncoding('utf8');
    try {
        await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('起動しなかった')), 15000);
            let buf = '';
            child.stdout.on('data', d => {
                buf += d;
                if (/http:\/\/127\.0\.0\.1:\d+/.test(buf)) { clearTimeout(t); res(); }
            });
            child.on('error', rej);
        });
        assert.equal((await readFile(outside, 'utf8')).trim(), first,
            '再起動でトークンが変わった（永続化できていない）');
    } finally {
        child.kill();
        await rm(outside, { force: true });
    }
    // (3) リポジトリの中は拒否する（コミットされるので）
    const inside = join(repo, 'tok');
    const bad = spawn(process.execPath,
        [SERVER, '--repo', repo, '--port', '0', '--allow-exec', '--token-file', inside],
        { shell: false, windowsHide: true, env: { ...process.env, ...isolatedConfig() } });
    bad.stderr.setEncoding('utf8');
    let err = '';
    bad.stderr.on('data', d => { err += d; });
    // ⚠️ 素の `await close` にしない。拒否されないと**サーバは正常に listen し続けて
    //    永久に閉じない** → node --test がハングし、SIGKILL されて要約が出ず、
    //    「smoke (0 pass, 0 fail)」だけが残って原因が消える（実際にそうなった）。
    //    失敗は失敗として観測できる形にする。
    const code = await Promise.race([
        new Promise(r => bad.on('close', r)),
        new Promise(r => setTimeout(() => r('timeout'), 15000)),
    ]);
    try {
        assert.equal(code, 1,
            `リポジトリ内のトークンファイルで起動してしまった（${code}）`
            + ' — containsPath が表記の違いで外れている可能性');
        assert.match(err, /リポジトリの中に置かないで/);
    } finally {
        bad.kill();
        await rm(inside, { force: true });
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
