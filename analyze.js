// Разбор поражения. Идея модели: каждого игрока проигравшей команды сравниваем
// с его прямым оппонентом по роли в команде-победителе («дуэль») и со своей же командой.
// Чем сильнее он уступил по нескольким независимым показателям, тем выше «индекс просадки».
// Показатели, для которых у матча нет данных (например, нет минутных рядов), просто
// не учитываются, а вес остальных пересчитывается.

export const MODEL_VERSION = 5;

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

export const fmt = (n) => Math.round(n || 0).toLocaleString('ru-RU');
export const time = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;

const ROLE_NAME = {
  1: 'Позиция 1 · Керри',
  2: 'Позиция 2 · Мид',
  3: 'Позиция 3 · Оффлейн',
  4: 'Позиция 4 · Поддержка',
  5: 'Позиция 5 · Полная поддержка',
};

// ---------- позиции игроков ----------

/** Три самых богатых — кор-игроки, двое остальных — поддержка; внутри групп смотрим на линию. */
function assignPositions(team) {
  const byNw = [...team].sort((a, b) => (b.net_worth || 0) - (a.net_worth || 0));
  const cores = byNw.slice(0, 3);
  const sups = byNw.slice(3);
  const pos = new Map();
  const taken = new Set();
  const laneToPos = { 1: 1, 2: 2, 3: 3 }; // лейн OpenDota: 1 — лёгкая, 2 — мид, 3 — сложная
  for (const p of cores) {
    const w = laneToPos[p.lane_role];
    if (w && !taken.has(w)) { pos.set(p.player_slot, w); taken.add(w); }
  }
  const left = [1, 2, 3].filter((x) => !taken.has(x));
  for (const p of cores) if (!pos.has(p.player_slot)) pos.set(p.player_slot, left.shift() ?? 3);

  const safe = sups.filter((p) => p.lane_role === 1);
  if (sups.length === 2 && safe.length === 1) {
    pos.set(safe[0].player_slot, 5);
    pos.set(sups.find((x) => x !== safe[0]).player_slot, 4);
  } else {
    sups.forEach((p, i) => pos.set(p.player_slot, i === 0 ? 4 : 5));
  }
  return pos;
}

// ---------- сравнение с оппонентом ----------

// 0 — не хуже оппонента, 100 — почти ничего. k задаёт «строгость».
const gapPenalty = (mine, theirs, k) => (theirs > 0 ? clamp((1 - (mine || 0) / theirs) * k) : null);

const utilityOf = (p) => (p.obs_placed || 0) * 2 + (p.sentry_placed || 0) + (p.hero_healing || 0) / 600;

const WEIGHTS = {
  1: { lane: 0.15, econ: 0.25, dmg: 0.20, tower: 0.10, deaths: 0.20, kp: 0.10, util: 0 },
  2: { lane: 0.15, econ: 0.20, dmg: 0.20, tower: 0.10, deaths: 0.20, kp: 0.15, util: 0 },
  3: { lane: 0.10, econ: 0.15, dmg: 0.20, tower: 0.15, deaths: 0.20, kp: 0.20, util: 0 },
  4: { lane: 0.10, econ: 0.05, dmg: 0.15, tower: 0.05, deaths: 0.20, kp: 0.25, util: 0.20 },
  5: { lane: 0.10, econ: 0.05, dmg: 0.10, tower: 0.00, deaths: 0.20, kp: 0.25, util: 0.30 },
};

/** Значение показателя в минуту `min` из минутного ряда или null. */
const atMinute = (arr, min) => (Array.isArray(arr) && arr.length > min ? Number(arr[min]) : null);

function scorePlayer(p, c, heroName) {
  const pos = p.pos;
  const opp = c.winnerByPos.get(pos) || null;
  const oppHero = opp ? heroName(opp) : null;

  const comp = {};
  comp.econ = opp ? gapPenalty(p.net_worth, opp.net_worth, 140) : null;
  comp.dmg = opp ? gapPenalty(p.hero_damage, opp.hero_damage, 120) : null;
  comp.tower = opp ? gapPenalty(p.tower_damage, opp.tower_damage, 90) : null;

  const teamDeaths = c.teamDeaths || 1;
  const deathShare = (p.deaths || 0) / teamDeaths;
  comp.deaths = clamp(((deathShare - 0.2) / 0.25) * 100);

  const kp = c.teamKills ? (100 * ((p.kills || 0) + (p.assists || 0))) / c.teamKills : 0;
  comp.kp = clamp(((c.avgKp - kp) / 30) * 100);

  let laneGap = 0;
  const g10 = atMinute(p.gold_t, 10), x10 = atMinute(p.xp_t, 10);
  const og10 = opp ? atMinute(opp.gold_t, 10) : null, ox10 = opp ? atMinute(opp.xp_t, 10) : null;
  if (g10 != null && x10 != null && og10 != null && ox10 != null) {
    laneGap = og10 + ox10 - (g10 + x10);
    comp.lane = gapPenalty(g10 + x10, og10 + ox10, 250);
  } else comp.lane = null;

  if (pos >= 4 && opp) {
    const mine = utilityOf(p), theirs = utilityOf(opp);
    comp.util = theirs > 0 ? gapPenalty(mine, theirs, 100) : 0;
  } else comp.util = null;

  // итог: средневзвешенное по тем показателям, что удалось посчитать
  const w = WEIGHTS[pos];
  let wSum = 0, acc = 0;
  const contrib = {};
  for (const k of Object.keys(w)) {
    if (comp[k] == null || w[k] === 0) continue;
    wSum += w[k]; acc += w[k] * comp[k];
  }
  for (const k of Object.keys(w)) if (comp[k] != null && w[k] > 0) contrib[k] = (w[k] / wSum) * comp[k];
  const score = wSum ? Math.round(clamp(acc / wSum)) : 0;
  const coverage = wSum / Object.values(w).reduce((a, b) => a + b, 0);

  // причины: самые тяжёлые показатели
  const T = {
    lane: ['Проигранная линия', `К 10-й минуте золота и опыта на ${fmt(laneGap)} меньше, чем у оппонента (${oppHero}).`],
    econ: ['Отставание по ресурсам', opp && `Состояние ${fmt(p.net_worth)} против ${fmt(opp.net_worth)} у оппонента (${oppHero}).`],
    dmg: ['Слабая отдача уроном', opp && `${fmt(p.hero_damage)} урона по героям против ${fmt(opp.hero_damage)} у оппонента (${oppHero}).`],
    deaths: ['Дорогие смерти', `${p.deaths || 0} из ${teamDeaths} смертей команды (${Math.round(deathShare * 100)}%).`],
    kp: ['Мало участия в боях', `Был в ${kp.toFixed(0)}% убийств команды при среднем по команде ${c.avgKp.toFixed(0)}%.`],
    tower: ['Слабое давление на здания', opp && `${fmt(p.tower_damage)} урона по зданиям против ${fmt(opp.tower_damage)} у оппонента.`],
    util: ['Мало пользы от поддержки', opp && `${p.obs_placed || 0} обсервов, ${p.sentry_placed || 0} сентри, ${fmt(p.hero_healing)} лечения — у оппонента заметно больше.`],
  };
  const THRESH = 25;
  const heavy = Object.entries(contrib).filter(([k]) => comp[k] >= THRESH).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const reasons = heavy.map(([k]) => ({ key: k, title: T[k][0], text: T[k][1] }));
  const rivalNote = oppHero ? oppHero : null;

  const confidence = clamp(
    40 + Math.round(coverage * 25) + (c.hasTeamfights ? 8 : 0) + (c.hasKillLog ? 8 : 0) + (p.lane_role ? 6 : 0) + (opp ? 6 : 0),
    40, 92,
  );

  return {
    ...p,
    kp,
    dmgShare: (100 * (p.hero_damage || 0)) / c.teamDamage,
    score,
    confidence,
    reasons,
    components: comp,
    rival: rivalNote,
    leaver: (p.leaver_status || 0) >= 2,
    role: ROLE_NAME[pos],
  };
}

// ---------- прочее ----------

/** Рейтинг внутри команды: чем меньше сумма мест по показателям, тем лучше игрок. */
function rankBest(team) {
  const metrics = [
    (p) => p.hero_damage || 0, (p) => p.net_worth || 0, (p) => (p.kills || 0) + (p.assists || 0),
    (p) => -(p.deaths || 0), (p) => p.tower_damage || 0,
  ];
  const total = new Map(team.map((p) => [p.player_slot, 0]));
  for (const m of metrics) {
    [...team].sort((a, b) => m(b) - m(a)).forEach((p, i) => total.set(p.player_slot, total.get(p.player_slot) + i));
  }
  return [...team].sort((a, b) => total.get(a.player_slot) - total.get(b.player_slot) || (b.hero_damage || 0) - (a.hero_damage || 0))[0];
}

/** Разница в золоте по минутам с точки зрения проигравшей команды (плюс = вы впереди). */
function goldSeries(players, losing) {
  const maxLen = Math.max(0, ...players.map((p) => (Array.isArray(p.gold_t) ? p.gold_t.length : 0)));
  if (maxLen < 2) return [];
  const series = [];
  for (let i = 0; i < maxLen; i++) {
    const side = (team) => players.filter((p) => p.team === team).reduce((n, p) => n + (Array.isArray(p.gold_t) ? Number(p.gold_t[i] || 0) : 0), 0);
    series.push({ r: side('Radiant'), d: side('Dire') });
  }
  return series;
}

/** Окно в 3 минуты, где команда потеряла больше всего преимущества. */
function findCollapse(adv) {
  if (adv.length < 6) return null;
  let best = null;
  for (let i = 0; i + 3 < adv.length; i++) {
    const drop = adv[i] - adv[i + 3];
    if (!best || drop > best.drop) best = { i, drop };
  }
  return best && best.drop > 1500 ? { from: best.i, to: best.i + 3, drop: best.drop, before: adv[best.i], after: adv[best.i + 3] } : null;
}

function lessonFor(reason, pos) {
  const A = {
    lane: 'Если линия проигрывается, не терпите до 10-й минуты: меняйте позицию, зовите помощь или уходите фармить в другое место.',
    econ: 'Между драками всегда ищите фарм: лес, крипы, стаки. Простой без дела — это золото, которое достаётся оппоненту.',
    dmg: 'Перед боем проверяйте, готовы ли вы наносить урон: ключевые предметы, ульта, позиция, откуда вас достанут не сразу.',
    deaths: 'Чем дольше игра, тем дороже каждая смерть. Не выходите на карту без ТП и без представления, где враги.',
    kp: 'Двигайтесь к дракам раньше: ТП-свиток и позиция рядом с командой дают больше участия, чем попытки догнать бой.',
    tower: 'После выигранной драки сразу идите на здания, пока соперник восстанавливается, а не продолжайте фарм.',
    util: 'Поддержке: ставьте вижн перед каждым объектом и держите сентри или дасты против невидимых героев.',
  };
  if (reason && A[reason.key]) return A[reason.key];
  return pos >= 4 ? 'Ищите активное влияние на карту: вижн, помощь коров и участие в боях.' : 'Следите за связкой «фарм → драка → здание»: хороший фарм без боёв и зданий не выигрывает игру.';
}

function mitigation(p, c) {
  const nwRatio = c.loserNw / (c.winnerNw || 1);
  if (nwRatio < 0.8) return { title: 'Команда проигрывала по ресурсам', text: `Суммарное состояние вашей команды — ${Math.round(nwRatio * 100)}% от соперника. При таком отставании один игрок мало что решает.` };
  if (c.hasLeaver) return { title: 'В команде был ливер', text: 'Игра 4 на 5 сильно снижает шансы, что бы ни делал каждый отдельный игрок.' };
  if (c.damageRank.get(p.player_slot) <= 2 && p.kp >= 60) return { title: 'Он работал в драках', text: `${p.kp.toFixed(0)}% участия в убийствах и ${p.dmgShare.toFixed(1)}% командного урона: игрок не выпадал из игры.` };
  if ((p.deaths || 0) <= c.avgDeaths) return { title: 'Смерти не выделяются', text: `${p.deaths || 0} смертей при среднем ${c.avgDeaths.toFixed(1)} по команде: главная проблема не в них.` };
  return { title: 'Поражение выглядит командным', text: 'Даже у самого слабого звена показатели не провальные: исход решился совокупностью мелких потерь.' };
}

// ---------- события по таймлайну ----------

function buildEvents(m, p, adv, deathTs) {
  const out = [];
  const advAt = (s) => (adv.length > 1 ? adv[Math.min(adv.length - 1, Math.round(s / 60))] : null);
  for (const t of deathTs) {
    const a = advAt(t);
    const lead = a != null ? (a >= 0 ? `команда впереди на ${fmt(a)}` : `команда позади на ${fmt(-a)}`) : null;
    const costly = a != null && a >= 1500;
    out.push({
      ts: t, t: time(t), danger: costly,
      title: costly ? 'Смерть при преимуществе' : 'Смерть',
      text: lead ? `В этот момент ${lead} золота.` : 'Погиб в этот момент матча.',
      why: costly ? 'Смерть при перевесе отдаёт сопернику возможность вернуться в игру.' : 'Сама по себе смерть — не ошибка, важно, что произошло дальше.',
    });
  }
  if (out.length) return out.slice(0, 8);

  const d = [];
  const mk = (title, text, danger) => d.push({ t: 'По итогам матча', danger, title, text, why: 'Таймлайна у матча нет, поэтому вывод построен на общей статистике.' });
  if ((p.deaths || 0) >= 3) mk('Много смертей', `${p.deaths} смертей за матч`, true);
  if (p.kp < 45) mk('Мало участия в убийствах', `Участие в убийствах команды ${p.kp.toFixed(0)}%`, true);
  else if (p.kp >= 65) mk('Активное участие в убийствах', `Участие в убийствах команды ${p.kp.toFixed(0)}%`, false);
  if (p.dmgShare < 10) mk('Небольшой урон', `${p.dmgShare.toFixed(1)}% командного урона по героям`, true);
  else if (p.dmgShare >= 20) mk('Много урона', `${p.dmgShare.toFixed(1)}% командного урона по героям`, false);
  if (!d.length) mk('Ничего выдающегося', 'Показатели игрока близки к средним по команде.', false);
  return d.slice(0, 5);
}

// ---------- подробности: смерти, драки, предметы, сравнение, события матча ----------

const CDN = 'https://cdn.cloudflare.steamstatic.com';
const prettyKey = (k) => String(k || '').replace(/^npc_dota_hero_/, '').replace(/^npc_dota_/, '').replace(/_/g, ' ');

/** Драки: кто сколько потерял, кто выиграл, что делал слабое звено. */
function buildFights(m, players, losing, culprit) {
  return (m.teamfights || []).map((f) => {
    const sumBy = (isLosing, field) => players
      .filter((p) => (p.team === losing) === isLosing)
      .reduce((a, p) => a + (f.players?.[p.idx]?.[field] || 0), 0);
    const ourDeaths = sumBy(true, 'deaths');
    const theirDeaths = sumBy(false, 'deaths');
    const x = f.players?.[culprit.idx] || {};
    const kills = Object.values(x.killed || {}).reduce((a, b) => a + b, 0);
    return {
      ts: f.start, t: time(f.start), lengthSec: Math.max(0, (f.end || f.start) - f.start),
      ourDeaths, theirDeaths,
      result: theirDeaths > ourDeaths ? 'won' : theirDeaths < ourDeaths ? 'lost' : 'even',
      ourDamage: sumBy(true, 'damage'), theirDamage: sumBy(false, 'damage'),
      culprit: {
        present: (x.damage || 0) > 0 || (x.deaths || 0) > 0 || kills > 0,
        damage: x.damage || 0, deaths: x.deaths || 0, kills, healing: x.healing || 0,
        goldDelta: x.gold_delta || 0, buybacks: x.buybacks || 0,
      },
    };
  });
}

/** Каждая смерть: кто убил, сколько золота потеряно, как была вся игра в этот момент, в драке или нет. */
function buildDeaths(p, m, adv, fights, nameByKey) {
  const log = p.deaths_log || [];
  const buybacks = (p.buyback_log || []).map((b) => b.time);
  // координаты смертей есть только внутри драк
  const posByFight = new Map();
  (m.teamfights || []).forEach((f, i) => {
    const pos = [];
    const dp = f.players?.[p.idx]?.deaths_pos || {};
    for (const [x, ys] of Object.entries(dp)) for (const [y, n] of Object.entries(ys)) for (let k = 0; k < n; k++) pos.push({ x: Number(x), y: Number(y) });
    posByFight.set(i, pos);
  });
  const usedInFight = new Map();

  const items = log.map((d) => {
    const fi = (m.teamfights || []).findIndex((f) => d.time >= f.start - 5 && d.time <= (f.last_death ?? f.end) + 5);
    const fight = fi >= 0 ? fights[fi] : null;
    let pos = null;
    if (fi >= 0) {
      const list = posByFight.get(fi) || [];
      const k = usedInFight.get(fi) || 0;
      usedInFight.set(fi, k + 1);
      if (list.length && list.length === (fights[fi].culprit.deaths || 0)) pos = list[k] || null;
    }
    const a = adv.length > 1 ? adv[Math.min(adv.length - 1, Math.round(d.time / 60))] : null;
    return {
      ts: d.time, t: time(d.time),
      killer: nameByKey(d.key),
      goldLost: d.gold_lost || 0, goldFed: d.gold_fed || 0, respawnSec: d.time_dead || 0,
      advAtDeath: a,
      aheadWhenDied: a != null && a >= 1500,
      buyback: buybacks.some((b) => Math.abs(b - d.time) < 45),
      fight: fight && { t: fight.t, result: fight.result, ourDeaths: fight.ourDeaths, theirDeaths: fight.theirDeaths },
      alone: !fight,
      pos,
    };
  });

  const killers = Object.entries(p.killed_by || {}).map(([k, n]) => ({ hero: nameByKey(k), count: n })).sort((a, b) => b.count - a.count);
  return {
    list: items,
    totalGoldLost: items.reduce((a, x) => a + x.goldLost, 0),
    totalGoldFed: items.reduce((a, x) => a + x.goldFed, 0),
    totalDeadSec: items.reduce((a, x) => a + x.respawnSec, 0),
    alone: items.filter((x) => x.alone).length,
    aheadWhenDied: items.filter((x) => x.aheadWhenDied).length,
    killers,
  };
}

/** Ключевые предметы по минутам покупки и итоговый инвентарь. */
function buildItems(p, itemsConst) {
  if (!itemsConst || !Object.keys(itemsConst).length) return { key: [], inventory: [] };
  const info = (key) => {
    const it = itemsConst[key];
    return it ? { name: it.dname || prettyKey(key), img: it.img ? CDN + it.img : null, cost: it.cost || 0, assembled: !!it.components } : null;
  };
  const byId = new Map(Object.entries(itemsConst).filter(([, v]) => v && v.id != null).map(([k, v]) => [v.id, k]));
  const key = [];
  for (const e of p.purchase_log || []) {
    if (String(e.key).startsWith('recipe_')) continue;
    const i = info(e.key);
    if (!i) continue;
    if ((i.assembled && i.cost >= 1000) || e.key === 'aghanims_shard') key.push({ ts: e.time, t: time(Math.max(0, e.time)), ...i });
  }
  const inv = [0, 1, 2, 3, 4, 5, 'n'].map((k) => (k === 'n' ? p.item_neutral : p[`item_${k}`])).filter(Boolean)
    .map((id) => { const k = byId.get(id); const i = k && info(k); return i && { name: i.name, img: i.img }; }).filter(Boolean);
  return { key, inventory: inv };
}

/** Сравнение с оппонентом по роли: строки таблицы. lower: true — чем меньше, тем лучше; null — без оценки. */
function buildCompare(p, r) {
  if (!r) return [];
  const heroTaken = (x) => Object.entries(x.damage_taken || {}).filter(([k]) => k.startsWith('npc_dota_hero_')).reduce((a, [, v]) => a + v, 0);
  const pct = (v) => (v == null ? null : Math.round(v * 100));
  const rows = [
    ['Убийства', p.kills, r.kills, false], ['Смерти', p.deaths, r.deaths, true], ['Помощь', p.assists, r.assists, false],
    ['GPM', p.gold_per_min, r.gold_per_min, false], ['XPM', p.xp_per_min, r.xp_per_min, false],
    ['Добито крипов', p.last_hits, r.last_hits, false], ['Отдано крипов', p.denies, r.denies, false],
    ['Состояние (net worth)', p.net_worth, r.net_worth, false], ['Уровень', p.level, r.level, false],
    ['Урон по героям', p.hero_damage, r.hero_damage, false], ['Получено урона от героев', heroTaken(p), heroTaken(r), null],
    ['Лечение', p.hero_healing, r.hero_healing, false], ['Урон по зданиям', p.tower_damage, r.tower_damage, false],
    ['Оглушения, сек', p.stuns != null ? Math.round(p.stuns) : null, r.stuns != null ? Math.round(r.stuns) : null, false],
    ['Эффективность линии, %', p.lane_efficiency_pct, r.lane_efficiency_pct, false],
    ['Участие в драках, %', pct(p.teamfight_participation), pct(r.teamfight_participation), false],
    ['Обсерверы', p.obs_placed, r.obs_placed, null], ['Сентри', p.sen_placed ?? p.sentry_placed, r.sen_placed ?? r.sentry_placed, null],
    ['Стаки лагеря', p.camps_stacked, r.camps_stacked, null], ['Руны', p.rune_pickups, r.rune_pickups, null],
    ['Нейтральные крипы', p.neutral_kills, r.neutral_kills, false], ['Выкупы', p.buyback_count, r.buyback_count, null],
  ];
  return rows.filter(([, a, b]) => a != null || b != null).map(([label, me, opp, lower]) => ({ label, me: me ?? 0, opp: opp ?? 0, lower }));
}

const LANE_RU = { top: 'верх', mid: 'мид', bot: 'низ' };
/** Башни, казармы, Рошан, Эгида, первая кровь — кому это пошло на пользу. */
function buildObjectives(m, players, losing, nameBySlot) {
  const out = [];
  const loseNum = losing === 'Radiant' ? 2 : 3;
  const sideOfSlot = (slot) => (slot < 128 ? 'Radiant' : 'Dire');
  for (const o of m.objectives || []) {
    if (o.type === 'building_kill') {
      const key = String(o.key || '');
      const radiantLost = key.includes('goodguys');
      const lane = LANE_RU[(/_(top|mid|bot)/.exec(key) || [])[1]];
      const tower = /tower(\d)/.exec(key);
      let what = null;
      if (tower) what = tower[1] === '4' ? 'Башня у трона' : `Башня ${tower[1]} яруса${lane ? ` (${lane})` : ''}`;
      else if (/rax/.test(key)) what = `${/melee/.test(key) ? 'Казармы ближнего боя' : 'Казармы дальнего боя'}${lane ? ` (${lane})` : ''}`;
      else if (/fort|ancient/.test(key)) what = 'Трон';
      if (!what) continue;
      const benefited = radiantLost ? 'Dire' : 'Radiant';
      out.push({ ts: o.time, t: time(o.time), text: `${what} (${radiantLost ? 'Radiant' : 'Dire'}) разрушена`, side: benefited === losing ? 'lose' : 'win' });
    } else if (o.type === 'CHAT_MESSAGE_ROSHAN_KILL') {
      out.push({ ts: o.time, t: time(o.time), text: 'Рошан убит', side: o.team === loseNum ? 'lose' : 'win' });
    } else if (o.type === 'CHAT_MESSAGE_AEGIS') {
      out.push({ ts: o.time, t: time(o.time), text: `${nameBySlot(o.player_slot)} забрал Эгиду`, side: sideOfSlot(o.player_slot) === losing ? 'lose' : 'win' });
    } else if (o.type === 'CHAT_MESSAGE_FIRSTBLOOD') {
      out.push({ ts: o.time, t: time(o.time), text: `Первая кровь: ${nameBySlot(o.player_slot)} убил ${nameBySlot(o.victim_player_slot)}`, side: sideOfSlot(o.player_slot) === losing ? 'lose' : 'win' });
    }
  }
  return out.sort((a, b) => a.ts - b.ts).slice(0, 60);
}

const topCounts = (obj, n, label) => Object.entries(obj || {})
  .map(([k, v]) => ({ name: label(k), count: v })).filter((x) => x.count > 0).sort((a, b) => b.count - a.count).slice(0, n);

// ---------- главная функция ----------

/**
 * @param m       ответ OpenDota на /matches/{id}
 * @param consts  { heroes, items } — /constants/heroes и /constants/items (items необязательно: без него нет блока предметов)
 */
export function analyzeMatch(m, consts) {
  if (!m || !Array.isArray(m.players) || !m.players.length) throw new Error('В ответе OpenDota нет данных игроков');
  const heroes = consts.heroes || {};
  const heroData = (p) => heroes[String(p.hero_id)] || {};
  const heroName = (p) => heroData(p).localized_name || `Герой #${p.hero_id}`;

  const players = m.players.map((p, i) => ({ ...p, idx: i, team: p.player_slot < 128 ? 'Radiant' : 'Dire' }));
  const losing = m.radiant_win ? 'Dire' : 'Radiant';
  const winning = m.radiant_win ? 'Radiant' : 'Dire';
  const losers = players.filter((p) => p.team === losing);
  const winners = players.filter((p) => p.team !== losing);

  const loserPos = assignPositions(losers);
  const winnerPos = assignPositions(winners);
  losers.forEach((p) => (p.pos = loserPos.get(p.player_slot)));
  winners.forEach((p) => (p.pos = winnerPos.get(p.player_slot)));

  const teamKills = sum(losers, (p) => p.kills);
  const teamDamage = sum(losers, (p) => p.hero_damage) || 1;
  const kpOf = (p) => (teamKills ? (100 * ((p.kills || 0) + (p.assists || 0))) / teamKills : 0);
  const damageRank = new Map([...losers].sort((a, b) => (b.hero_damage || 0) - (a.hero_damage || 0)).map((p, i) => [p.player_slot, i + 1]));
  const hasKillLog = players.some((p) => Array.isArray(p.kills_log) && p.kills_log.length);

  const ctx = {
    winnerByPos: new Map(winners.map((p) => [p.pos, p])),
    teamDeaths: sum(losers, (p) => p.deaths),
    teamKills, teamDamage,
    avgKp: losers.length ? sum(losers, kpOf) / losers.length : 0,
    avgDeaths: losers.length ? sum(losers, (p) => p.deaths) / losers.length : 0,
    hasTeamfights: !!(m.teamfights && m.teamfights.length),
    hasKillLog,
    loserNw: sum(losers, (p) => p.net_worth),
    winnerNw: sum(winners, (p) => p.net_worth),
    hasLeaver: losers.some((p) => (p.leaver_status || 0) >= 2),
    damageRank,
  };

  const scored = losers.map((p) => scorePlayer(p, ctx, heroName)).sort((a, b) => b.score - a.score);
  const pool = scored.filter((x) => !x.leaver);
  const culprit = pool[0] || scored[0];
  const runnerUp = pool.find((x) => x !== culprit) || null;

  const series = goldSeries(players, losing);
  const sign = losing === 'Radiant' ? 1 : -1;
  const adv = series.map((x) => (x.r - x.d) * sign);

  // моменты смерти слабого звена (по записям убийств соперников)
  const heroKey = heroData(culprit).name;
  const culpritDeaths = [];
  winners.forEach((x) => (x.kills_log || []).forEach((k) => { if (k.key === heroKey) culpritDeaths.push(k.time); }));
  culpritDeaths.sort((a, b) => a - b);

  const collapse = findCollapse(adv);
  let turning;
  if (collapse) {
    const deathsIn = culpritDeaths.filter((t) => t >= collapse.from * 60 && t <= collapse.to * 60).length;
    turning = {
      t: time(collapse.from * 60),
      fromMin: collapse.from,
      toMin: collapse.to,
      title: 'Резкая потеря преимущества',
      text: `С ${time(collapse.from * 60)} по ${time(collapse.to * 60)} разница по золоту изменилась с ${collapse.before >= 0 ? '+' : '−'}${fmt(Math.abs(collapse.before))} до ${collapse.after >= 0 ? '+' : '−'}${fmt(Math.abs(collapse.after))}.` +
        (deathsIn ? ` ${culprit.personaname || 'Слабое звено'} погиб в этом окне (${deathsIn}).` : ''),
    };
  } else {
    turning = { t: '—', title: 'Единого перелома нет', text: 'Преимущество уходило постепенно или у матча нет минутных данных о золоте.' };
  }

  const view = (p) => p && {
    name: p.personaname || `Игрок ${p.idx + 1}`,
    accountId: p.account_id || null,
    hero: heroName(p),
    heroImg: heroData(p).img ? `https://cdn.cloudflare.steamstatic.com${heroData(p).img}` : null,
    kills: p.kills || 0, deaths: p.deaths || 0, assists: p.assists || 0,
    gpm: p.gold_per_min || 0, xpm: p.xp_per_min || 0, lastHits: p.last_hits || 0,
    heroDamage: p.hero_damage || 0, towerDamage: p.tower_damage || 0, netWorth: p.net_worth || 0,
    role: p.role || (p.pos ? ROLE_NAME[p.pos] : null),
    score: p.score, confidence: p.confidence, reasons: p.reasons || [],
    kp: p.kp ?? kpOf(p), dmgShare: p.dmgShare ?? 0, leaver: !!p.leaver, rival: p.rival || null,
    components: p.components || null,
  };

  const mvpPlayer = rankBest(winners);
  const bestLoserPlayer = rankBest(losers);
  const radScore = m.radiant_score ?? sum(players.filter((p) => p.team === 'Radiant'), (p) => p.kills);
  const direScore = m.dire_score ?? sum(players.filter((p) => p.team === 'Dire'), (p) => p.kills);
  const scoredBySlot = new Map(scored.map((p) => [p.player_slot, p]));

  // ---- подробная статистика (есть, когда у матча разобран реплей) ----
  const itemsConst = consts.items || {};
  const heroByKey = new Map(Object.values(heroes).map((h) => [h.name, h]));
  const nameByKey = (k) => heroByKey.get(k)?.localized_name || prettyKey(k);
  const bySlot = new Map(players.map((p) => [p.player_slot, p]));
  const nameBySlot = (s) => (bySlot.get(s) ? heroName(bySlot.get(s)) : 'Герой');
  const rivalRaw = ctx.winnerByPos.get(culprit.pos) || null;
  const shortHero = String(heroData(culprit).name || '').replace('npc_dota_hero_', '');
  const abilityNice = (k) => String(k).replace(new RegExp(`^${shortHero}_`), '').replace(/_/g, ' ');
  const fightsList = buildFights(m, players, losing, culprit);
  const deaths = buildDeaths(culprit, m, adv, fightsList, nameByKey);
  const deep = {
    rival: rivalRaw ? view({ ...rivalRaw, role: ROLE_NAME[rivalRaw.pos] }) : null,
    deaths,
    fights: fightsList,
    fightsSummary: {
      total: fightsList.length,
      won: fightsList.filter((f) => f.result === 'won').length,
      lost: fightsList.filter((f) => f.result === 'lost').length,
      even: fightsList.filter((f) => f.result === 'even').length,
      culpritPresent: fightsList.filter((f) => f.culprit.present).length,
      lostWithoutCulprit: fightsList.filter((f) => f.result === 'lost' && !f.culprit.present).length,
    },
    items: {
      me: buildItems(culprit, itemsConst),
      rival: rivalRaw ? buildItems(rivalRaw, itemsConst) : { key: [], inventory: [] },
    },
    compare: buildCompare(culprit, rivalRaw),
    objectives: buildObjectives(m, players, losing, nameBySlot),
    series: {
      nwMe: culprit.networth_t || [],
      nwRival: rivalRaw?.networth_t || [],
      xpAdv: (m.radiant_xp_adv || []).map((v) => v * sign),
    },
    extras: {
      abilities: topCounts(culprit.ability_uses, 6, abilityNice),
      itemUses: topCounts(culprit.item_uses, 6, (k) => itemsConst[k]?.dname || prettyKey(k)),
      killStreaks: culprit.kill_streaks || {},
      multiKills: culprit.multi_kills || {},
    },
  };

  return {
    v: MODEL_VERSION,
    deep,
    matchId: m.match_id,
    duration: m.duration || 0,
    winner: winning,
    loser: losing,
    score: { win: m.radiant_win ? radScore : direScore, lose: m.radiant_win ? direScore : radScore },
    detail: {
      teamfights: (m.teamfights || []).length,
      goldSeries: series.length > 1,
      killLog: hasKillLog,
      parsed: series.length > 1 || hasKillLog || ctx.hasTeamfights,
    },
    culprit: view(culprit),
    runnerUp: view(runnerUp),
    mvp: view(mvpPlayer),
    bestLoser: view(scoredBySlot.get(bestLoserPlayer.player_slot)),
    losers: scored.map(view),
    winners: winners.map(view),
    turning,
    lesson: { reason: culprit.reasons[0]?.title || null, action: lessonFor(culprit.reasons[0], culprit.pos) },
    mitigation: mitigation(culprit, ctx),
    events: buildEvents(m, culprit, adv, culpritDeaths),
    gold: { series: adv, culpritDeaths },
  };
}
