// TMTN 多用户云端网关
// 每位访客（浏览器 cookie）= 一个独立的 TMTN 实盘进程 + 独立的币安 Agentic Wallet 会话目录 + 独立的数据目录。
// TMTN 进程只监听 127.0.0.1 的内部端口，外部只能经过本网关、凭自己的 cookie 访问自己的进程。
// 本网关和 TMTN 都不接触私钥 / 助记词：签名在币安那边完成，登录在币安 App 里确认。
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import httpProxy from 'http-proxy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_ROOT = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const USERS = path.join(DATA_ROOT, 'users');
const MAX_PROCS = Number(process.env.MAX_PROCS || 5);          // 同时运行的 TMTN 进程上限（每个约 120MB 内存）
const MAX_USERS = Number(process.env.MAX_USERS || 200);        // 会话目录上限
const IDLE_MIN = Number(process.env.IDLE_MIN || 30);           // 没打开页面多少分钟后停掉进程（开了「离开后保持运行」的除外）
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);    // 多少天没来访就登出并删除会话
const ACCESS_CODE = process.env.ACCESS_CODE || '';             // 设了就要先输入邀请码才能用
const BAW_BIN = path.join(__dirname, 'node_modules', '.bin', 'baw');
const TMTN = path.join(__dirname, 'tmtn', 'server.js');
const OPENFOUR = path.join(__dirname, 'tmtn', '.agents', 'skills', 'binance-agentic-wallet', 'scripts', 'agent-id-exclusive-token-launches.mjs');
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
fs.mkdirSync(USERS, { recursive: true, mode: 0o700 });

// 传给 TMTN 子进程的共享配置（RPC、上限等）；会话相关的变量由网关按用户设置
const SHARED_ENV = ['PATH', 'NODE_ENV', 'TZ', 'NODEREAL_RPC', 'RPC_URL', 'FOUR_LOG_RPC', 'FOUR_LOG_STEP', 'NAME_RPC', 'BSC_TESTNET_RPC', 'BSC_WSS', 'FOUR_MANAGER',
  'BINANCE_CHAIN_ID', 'BAW_SLIPPAGE_UNIT', 'WALLET_LABEL', 'PREAPPROVE'];

// ---------- 会话存储 ----------
const hashSid = (sid) => crypto.createHash('sha256').update(sid).digest('hex').slice(0, 40);
const udir = (h) => path.join(USERS, h);
const readMeta = (h) => { try { return JSON.parse(fs.readFileSync(path.join(udir(h), 'meta.json'), 'utf8')); } catch { return null; } };
const writeMeta = (h, m) => fs.writeFileSync(path.join(udir(h), 'meta.json'), JSON.stringify(m, null, 1), { mode: 0o600 });
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const setCookie = (req, res, name, val, maxAge) => res.setHeader('Set-Cookie', `${name}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`);

function getSession(req) {
  const sid = cookies(req).tmtn_sid;
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null;
  const h = hashSid(sid), m = readMeta(h);
  return m ? { h, m } : null;
}
function newSession(req, res) {
  if (fs.readdirSync(USERS).length >= MAX_USERS) return null;
  const sid = crypto.randomBytes(32).toString('hex'), h = hashSid(sid);
  fs.mkdirSync(path.join(udir(h), 'baw'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(udir(h), 'data'), { recursive: true, mode: 0o700 });
  const m = { instanceId: crypto.randomUUID(), created: Date.now(), lastSeen: Date.now(), autoTransferTo: '', keepAlive: false };
  writeMeta(h, m);
  setCookie(req, res, 'tmtn_sid', sid, SESSION_DAYS * 86400);
  return { h, m };
}
function userEnv(s) {
  const env = {};
  for (const k of SHARED_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    HOME: udir(s.h),
    BINANCE_BAW_DIR: path.join(udir(s.h), 'baw'),
    BINANCE_INSTANCE_ID: s.m.instanceId,
    TMTN_DATA_DIR: path.join(udir(s.h), 'data'),
    BAW_BIN, OPENFOUR_SCRIPT: OPENFOUR,
    MODE: 'live',
    LIVE_TRADE: process.env.LIVE_TRADE ?? '1',
    MAX_TRADE_BNB: process.env.MAX_TRADE_BNB ?? '0.5',
    FOUR_BACKFILL_BLOCKS: process.env.FOUR_BACKFILL_BLOCKS ?? (process.env.NODEREAL_RPC ? '150000' : '20000'),
    AUTO_TRANSFER_TO: ADDR_RE.test(s.m.autoTransferTo || '') ? s.m.autoTransferTo : '',
  });
  return env;
}

// ---------- 子进程管理 ----------
const procs = new Map(); // h -> {child, port, ready, lastHit, startedAt, log}
// 向系统要一个空闲端口（避免和其他程序撞端口）
const freePort = () => new Promise((resolve, reject) => { const srv = net.createServer(); srv.unref(); srv.on('error', reject); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });

function stopProc(h, why) {
  const p = procs.get(h); if (!p) return;
  procs.delete(h);
  if (p.child) { try { p.child.kill('SIGTERM'); setTimeout(() => { try { p.child.kill('SIGKILL'); } catch {} }, 5000); } catch {} }
  console.log(`[gw] stop ${h.slice(0, 8)} (${why})`);
}

function startProc(s) {
  const p = { child: null, port: 0, ready: false, lastHit: Date.now(), startedAt: Date.now(), ws: 0 };
  procs.set(s.h, p);
  freePort().then((port) => { if (procs.get(s.h) === p) spawnChild(s, p, port); }).catch((e) => { console.error('[gw] port', e.message); procs.delete(s.h); });
  return p;
}

function spawnChild(s, p, port) {
  const logFile = path.join(udir(s.h), 'tmtn.log');
  try { if (fs.statSync(logFile).size > 5e6) fs.truncateSync(logFile, 0); } catch {}
  const fd = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, ['--max-old-space-size=192', TMTN], { cwd: path.dirname(TMTN), env: { ...userEnv(s), PORT: String(port) }, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  Object.assign(p, { child, port, logFile });
  const tail = () => { try { return fs.readFileSync(logFile, 'utf8').slice(-400); } catch { return ''; } };
  // 就绪检测：端口能返回 /api/state 就算启动完成
  const probe = setInterval(() => {
    if (p.ready || child.exitCode !== null || procs.get(s.h) !== p) return clearInterval(probe);
    if (Date.now() - p.startedAt > 180e3) { clearInterval(probe); console.log(`[gw] ${s.h.slice(0, 8)} 启动超时: ${tail()}`); stopProc(s.h, '启动超时'); return; }
    const r = http.get({ host: '127.0.0.1', port, path: '/api/state', timeout: 3000 }, (x) => { x.resume(); if (x.statusCode < 500) { p.ready = true; clearInterval(probe); console.log(`[gw] ${s.h.slice(0, 8)} ready in ${Math.round((Date.now() - p.startedAt) / 1000)}s`); } });
    r.on('error', () => {}); r.on('timeout', () => r.destroy());
  }, 1500);
  child.on('exit', (code) => { if (procs.get(s.h) === p) { procs.delete(s.h); console.log(`[gw] ${s.h.slice(0, 8)} exited ${code}: ${tail()}`); } });
  procs.set(s.h, p);
  console.log(`[gw] start ${s.h.slice(0, 8)} on :${port}`);
}

// 拿到（必要时启动）这个访客的进程；满员时先停掉最久没用的、没开保持运行的进程
function ensureProc(s) {
  let p = procs.get(s.h);
  if (p) return p;
  if (procs.size >= MAX_PROCS) {
    const victims = [...procs.entries()].filter(([h]) => !(readMeta(h) || {}).keepAlive).sort((a, b) => a[1].lastHit - b[1].lastHit);
    const v = victims.find(([, q]) => Date.now() - q.lastHit > 5 * 60e3);
    if (!v) return null;
    stopProc(v[0], '为新访客腾位置');
  }
  return startProc(s);
}

// 定时：停掉闲置进程；删除过期会话（先在 baw 里登出）
setInterval(() => {
  for (const [h, p] of procs) {
    const m = readMeta(h) || {};
    if (!m.keepAlive && Date.now() - p.lastHit > IDLE_MIN * 60e3) stopProc(h, `闲置 ${IDLE_MIN} 分钟`);
  }
}, 60e3);
setInterval(() => {
  for (const h of fs.readdirSync(USERS)) {
    const m = readMeta(h);
    if (m && (m.keepAlive || Date.now() - m.lastSeen < SESSION_DAYS * 86400e3)) continue;
    destroy({ h, m: m || {} }, '会话过期');
  }
}, 3600e3);

function destroy(s, why) {
  stopProc(s.h, why);
  return new Promise((resolve) => {
    if (!s.m.instanceId) { fs.rmSync(udir(s.h), { recursive: true, force: true }); return resolve(); }
    execFile(BAW_BIN, ['auth', 'signout', '--json'], { env: userEnv(s), timeout: 20000 }, () => { fs.rmSync(udir(s.h), { recursive: true, force: true }); resolve(); });
  });
}

// ---------- 小页面 ----------
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body, refresh) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${esc(title)}</title>
<style>body{background:#0b0e13;color:#e6edf3;font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
.c{max-width:460px;width:100%;background:#11151b;border:1px solid #2b3240;border-radius:12px;padding:22px}h1{font-size:18px;margin:0 0 10px}.mu{color:#8b949e;font-size:13px}.warn{color:#f0b90b;font-size:13px}
input{width:100%;box-sizing:border-box;background:#0b0e13;border:1px solid #2b3240;color:#e6edf3;border-radius:8px;padding:9px;font:14px ui-monospace,monospace;margin:6px 0}
button,a.b{display:inline-block;background:#f0b90b;color:#111;border:0;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer;text-decoration:none;margin:6px 6px 0 0}button.g{background:#1a202a;color:#e6edf3;border:1px solid #2b3240}button.r{background:#da3633;color:#fff}
label{display:flex;gap:8px;align-items:center;margin:10px 0}hr{border:0;border-top:1px solid #2b3240;margin:16px 0}</style></head><body><div class="c">${body}</div></body></html>`;

function send(res, code, html, type = 'text/html; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(html);
}
const wantsHtml = (req) => req.method === 'GET' && (req.headers.accept || '').includes('text/html');
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 8192) req.destroy(); }); req.on('end', () => r(Object.fromEntries(new URLSearchParams(b)))); }); }

function panel(s) {
  const p = procs.get(s.h);
  return page('我的会话', `<h1>☁ 我的 TMTN 会话</h1>
  <p class="mu">进程：${p ? (p.ready ? '运行中' : '启动中') : '未运行'} · 创建于 ${new Date(s.m.created).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
  <form method="post" action="/_gw/settings">
    <b>自动转出目标地址</b>
    <p class="mu">TMTN 的「领取后 / 发射后自动转出」需要它。只填你自己的地址；留空 = 三个自动转出开关都打不开。保存后会重启你的进程。</p>
    <input name="autoTransferTo" placeholder="0x…（可留空）" value="${esc(s.m.autoTransferTo)}">
    <label><input type="checkbox" name="keepAlive" value="1" ${s.m.keepAlive ? 'checked' : ''} style="width:auto"> 离开页面后保持运行（自动领取 / 自动转出需要）</label>
    <p class="mu">不勾选时，${IDLE_MIN} 分钟没打开页面会停掉进程，自动领取 / 转出也会停。钱包登录不受影响。</p>
    <button>保存</button><a class="b" href="/">回到终端</a>
  </form><hr>
  <form method="post" action="/_gw/restart"><button class="g">重启我的进程</button></form>
  <form method="post" action="/_gw/destroy" onsubmit="return confirm('会在币安里登出，并删除你在服务器上的全部数据（持仓记录、设置、收藏）。确定？')"><button class="r">登出并删除我的会话</button></form>
  <p class="warn">本服务不会索要私钥或助记词。任何页面向你要这些，立即关闭。</p>`);
}

// ---------- 反向代理 ----------
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false, proxyTimeout: 180000 });
proxy.on('error', (err, req, res) => {
  if (res && res.writeHead && !res.headersSent) send(res, 502, page('稍等', '<h1>终端正在启动…</h1><p class="mu">几秒后自动刷新。</p>', 3));
  else try { res.destroy(); } catch {}
});

const hits = new Map();
function limited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), now = Date.now();
  const b = hits.get(ip) || { n: 0, t: now }; if (now - b.t > 60e3) { b.n = 0; b.t = now; } b.n++; hits.set(ip, b);
  return b.n > 600;
}
setInterval(() => hits.clear(), 10 * 60e3);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (limited(req)) return send(res, 429, '请求过于频繁', 'text/plain; charset=utf-8');

  // 邀请码
  if (ACCESS_CODE && cookies(req).tmtn_ac !== crypto.createHash('sha256').update(ACCESS_CODE).digest('hex')) {
    if (url.pathname === '/_gw/code' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.code === ACCESS_CODE) { setCookie(req, res, 'tmtn_ac', crypto.createHash('sha256').update(ACCESS_CODE).digest('hex'), 30 * 86400); res.writeHead(303, { Location: '/' }); return res.end(); }
    }
    if (!wantsHtml(req) && url.pathname !== '/') return send(res, 401, '{"error":"需要邀请码"}', 'application/json');
    return send(res, 401, page('邀请码', `<h1>TMTN 云端终端</h1><form method="post" action="/_gw/code"><input name="code" placeholder="邀请码" autofocus><button>进入</button></form>`));
  }

  let s = getSession(req);
  if (!s && req.method === 'POST' && url.pathname === '/_gw/start') {
    const b = await readBody(req);
    if (b.agree !== '1') { res.writeHead(303, { Location: '/' }); return res.end(); }
    if (!newSession(req, res)) return send(res, 503, page('满员', '<h1>服务器会话已满</h1><p class="mu">请稍后再来。</p>'));
    res.writeHead(303, { Location: '/' }); return res.end();
  }
  if (url.pathname.startsWith('/_gw/')) {
    if (!s) { res.writeHead(303, { Location: '/' }); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/_gw/') return send(res, 200, panel(s));
    if (req.method === 'POST' && url.pathname === '/_gw/settings') {
      const b = await readBody(req), to = String(b.autoTransferTo || '').trim();
      if (to && !ADDR_RE.test(to)) return send(res, 400, page('格式错误', '<h1>地址格式不对</h1><p>需要 0x 开头的 40 位地址。</p><a class="b" href="/_gw/">返回</a>'));
      s.m.autoTransferTo = to; s.m.keepAlive = b.keepAlive === '1'; writeMeta(s.h, s.m);
      stopProc(s.h, '设置已更新'); res.writeHead(303, { Location: '/' }); return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/_gw/restart') { stopProc(s.h, '用户重启'); res.writeHead(303, { Location: '/' }); return res.end(); }
    if (req.method === 'POST' && url.pathname === '/_gw/destroy') {
      await destroy(s, '用户删除'); setCookie(req, res, 'tmtn_sid', '', 0);
      return send(res, 200, page('已删除', '<h1>已登出并删除</h1><p class="mu">你的币安钱包会话和服务器上的数据都已清除。</p><a class="b" href="/">重新开始</a>'));
    }
    return send(res, 404, 'not found', 'text/plain');
  }

  if (!s) {
    if (!wantsHtml(req)) return send(res, 401, '{"error":"没有会话，请先打开首页"}', 'application/json');
    return send(res, 200, page('TMTN 云端终端', `<h1>TMTN · BSC Agent 内盘快速买卖终端</h1>
      <p>进入后会为你单独启动一个终端，用你自己的<b>币安 Agentic 钱包</b>登录（在币安 App 里核对配对码并确认）。</p>
      <p class="warn">这是会动用真实资金的开源软件（TMTN，MIT 协议，未经审计）。链上交易不可撤销，meme 币可能归零。不构成投资建议，后果自负。</p>
      <p class="mu">本站不会索要私钥或助记词。你的钱包会话、设置、持仓记录保存在服务器上你自己的目录里，随时可在「我的会话」里一键登出并删除。</p>
      <form method="post" action="/_gw/start"><label><input type="checkbox" name="agree" value="1" required style="width:auto"> 我已了解上述风险</label><button>进入终端</button></form>`));
  }
  s.m.lastSeen = Date.now(); if (Math.random() < 0.05 || Date.now() - (s.m._w || 0) > 60e3) { s.m._w = Date.now(); writeMeta(s.h, s.m); }
  const p = ensureProc(s);
  if (!p) return wantsHtml(req) ? send(res, 503, page('满员', `<h1>现在人有点多</h1><p class="mu">同时最多运行 ${MAX_PROCS} 个终端。1 分钟后自动重试。</p>`, 60)) : send(res, 503, '{"error":"服务器满员"}', 'application/json');
  p.lastHit = Date.now();
  if (!p.ready) {
    if (wantsHtml(req)) return send(res, 200, page('启动中', '<h1>正在启动你的专属终端…</h1><p class="mu">第一次大约 10–30 秒，会自动刷新。</p>', 3));
    return send(res, 503, '{"error":"终端启动中"}', 'application/json');
  }
  proxy.web(req, res, { target: `http://127.0.0.1:${p.port}` });
});

server.on('upgrade', (req, socket, head) => {
  const s = getSession(req); const p = s && procs.get(s.h);
  if (!p || !p.ready) return socket.destroy();
  p.lastHit = Date.now(); p.ws = (p.ws || 0) + 1;
  socket.once('close', () => { p.ws--; p.lastHit = Date.now(); });
  proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${p.port}` });
});
// 有 WebSocket 连着就算在用（页面开着）
setInterval(() => { for (const p of procs.values()) if (p.ws > 0) p.lastHit = Date.now(); }, 30e3);

const shutdown = () => { for (const h of [...procs.keys()]) stopProc(h, '网关关闭'); setTimeout(() => process.exit(0), 1500); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

// 重启后：恢复「保持运行」的会话
for (const h of fs.readdirSync(USERS)) { const m = readMeta(h); if (m && m.keepAlive && procs.size < MAX_PROCS) startProc({ h, m }); }

server.listen(PORT, () => console.log(`[gw] TMTN cloud gateway :${PORT} data=${DATA_ROOT} maxProcs=${MAX_PROCS}`));
