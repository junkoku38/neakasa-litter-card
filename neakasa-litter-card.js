/*
 * neakasa-litter-card.js — v3
 * Carte Lovelace pour la litière Neakasa M1 (intégration hass-neakasa)
 *
 * Installation :
 *   1. Copier ce fichier dans /config/www/neakasa-litter-card.js
 *   2. Paramètres > Tableaux de bord > ⋮ > Ressources > Ajouter
 *      URL : /local/neakasa-litter-card.js   Type : Module JavaScript
 *   3. Carte manuelle :
 *        type: custom:neakasa-litter-card
 *        room: Salle de bain
 *        cat_name: Minou          # chat principal (affiché quand un chat est présent)
 *        cats: [Minou, Nana]      # optionnel : multi-chats explicite
 *                                 # (sinon détection auto de sensor.<prefix>_cat_*)
 *        bin_capacity: 15         # optionnel : nb de cycles avant « bac plein » (défaut 15)
 *        prefix: neakasa_m1       # optionnel : préfixe des entity_id
 *
 * v3 :
 *   - multi-chats : poids et tendance par chat (auto-détection)
 *   - prévision du remplissage du bac à déchets (bin_capacity)
 *   - histogramme des passages sur 7 jours
 *   - fiabilisation : delta de poids calculé sur la vraie période, garde-fous
 *     (entités manquantes, horodatages futurs, timers, accessibilité clavier)
 */

const NK_BUSY = ['cleaning', 'leveling', 'flipover', 'restoring'];
const NK_ALERT = ['side_bin_locking_panels_missing', 'cleaning_interrupted'];
const NK_LITTER = { sufficient: 'suffisante', moderate: 'moyenne', insufficient: 'à recharger' };
const DAY = 86400000;
let NK_UID = 0;

/* Intégrations supportées :
 *  - "ha-neakasa-litterbox" (roquerodrigo) : sensor.<dev>_status (idle/cleaning/restoring/
 *    leveling/cat_appears), sensor.<chat>_weight/last_visit, sensor.<dev>_sand_level,
 *    sensor.<dev>_visits_today, binary_sensor.<dev>_waste_bucket_full, button.<dev>_clean_now
 *  - "hass-neakasa" : sensor.<prefix>_device_status, sensor.<prefix>_cat_<slug>, etc. */
const nkDefaultEntities = (p, cat) => ({
  status: `sensor.${p}_device_status`,
  last_usage: `sensor.${p}_last_usage`,
  stay_time: `sensor.${p}_last_stay_time`,
  litter_level: `sensor.${p}_cat_litter_level`,
  litter_state: `sensor.${p}_cat_litter_state`,
  bin_state: `sensor.${p}_bin_state`,
  cat_weight: `sensor.${p}_cat_${nkSlug(cat)}`,
  clean: `button.${p}_clean`,
});

const nkSlug = (s) =>
  String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const nkUnslug = (s) =>
  String(s).split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const nkNum = (v, d = 1) => Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const nkMid = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

function nkSpan(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "à l'instant";
  if (m < 60) return `${m}\u00a0min`;
  if (m < 1440) return `${Math.floor(m / 60)}\u00a0h\u00a0${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 1440)}\u00a0j`;
}
const nkAgo = (t) => { const s = nkSpan(Date.now() - t); return s === "à l'instant" ? s : `il y a ${s}`; };

const NK_CSS = `
  :host {
    --nk-sand: #c8b98e; --nk-sand-dark: #9c8f67; --nk-sand-light: #e2d6b1;
    --nk-ok: #8fcaa9; --nk-warn: #d9b36a; --nk-alert: #e38b7a;
    --nk-text: #ecebe6; --nk-dim: #9a9ea6; --nk-faint: #6f747c; --nk-line: rgba(255,255,255,.06);
  }
  ha-card {
    display: block; position: relative; overflow: hidden;
    padding: 22px 24px 20px; border-radius: 24px;
    background: linear-gradient(180deg, #1e2126 0%, #16181c 100%);
    border: 1px solid rgba(255,255,255,.07); box-shadow: none; color: var(--nk-text); font-family: inherit;
  }
  [data-more] { cursor: pointer; }
  [data-more]:focus-visible { outline: 2px solid var(--nk-sand); outline-offset: 2px; border-radius: 8px; }
  .head { display: flex; align-items: center; gap: 14px; }
  .ico {
    flex: none; width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center;
    color: #f1efe9; --mdc-icon-size: 22px;
    background: radial-gradient(circle at 50% 30%, #2b2e34, #1a1c20);
    border: 1px solid rgba(255,255,255,.09);
    box-shadow: 0 0 0 4px rgba(255,255,255,.025), inset 0 1px 0 rgba(255,255,255,.05);
    transition: color .3s, border-color .3s;
  }
  .ico.acc { color: var(--nk-sand); border-color: rgba(200,185,142,.5); }
  .ico.busy { animation: nk-halo 2s ease-in-out infinite; }
  @keyframes nk-halo { 50% { box-shadow: 0 0 0 7px rgba(200,185,142,.10); } }
  .who { flex: 1; min-width: 0; }
  .title { font-size: 18px; font-weight: 600; letter-spacing: -.01em; color: #f4f3ef; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-size: 14px; color: var(--nk-dim); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub.acc { color: var(--nk-sand); } .sub.alert { color: var(--nk-alert); }
  .btn {
    flex: none; height: 40px; width: 68px; padding: 0; border-radius: 999px; cursor: pointer;
    display: grid; place-items: center; --mdc-icon-size: 20px;
    background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.10); color: #f1efe9;
    transition: background .2s, color .2s;
  }
  .btn:hover { background: rgba(255,255,255,.13); }
  .btn:focus-visible { outline: 2px solid var(--nk-sand); outline-offset: 2px; }
  .btn.armed { background: var(--nk-sand); border-color: transparent; color: #1b1c1f; }
  .btn[disabled] { opacity: .35; cursor: default; pointer-events: none; }
  .label { font-size: 11px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: #8b9098; }

  .main { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(0, 1fr); gap: 18px; align-items: center; margin-top: 20px; }
  .clock { position: relative; aspect-ratio: 1; }
  .clock svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .clock .hl { font-size: 12px; fill: var(--nk-faint); font-family: inherit; }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; pointer-events: none; }
  .center .v { font-size: 26px; font-weight: 300; line-height: 1; letter-spacing: -.02em; color: #f6f5f1; white-space: nowrap; }
  .center .v.name { font-size: 19px; font-weight: 400; max-width: 44%; overflow: hidden; text-overflow: ellipsis; }
  .center .v.busy { font-size: 16px; }
  .center .s { font-size: 11px; color: var(--nk-dim); margin-top: 6px; line-height: 1.35; max-width: 44%; }
  .spin { transform-box: fill-box; transform-origin: center; animation: nk-spin 2.4s linear infinite; }
  @keyframes nk-spin { to { transform: rotate(360deg); } }

  .side { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
  .count { display: flex; align-items: baseline; gap: 6px; margin-top: 6px; }
  .count .n { font-size: 40px; font-weight: 200; line-height: 1; color: #f6f5f1; }
  .count .u { font-size: 14px; color: var(--nk-dim); }
  .usual { font-size: 12px; color: var(--nk-faint); margin-top: 4px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; padding: 4px 9px; border-radius: 999px; font-size: 11px; font-weight: 500; background: color-mix(in srgb, currentColor 13%, transparent); }
  .pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .cats { display: grid; gap: 18px; min-width: 0; }
  .w { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
  .w .kg { font-size: 20px; font-weight: 300; color: #f3f2ee; }
  .w .d { font-size: 12px; color: var(--nk-dim); }
  .mini { height: 24px; margin-top: 6px; }
  .mini svg { width: 100%; height: 100%; overflow: visible; display: block; }
  .mini:empty { display: none; }
  .visits { font-size: 12px; color: var(--nk-dim); margin-top: 2px; }
  .visits b { color: var(--nk-text); font-weight: 600; }

  .actions { display: flex; gap: 8px; margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--nk-line); align-items: center; }
  .actions .btn { width: 52px; }
  .actions .spacer { flex: 1; }
  .toggles { display: flex; gap: 4px; }
  .tg {
    display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px;
    border-radius: 50%; cursor: pointer; --mdc-icon-size: 18px;
    background: rgba(255,255,255,.06); border: 1px solid transparent; color: var(--nk-faint);
    transition: color .2s, background .2s;
  }
  .tg:hover { background: rgba(255,255,255,.11); }
  .tg:focus-visible { outline: 2px solid var(--nk-sand); outline-offset: 2px; }
  .tg.on { color: var(--nk-sand); background: rgba(200,185,142,.14); }
  .tg.off { color: var(--nk-faint); }

  .sheet {
    position: absolute; inset: 0; z-index: 5; border-radius: 24px; overflow: hidden;
    background: linear-gradient(180deg, #22252b 0%, #17191d 100%);
    display: flex; flex-direction: column;
    opacity: 0; animation: nk-sheet-in .25s ease forwards;
  }
  @keyframes nk-sheet-in { to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .sheet { animation: none; opacity: 1; } }
  .sheet-head {
    display: flex; align-items: center; gap: 10px; padding: 16px 18px 12px;
    border-bottom: 1px solid var(--nk-line); flex: none;
  }
  .sheet-head .t { flex: 1; font-size: 16px; font-weight: 600; color: #f4f3ef; }
  .sheet-head .s { font-size: 12px; color: var(--nk-dim); margin-top: 2px; }
  .close {
    flex: none; width: 36px; height: 36px; border-radius: 50%; border: none; cursor: pointer;
    display: grid; place-items: center; background: rgba(255,255,255,.08); color: #f1efe9; --mdc-icon-size: 18px;
  }
  .close:hover { background: rgba(255,255,255,.14); }
  .close:focus-visible { outline: 2px solid var(--nk-sand); outline-offset: 2px; }
  .logs { flex: 1; overflow-y: auto; padding: 6px 18px 18px; }
  .logs::-webkit-scrollbar { width: 4px; }
  .logs::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 2px; }
  .day { font-size: 11px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--nk-faint); margin: 16px 0 6px; }
  .log {
    display: flex; align-items: center; gap: 12px; padding: 9px 0; min-width: 0;
    border-bottom: 1px solid rgba(255,255,255,.03);
  }
  .log .av {
    flex: none; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center;
    --mdc-icon-size: 19px; color: #1b1c1f; font-size: 15px; font-weight: 700;
    background: var(--nk-sand);
  }
  .log .av.alt { background: var(--nk-ok); }
  .log .who { flex: 1; min-width: 0; }
  .log .who .n { font-size: 14px; color: var(--nk-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .log .who .h { font-size: 12px; color: var(--nk-dim); margin-top: 1px; }
  .log .kg { flex: none; text-align: right; }
  .log .kg .v { font-size: 15px; color: #f3f2ee; font-weight: 500; }
  .log .kg .u { font-size: 11px; color: var(--nk-faint); }
  .log .dur { flex: none; font-size: 11px; color: var(--nk-faint); min-width: 40px; text-align: right; }
  .empty { padding: 40px 0; text-align: center; color: var(--nk-faint); font-size: 13px; }

  .week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--nk-line); }
  .wk { display: flex; flex-direction: column; align-items: center; gap: 5px; min-width: 0; }
  .wk .n { font-size: 11px; color: var(--nk-dim); height: 14px; line-height: 14px; }
  .wk.today .n { color: var(--nk-text); font-weight: 500; }
  .wk .bwrap { width: 100%; max-width: 30px; height: 56px; display: flex; align-items: flex-end; }
  .wk .b { width: 100%; border-radius: 4px 4px 2px 2px; background: rgba(255,255,255,.13); min-height: 3px; }
  .wk.today .b { background: var(--nk-sand); }
  .wk.zero .b { background: rgba(255,255,255,.05); }
  .wk .lbl { font-size: 11px; color: var(--nk-faint); }
  .wk.today .lbl { color: var(--nk-sand); }

  .supplies { display: grid; grid-template-columns: 1fr 1fr; margin-top: 22px; border-top: 1px solid var(--nk-line); }
  .sup { padding-top: 16px; min-width: 0; }
  .sup:first-child { padding-right: 18px; }
  .sup + .sup { padding-left: 18px; border-left: 1px solid var(--nk-line); }
  .sup .art { height: 50px; margin-top: 10px; display: flex; align-items: flex-end; }
  .sup .art svg { height: 50px; width: auto; max-width: 100%; display: block; overflow: visible; }
  .sup .t { font-size: 15px; color: var(--nk-text); margin-top: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sup .t small { display: block; font-size: 12px; color: var(--nk-dim); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .warn-msg { padding: 16px; font-size: 14px; color: var(--nk-alert); }
  @media (prefers-reduced-motion: reduce) { .spin, .ico.busy { animation: none; } }
`;

class NeakasaLitterCard extends HTMLElement {
  constructor() {
    super();
    this._uid = `nk${++NK_UID}`;
    this._armed = false;
    this._armT = null;
    this._armedLvl = false;
    this._armTLvl = null;
    this._connected = false;
    this._fetching = false;
    this._showLogs = false;
  }

  setConfig(config) {
    const p = config.prefix || 'neakasa_m1';
    const cat = config.cat_name || 'Minou';
    this._config = {
      name: 'Litière',
      room: 'Neakasa M1',
      bin_capacity: 15,
      ...config,
      cat_name: cat,
      integration: null, // détectée au premier set hass
      entities: null,    // résolues à la détection
      ...(config.integration ? { integration: config.integration } : {}),
      ...(config.entities ? { entities: { ...nkDefaultEntities(p, cat), ...config.entities } } : {}),
    };
    this._detected = false;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this._catsList = [];
    this._history = null;
    this._sig = null;
  }

  /* Résout les entités selon l'intégration réellement présente.
   * Priorité : config explicite > ha-neakasa-litterbox > hass-neakasa. */
  _detect(hass) {
    if (this._detected || this._config.entities) { this._detected = true; return; }
    const S = hass.states;
    const p = this._config.prefix || 'neakasa_m1';
    const cat = this._config.cat_name;
    if (S[`sensor.${p}_status`] || S[`button.${p}_clean_now`]) {
      // roquerodrigo/ha-neakasa-litterbox : nom de device configurable, chats = sensor.<chat>_*
      this._config.integration = 'litterbox';
      this._config.entities = {
        status: `sensor.${p}_status`,
        last_usage: `sensor.${p}_last_visit`,
        stay_time: null,
        litter_level: `sensor.${p}_sand_level`,
        litter_state: null,
        bin_state: `binary_sensor.${p}_waste_bucket_full`,
        clean: `button.${p}_clean_now`,
        needs_cleaning: `binary_sensor.${p}_needs_cleaning`,
        level: `button.${p}_level_now`,
        visits_today: `sensor.${p}_visits_today`,
        auto_clean: `switch.${p}_auto_clean`,
        auto_level: `switch.${p}_auto_level`,
        child_lock: `switch.${p}_child_lock`,
        silent_mode: `switch.${p}_silent_mode`,
      };
    } else {
      this._config.integration = 'legacy';
      this._config.entities = nkDefaultEntities(p, cat);
    }
    this._detected = true;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._detect(hass);
    if (!this._catsScanned) this._scanCats();
    const e = this._config.entities;
    const sig = [...Object.values(e), ...this._catsList.map((k) => k.id)]
      .map((id) => id && hass.states[id]?.state).join('|');
    if (sig === this._sig) return;
    const needFetch = !this._history
      || hass.states[e.last_usage]?.state !== this._lastUsage
      || hass.states[e.status]?.state !== this._lastStatus
      || hass.states[e.bin_state]?.state !== this._lastBin;
    this._sig = sig;
    this._lastUsage = hass.states[e.last_usage]?.state;
    this._lastStatus = hass.states[e.status]?.state;
    this._lastBin = hass.states[e.bin_state]?.state;
    if (NK_BUSY.includes(this._lastStatus)) { this._armed = false; this._armedLvl = false; }
    this._render();
    if (needFetch) this._fetch();
  }

  connectedCallback() {
    if (this._connected) return;
    this._connected = true;
    const root = this.shadowRoot;
    root.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-close]')) { this._showLogs = false; this._render(); return; }
      if (ev.target.closest('[data-logs]')) { this._showLogs = true; this._render(); return; }
      const btn = ev.target.closest('.btn');
      if (btn) {
        if (btn.dataset.act === 'level') this._onLevel();
        else this._onClean();
        return;
      }
      const tg = ev.target.closest('[data-toggle]');
      if (tg) { this._onToggle(tg.dataset.toggle); return; }
      const t = ev.target.closest('[data-more]');
      if (t) this._moreInfo(t.dataset.more);
    });
    root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this._showLogs) { this._showLogs = false; this._render(); return; }
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      if (ev.target.closest?.('[data-close]')) { ev.preventDefault(); this._showLogs = false; this._render(); return; }
      if (ev.target.closest?.('[data-logs]')) { ev.preventDefault(); this._showLogs = true; this._render(); return; }
      const tg = ev.target.closest?.('[data-toggle]');
      if (tg) { ev.preventDefault(); this._onToggle(tg.dataset.toggle); return; }
      const t = ev.target.closest?.('[data-more]');
      if (t) { ev.preventDefault(); this._moreInfo(t.dataset.more); }
    });
    this._tick = setInterval(() => this._render(), 60000);
    this._poll = setInterval(() => this._fetch(), 10 * 60000);
  }

  disconnectedCallback() {
    this._connected = false;
    clearInterval(this._tick);
    clearInterval(this._poll);
    clearTimeout(this._armT);
    clearTimeout(this._armTLvl);
  }

  getCardSize() { return 7; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }
  static getStubConfig() { return { name: 'Litière', room: 'Salle de bain', cat_name: 'Minou' }; }

  static async getConfigElement() {
    await nkEnsureHaForm();
    return document.createElement('neakasa-litter-card-editor');
  }

  async _fetch() {
    if (!this._hass || this._fetching || !this._config.entities) return;
    this._fetching = true;
    const e = this._config.entities;
    try {
      if (!this._catsScanned) this._scanCats();
      const start = new Date(nkMid(Date.now()) - 6 * DAY);
      const ids = [
        e.status, e.last_usage, e.bin_state,
        ...this._catsList.map((k) => k.id),
        ...this._catsList.map((k) => k.visitId).filter(Boolean),
        ...this._catsList.map((k) => k.visitsId).filter(Boolean),
      ].filter((id, i, a) => id && this._hass.states[id] && a.indexOf(id) === i);
      this._history = await this._hass.callWS({
        type: 'history/history_during_period',
        start_time: start.toISOString(),
        end_time: new Date().toISOString(),
        entity_ids: ids,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      }) || {};
    } catch (err) {
      console.warn('[neakasa-litter-card] historique indisponible', err);
      this._history = this._history || {};
    } finally {
      this._fetching = false;
    }
    if (this.isConnected) this._render();
  }

  /* ───────────── Chats détectés ───────────── */
  _scanCats() {
    const c = this._config, S = this._hass.states;
    const list = [];
    const seen = new Set();
    const add = (name, id, visitId, visitsId) => {
      if (!id || seen.has(id) || !S[id]) return;
      seen.add(id);
      list.push({
        name: String(name), id,
        visitId: visitId && S[visitId] ? visitId : null,
        visitsId: visitsId && S[visitsId] ? visitsId : null,
      });
    };
    const slug = nkSlug(c.cat_name);
    const explicit = Array.isArray(c.cats) && c.cats.length > 0;

    if (c.integration === 'litterbox') {
      // roquerodrigo : sensor.<chat>_weight, sensor.<chat>_last_visit, sensor.<chat>_visits_today
      if (explicit) {
        c.cats.forEach((n) => add(n, `sensor.${nkSlug(n)}_weight`, `sensor.${nkSlug(n)}_last_visit`, `sensor.${nkSlug(n)}_visits_today`));
      } else {
        const re = /^sensor\.([a-z0-9_]+)_weight$/;
        Object.keys(S).forEach((id) => {
          const m = id.match(re);
          if (!m) return;
          const k = m[1];
          if (/^litiere|litter/.test(k)) return; // exclut l'ancienne entité poids global
          const st = S[id];
          // ne garder que les capteurs issus de l'intégration (unité kg ou lbs)
          if (!/^(kg|lb|lbs)$/i.test(String(st.attributes?.unit_of_measurement ?? 'kg'))) return;
          add(nkUnslug(k), id, `sensor.${k}_last_visit`, `sensor.${k}_visits_today`);
        });
        list.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
      }
      if (!list.length) add(c.cat_name, `sensor.${slug}_weight`, `sensor.${slug}_last_visit`, `sensor.${slug}_visits_today`);
    } else {
      // legacy hass-neakasa : sensor.<prefix>_cat_<slug>
      const esc = String(c.prefix || 'neakasa_m1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (explicit) c.cats.forEach((n) => add(n, `sensor.${esc}_cat_${nkSlug(n)}`));
      add(c.cat_name, c.entities.cat_weight);
      if (!explicit) {
        const re = new RegExp(`^sensor\\.${esc}_cat_([a-z0-9_]+)$`);
        Object.keys(S).forEach((id) => {
          const m = id.match(re);
          if (m && !/^litter_/.test(m[1])) add(nkUnslug(m[1]), id);
        });
        list.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
      }
    }
    this._catsList = list;
    this._catsScanned = true;
  }

  /* ───────────── Données ───────────── */
  _data() {
    const H = this._history || {};
    const e = this._config.entities;
    const S = this._hass.states;
    const now = Date.now();
    const today = nkMid(now);
    const ts = (x) => (x.lu ?? x.lc) * 1000;
    const dayIdx = (t) => Math.round((today - nkMid(t)) / DAY);

    // Passages : chaque valeur distincte de « last usage » = une visite
    const vs = new Set();
    (H[e.last_usage] || []).forEach((x) => { const t = Date.parse(x.s); if (!isNaN(t)) vs.add(t); });
    const cur = Date.parse(S[e.last_usage]?.state);
    if (!isNaN(cur)) vs.add(cur);
    const visits = [...vs]
      .filter((t) => {
        const i = dayIdx(t);
        return t <= now && i >= 0 && i <= 6;
      })
      .sort((a, b) => a - b);

    const perDay = Array(7).fill(0);
    visits.forEach((t) => { perDay[dayIdx(t)] += 1; });
    const prev = perDay.slice(1).filter((n) => n > 0);

    // Cycles de nettoyage (états « busy » fusionnés)
    const sh = (H[e.status] || []).map((x) => ({ t: ts(x), s: x.s }));
    const cycles = [];
    let lastClean = null;
    sh.forEach((x, i) => {
      if (!NK_BUSY.includes(x.s)) return;
      const end = sh[i + 1]?.t ?? null;
      const last = cycles[cycles.length - 1];
      if (last && x.t - (last.b ?? x.t) < 30000) last.b = end;
      else cycles.push({ a: x.t, b: end });
    });
    cycles.forEach((c) => { if (c.b) lastClean = c.b; });

    // Dernier vidage du bac : legacy = passage full/missing → normal ;
    // litterbox = binary_sensor (on → off)
    const bh = (H[e.bin_state] || []).map((x) => ({ t: ts(x), s: x.s }));
    let emptiedAt = null;
    const binKind = (e.bin_state || '').startsWith('binary_sensor.') ? 'binary' : 'text';
    if (binKind === 'binary') {
      bh.forEach((x, i) => { if (i > 0 && x.s === 'off' && bh[i - 1].s === 'on') emptiedAt = x.t; });
    } else {
      bh.forEach((x, i) => { if (i > 0 && x.s === 'normal' && ['full', 'missing'].includes(bh[i - 1].s)) emptiedAt = x.t; });
    }
    const sinceEmpty = emptiedAt ? cycles.filter((c) => c.a > emptiedAt).length : null;

    // Prévision du bac plein : rythme réel depuis vidage, sinon moyenne 7 j
    const cap = Number(this._config.bin_capacity) > 0 ? Number(this._config.bin_capacity) : 15;
    const sinceDays = emptiedAt ? Math.max(0.5, (now - emptiedAt) / DAY) : null;
    const used = sinceEmpty ?? cycles.length;
    let rate = null;
    if (sinceEmpty !== null && sinceDays) rate = sinceEmpty / sinceDays;
    else if (cycles.length >= 3) rate = cycles.length / 7;
    let binEta = null;
    if (rate && rate > 0.05 && used < cap) {
      const d = (cap - used) / rate;
      if (d < 45) binEta = d;
    }

    // Poids par chat : moyenne par jour (recent → ancien après reverse)
    const mkWeights = (id) => {
      const wd = Array.from({ length: 7 }, () => ({ v: 0, n: 0 }));
      const wNow = parseFloat(S[id]?.state);
      (H[id] || []).forEach((x) => {
        const v = parseFloat(x.s), i = dayIdx(ts(x));
        if (!isNaN(v) && v > 0 && i >= 0 && i <= 6) { wd[i].v += v; wd[i].n += 1; }
      });
      if (!isNaN(wNow) && wNow > 0) { wd[0].v += wNow; wd[0].n += 1; }
      return {
        wNow,
        weights: wd.map((d, i) => (d.n ? { i, v: d.v / d.n } : null)).filter(Boolean).reverse(),
      };
    };
    const cats = (this._catsList || []).map((k) => {
      const { wNow, weights } = mkWeights(k.id);
      const ok = !isNaN(wNow) && wNow > 0;
      let delta = '';
      if (ok && weights.length >= 2) {
        const old = weights[weights.length - 1];
        const g = Math.round((wNow - old.v) * 1000);
        const pct = Math.abs(g) / (old.v * 10);
        const col = pct >= 5 ? 'var(--nk-warn)' : 'var(--nk-dim)';
        delta = `<span class="d" style="color:${col}">${Math.abs(g) < 20 ? 'stable' : `${g > 0 ? '+' : '−'}${Math.abs(g)} g`} sur ${old.i + 1} j</span>`;
      }
      const vToday = k.visitsId ? parseInt(S[k.visitsId]?.state, 10) : NaN;
      return { ...k, ok, wNow, weights, delta, mini: this._mini(weights), vToday: isNaN(vToday) ? null : vToday };
    });

    // Toggles réels (absents de l'entité = non affichés)
    const switches = [
      ['auto_clean', 'Nettoyage auto', 'mdi:broom'],
      ['auto_level', 'Nivelage auto', 'mdi:layers'],
      ['silent_mode', 'Mode silencieux', 'mdi:volume-mute'],
      ['child_lock', 'Verrouillage', 'mdi:lock'],
    ].map(([key, label, icon]) => ({ key, label, icon, id: e[key] }))
      .filter((s) => s.id && S[s.id]);

    const needsCleaning = e.needs_cleaning && S[e.needs_cleaning] ? S[e.needs_cleaning].state === 'on' : false;

    /* Journal des passages (comme l'app officielle).
     * HA ne reçoit que des instantanés pollés du cloud : la VALEUR de
     * sensor.<chat>_last_visit est l'heure d'entrée de la DERNIÈRE visite du
     * chat ; les visites intermédiaires du même lot sont perdues et n'apparaî
     * ssent que via le compteur sensor.<chat>_visits_today.
     * Reconstruction :
     *  A. visites connues = chaque valeur de last_visit (heure réelle d'entrée,
     *     poids publié dans le même lot que la réception) ;
     *  B. appariement à un épisode de présence (± 2,5 min de l'entrée) pour la
     *     durée ; visites sans épisode affichées avec leur seule heure ;
     *  C. visites perdues : perdues(chat, jour) = max(visits_today) − connues ;
     *     chaque épisode restant (≥ 30 s) est attribué au chat dont le prochain
     *     relevé connu suit de plus près (≤ 35 min — lots cloud retardés) ;
     *  D. le reste = passages non identifiés ; micro-présences ignorées. */
    const logs = [];
    const CAT_IN_STATES = ['cat_present', 'cat_appears'];

    // 1. épisodes de présence
    const episodes = [];
    let curEp = null;
    (H[e.status] || []).forEach((x) => {
      const t = ts(x), s = x.s;
      if (CAT_IN_STATES.includes(s) && !curEp) curEp = { a: t, b: null };
      else if (!CAT_IN_STATES.includes(s) && curEp) { curEp.b = t; episodes.push(curEp); curEp = null; }
    });
    const curStatus = S[e.status]?.state;
    if (curEp) { curEp.b = now; episodes.push(curEp); }
    else if (CAT_IN_STATES.includes(curStatus)) {
      const lc = Date.parse(S[e.status].last_changed);
      if (!isNaN(lc)) episodes.push({ a: lc, b: now });
    }

    // 2. visites connues par chat : la VALEUR de last_visit = heure réelle
    //    d'entrée ; la réception (lu) sert à apparier le poids publié
    //    dans le même lot du cloud.
    const catVisits = [];
    (this._catsList || []).forEach((k) => {
      if (!k.visitId) return;
      const seenT = new Set();
      const points = [];
      (H[k.visitId] || []).forEach((x) => {
        const tv = Date.parse(x.s);
        if (!isNaN(tv) && !seenT.has(tv)) { seenT.add(tv); points.push({ tv, tr: ts(x) }); }
      });
      const curV = Date.parse(S[k.visitId]?.state);
      if (!isNaN(curV) && !seenT.has(curV)) {
        const lc = Date.parse(S[k.visitId].last_updated);
        points.push({ tv: curV, tr: isNaN(lc) ? now : lc });
      }
      points.sort((a, b) => a.tv - b.tv);
      const wHist = (H[k.id] || [])
        .map((x) => ({ t: ts(x), v: parseFloat(x.s) }))
        .filter((w) => !isNaN(w.v) && w.v > 0)
        .sort((a, b) => a.t - b.t);
      const wCur = parseFloat(S[k.id]?.state);
      if (!isNaN(wCur) && wCur > 0) wHist.push({ t: now, v: wCur });
      points.forEach((p) => {
        if (p.tv > now) return;
        let w = null;
        for (let j = 0; j < wHist.length; j++) {
          if (wHist[j].t >= p.tr - 120000) { w = wHist[j].v; break; }
        }
        if (w === null) w = wHist.length ? wHist[wHist.length - 1].v : null;
        catVisits.push({ cat: k.name, catId: k.id, t: p.tv, w });
      });
    });

    // A+B. appariement visites ↔ épisodes. L'horodatage cloud = heure
    // d'entrée (± drift d'horloge). Priorité : épisode CONTENANT la visite ;
    // à défaut, le plus proche du DÉBUT d'épisode (≤ 3 min, drift max).
    const epFree = new Set(episodes.map((_, i) => i));
    const take = (v) => {
      let hit = null;
      // 1. épisode contenant la visite
      episodes.forEach((ep, i) => {
        if (hit !== null || !epFree.has(i)) return;
        if (v.t >= ep.a - 60000 && v.t <= ep.b + 60000) hit = i;
      });
      // 2. sinon : le plus proche du début, ≤ 10 min (l'entrée peut précéder
      //    l'horodatage cloud — pesée en cours de visite, lots retardés)
      if (hit === null) {
        let best = Infinity;
        episodes.forEach((ep, i) => {
          if (!epFree.has(i)) return;
          const d = Math.abs(v.t - ep.a);
          if (d <= 600000 && d < best) { best = d; hit = i; }
        });
      }
      if (hit !== null) {
        epFree.delete(hit);
        const ep = episodes[hit];
        logs.push({ cat: v.cat, catId: v.catId, t: v.t, dur: ep.b - ep.a, w: v.w, inferred: false, epIdx: hit });
      } else {
        logs.push({ cat: v.cat, catId: v.catId, t: v.t, dur: null, w: v.w, inferred: false });
      }
    };
    catVisits.slice().sort((a, b) => a.t - b.t).forEach((v) => take(v));

    // C. visites perdues, par chat et par jour, via les compteurs
    const lost = {}; // catId -> { day -> perdus }
    (this._catsList || []).forEach((k) => {
      if (!k.visitsId) return;
      const maxDay = {}; // dayIdx -> max visites du jour
      const bump = (val, t) => {
        const d = dayIdx(t);
        if (d < 0 || d > 6) return;
        const n = parseInt(val, 10);
        if (!isNaN(n) && n > (maxDay[d] ?? 0)) maxDay[d] = n;
      };
      (H[k.visitsId] || []).forEach((x) => bump(x.s, ts(x)));
      bump(S[k.visitsId]?.state, now);
      const known = {}; // dayIdx -> nb de visites connues
      catVisits.forEach((v) => {
        if (v.catId !== k.id) return;
        const d = dayIdx(v.t);
        if (d >= 0 && d <= 6) known[d] = (known[d] || 0) + 1;
      });
      const per = {};
      Object.keys(maxDay).forEach((d) => {
        const l = maxDay[d] - (known[d] || 0);
        if (l > 0) per[d] = l;
      });
      if (Object.keys(per).length) lost[k.id] = per;
    });

    // quotas de visites perdues par chat et par jour (copies modifiables)
    const lostKeys = {};
    (this._catsList || []).forEach((k) => { if (lost[k.id]) lostKeys[k.id] = { ...lost[k.id] }; });
    const nextKnown = (kId, after, d) => {
      let next = null;
      catVisits.forEach((v) => {
        if (v.catId !== kId || dayIdx(v.t) !== d || v.t <= after) return;
        if (next === null || v.t < next) next = v.t;
      });
      return next;
    };

    // C bis. passages multiples dans un même épisode : si le chat a encore des
    // visites perdues et que sa pesée connue est ≥ 5 min APRÈS l'entrée de
    // l'épisode apparié, l'épisode a contenu plusieurs passages — l'entrée de
    // l'épisode est le premier (compteur : 2 visites, 1 pesée).
    Object.keys(lostKeys).forEach((kId) => {
      Object.keys(lostKeys[kId]).forEach((d) => {
        while ((lostKeys[kId][d] ?? 0) > 0) {
          const k = (this._catsList || []).find((c) => c.id === kId);
          if (!k) break;
          // pesée connue de ce chat appariée à un épisode, sans doublon déjà déduit
          const target = logs.find((l) =>
            l.catId === kId && !l.inferred && l.epIdx !== undefined
            && !logs.some((m) => m.inferred && m.catId === kId && m.epIdx === l.epIdx)
            && (l.t - episodes[l.epIdx].a) >= 300000);
          if (!target) break;
          const ep = episodes[target.epIdx];
          lostKeys[kId][d] -= 1;
          logs.push({ cat: k.name, catId: kId, t: ep.a, dur: null, w: null, inferred: true, epIdx: target.epIdx });
        }
      });
    });
    // C. attribution des autres visites perdues : appariement glouton par
    // distance minimale globale — l'épisode dont le prochain relevé connu est
    // le plus proche est traité d'abord, chaque chat ne pouvant recevoir que
    // le nombre de visites qu'il a réellement perdues ce jour.
    // construire toutes les paires (épisode, chat, distance) possibles
    const pairs = [];
    [...epFree]
      .filter((i) => (episodes[i].b - episodes[i].a) >= 5000)
      .forEach((i) => {
        const ep = episodes[i];
        const d = dayIdx(ep.a);
        (this._catsList || []).forEach((k) => {
          const l = lostKeys[k.id]?.[d] ?? 0;
          if (l <= 0) return;
          const next = nextKnown(k.id, ep.a, d);
          if (next === null) return;
          const dist = next - ep.a;
          if (dist <= 35 * 60000) pairs.push({ ep: i, k, d, dist });
        });
      });
    // traiter les paires les plus proches d'abord
    pairs.sort((a, b) => a.dist - b.dist);
    pairs.forEach((p) => {
      if (!epFree.has(p.ep)) return;
      if ((lostKeys[p.k.id]?.[p.d] ?? 0) <= 0) return;
      lostKeys[p.k.id][p.d] -= 1;
      epFree.delete(p.ep);
      const ep = episodes[p.ep];
      logs.push({ cat: p.k.name, catId: p.k.id, t: ep.a, dur: ep.b - ep.a, w: null, inferred: true });
    });

    [...epFree].forEach((i) => {
      const ep = episodes[i];
      if ((ep.b - ep.a) < 5000) return; // micro-présence ignorée
      logs.push({ cat: null, catId: null, t: ep.a, dur: ep.b - ep.a, w: null, inferred: false });
    });

    logs.sort((a, b) => b.t - a.t);
    const logsLimited = logs.slice(0, 50);

    return { now, today, dayIdx, visits, perDay, prev, cycles, lastClean, emptiedAt, sinceEmpty, binEta, cats, switches, needsCleaning, logs: logsLimited };
  }

  /* ───────────── Cadran 24 h × 7 jours ───────────── */
  _clock(D, busy) {
    const C = 116, R0 = 92, ST = 6;
    const ang = (t) => { const d = new Date(t); return ((d.getHours() + d.getMinutes() / 60) / 24) * 2 * Math.PI - Math.PI / 2; };
    const at = (a, r) => [C + r * Math.cos(a), C + r * Math.sin(a)].map((n) => n.toFixed(1));
    let g = '';
    for (let h = 0; h < 24; h += 3) {
      const a = (h / 24) * 2 * Math.PI - Math.PI / 2;
      const [x1, y1] = at(a, R0 + 5), [x2, y2] = at(a, R0 + (h % 6 ? 8 : 10));
      g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(255,255,255,${h % 6 ? 0.12 : 0.28})" stroke-width="1.2" stroke-linecap="round"/>`;
    }
    [['0 h', 0], ['6 h', 6], ['12 h', 12], ['18 h', 18]].forEach(([l, h]) => {
      const [x, y] = at((h / 24) * 2 * Math.PI - Math.PI / 2, R0 + 25);
      g += `<text class="hl" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central">${l}</text>`;
    });
    for (let i = 6; i >= 0; i--) {
      g += `<circle cx="${C}" cy="${C}" r="${R0 - i * ST}" fill="none" stroke="rgba(255,255,255,${i ? 0.04 : 0.07})" stroke-width="${i ? 1 : 2}"/>`;
    }
    const an = ang(D.now);
    const [sx, sy] = at(-Math.PI / 2, R0), [ex, ey] = at(an, R0);
    const large = an + Math.PI / 2 > Math.PI ? 1 : 0;
    g += `<path d="M${sx},${sy} A${R0},${R0} 0 ${large} 1 ${ex},${ey}" fill="none" stroke="rgba(255,255,255,.17)" stroke-width="2" stroke-linecap="round"/>`;
    D.visits.forEach((t) => {
      const i = D.dayIdx(t);
      const [x, y] = at(ang(t), R0 - i * ST);
      g += `<circle cx="${x}" cy="${y}" r="${i ? 2.3 : 3.4}" fill="var(--nk-sand)" opacity="${i ? (0.62 - i * 0.07).toFixed(2) : 1}"/>`;
    });
    g += `<circle cx="${ex}" cy="${ey}" r="3" fill="#f4f3ef" style="filter:drop-shadow(0 0 4px rgba(255,255,255,.7))"/>`;
    if (busy) {
      const r = R0;
      g += `<circle cx="${C}" cy="${C}" r="${r}" fill="none" stroke="rgba(200,185,142,.12)" stroke-width="2"/>
            <circle class="spin" cx="${C}" cy="${C}" r="${r}" fill="none" stroke="var(--nk-sand)" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="${(2 * Math.PI * r * 0.22).toFixed(1)} 999"/>`;
    }
    return `<svg viewBox="0 0 ${2 * C} ${2 * C}" aria-hidden="true">${g}</svg>`;
  }

  /* ───────────── Bac de litière (niveau en « grains ») ───────────── */
  _tray(level, low) {
    const id = this._uid;
    const lv = isNaN(level) ? 0 : Math.max(0, Math.min(100, level)) / 100;
    const y = 42 - lv * 34;
    const tray = 'M2,6 H158 L151,40 Q150,44 146,44 H14 Q10,44 9,40 Z';
    return `<svg viewBox="0 0 160 48" aria-hidden="true">
      <defs>
        <pattern id="${id}g" width="7" height="6" patternUnits="userSpaceOnUse">
          <rect width="7" height="6" fill="var(--nk-sand)"/>
          <circle cx="1.5" cy="1.6" r=".9" fill="var(--nk-sand-light)"/>
          <circle cx="5" cy="4.2" r=".8" fill="var(--nk-sand-dark)"/>
          <circle cx="4.9" cy="1" r=".5" fill="#b3a57c"/>
        </pattern>
        <clipPath id="${id}c"><path d="${tray}"/></clipPath>
      </defs>
      <path d="${tray}" fill="rgba(255,255,255,.03)"/>
      <g clip-path="url(#${id}c)">
        <path d="M0,${y + 1} Q40,${y - 2} 80,${y} T160,${y + 0.5} V48 H0 Z" fill="url(#${id}g)"/>
      </g>
      <path d="${tray}" fill="none" stroke="${low ? 'var(--nk-alert)' : 'rgba(255,255,255,.22)'}" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>`;
  }

  /* ───────────── Bac à déchets (un « grumeau » par cycle) ───────────── */
  _bin(state, n) {
    const id = this._uid;
    const body = 'M8,10 H52 L48.6,44 Q48.2,47 45,47 H15 Q11.8,47 11.4,44 Z';
    const missing = state === 'missing', full = state === 'full';
    let fill = '';
    if (full) {
      fill = `<g clip-path="url(#${id}b)"><rect x="0" y="10" width="60" height="40" fill="rgba(227,139,122,.28)"/></g>`;
    } else if (n) {
      const k = Math.min(n, 30);
      for (let j = 0; j < k; j++) {
        const row = Math.floor(j / 6), col = j % 6;
        const x = 16 + col * 5.6 + (row % 2 ? 2.4 : 0) + ((j * 7) % 3) * 0.3;
        const yy = 42 - row * 5.2 - ((j * 5) % 3) * 0.3;
        fill += `<circle cx="${x.toFixed(1)}" cy="${yy.toFixed(1)}" r="${(2 + ((j * 3) % 3) * 0.25).toFixed(2)}" fill="var(--nk-sand-dark)"/>`;
      }
      fill = `<g clip-path="url(#${id}b)">${fill}</g>`;
    }
    const stroke = full ? 'var(--nk-alert)' : 'rgba(255,255,255,.22)';
    return `<svg viewBox="0 0 60 50" aria-hidden="true">
      <defs><clipPath id="${id}b"><path d="${body}"/></clipPath></defs>
      <path d="${body}" fill="rgba(255,255,255,.03)" ${missing ? 'opacity=".4"' : ''}/>
      ${fill}
      <path d="${body}" fill="none" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round" ${missing ? 'stroke-dasharray="3 3" opacity=".6"' : ''}/>
      <path d="M5,6.5 H55 M25,6.5 V3.5 H35 V6.5" fill="none" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" ${missing ? 'stroke-dasharray="3 3" opacity=".6"' : ''}/>
    </svg>`;
  }

  /* ───────────── Mini tendance du poids (moyenne par jour) ───────────── */
  _mini(ws) {
    if (ws.length < 2) return '';
    const vals = ws.map((w) => w.v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 0.3) { const c = (hi + lo) / 2; lo = c - 0.15; hi = c + 0.15; }
    const W = 120, H = 24;
    const xy = ws.map((w) => [((6 - w.i) / 6) * W, 3 + (1 - (w.v - lo) / (hi - lo)) * (H - 6)]);
    const pts = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const dots = xy.map(([x, y], k) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${k === xy.length - 1 ? 2.6 : 1.6}" fill="${k === xy.length - 1 ? '#f4f3ef' : 'rgba(255,255,255,.45)'}"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMid meet" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.2" stroke-linejoin="round"/>${dots}
    </svg>`;
  }

  /* ───────────── Rendu ───────────── */
  _render() {
    if (!this._hass || !this._config || !this.shadowRoot) return;
    const c = this._config, e = c.entities, S = this._hass.states;
    const st = (id) => S[id]?.state;

    if (!S[e.status]) {
      this.shadowRoot.innerHTML = `<style>${NK_CSS}</style><ha-card><div class="warn-msg">
        Entité introuvable : <b>${e.status}</b><br>Vérifie le paramètre <code>prefix</code> ou <code>entities</code>.</div></ha-card>`;
      return;
    }

    const D = this._data();
    const status = st(e.status);
    const busy = NK_BUSY.includes(status);
    const catIn = ['cat_present', 'cat_appears'].includes(status);
    const alert = NK_ALERT.includes(status) || st(e.bin_state) === 'on' && (e.bin_state || '').startsWith('binary_sensor.');
    const cats = D.cats;
    // Chat présent : si un seul chat connu, c'est lui ; sinon on désigne celui
    // dont le dernier passage est très récent (≤ 15 min), sinon indéterminé.
    let mainCat = cats.length === 1 ? cats[0].name : (cats.length ? null : c.cat_name);
    if (catIn && !mainCat && cats.length > 1) {
      const recent = cats
        .map((k) => [k.name, Date.parse(S[k.visitId || k.id]?.state) || 0])
        .filter(([, t]) => t && Date.now() - t < 15 * 60000)
        .sort((a, b) => b[1] - a[1]);
      if (recent.length === 1) mainCat = recent[0][0];
    }

    // En-tête
    const labels = {
      idle: `Prête${D.lastClean ? ` · nettoyée ${nkAgo(D.lastClean)}` : ''}`,
      cat_present: mainCat ? `${mainCat} est à l'intérieur` : 'Un chat est à l\u2019intérieur',
      cat_appears: mainCat ? `${mainCat} est à l'intérieur` : 'Un chat est à l\u2019intérieur',
      cleaning: 'Nettoyage en cours',
      leveling: 'Nivelage de la litière',
      restoring: 'Remise en place',
      flipover: 'Évacuation des déchets',
      paused: 'En pause',
      side_bin_locking_panels_missing: 'Panneaux latéraux absents',
      cleaning_interrupted: 'Nettoyage interrompu',
    };
    const sub = labels[status] || 'Hors ligne';
    const subCls = alert ? 'alert' : (catIn || busy) ? 'acc' : '';

    // Centre du cadran
    const lastT = D.visits.length ? D.visits[D.visits.length - 1] : Date.parse(st(e.last_usage));
    const stay = e.stay_time ? parseFloat(st(e.stay_time)) : NaN;
    const stayTxt = isNaN(stay) ? '' : `<br>resté ${stay >= 60 ? `${Math.floor(stay / 60)} min ${String(Math.round(stay % 60)).padStart(2, '0')}` : `${Math.round(stay)} s`}`;
    let center;
    if (catIn) {
      const since = Date.parse(S[e.status].last_changed);
      center = `<div class="v name">${mainCat || 'Chat'}</div><div class="s">à l'intérieur${isNaN(since) ? '' : `<br>depuis ${nkSpan(Date.now() - since)}`}</div>`;
    } else if (busy) {
      center = `<div class="v name busy">Nettoyage</div><div class="s">${{ leveling: 'nivelage', flipover: 'évacuation' }[status] || 'en cours'}</div>`;
    } else if (!isNaN(lastT)) {
      center = `<div class="v">${nkSpan(Date.now() - lastT)}</div><div class="s">depuis son passage${stayTxt}</div>`;
    } else {
      center = `<div class="v">—</div><div class="s">aucun passage</div>`;
    }

    // Rythme du jour
    const todayCount = D.perDay[0];
    const hoursSince = isNaN(lastT) ? Infinity : (Date.now() - lastT) / 3600000;
    let usual = '', pill;
    if (D.prev.length >= 3) {
      const lo = Math.min(...D.prev), hi = Math.max(...D.prev);
      usual = lo === hi ? `habituellement ${lo}` : `habituellement ${lo} à ${hi}`;
      if (hoursSince >= 24) pill = ['var(--nk-alert)', 'Aucun passage depuis 24 h'];
      else if (todayCount > hi) pill = ['var(--nk-warn)', "Plus que d'habitude"];
      else pill = ['var(--nk-ok)', 'Dans ses habitudes'];
    } else if (isNaN(lastT) && this._history) {
      usual = 'aucun passage enregistré';
      pill = ['var(--nk-dim)', 'En attente de passages'];
    } else {
      usual = this._history ? 'quelques jours de données' : 'chargement…';
      pill = ['var(--nk-dim)', 'Apprend ses habitudes'];
    }

    // Consommables
    const lvl = parseFloat(st(e.litter_level));
    const ls = e.litter_state ? st(e.litter_state) : null, bs = st(e.bin_state);
    const binBinary = (e.bin_state || '').startsWith('binary_sensor.');
    const binFull = binBinary ? bs === 'on' : bs === 'full';
    const low = ls === 'insufficient' || (binBinary && !isNaN(lvl) && lvl <= 10 && !ls);
    let binTxt;
    if (binFull) binTxt = '<span style="color:var(--nk-alert)">Plein</span><small>à vider</small>';
    else if (!binBinary && bs === 'missing') binTxt = '<span style="color:var(--nk-alert)">Absent</span><small>bac non détecté</small>';
    else {
      const cnt = D.sinceEmpty !== null
        ? `${D.sinceEmpty} cycle${D.sinceEmpty > 1 ? 's' : ''} depuis le vidage`
        : `${D.cycles.length} cycle${D.cycles.length > 1 ? 's' : ''} sur 7 j`;
      const eta = D.binEta === null ? '' : D.binEta < 1 ? ' · plein imminent' : ` · plein dans ~${Math.round(D.binEta)} j`;
      binTxt = `OK<small>${cnt}${eta}</small>`;
    }

    // Histogramme 7 jours (J-6 → aujourd'hui)
    const maxDay = Math.max(1, ...D.perDay);
    const bars = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(D.today);
      d.setDate(d.getDate() - i);
      const n = D.perDay[i];
      const lbl = d.toLocaleDateString('fr-FR', { weekday: 'narrow' });
      const title = `${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' })} : ${n} passage${n > 1 ? 's' : ''}`;
      bars.push(`<div class="wk${i === 0 ? ' today' : ''}${n === 0 ? ' zero' : ''}" data-more="${e.last_usage}" tabindex="0" role="button" title="${title}">
        <div class="n">${n > 0 ? n : ''}</div>
        <div class="bwrap"><div class="b" style="height:${Math.max(5, Math.round((n / maxDay) * 100))}%"></div></div>
        <div class="lbl">${lbl}</div>
      </div>`);
    }

    const armed = this._armed && !catIn && !busy;
    const armedLvl = this._armedLvl && !catIn && !busy;
    const canLevel = !!(e.level && S[e.level]);
    const canClean = !!(e.clean && S[e.clean]);
    const hasLogs = D.logs.length > 0;

    this.shadowRoot.innerHTML = `
      <style>${NK_CSS}</style>
      <ha-card>
        <div class="head">
          <div class="ico ${catIn || busy ? 'acc' : ''} ${busy ? 'busy' : ''}" data-more="${e.status}" tabindex="0"><ha-icon icon="mdi:cat"></ha-icon></div>
          <div class="who">
            <div class="title">${c.name} · ${c.room}</div>
            <div class="sub ${subCls}">${sub}</div>
            ${D.needsCleaning ? '<div class="sub alert">Besoin de nettoyage</div>' : ''}
          </div>
          ${canLevel ? `
          <button class="btn ${armedLvl ? 'armed' : ''}" data-act="level" ${catIn || busy ? 'disabled' : ''}
            title="${armedLvl ? 'Appuie encore pour confirmer' : 'Niveler la litière'}" aria-label="${armedLvl ? 'Confirmer le nivelage' : 'Niveler la litière'}">
            <ha-icon icon="${armedLvl ? 'mdi:check' : 'mdi:layers'}"></ha-icon>
          </button>` : ''}
          ${canClean ? `
          <button class="btn ${armed ? 'armed' : ''}" data-act="clean" ${catIn || busy ? 'disabled' : ''}
            title="${armed ? 'Appuie encore pour confirmer' : 'Lancer un nettoyage'}" aria-label="${armed ? 'Confirmer le nettoyage' : 'Lancer un nettoyage'}">
            <ha-icon icon="${armed ? 'mdi:check' : 'mdi:shimmer'}"></ha-icon>
          </button>` : ''}
        </div>

        <div class="main">
          <div class="clock" data-more="${e.last_usage}" tabindex="0" role="button" aria-label="Passages des 7 derniers jours selon l'heure">
            ${this._clock(D, busy)}
            <div class="center">${center}</div>
          </div>
          <div class="side">
            <div data-more="${e.last_usage}" tabindex="0" role="button">
              <div class="label">Aujourd'hui</div>
              <div class="count"><span class="n">${this._history ? todayCount : '—'}</span><span class="u">passage${todayCount > 1 ? 's' : ''}</span></div>
              <div class="usual">${usual}</div>
              <span class="pill" style="color:${pill[0]}"><i></i>${pill[1]}</span>
            </div>
            ${cats.length ? `<div class="cats">${cats.map((k) => `
            <div data-more="${k.id}" tabindex="0" role="button">
              <div class="label">Poids · ${k.name}</div>
              <div class="w"><span class="kg">${k.ok ? nkNum(k.wNow, 2) : '—'} kg</span>${k.delta}</div>
              <div class="mini">${k.mini}</div>
              ${k.vToday !== null ? `<div class="visits">${k.vToday} passage${k.vToday > 1 ? 's' : ''} aujourd'hui</div>` : ''}
            </div>`).join('')}</div>` : ''}
          </div>
        </div>

        <div class="week">${bars.join('')}</div>

        <div class="supplies">
          <div class="sup" data-more="${e.litter_level}" tabindex="0" role="button">
            <div class="label">Litière</div>
            <div class="art">${this._tray(lvl, low)}</div>
            <div class="t">${isNaN(lvl) ? '—' : `${Math.round(lvl)} %`}<small style="${low ? 'color:var(--nk-alert)' : ''}">${NK_LITTER[ls] || (binBinary && low ? 'à recharger' : '')}</small></div>
          </div>
          <div class="sup" data-more="${e.bin_state}" tabindex="0" role="button">
            <div class="label">Bac à déchets</div>
            <div class="art">${this._bin(binFull ? 'full' : binBinary ? 'normal' : bs, D.sinceEmpty)}</div>
            <div class="t">${binTxt}</div>
          </div>
        </div>

        ${D.switches.length ? `
        <div class="actions">
          ${D.switches.map((s) => `
          <div class="tg ${st(s.id) === 'on' ? 'on' : 'off'}" data-toggle="${s.id}" tabindex="0" role="button"
            title="${s.label} : ${st(s.id) === 'on' ? 'activé' : 'désactivé'}" aria-label="${s.label}">
            <ha-icon icon="${s.icon}"></ha-icon>
          </div>`).join('')}
          <div class="spacer"></div>
          ${hasLogs ? `
          <div class="tg" data-logs="1" tabindex="0" role="button" title="Journal des passages" aria-label="Journal des passages">
            <ha-icon icon="mdi:clipboard-text-clock"></ha-icon>
          </div>` : ''}
        </div>` : hasLogs ? `
        <div class="actions">
          <div class="spacer"></div>
          <div class="tg" data-logs="1" tabindex="0" role="button" title="Journal des passages" aria-label="Journal des passages">
            <ha-icon icon="mdi:clipboard-text-clock"></ha-icon>
          </div>
        </div>` : ''}

        ${this._showLogs ? this._logsSheet(D) : ''}
      </ha-card>`;
  }

  /* ───────────── Journal des passages (sheet plein écran carte) ───────────── */
  _logsSheet(D) {
    const e = this._config.entities;
    // regrouper par jour (fr), plus récent en tête
    const groups = [];
    let curDay = null;
    D.logs.forEach((l) => {
      const d = new Date(l.t);
      const key = nkMid(l.t);
      if (key !== curDay) {
        curDay = key;
        groups.push({ key, label: d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }), items: [] });
      }
      groups[groups.length - 1].items.push(l);
    });
    const catsSeen = [...new Set(D.logs.filter((l) => l.cat).map((l) => l.cat))];
    const colorOf = (name) => (name && catsSeen.length > 1 && name === catsSeen[1] ? 'var(--nk-ok)' : 'var(--nk-sand)');
    const initials = (name) => name ? name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() : '?';

    const rows = groups.map((g) => `
      <div class="day">${g.label}</div>
      ${g.items.map((l) => {
        const d = new Date(l.t);
        const h = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        const durTxt = l.dur ? ` · ${nkSpan(l.dur)}` : '';
        return `<div class="log">
          <div class="av" style="background:${colorOf(l.cat)};${l.cat ? '' : 'background:rgba(255,255,255,.15);color:var(--nk-dim);'}">${initials(l.cat)}</div>
          <div class="who" ${l.catId ? `data-more="${l.catId}" tabindex="0" role="button"` : ''}>
            <div class="n">${l.cat || 'Chat non identifié'}${l.inferred ? ' <span style="font-size:10px;color:var(--nk-faint)">·déduit</span>' : ''}</div>
            <div class="h">${h}${durTxt}</div>
          </div>
          ${l.w !== null && l.w !== undefined ? `<div class="kg"><div class="v">${nkNum(l.w, 2)}</div><div class="u">kg</div></div>` : '<div class="kg"><div class="v">—</div></div>'}
        </div>`;
      }).join('')}`).join('');

    const known = D.logs.filter((l) => l.cat).length;
    return `
      <div class="sheet">
        <div class="sheet-head">
          <div style="flex:1">
            <div class="t">Passages</div>
            <div class="s">${D.logs.length} sur 7 jours${catsSeen.length > 1 ? ` · ${catsSeen.length} chats` : ''}${known < D.logs.length ? ` · ${D.logs.length - known} non identifié${D.logs.length - known > 1 ? 's' : ''}` : ''}</div>
          </div>
          <button class="close" data-close="1" aria-label="Fermer"><ha-icon icon="mdi:close"></ha-icon></button>
        </div>
        <div class="logs">${rows || '<div class="empty">Aucun passage enregistré</div>'}</div>
      </div>`;
  }

  _onClean() {
    const e = this._config.entities;
    if (!this._hass.states[e.clean]) return;
    if (this._armed) {
      clearTimeout(this._armT);
      this._armed = false;
      this._hass.callService('button', 'press', { entity_id: e.clean });
      this._render();
      return;
    }
    this._armed = true;
    this._render();
    this._armT = setTimeout(() => { this._armed = false; this._render(); }, 3000);
  }

  _onLevel() {
    const e = this._config.entities;
    if (!this._hass.states[e.level]) return;
    if (this._armedLvl) {
      clearTimeout(this._armTLvl);
      this._armedLvl = false;
      this._hass.callService('button', 'press', { entity_id: e.level });
      this._render();
      return;
    }
    this._armedLvl = true;
    this._render();
    this._armTLvl = setTimeout(() => { this._armedLvl = false; this._render(); }, 3000);
  }

  _onToggle(id) {
    const state = this._hass.states[id];
    if (!state) return;
    this._hass.callService('switch', state.state === 'on' ? 'turn_off' : 'turn_on', { entity_id: id });
  }

  _moreInfo(entityId) {
    if (!entityId || !this._hass.states[entityId]) return;
    this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
  }
}

if (!customElements.get('neakasa-litter-card')) {
  customElements.define('neakasa-litter-card', NeakasaLitterCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'neakasa-litter-card',
    name: 'Neakasa M1 · Litière',
    description: 'Rythme de passage, poids par chat, litière, bac à déchets et prévision du plein.',
    preview: false,
    documentationURL: 'https://github.com/junkoku38/neakasa-litter-card',
  });
}

/* ═══════════════════════ Éditeur visuel ═══════════════════════ */

const nkFireEvent = (node, type, detail = {}) => {
  const ev = new Event(type, { bubbles: true, cancelable: false, composed: true });
  ev.detail = detail;
  node.dispatchEvent(ev);
};

async function nkEnsureHaForm() {
  if (customElements.get('ha-form')) return true;
  try {
    const helpers = await window.loadCardHelpers();
    const card = helpers.createCardElement({ type: 'entities', entities: [] });
    if (card?.constructor?.getConfigElement) await card.constructor.getConfigElement();
  } catch (err) {
    console.warn('[neakasa-litter-card] ha-form indisponible', err);
  }
  return !!customElements.get('ha-form');
}

const NK_EDIT_KEYS = ['name', 'room', 'cat_name', 'cats', 'bin_capacity', 'prefix'];
const NK_EDIT_MANAGED = [...NK_EDIT_KEYS, 'type', 'entities', 'integration'];
const NK_EDIT_LABELS = {
  name: 'Nom affiché',
  room: 'Pièce',
  cat_name: 'Chat principal',
  cats: 'Chats (liste)',
  bin_capacity: 'Capacité du bac (cycles)',
  prefix: 'Préfixe des entités',
};
const NK_EDIT_HELPERS = {
  cat_name: 'Chat affiché quand la litière détecte une présence sans pouvoir identifier le chat.',
  cats: 'Optionnel. Liste explicite des chats (multi-chats), ex. « Minou, Nana ». Vide = détection automatique.',
  bin_capacity: 'Nombre de cycles de nettoyage avant de considérer le bac plein (défaut 15).',
  prefix: 'Préfixe des entity_id de la litière, ex. « neakasa_m1 ». Laisser vide pour utiliser celui détecté.',
};

const NK_EDIT_SCHEMA = [
  { name: 'name', selector: { text: {} } },
  { name: 'room', selector: { text: {} } },
  { name: 'cat_name', selector: { text: {} } },
  { name: 'cats', selector: { text: {} } },
  {
    type: 'expandable', name: '', title: 'Avancé', icon: 'mdi:tune',
    schema: [
      { name: 'bin_capacity', selector: { number: { min: 3, max: 60, mode: 'box', unit_of_measurement: 'cycles' } } },
      { name: 'prefix', selector: { text: {} } },
    ],
  },
];

class NeakasaLitterCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
  }

  setConfig(config) {
    this._config = config ? { ...config } : {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  connectedCallback() {
    nkEnsureHaForm().then(() => this._render());
  }

  _data() {
    const c = this._config || {};
    const d = {};
    NK_EDIT_KEYS.forEach((k) => {
      if (c[k] !== undefined) d[k] = Array.isArray(c[k]) ? c[k].join(', ') : c[k];
    });
    return d;
  }

  _merge(v) {
    const out = { ...this._config };
    NK_EDIT_KEYS.forEach((k) => {
      const val = v[k];
      if (k === 'cats') {
        const arr = String(val ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (arr.length) out.cats = arr; else delete out.cats;
        return;
      }
      if (val === '' || val === undefined || val === null) delete out[k];
      else out[k] = val;
    });
    return out;
  }

  _unmanaged() {
    return Object.keys(this._config || {}).filter((k) => !NK_EDIT_MANAGED.includes(k));
  }

  _render() {
    if (!this.shadowRoot) return;
    if (!customElements.get('ha-form')) {
      this.shadowRoot.innerHTML = `<style>${NeakasaLitterCardEditor.styles}</style>
        <div class="warn">Le composant <code>ha-form</code> n'a pas pu être chargé.
        Utilisez l'éditeur YAML de la carte.</div>`;
      return;
    }
    if (!this._form) {
      this.shadowRoot.innerHTML = `<style>${NeakasaLitterCardEditor.styles}</style>
        <div class="wrap"></div><div class="note"></div>`;
      this._form = document.createElement('ha-form');
      this._form.computeLabel = (s) => NK_EDIT_LABELS[s.name] || s.name;
      this._form.computeHelper = (s) => NK_EDIT_HELPERS[s.name] || '';
      this._form.addEventListener('value-changed', (ev) => {
        ev.stopPropagation();
        nkFireEvent(this, 'config-changed', { config: this._merge(ev.detail.value) });
      });
      this.shadowRoot.querySelector('.wrap').appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = NK_EDIT_SCHEMA;
    this._form.data = this._data();
    const extra = this._unmanaged();
    const note = this.shadowRoot.querySelector('.note');
    if (extra.length) {
      note.innerHTML = `<div class="keep">Conservé sans être éditable ici : <b></b>. Passez par l'éditeur YAML pour y toucher.</div>`;
      note.querySelector('b').textContent = extra.join(', ');
    } else note.innerHTML = '';
  }
}

NeakasaLitterCardEditor.styles = `
:host{display:block;}
.warn,.keep{margin-top:12px;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.5;}
.warn{background:var(--warning-color,#dfb37a);color:#1c1c1c;}
.keep{background:rgba(143,176,201,.16);color:var(--primary-text-color);border:1px solid rgba(143,176,201,.4);}
code{font-family:monospace;}
`;

if (!customElements.get('neakasa-litter-card-editor')) {
  customElements.define('neakasa-litter-card-editor', NeakasaLitterCardEditor);
}