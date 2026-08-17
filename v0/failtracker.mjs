// SPDX-License-Identifier: MIT
//
// 🔒 **「唯一の壁」に必ず付ける3点セット（下限・記録・遅延）の実装。**
//
// 壁ごとに1つ作る。読み取り（`authed()` = 401）と実行・書き込み
// （`gateMutation()` = 403）は**別の capability の壁**なので、
// 数と遅延を共有してはいけない（読み取りの失敗で実行が絞られる／その逆になる）。
//
// 🚨 **なぜ module に出したか。** 読み取り側にだけ実装があり、実行側には
//    何も無かった（9回目のレビュー / #48。実測 8,955 req/s で当て放題・痕跡ゼロ）。
//    片方にしか無い道具は、もう片方で「無いことに気付かない」形の穴になる。
//    ここに1つ置いて2箇所から使う。
//
// 設計の要点（どれも実測から来ている。`docs/auth-ordering.md`）:
//   1. **遅延だけではレートを縛れない。** 遅延は1本ずつを遅くするだけで、
//      同じ相手の**同時本数**を縛らない。並列度を上げれば速さは戻る
//      （実測: 遅延がある状態で並列 1200 本 = 485 回/秒）。
//      → `makeInflightGate` で**比較の手前**に門を置く。
//   2. **記録は本数ではなく時間で縛る。** 認証前の要求は誰でも撃てるので、
//      1本1行だと外からログを無制限に伸ばせる（実測 400 本で 61 KB、
//      「50件ごとに1行」でも 7 秒で 503 KB）。
//   3. **一度通った値そのものは門の外に置く。** トンネル越しでは peer が
//      全部 127.0.0.1 なので、peer では攻撃と正規を区別できない
//      （実測: 門だけだと正規の鍵が 15 本中 0 本しか通らなくなった）。

import { createHash } from 'node:crypto';

/** 秘密は値そのものを持たない。突き合わせはハッシュで行う */
export const secretHash = v => createHash('sha256').update(String(v ?? ''), 'utf8').digest('hex');

/**
 * 連続失敗から遅延（ms）を決める。**純関数なのでテストで固定できる。**
 *
 * ⚠️ 指数にするが上限を付ける（無限に伸ばすとイベントループにタイマーが溜まり、
 *    正規の利用者も締め出す）。
 */
export function failDelay(count, { free = 3, maxMs = 2000, baseMs = 50 } = {}) {
    if (!Number.isFinite(count) || count <= free) return 0;
    return Math.min(maxMs, 2 ** (count - free) * baseMs);
}

/**
 * 🔒 **比較の手前に置く「同時本数」の門。**
 *
 * ⚠️ **順序が守りの本体。** 比較の後ろに置くと、429 が「その値は違った」の
 *    同義語になり、当てる速さは並列度で決まったままになる。
 */
export function makeInflightGate(max) {
    const inflight = new Map();   // peer -> 本数
    return {
        acquire(peer) {
            const n = inflight.get(peer) ?? 0;
            if (n >= max) return false;
            inflight.set(peer, n + 1);
            return true;
        },
        release(peer) {
            const n = (inflight.get(peer) ?? 1) - 1;
            if (n > 0) inflight.set(peer, n);
            else inflight.delete(peer);
        },
        /** 検査用。今掴まれている本数 */
        count(peer) { return inflight.get(peer) ?? 0; },
    };
}

/**
 * 🔒 **一度通った値そのものの控え**（混雑の門を素通りさせる相手を決める）。
 *
 * ⚠️ **認可の代わりではない。** 素通りするのは混雑の門だけで、
 *    値の照合は必ず通る（合っていなければ拒否される）。
 * ⚠️ 総当たり側がここに入る道は無い（**通った後にしか登録されない**）。
 */
export function makeGoodSet({ ttlMs = 60 * 60 * 1000, max = 64, now = () => Date.now() } = {}) {
    const seen = new Map();   // hash -> 最後に通った時刻
    return {
        has(values) {
            const t = now();
            for (const v of values ?? []) {
                const h = secretHash(v);
                const at = seen.get(h);
                if (at !== undefined && t - at < ttlMs) { seen.set(h, t); return true; }
            }
            return false;
        },
        /**
         * @param {string[]} values 合っていると**確認済み**の値だけを渡すこと。
         *   🚨 提示された値を全部覚えてはいけない（偽 Cookie を正しいトークンと
         *      一緒に送るだけで、その偽の値が門を素通りする鍵になる）。
         */
        remember(values) {
            const t = now();
            for (const v of values ?? []) seen.set(secretHash(v), t);
            if (seen.size > max) {
                for (const [k, at] of seen) {
                    if (seen.size <= max) break;
                    if (t - at >= ttlMs) seen.delete(k);
                }
                // それでも溢れるなら古い順に落とす（Map は挿入順）
                for (const k of seen.keys()) {
                    if (seen.size <= max) break;
                    seen.delete(k);
                }
            }
        },
        /**
         * 🔒 **控えを全部捨てる（トークンを回転したとき）。**
         *
         * 回転後も古い値のハッシュが残っていると、**古いトークンと古い派生秘密が
         * 混雑の門だけは素通りできる**（比較は必ず走るので認可は破れないが、
         * 総当たりの絞りが緩む状態を残さない）。
         */
        forget() { seen.clear(); },
        get size() { return seen.size; },
    };
}

/**
 * 壁ごとの失敗の台帳。
 *
 * @param {object} o
 * @param {(rec: object) => Promise<void>} o.audit 監査に1行書く
 * @param {string} o.event 個別行のイベント名
 * @param {string} o.summaryEvent 集約行のイベント名
 */
export function makeFailTracker({
    audit, event, summaryEvent,
    windowMs = 5 * 60 * 1000,
    logFirst = 3,
    summaryMs = 10 * 1000,
    maxPeers = 256,
    delayOpts = {},
    now = () => Date.now(),
    sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
    const peers = new Map();   // peer -> { count, firstAt, logged, shed, reported, reportedAt }

    /** 窓の中の記録を取り出す（窓が変わっていたら前の窓を締めてから作り直す） */
    const record = (peer, t) => {
        const cur = peers.get(peer);
        if (cur && t - cur.firstAt < windowMs) return cur;
        if (cur) flush(peer, cur, 'window-rolled').catch(() => {});
        const rec = { count: 0, firstAt: t, logged: 0, shed: 0, reported: 0, reportedAt: 0 };
        peers.set(peer, rec);
        // 台帳が無限に増えないよう古いものを落とす
        if (peers.size > maxPeers) {
            for (const [k, v] of peers) {
                if (k !== peer && t - v.firstAt >= windowMs) peers.delete(k);
            }
        }
        return rec;
    };

    /**
     * 🚨 **記録を捨てるなら「捨てた」と分かる形にする。**
     *    個別行は窓の先頭 `logFirst` 本だけ。残りは件数だけの集約行にする。
     */
    async function flush(peer, rec, why) {
        const dropped = (rec.count - rec.logged) + rec.shed;
        if (dropped <= rec.reported) return;
        rec.reported = dropped;
        rec.reportedAt = now();
        await audit({
            event: summaryEvent, peer, why,
            // 比較して外れた本数と、比較せずに切った本数を分けて残す
            attempts: rec.count, logged: rec.logged,
            suppressed: rec.count - rec.logged, shed: rec.shed,
            windowStartedAt: new Date(rec.firstAt).toISOString(),
        }).catch(() => { /* 監査に書けなくても応答は返す */ });
    }

    /** 集約行を出す条件（最初の1件と、そこから一定時間ごと） */
    const summaryDue = (rec, t) => {
        const dropped = (rec.count - rec.logged) + rec.shed;
        if (dropped <= rec.reported) return false;
        return rec.reported === 0 || t - rec.reportedAt >= summaryMs;
    };

    return {
        /** 比較せずに切った（429）ことを数える。**ここでは追記しない**（増幅を断つため） */
        shed(peer) {
            const t = now();
            const rec = record(peer, t);
            rec.shed++;
            if (summaryDue(rec, t)) flush(peer, rec, 'shed').catch(() => {});
            return rec;
        },
        /**
         * 比較して外れたことを数え、**遅延してから**返す。
         * 🚨 遅延の間も枠（inflight）を握っていること。これが「並列でも縛れる」の本体。
         */
        async note(peer, extra = {}) {
            const t = now();
            const rec = record(peer, t);
            rec.count++;
            // 🔒 **本文は残さない**（トークンの候補を記録に書かない）
            if (rec.logged < logFirst) {
                rec.logged++;
                await audit({ event, peer, ...extra, count: rec.count })
                    .catch(() => { /* 監査に書けなくても応答は返す */ });
            } else if (summaryDue(rec, t)) {
                await flush(peer, rec, 'threshold');
            }
            const delay = failDelay(rec.count, delayOpts);
            if (delay > 0) await sleep(delay);
            return rec.count;
        },
        /** 終了時に集約待ちを落とさない（「何本外されたか」を残して終わる） */
        flushAll(why) {
            const out = [];
            for (const [peer, rec] of peers) out.push(flush(peer, rec, why));
            return Promise.allSettled(out);
        },
        /** 検査用 */
        peek(peer) { return peers.get(peer) ?? null; },
        get size() { return peers.size; },
    };
}
