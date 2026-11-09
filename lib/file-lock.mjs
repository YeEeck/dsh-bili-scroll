/**
 * lib/file-lock.mjs —— 一张带 pid + ts 的跨宿主锁（投递用）
 * ============================================================================
 * 工单 05：同一台机器可能同时开着桌面版与网页版两个 DSH，两边都装着这个插件；
 * 投递必须有锁，否则同一条会被发两遍（见 docs/adr/0001-collect-and-deliver.md）。
 *
 * 写法沿用 `run-lock.json` / `dm-lock.json`：文件里一行 `{ pid, ts }`，
 * 新鲜的（未过期）且那个进程还活着 = 别人正占着；过期或进程已经没了 = 可以清掉重写。
 *
 * 比老写法多做的两件事（都是为了让「同时点」尽量只发生一次）：
 *   ① 用 `open(..., 'wx')` **原子创建**：两个宿主同时看到"没锁"时，只有一个能建成；
 *   ② 清过期锁前再读一遍，确认它没被换掉（避免把别人刚写的新锁删了）。
 * 仍然沿用老规矩的兜底：**锁文件写不进去就照常干**（宁可偶尔重复一次，也不能因为锁坏了不投递），
 * 但会留一行日志。
 *
 * TTL 默认 3 分钟：一次发送的超时是 60 秒，够覆盖一个卡住的调用，又不至于让崩溃的宿主锁太久。
 * ============================================================================
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'

/**
 * 这个 pid 还活着吗。
 * @param {unknown} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try { process.kill(n, 0); return true } catch { return false }
}

/**
 * 建一把锁。返回的对象里：
 *   · `acquire()` → `{ ok: true, holder? }` 或 `{ ok: false, busy: true, holder }`
 *     （写不了锁时 `{ ok: true, unsafe: true }`，调用方照发并留日志）
 *   · `release()` → 只放自己的那张；别人的锁不碰
 *   · `read()`    → 当前锁的内容（排查用）
 *
 * @param {object} opts
 * @param {string} opts.file 锁文件路径
 * @param {number} [opts.ttlMs] 多久算过期（毫秒），默认 3 分钟
 * @param {number} [opts.pid] 自己的 pid（测试可注入）
 * @param {() => number} [opts.now] 时钟（测试可注入）
 * @param {(pid: number) => boolean} [opts.isAlive] 存活判断（测试可注入）
 * @param {(msg: string) => void} [opts.log] 日志
 * @returns {{file: string, acquire: Function, release: Function, read: Function}}
 */
export function createFileLock({
  file,
  ttlMs = 3 * 60_000,
  pid = process.pid,
  now = Date.now,
  isAlive = pidAlive,
  log = () => {},
} = {}) {
  if (!file) throw new TypeError('createFileLock 需要 file')

  const readRaw = () => {
    try { return readFileSync(file, 'utf8') } catch { return '' }
  }
  const parse = (raw) => {
    if (!raw) return null
    try {
      const j = JSON.parse(raw)
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null
    } catch { return null }
  }
  /** 这张锁还占着吗（新鲜 + 进程活着）；返回占着的那张，没有 = null */
  const holderOf = (raw) => {
    const lock = parse(raw)
    if (!lock) return null
    const ts = Number(lock.ts)
    if (!Number.isFinite(ts) || ts <= now() - ttlMs) return null
    return isAlive(Number(lock.pid)) ? lock : null
  }
  const create = () => {
    const fd = openSync(file, 'wx')
    try { writeSync(fd, JSON.stringify({ pid, ts: now() }), 'utf8') } finally { closeSync(fd) }
  }

  const acquire = () => {
    const holder = holderOf(readRaw())
    if (holder) return { ok: false, busy: true, holder }

    try {
      create()
      return { ok: true, holder: { pid, ts: now() } }
    } catch (e) {
      if (e?.code !== 'EEXIST') {
        // 权限 / 目录没了之类：照发，但留痕（和老锁同一个兜底）
        log('投递锁写不了（这一次照发）：' + String(e?.message ?? e))
        return { ok: true, unsafe: true }
      }
    }

    // EEXIST：可能是刚被另一个宿主抢到，也可能是一张过期/写坏的旧纸条
    const raw = readRaw()
    const nowHolder = holderOf(raw)
    if (nowHolder) return { ok: false, busy: true, holder: nowHolder }

    // 旧纸条：删之前再读一遍，确认没被换掉（否则可能删掉别人的新锁）
    try {
      if (readRaw() === raw) unlinkSync(file)
    } catch (e) {
      log('清过期投递锁失败（继续试）：' + String(e?.message ?? e))
    }
    try {
      create()
      return { ok: true }
    } catch (e) {
      if (e?.code === 'EEXIST') return { ok: false, busy: true, holder: parse(readRaw()) }
      log('投递锁写不了（这一次照发）：' + String(e?.message ?? e))
      return { ok: true, unsafe: true }
    }
  }

  const release = () => {
    const lock = parse(readRaw())
    // 只放自己的；别人的锁一个字都别碰
    if (lock && Number(lock.pid) !== Number(pid)) return false
    try { unlinkSync(file); return true } catch { return false }
  }

  return { file, acquire, release, read: () => parse(readRaw()) }
}
