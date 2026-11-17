// RP City — servidor online (sem dependências). Uso: node server.js
// Coloque o rp-city.html na mesma pasta: abrindo o endereço do servidor no navegador, o jogo já carrega.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const ADM_ID = process.env.ADM_ID || '1';      // ID do dono (ADM). Entre primeiro com ele.
const ADM_PASS = process.env.ADM_PASS || '';   // se definida, só quem sabe esta senha entra como ADM (protege o ID do dono)
const RESERVED = new Set(['2']);                  // ID 2 = IA do jogo

// ---------- banco simples em arquivo ----------
let db = { accounts: {}, sessions: {}, bans: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
let dirty = false;
const save = () => { dirty = true; };
const flush = () => { if (!dirty) return; dirty = false; try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); } catch (e) { console.log('erro ao salvar:', e.message); } };
setInterval(flush, 5000);
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });

// ---------- memória (não precisa persistir) ----------
const presence = new Map();   // id -> {x,z,h,t,name}
const missions = new Map();   // id -> {job,x,z,sx,sz,t,n}
const chat = [];              // {id,name,text,t}
const chatRate = new Map();   // id -> [timestamps]
const loginRate = new Map();  // ip -> [timestamps]
let lastChatT = 0;

// ---------- missões (espelham as do jogo) ----------
const CELL = 76, rc = k => (k + 0.5) * CELL;
const JOBS = { taxi: { pay: 180, d: [150, 350] }, ent: { pay: 140, d: [100, 250] }, cam: { pay: 320, d: [400, 800] }, med: { pay: 240, d: [200, 450] } };
const POIS = [
  ['Praça do Centro', 4 * CELL, 4 * CELL], ['Porto', rc(6), rc(6)], ['Praia Norte', rc(0), rc(0)], ['Alto da Serra', rc(7), rc(0)],
  ['Terminal Rodoviário', rc(11), rc(4)], ['Zona Industrial', rc(16), rc(9)], ['Bairro Operário', rc(9), rc(14)],
  ['Distrito Financeiro', rc(20), rc(20)], ['Mirante', rc(4), rc(21)]
];
const today = () => new Date().toISOString().slice(0, 10);

// ---------- utilidades ----------
const num = (v, d = 0) => Number.isFinite(+v) ? +v : d;
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>&]/g, '').slice(0, n);
const hash = (pass, salt) => crypto.pbkdf2Sync(pass, salt, 60000, 32, 'sha256').toString('hex');
const isAdm = id => id === ADM_ID;
function banInfo(id) {
  const b = db.bans[id]; if (!b) return null;
  if (b.until && b.until <= Date.now()) { delete db.bans[id]; save(); return null; }
  return { reason: b.reason || 'não informado', until: b.until || 0 };
}
function ranking() {
  return Object.entries(db.accounts).filter(([, a]) => Number.isFinite(a.money))
    .sort((a, b) => b[1].money - a[1].money).slice(0, 10).map(([id, a]) => ({ id, name: a.name || 'Jogador', money: Math.round(a.money) }));
}
function authed(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return null;
  const s = db.sessions[m[1]]; if (!s) return null;
  if (s.exp < Date.now()) { delete db.sessions[m[1]]; save(); return null; }
  const acc = db.accounts[s.id]; if (!acc) return null;
  return { id: s.id, acc };
}
function limited(map, key, max, ms) {
  const now = Date.now(), a = (map.get(key) || []).filter(t => now - t < ms);
  if (a.length >= max) { map.set(key, a); return true; }
  a.push(now); map.set(key, a); return false;
}

// ---------- rotas ----------
const routes = {
  async '/api/login'(req, body, ctx) {
    if (limited(loginRate, ctx.ip, 12, 60000)) return [429, { error: 'Muitas tentativas. Espere 1 minuto.' }];
    const id = String(body.id || '').trim(), pass = String(body.pass || '');
    if (!/^\d{1,6}$/.test(id)) return [400, { error: 'ID inválido (1 a 6 números).' }];
    if (RESERVED.has(id)) return [403, { error: 'Esse ID é reservado.' }];
    if (pass.length < 6 || pass.length > 100) return [400, { error: 'Senha com no mínimo 6 caracteres.' }];
    if (ADM_PASS && id === ADM_ID && pass !== ADM_PASS) return [403, { error: 'Senha incorreta.' }];
    let acc = db.accounts[id];
    if (!acc) {  // primeiro acesso: cria a conta
      const salt = crypto.randomBytes(16).toString('hex');
      acc = db.accounts[id] = { salt, hash: hash(pass, salt), name: 'Jogador', money: null, credit: 0, done: 0, day: today(), paid: false, flags: 0, created: Date.now() };
    } else if (hash(pass, acc.salt) !== acc.hash) return [403, { error: 'Senha incorreta.' }];
    const b = banInfo(id); if (b) return [403, { banned: b, error: 'Conta banida.' }];
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { id, exp: Date.now() + 30 * 86400000 };
    save();
    const out = { token, adm: isAdm(id), ranking: ranking() };
    if (acc.save && acc.save.rp) out.save = JSON.stringify(acc.save);
    return [200, out];
  },

  async '/api/sync'(req, body, ctx) {
    const { id, acc } = ctx.user;
    const b = banInfo(id); if (b) return [200, { banned: b }];
    if (typeof body.name === 'string') acc.name = clean(body.name, 24) || 'Jogador';
    if (body.money !== undefined && Number.isFinite(+body.money)) {
      const m = Math.max(0, Math.min(1e12, Math.round(+body.money)));
      if (acc.money !== null && m - acc.money > 5000000 && !isAdm(id)) acc.flags++;   // salto suspeito (só avisa)
      acc.money = m;
    }
    if (acc.money === null) acc.money = 500;
    if (acc.credit) { acc.money += acc.credit; acc.credit = 0; }                       // transferências recebidas
    if (body.save && typeof body.save === 'object') {
      const s = acc.save || (acc.save = {});
      for (const k of ['rp', 'extra']) if (typeof body.save[k] === 'string' && body.save[k].length < 300000) s[k] = body.save[k];
    }
    save();
    return [200, { money: acc.money, adm: isAdm(id), ranking: ranking(), flags: acc.flags || 0 }];
  },

  async '/api/mission/start'(req, body, ctx) {
    const { id } = ctx.user, j = JOBS[body.job];
    if (!j) return [400, { error: 'trabalho inválido' }];
    const sx = num(body.x), sz = num(body.z), last = missions.get(id);
    const D = p => Math.hypot(sx - p[1], sz - p[2]);
    let c = POIS.filter(p => D(p) >= 60 && D(p) <= j.d[1] * 1.6 && !(last && last.n === p[0]));
    if (!c.length) c = POIS.filter(p => D(p) >= 60 && !(last && last.n === p[0]));
    const p = c[Math.floor(Math.random() * c.length)] || POIS[0];
    const m = { job: body.job, x: Math.round(p[1]), z: Math.round(p[2]), sx, sz, t: Date.now(), n: p[0] };
    missions.set(id, m);
    return [200, { x: m.x, z: m.z }];
  },

  async '/api/mission/complete'(req, body, ctx) {
    const { id, acc } = ctx.user, m = missions.get(id);
    if (!m) return [200, { error: 'sem missão' }];
    if (Math.hypot(num(body.x) - m.x, num(body.z) - m.z) > 40) return [200, { error: 'longe do destino' }];
    if (Date.now() - m.t < 4000) return [200, { error: 'rápido demais' }];
    if (body.money !== undefined && Number.isFinite(+body.money)) acc.money = Math.max(0, Math.round(+body.money));
    if (acc.money === null) acc.money = 500;
    if (acc.credit) { acc.money += acc.credit; acc.credit = 0; }
    if (acc.day !== today()) { acc.day = today(); acc.done = 0; acc.paid = false; }
    const d = Math.hypot(m.sx - m.x, m.sz - m.z);
    const pay = Math.round((JOBS[m.job].pay + d * 0.5) * (body.hungry ? 0.5 : 1));
    acc.money += pay; acc.done++;
    let bonus = 0;
    if (acc.done >= 3 && !acc.paid) { acc.paid = true; bonus = 650; acc.money += bonus; }
    missions.delete(id); save();
    return [200, { money: acc.money, done: acc.done, pay, bonus }];
  },

  async '/api/presence'(req, body, ctx) {
    const { id, acc } = ctx.user, now = Date.now();
    presence.set(id, { x: num(body.x), z: num(body.z), h: num(body.h), t: now, name: acc.name || 'Jogador' });
    const players = [];
    for (const [pid, p] of presence) {
      if (now - p.t > 10000) { presence.delete(pid); continue; }
      if (pid !== id && players.length < 60) players.push({ id: pid, name: p.name, x: p.x, z: p.z, h: p.h });
    }
    return [200, { players }];
  },

  async '/api/chat'(req, body, ctx) {
    const { id, acc } = ctx.user, text = String(body.text == null ? '' : body.text).trim();
    if (!text) return [200, { error: 'mensagem vazia' }];
    if (text.length > 900) return [200, { error: 'mensagem muito longa' }];
    if (banInfo(id)) return [200, { error: 'conta banida' }];
    if (limited(chatRate, id, 20, 10000)) return [200, { error: 'devagar, muitas mensagens' }];
    lastChatT = Math.max(Date.now(), lastChatT + 1);
    chat.push({ id, name: acc.name || 'Jogador', text, t: lastChatT });
    if (chat.length > 300) chat.splice(0, chat.length - 300);
    return [200, { ok: true }];
  },

  async '/api/chat/poll'(req, body) {
    const since = num(body.since);
    return [200, { messages: chat.filter(m => m.t > since).slice(-60) }];
  },

  async '/api/transfer'(req, body, ctx) {
    const { id, acc } = ctx.user, to = String(body.to || ''), amt = Math.round(+body.amount);
    if (!/^\d{1,6}$/.test(to) || !(amt > 0)) return [200, { error: 'ID ou valor inválido' }];
    if (to === id) return [200, { error: 'Não dá para transferir para você mesmo' }];
    const dest = db.accounts[to]; if (!dest) return [200, { error: 'Esse ID não existe' }];
    if (acc.money === null || acc.money < amt) return [200, { error: 'Saldo insuficiente' }];
    acc.money -= amt; dest.credit = (dest.credit || 0) + amt; save();
    return [200, { money: acc.money }];
  },

  async '/api/admin/ban'(req, body, ctx) {
    if (!isAdm(ctx.user.id)) return [403, { error: 'só o ADM' }];
    const id = String(body.id || ''); if (!/^\d{1,6}$/.test(id) || isAdm(id)) return [400, { error: 'ID inválido' }];
    const min = Math.max(0, num(body.minutes));
    db.bans[id] = { until: min ? Date.now() + min * 60000 : 0, reason: clean(body.reason, 120) || 'não informado' };
    for (const [t, s] of Object.entries(db.sessions)) if (s.id === id) delete db.sessions[t];
    save(); return [200, { ok: true }];
  },

  async '/api/admin/unban'(req, body, ctx) {
    if (!isAdm(ctx.user.id)) return [403, { error: 'só o ADM' }];
    delete db.bans[String(body.id || '')]; save(); return [200, { ok: true }];
  }
};
const PUBLIC = new Set(['/api/login']);

// ---------- servidor HTTP ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const send = (res, code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS)); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'GET') {      // serve o jogo
    if (url === '/' || url === '/index.html' || url === '/rp-city.html') {
      const readGame = cb => fs.readFile(path.join(__dirname, 'rp-city.html'), (e, d) => e ? fs.readFile(path.join(__dirname, 'rp-city.txt'), cb) : cb(null, d));
      return readGame((e, d) => {
        if (e) { res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS)); return res.end('Servidor do RP City no ar. Coloque o rp-city.html na mesma pasta para abrir o jogo por aqui.'); }
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, CORS)); res.end(d);
      });
    }
    return send(res, 404, { error: 'não encontrado' });
  }
  const handler = routes[url];
  if (req.method !== 'POST' || !handler) return send(res, 404, { error: 'não encontrado' });
  let raw = '', big = false;
  req.on('data', c => { raw += c; if (raw.length > 700000) { big = true; req.destroy(); } });
  req.on('end', async () => {
    if (big) return;
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, { error: 'JSON inválido' }); }
    const ctx = { ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim() };
    if (!PUBLIC.has(url)) { ctx.user = authed(req); if (!ctx.user) return send(res, 401, { error: 'sessão inválida' }); }
    try { const [code, out] = await handler(req, body, ctx); send(res, code, out); }
    catch (e) { console.log('erro', url, e.message); send(res, 500, { error: 'erro no servidor' }); }
  });
}).listen(PORT, '0.0.0.0', () => console.log('RP City online na porta ' + PORT + ' · ADM = ID ' + ADM_ID));
