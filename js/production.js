import { UNIT_TYPES, TEMPLATES, UPGRADES } from './config.js?v=85';
import { DIVISION, DIVISION_MAX, strength, unitsOf, centerOf } from './orbat.js?v=85';

// Ausbildung über das Baumenü: Aufträge je Stadt. Eine Stadt bildet je nach Größe 1 bis 3
// Kompanien gleichzeitig aus (citySlots), die übrigen Aufträge warten in ihrer Reihenfolge.
// Bezahlt wird beim Auftrag; wer ihn abbricht, bekommt alles zurück. Fällt die Stadt, sind
// ihre Aufträge verloren.
// Arten: einzelne Kompanie, ganze Division nach Vorlage (eine Gruppe, die nach der letzten
// Kompanie zur Division wird) und Verstärkung einer bestehenden Division.
export class Production {
  constructor(game) {
    this.game = game;
    this.orders = [];
    this.nextId = 1;
    this.nextGroup = 1;
    this.groups = new Map(); // Gruppe -> fertige Kompanien
    this.refillTimer = 0;
  }

  citySlots(c) {
    return this.game.citySize(c);
  }

  ordersOf(p) { return this.orders.filter((o) => o.owner === p); }
  pendingFor(div) { return this.orders.filter((o) => o.division === div).length; }

  // Einzelne Kompanie (oder Verstärkung, wenn division gesetzt) in einer eigenen Stadt
  order(p, cityId, type, division = null, group = 0) {
    const c = this.game.cities[cityId];
    if (!c || c.owner !== p || !UNIT_TYPES[type]) return null;
    if (!this.game.pay(p, UNIT_TYPES[type].cost)) return null;
    const o = { id: this.nextId++, owner: p, city: cityId, type, division, group, timer: 0 };
    this.orders.push(o);
    return o;
  }

  // Ganze Division nach Vorlage: erst bezahlen, wenn alles bezahlbar ist
  orderTemplate(p, cityId, templateId) {
    const t = TEMPLATES.find((x) => x.id === templateId);
    const c = this.game.cities[cityId];
    if (!t || !c || c.owner !== p) return null;
    const cost = templateCost(t);
    const e = this.game.eco[p];
    if (e.money < cost.money || e.manpower < cost.manpower) return null;
    const group = this.nextGroup++;
    this.groups.set(group, []);
    const types = [...Array(t.light).fill('light'), ...Array(t.heavy).fill('heavy')];
    return types.map((type) => this.order(p, cityId, type, null, group));
  }

  // Verstärkung: in der eigenen Stadt, die der Division am nächsten liegt
  reinforce(p, div, type) {
    if (!div || div.dissolved || strength(div) + this.pendingFor(div) >= DIVISION_MAX) return null;
    const c = this.nearestCity(p, centerOf(div));
    return c ? this.order(p, c.id, type, div) : null;
  }

  // Ausrüstung einer Division verbessern (sofort wirksam)
  upgrade(p, div, key) {
    const up = UPGRADES[key];
    const lvl = div.equip[key];
    if (!up || lvl >= up.cost.length) return false;
    if (!this.game.pay(p, { money: up.cost[lvl], manpower: 0 })) return false;
    div.equip[key]++;
    this.game.applyEquipment(div);
    return true;
  }

  cancel(id) {
    const o = this.orders.find((x) => x.id === id);
    if (!o) return;
    this.orders = this.orders.filter((x) => x !== o);
    const e = this.game.eco[o.owner], cost = UNIT_TYPES[o.type].cost;
    e.money += cost.money;
    e.spent -= cost.money;
    e.manpower = Math.min(e.mpCap, e.manpower + cost.manpower);
    if (o.group) this.finishGroup(o.group);
  }

  nearestCity(p, pt) {
    let best = null, bd = Infinity;
    for (const c of this.game.cities) {
      if (c.owner !== p) continue;
      const d = pt ? Math.hypot(c.x - pt.x, c.y - pt.y) : 0;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // Aufträge in Arbeit: je Stadt die ersten citySlots Aufträge
  active(cityId) {
    const c = this.game.cities[cityId];
    return this.orders.filter((o) => o.city === cityId).slice(0, c ? this.citySlots(c) : 0);
  }

  step(dt) {
    const g = this.game;
    // Aufträge in verlorenen Städten verfallen
    const lost = this.orders.filter((o) => g.cities[o.city].owner !== o.owner);
    if (lost.length) {
      this.orders = this.orders.filter((o) => !lost.includes(o));
      for (const o of lost) if (o.group) this.finishGroup(o.group);
    }
    const busy = new Map();
    for (const o of [...this.orders]) {
      const c = g.cities[o.city];
      const n = busy.get(c) || 0;
      if (n >= this.citySlots(c)) continue;
      busy.set(c, n + 1);
      o.timer += dt;
      if (o.timer >= UNIT_TYPES[o.type].buildTime) this.complete(o);
    }
    // Auffüllen: Divisionen mit eingeschaltetem Auffüllen bestellen selbst nach (eine je Sekunde)
    this.refillTimer -= dt;
    if (this.refillTimer <= 0) {
      this.refillTimer = 1;
      for (const p of g.players) {
        for (const div of g.orbat[p].all(DIVISION)) {
          if (!div.refill || strength(div) + this.pendingFor(div) >= DIVISION_MAX) continue;
          const units = unitsOf(div);
          const heavy = units.filter((u) => u.type === 'heavy').length;
          if (this.reinforce(p, div, heavy * 2 > units.length ? 'heavy' : 'light')) break;
        }
      }
    }
  }

  complete(o) {
    const g = this.game;
    this.orders = this.orders.filter((x) => x !== o);
    const c = g.cities[o.city];
    const u = g.spawnUnit(o.owner, o.type, c);
    g.stats[o.owner].built++;
    const div = o.division && !o.division.dissolved ? o.division : null;
    if (div && g.orbat[o.owner].add(div, [u])) {
      g.applyEquipment(div);
      // zur Division marschieren; steht sie an einer Front, übernimmt die Front den Weg
      if (!div.front) {
        const ctr = centerOf(div);
        if (ctr) u.path = g.map.findPath(u.x, u.y, ctr.x, ctr.y) || [];
      }
    }
    if (o.group) {
      this.groups.get(o.group).push(u);
      this.finishGroup(o.group);
    }
    g.events.push({ type: 'spawn', unit: u, city: c, order: o });
  }

  // Gruppe fertig, wenn kein Auftrag mehr offen ist: die Kompanien bilden eine neue Division
  finishGroup(group) {
    if (this.orders.some((o) => o.group === group)) return;
    const units = (this.groups.get(group) || []).filter((u) => u.hp > 0 && !u.regiment);
    this.groups.delete(group);
    if (!units.length) return;
    const div = this.game.orbat[units[0].owner].createDivision(units);
    if (div) this.game.events.push({ type: 'divisionTrained', division: div });
  }
}

export function templateCost(t) {
  const L = UNIT_TYPES.light.cost, H = UNIT_TYPES.heavy.cost;
  return { money: t.light * L.money + t.heavy * H.money, manpower: t.light * L.manpower + t.heavy * H.manpower };
}
