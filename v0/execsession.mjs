// SPDX-License-Identifier: MIT
//
// 実行セッションの台帳。**クライアントが切断しても子プロセスを殺さない**代わりに、
// 寿命を明示的に管理する。
//
// なぜ必要か（#17）:
//   以前は「クライアント切断で子プロセスを必ず殺す」だった。プロセスを取り残さない
//   ための守りだが、**スマホでは致命的**。モバイルブラウザはタブを積極的に停止するので、
//   `npm test` を投げてタブを裏に回すとその瞬間に死ぬ。
//
// 🚨 **守りを緩めるので、代わりの制約をこのファイルに集める。**
//   経路に散らすと1つ忘れる（docs/auth-ordering.md と同じ理屈）。
//     1. 同時セッション数の上限（検査と予約は同じ同期ブロックで）
//     2. 絶対上限時間（--exec-timeout）
//     3. 切断後の猶予（既定 5分。再購読で延びる。keepAlive で無効化できる）
//     4. 終了後の保持期間（出力を読みに戻れるように。過ぎたら台帳から消す）
//     5. リングバッファの上限バイト（省略したら必ず件数を告知する）
//
// ⚠️ **掃除の判断は純関数 `sweep(now)` にしてある。** タイマーを使うと
//    「時間が経ったことにする」ためにテストが実時間を待つか、タイマーを
//    モックすることになる。状態と now から決定を返す形なら決定的にテストできる。
//    副作用（実際の kill）はサーバ側が行う。
//
// ⚠️ セッション id は序数にしない。払い出し順が変わったときに
//    「ヘッダは A なのに中身は B」になる（CLAUDE.md の UI 規則と同じ理由）。

import { randomBytes } from 'node:crypto';

export const DEFAULTS = {
    maxConcurrent: 8,
    bufferBytes: 256 * 1024,   // 1セッションあたりの再生用バッファ
    bufferRecords: 4000,       // 件数の上限（極端に小さい行が大量に来る場合）
    detachedGraceMs: 5 * 60 * 1000,
    retainMs: 10 * 60 * 1000,  // 終了後、台帳に残す時間
    // 🚨 標準入力の**総量**の上限（#26）。1回 64KB を縛っても、相手が読まなければ
    //    書いた分は親のメモリに無限に溜まる。「守りを緩めた代わりの制約」の表に
    //    **入力の総量だけが無かった**。しかも溜まっている間も ok:true を返すので
    //    画面から滞留が見えない。
    inputTotalBytes: 4 * 1024 * 1024,
    // 相手が読まずに溜まっている量の上限（backpressure を見る）
    inputPendingBytes: 1 * 1024 * 1024,
};

/** セッション id の形。HTTP から来た値はこれで検証してから使う。 */
export const ID_RE = /^[0-9a-f]{16}$/;
export function isSessionId(v) {
    return typeof v === 'string' && ID_RE.test(v);
}

/**
 * 追記専用のリングバッファ。
 *
 * ⚠️ 上限で捨てたら**件数を持っておく**。再購読したときに
 *    「間が抜けている」ことを告知できないと、利用者は出力が完全だと誤解する
 *    （CLAUDE.md「表示上限で省略したら必ず告知する」）。
 */
export class RingLog {
    constructor({ maxBytes = DEFAULTS.bufferBytes, maxRecords = DEFAULTS.bufferRecords } = {}) {
        this.maxBytes = maxBytes;
        this.maxRecords = maxRecords;
        this.records = [];
        this.bytes = 0;
        this.seq = 0;        // 直近に払い出した通番
        this.dropped = 0;    // 上限で捨てた件数（累計）
    }

    /**
     * レコードを追記し、通番を振って返す。
     *
     * ⚠️ **レコードそのものを電文の形にしておく**（`{n, t, d}`）。
     *    サイズなどの内部用フィールドを持たせると、そのまま JSON にして
     *    クライアントへ送ったときに漏れる。バイト数は捨てるときに数え直す。
     */
    push(t, d) {
        const rec = { n: ++this.seq, t };
        if (d !== undefined) rec.d = d;
        this.records.push(rec);
        this.bytes += RingLog.#size(rec);
        // ⚠️ 直近の1件は必ず残す（購読者に流すのがこのレコードなので）
        while (this.records.length > this.maxRecords
            || (this.bytes > this.maxBytes && this.records.length > 1)) {
            const gone = this.records.shift();
            this.bytes -= RingLog.#size(gone);
            this.dropped++;
        }
        return rec;
    }

    static #size(rec) {
        return typeof rec.d === 'string' ? Buffer.byteLength(rec.d, 'utf8') : 0;
    }

    /**
     * 通番 `from` より後のレコードを返す。
     * `missing` は「from の直後から連続していない」= 取りこぼした件数。
     */
    since(from) {
        const n = Number.isFinite(from) ? from : 0;
        const out = this.records.filter(r => r.n > n);
        const firstKept = this.records.length ? this.records[0].n : this.seq + 1;
        const missing = Math.max(0, firstKept - 1 - n);
        return { records: out, missing, seq: this.seq };
    }
}

/**
 * 1セッション。子プロセスそのものは持つが、殺し方は知らない
 * （プラットフォーム依存なのでサーバ側の killTree に任せる）。
 */
class Session {
    constructor({ id, worktree, argv, keepAlive, createdAt, limits }) {
        this.id = id;
        this.worktree = worktree;
        this.argv = argv;
        this.keepAlive = !!keepAlive;
        this.createdAt = createdAt;
        this.state = 'starting';      // starting → running → exiting → done
        this.child = null;
        this.exit = null;             // {code, signal, note, at}
        this.log = new RingLog(limits);
        this.subscribers = new Set(); // (rec) => void
        this.lastDetachedAt = null;   // 購読者ゼロになった時刻
        this.killRequested = null;    // 理由（監査用）
        this.inputBytes = 0;          // 標準入力に書いた総量（#26）
    }

    get running() {
        return this.state === 'starting' || this.state === 'running';
    }

    /** 画面と /api/v0/state に出す形。**自由文（argv）は出すが出力は出さない。** */
    describe(now) {
        return {
            id: this.id,
            worktree: this.worktree,
            argv: this.argv,
            state: this.state,
            keepAlive: this.keepAlive,
            createdAt: new Date(this.createdAt).toISOString(),
            ageMs: Math.max(0, now - this.createdAt),
            subscribers: this.subscribers.size,
            // 切断中なら、あと何秒で止まるか（黙って殺さない）
            detachedMs: this.lastDetachedAt === null ? null : Math.max(0, now - this.lastDetachedAt),
            seq: this.log.seq,
            dropped: this.log.dropped,
            inputBytes: this.inputBytes,
            // 相手が読まずに溜まっている量。ok:true だけ返して滞留を隠さない
            inputPending: this.child?.stdin?.writableLength ?? 0,
            exit: this.exit,
        };
    }
}

export class ExecRegistry {
    /**
     * @param {object} o
     * @param {number} o.execTimeoutMs 絶対上限。これは緩めない
     * @param {() => number} [o.now]
     */
    constructor({ execTimeoutMs, limits = {}, now = () => Date.now() } = {}) {
        this.limits = { ...DEFAULTS, ...limits };
        this.execTimeoutMs = execTimeoutMs;
        this.now = now;
        this.sessions = new Map();
        this.reserved = 0;   // create() で確保した枠（start 前も数える）
    }

    /**
     * 枠を取ってセッションを作る。上限に達していれば null。
     *
     * ⚠️ **検査と予約を同じ同期ブロックで行う。** 間に await を挟むと
     *    同時に来た要求が全部検査を通る（上限8に対して24本走ったのを実測されている）。
     *    だからこのメソッドは async にしない。
     */
    create({ worktree, argv, keepAlive = false }) {
        if (this.reserved >= this.limits.maxConcurrent) return null;
        this.reserved++;
        let id;
        do { id = randomBytes(8).toString('hex'); } while (this.sessions.has(id));
        const s = new Session({
            id, worktree, argv, keepAlive,
            createdAt: this.now(),
            limits: { maxBytes: this.limits.bufferBytes, maxRecords: this.limits.bufferRecords },
        });
        // 作った時点で購読者はゼロ。POST がすぐ購読するが、
        // 失敗しても猶予タイマーが効くように時刻を入れておく
        s.lastDetachedAt = this.now();
        this.sessions.set(id, s);
        return s;
    }

    get(id) {
        return isSessionId(id) ? (this.sessions.get(id) ?? null) : null;
    }

    /**
     * 子プロセスが起動できた。
     *
     * 🚨 **既に終わっているセッションを running に戻してはいけない。**
     *    `create()` から `spawn()` までの間に `await`（worktree の列挙）が入るので、
     *    その隙に sweep が猶予切れで殺したり、`/kill` が来たりする。
     *    無条件に `state='running'` にしていたので:
     *      - 「停止した」と告げた後にプロセスが走り続ける（嘘）
     *      - あとで exit したときに finish がもう一度通り、**枠が二重に返る**
     *        （上限8のはずが増える）
     *    （レビューで実測）
     *
     * @returns {boolean} 付けられたか。false なら呼び出し側が子を殺す
     */
    attachChild(s, child) {
        if (!s.running) return false;
        s.child = child;
        s.state = 'running';
        return true;
    }

    /**
     * 起動に失敗した / 終了した。**枠はここで返す。**
     *
     * ⚠️ 二重に呼ばれても1回しか効かないこと（`running` の判定）が要る。
     *    `exit` と上限タイマーと明示的な kill のどこから来ても同じ経路を通るため。
     */
    finish(s, { code = null, signal = null, note = null } = {}) {
        if (!s.running) return false;
        s.state = 'done';
        s.exit = { code, signal, note, at: new Date(this.now()).toISOString() };
        // 理由は exit の**前**に流す（後に出すと、閉じた後の行として見落とされる）
        if (note) this.emit(s, 'err', note);
        const rec = s.log.push('exit');
        rec.code = code;
        rec.signal = signal;
        this.reserved = Math.max(0, this.reserved - 1);
        this.#fanout(s, rec);
        return true;
    }

    /** 出力を1件積んで購読者に流す */
    emit(s, t, d) {
        this.#fanout(s, s.log.push(t, d));
    }

    #fanout(s, rec) {
        for (const fn of s.subscribers) {
            try { fn(rec); } catch { /* 購読者側の失敗でセッションを壊さない */ }
        }
    }

    /**
     * 購読する。`from` より後の分を先に再生してから追従する。
     * @returns {{unsubscribe: () => void, replay: {records: object[], missing: number}}}
     */
    subscribe(s, from, onRecord) {
        const replay = s.log.since(from);
        s.subscribers.add(onRecord);
        s.lastDetachedAt = null;
        return {
            replay,
            unsubscribe: () => {
                s.subscribers.delete(onRecord);
                if (!s.subscribers.size) s.lastDetachedAt = this.now();
            },
        };
    }

    /**
     * 掃除すべきものを返す**純粋な判断**。副作用は呼び出し側が行う。
     *
     * @returns {{kill: {session: Session, reason: string}[], evict: Session[]}}
     */
    sweep(now = this.now()) {
        const kill = [];
        const evict = [];
        for (const s of this.sessions.values()) {
            if (s.running) {
                // 🚨 **既に殺しに行っているものを二度候補にしない。**
                //    サーバは「殺してから終端する」順序（殺せたかを確かめてから
                //    `exit` を積む）なので、await の間セッションは running のまま。
                //    ここで弾かないと 1 秒後の tick が同じものを二重に殺しに行く。
                //    ⚠️ 殺せなかったときサーバは `killRequested` を null に戻すので、
                //    そのときは次の tick で**もう一度候補になる**（回復経路を残す）。
                if (s.killRequested) continue;
                // 1. 絶対上限。これは緩めない
                if (now - s.createdAt >= this.execTimeoutMs) {
                    kill.push({ session: s, reason: 'timeout' });
                    continue;
                }
                // 2. 切断後の猶予。keepAlive なら絶対上限だけで縛る
                if (!s.keepAlive && s.lastDetachedAt !== null
                    && now - s.lastDetachedAt >= this.limits.detachedGraceMs) {
                    kill.push({ session: s, reason: 'detached' });
                }
                continue;
            }
            // 3. 終了後の保持。出力を読みに戻れるように少し残してから消す。
            // 🚨 **購読者が残っていても、保持期間を過ぎたら消す。**
            //    以前は `!s.subscribers.size` を条件にしていたので、
            //    切断を検知できない購読者（詰まったソケット等）が1つ残るだけで
            //    **セッションが永久に台帳に残りメモリが溜まり続けた**（レビューで実測）。
            //    終了済みなので、これ以上待っても新しい出力は無い。
            const doneAt = s.exit ? Date.parse(s.exit.at) : s.createdAt;
            if (now - doneAt >= this.limits.retainMs) evict.push(s);
        }
        return { kill, evict };
    }

    remove(s) {
        // ⚠️ 購読者の参照も切る。残すと購読側のクロージャ（応答オブジェクト）が
        //    台帳から消えた後も生き続ける
        s.subscribers.clear();
        this.sessions.delete(s.id);
    }

    list(now = this.now()) {
        return [...this.sessions.values()]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(s => s.describe(now));
    }

    get running() {
        return [...this.sessions.values()].filter(s => s.running);
    }
}
