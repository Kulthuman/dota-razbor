// Общая часть для страниц приложения, которые работают без сервера (GitHub Pages):
// запросы к OpenDota прямо из браузера, разбор матча через analyze.js, хранение аккаунта.
import { analyzeMatch, MODEL_VERSION } from './analyze.js';

const API = 'https://api.opendota.com/api';
const CDN = 'https://cdn.cloudflare.steamstatic.com';
const tg = window.Telegram && window.Telegram.WebApp;

export const rankName = (t) => {
  const m = Math.floor((t || 0) / 10), s = (t || 0) % 10;
  const n = { 1: 'Рекрут', 2: 'Страж', 3: 'Рыцарь', 4: 'Герой', 5: 'Легенда', 6: 'Властелин', 7: 'Божество', 8: 'Титан' }[m];
  return n ? (s && m < 8 ? `${n} ${s}` : n) : 'без ранга';
};

// ---------- запросы к OpenDota ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function od(path, opts = {}, retries = 1) {
  let r;
  try { r = await fetch(API + path, opts); } catch {
    if (retries > 0) { await sleep(1200); return od(path, opts, retries - 1); }
    throw new Error('OpenDota не отвечает. Проверь интернет (или VPN) и попробуй позже.');
  }
  if (r.status === 429) throw new Error('OpenDota просит подождать (лимит запросов). Попробуй через минуту.');
  if (r.status === 404) throw new Error('Не найдено.');
  if (r.status >= 500) {
    if (retries > 0) { await sleep(1200); return od(path, opts, retries - 1); }
    throw new Error(`OpenDota сейчас недоступен (${r.status}). Попробуй позже.`);
  }
  if (!r.ok) throw new Error(`Ошибка OpenDota (${r.status}).`);
  return r.json();
}

// ---------- кэш в браузере (localStorage), с запасом на случай, когда он недоступен ----------

function lsGet(key, maxAgeMs) {
  try {
    const c = JSON.parse(localStorage.getItem(key) || 'null');
    if (c && (!maxAgeMs || Date.now() - c.t < maxAgeMs)) return c.d;
  } catch { /* кэш недоступен — не страшно */ }
  return null;
}
function lsSet(key, d) { try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch { /* переполнен или закрыт */ } }

async function cached(key, ttl, make) {
  const hit = lsGet(key, ttl);
  if (hit) return hit;
  const d = await make();
  lsSet(key, d);
  return d;
}

const heroes = () => cached('c:heroes', 24 * 3600e3, () => od('/constants/heroes'));

// ---------- привязанный аккаунт (хранится в Telegram, а если его нет — в браузере) ----------

const cloudOk = !!(tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9'));
export const account = {
  get() {
    return new Promise((resolve) => {
      const local = () => { try { return localStorage.getItem('accountId'); } catch { return null; } };
      if (!cloudOk) return resolve(local());
      tg.CloudStorage.getItem('accountId', (err, v) => resolve(!err && v ? v : local()));
    });
  },
  set(id) {
    try { localStorage.setItem('accountId', id); } catch { /* ок */ }
    return new Promise((resolve) => {
      if (!cloudOk) return resolve();
      tg.CloudStorage.setItem('accountId', String(id), () => resolve());
    });
  },
};

// ---------- Steam ID ----------

export function parseAccountId(text) {
  let s = String(text || '').trim();
  const link = s.match(/(?:players|profiles)\/(\d{3,20})/i);
  if (link) s = link[1];
  if (!/^\d{3,20}$/.test(s)) return null;
  const n = BigInt(s), base = 76561197960265728n;
  const id = n >= base ? n - base : n;
  return id > 0n && id < 4294967296n ? String(id) : null;
}

// ---------- игроки ----------

const heroOf = (h, id) => h?.[id] || {};

async function candidate(p, h) {
  const [prof, recent] = await Promise.allSettled([
    cached(`p:${p.account_id}`, 600e3, () => od(`/players/${p.account_id}`)),
    cached(`r:${p.account_id}`, 600e3, () => od(`/players/${p.account_id}/recentMatches`)),
  ]);
  const rec = recent.status === 'fulfilled' ? recent.value : null;
  const names = [...new Set((rec || []).slice(0, 10).map((m) => heroOf(h, m.hero_id).localized_name).filter(Boolean))].slice(0, 4);
  return {
    accountId: String(p.account_id),
    name: p.personaname || prof.value?.profile?.personaname || String(p.account_id),
    avatar: p.avatarfull || prof.value?.profile?.avatarfull || null,
    lastMatch: p.last_match_time || (rec && rec[0] ? new Date(rec[0].start_time * 1000).toISOString() : null),
    rankTier: prof.status === 'fulfilled' ? prof.value.rank_tier || null : null,
    heroes: names,
    hidden: rec ? rec.length === 0 : null,
  };
}

/** Поиск по нику, ID или ссылке на профиль. */
export async function findPlayers(query) {
  const q = String(query || '').trim().slice(0, 60);
  const id = parseAccountId(q);
  const h = await heroes().catch(() => ({}));
  if (id) return [await candidate({ account_id: id }, h)];
  if (q.length < 2) return [];
  const found = (await od(`/search?q=${encodeURIComponent(q)}`))
    .filter((p) => p.personaname)
    .sort((a, b) => new Date(b.last_match_time || 0) - new Date(a.last_match_time || 0))
    .slice(0, 6);
  return Promise.all(found.map((p) => candidate(p, h)));
}

/** Профиль и последние игры. */
export async function overview(accountId) {
  const [h, prof, recent] = await Promise.all([
    heroes().catch(() => ({})),
    od(`/players/${accountId}`).catch(() => null),
    od(`/players/${accountId}/recentMatches`).catch(() => null),
  ]);
  return {
    accountId: String(accountId),
    name: prof?.profile?.personaname || String(accountId),
    avatar: prof?.profile?.avatarfull || null,
    rankTier: prof?.rank_tier || null,
    hidden: recent ? recent.length === 0 : null,
    matches: (recent || []).slice(0, 20).map((m) => {
      const hero = heroOf(h, m.hero_id);
      return {
        matchId: String(m.match_id),
        hero: hero.localized_name || `Герой #${m.hero_id}`,
        heroImg: hero.img ? CDN + hero.img : null,
        win: (m.player_slot < 128) === m.radiant_win,
        kills: m.kills, deaths: m.deaths, assists: m.assists,
        startTime: m.start_time, duration: m.duration,
      };
    }),
  };
}

// ---------- разбор матча ----------

export async function getReport(matchId) {
  if (matchId === 'demo') return (await fetch('demo.json')).json();
  const hit = lsGet(`an:${matchId}`);
  if (hit && hit.v === MODEL_VERSION) return hit;
  const [m, h] = await Promise.all([od(`/matches/${matchId}`), heroes()]);
  const result = analyzeMatch(m, { heroes: h });
  if (result.detail.parsed) lsSet(`an:${matchId}`, result); // неполные разборы не кэшируем: данные могут появиться позже
  return result;
}

/** Просим OpenDota разобрать реплей матча (детали появятся через несколько минут). */
export async function requestParse(matchId) {
  await od(`/request/${matchId}`, { method: 'POST' }, 0);
}
