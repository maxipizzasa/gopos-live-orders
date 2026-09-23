// ==UserScript==
// @name         Maxipizza · GoPOS Live Orders
// @namespace    https://maxipizza.pl/gopos-live-orders
// @version      0.7.0
// @description  Pokazuje numer kuchenny zamówienia pod awatarem źródła na kartach Live Orders w GoPOS
// @author       Maxipizza
// @match        https://app.gopos.io/*
// @run-at       document-idle
// @noframes
// @updateURL    https://maxipizzasa.github.io/gopos-live-orders/maxipizza-live-orders.user.js
// @downloadURL  https://maxipizzasa.github.io/gopos-live-orders/maxipizza-live-orders.user.js
// @connect      maxipizzasa.github.io
// @connect      api.maxipizza.org
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// ==/UserScript==

/*
 * Standalone: no backend, no login. Everything comes from the GoPOS page itself.
 *
 * How it works
 *  1. GoPOS renders every live order as `.live-orders-list-item` (React) and loads orders with
 *     `include=custom_fields`. The order object with its custom fields sits in the React fiber
 *     props of the card (`memoizedProps.order`), so no DOM scraping of numbers is needed.
 *  2. The kitchen number is the custom field `kitchenOrderNumber` of that object.
 *  3. Rendering (variant "a2" of the mockups): the source avatar (the coloured circle with
 *     GoPOS / GoOrder / Bolt…) is shrunk from 60 to 44 px and the kitchen number is placed right
 *     under it, centred on the same axis, 22 px condensed bold. No band, no label, the card keeps
 *     its height. The avatar is found by shape (a circle ≥ 36 px outside the right-hand column),
 *     not by class name, so a GoPOS class rename does not break it.
 *     - If the avatar sits in its own column, the number is inserted as its sibling and the column
 *       is turned into a centred flex column (layout mode).
 *     - Otherwise the number is absolutely positioned under the measured avatar (absolute mode).
 *     React leaves our elements alone because it never created them; when GoPOS re-mounts a card
 *     the MutationObserver puts everything back.
 *  4. GoPOS is a single-page app: going from the home page to Live Orders does not reload the
 *     page, so the script matches the whole app, attaches its observer once, and does nothing
 *     until live-order cards show up in the DOM.
 *
 * Distribution: this file is served from GitHub Pages (https://maxipizzasa.github.io/gopos-live-orders/); Tampermonkey
 * follows @updateURL and installs a new version on its own whenever @version grows.
 * Remote control: https://maxipizzasa.github.io/gopos-live-orders/config.json is polled once a minute (cache-busted):
 *   { "enabled": true, "avatarSize": 44, "numberSize": 22 }
 * enabled=false removes everything the script drew and pauses it on every machine within a minute;
 * the two sizes let the look be tuned without shipping a new version. Fetch failures keep the last
 * known state (fail-open), so an outage of the config host never blanks the screens.
 *
 * Order age status color: the org id is read from the URL (`/{orgId}/...`) and used to poll
 * `https://dev.maxipizza.org/public/{orgId}/order-preparation-time/` (needs `Accept: application/json`,
 * the endpoint defaults to XML otherwise) once a minute for
 *   { "statusGreenMinutes": 15, "statusOrangeMinutes": 30, "statusRedMinutes": 45, "delayedOrderQueueThresholdMinutes": 60 }
 * Each card's border/background is colored by elapsed minutes since an anchor time: green while
 * under statusGreenMinutes, orange until statusOrangeMinutes, red from there on (statusRedMinutes
 * is carried but not used for coloring). The anchor is `order.created_at`, except for "delayed"
 * orders (scheduled well after they were placed: gap between created_at and
 * estimated_delivery_at/estimated_preparation_at exceeds DELAYED_ORDER_THRESHOLD_MINUTES) whose
 * anchor is instead `calculated_delivery_at - delayedOrderQueueThresholdMinutes`, where
 * calculated_delivery_at is the later of estimated_preparation_at/estimated_delivery_at; such an
 * order stays uncolored until that anchor time arrives. Cards with the GoPOS class "external" are
 * left untouched. Fetch failures keep the last known thresholds (fail-open); before the first
 * successful fetch, no card is colored.
 */
(function () {
  'use strict';

  const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.0.0';
  /** Live-orders route of the SPA, e.g. /2876/live_orders/list. Evaluated on every scan, never cached. */
  const onLiveOrdersPage = () => /^\/\d+\/live_orders(\/|$)/.test(location.pathname);

  const CARD_SELECTOR = '.live-orders-list-item';
  const TABLE_ITEM_SELECTOR = '.live-orders-table-item';   // one per card, wraps CARD_SELECTOR
  const STATUS_COLOR_LIMIT = 4;                             // only the first N cards get age colors
  const DELAYED_ORDER_THRESHOLD_MINUTES = 75;               // mirrors backend isDelayed()
  const RIGHT_BOX_SELECTOR = '.live-orders-list-item-right-box';
  const LEFT_BOX_SELECTOR = '.live-orders-list-item-left-box';   // best guess, optional
  const CONFIG_URL = 'https://maxipizzasa.github.io/gopos-live-orders/config.json';
  const CONFIG_POLL_MS = 60000;
  const PREP_TIME_URL = (orgId) => `https://api.maxipizza.org/public/${orgId}/order-preparation-time/`;
  const PREP_TIME_POLL_MS = 60000;
  const GAP = 6;

  const state = {
    debug: !!GM_getValue('debug', false),
    enabled: true,
    avatarSize: 44,      // GoPOS default is 60; both sizes can be overridden by config.json
    numberSize: 22,
    prepTime: null,      // { greenMin, orangeMin, redMin, delayedQueueMin } once fetched, else no coloring
  };
  const log = (...args) => { if (state.debug) console.log('[mxp]', ...args); };

  /** Org id from the SPA path, e.g. "2876" from "/2876/live_orders/list". Null off an org route. */
  function orgIdFromPath() {
    const m = /^\/(\d+)(\/|$)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function toggleDebug() {
    state.debug = !state.debug;
    GM_setValue('debug', state.debug);
    alert('Maxipizza debug: ' + (state.debug ? 'ON' : 'OFF'));
  }
  GM_registerMenuCommand('Maxipizza: debug on/off', toggleDebug);

  // ------------------------------------------------------------------ GoPOS DOM / React
  /** GoPOS order object from the React fiber of a card, or null when GoPOS changed its internals. */
  function orderFromCard(card) {
    const key = Object.keys(card).find((k) => k.startsWith('__reactFiber$'));
    let fiber = key ? card[key] : null;
    for (let i = 0; i < 12 && fiber; i++) {
      const props = fiber.memoizedProps;
      if (props && props.order && props.order.id) return props.order;
      fiber = fiber.return;
    }
    return null;
  }

  function collectCards() {
    const result = [];
    document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
      const order = orderFromCard(card);
      if (order) result.push({ card, order });
    });
    return result;
  }

  /**
   * Kitchen number from the GoPOS order object: the custom field `kitchenOrderNumber`.
   * Accepts the API shape (`custom_fields: [{slug, value}]`, as returned by
   * GET /ajax/{org}/orders/live_orders?include=custom_fields) and a few normalized shapes.
   * Null when the order carries none.
   */
  function kitchenNumberFrom(order) {
    if (!order) return null;
    const direct = order.kitchen_order_number || order.kitchenOrderNumber;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const fields = order.custom_fields || order.customFields;
    if (Array.isArray(fields)) {
      const f = fields.find((x) => x && (x.slug === 'kitchenOrderNumber' || x.name === 'kitchenOrderNumber'));
      if (f && typeof f.value === 'string' && f.value.trim()) return f.value.trim();
    } else if (fields && typeof fields === 'object') {
      const v = fields.kitchenOrderNumber;
      const str = typeof v === 'string' ? v : (v && typeof v.value === 'string' ? v.value : null);
      if (str && str.trim()) return str.trim();
    }
    return null;
  }

  /**
   * The source avatar: the coloured circle with GoPOS / GoOrder / Bolt… on the left of the card.
   * Found by shape, not by class name, so GoPOS class renames do not break it:
   *   1. a circle (border-radius ≥ 40 % of its width) of at least 30 px, roughly square;
   *   2. otherwise an <img> / <svg> of at least 30 px, roughly square (a logo without radius);
   *   3. otherwise the largest roughly square element of at least 30 px.
   * Only elements left of the right-hand column and outside it count. Null when nothing fits.
   */
  const avatarCache = new WeakMap();
  function describe(el) {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, class: String(el.className || '').slice(0, 60), w: Math.round(r.width), h: Math.round(r.height),
             radius: getComputedStyle(el).borderTopLeftRadius, left: Math.round(r.left) };
  }
  function leftSideCandidates(card) {
    const rightBox = card.querySelector(RIGHT_BOX_SELECTOR);
    const limit = rightBox ? rightBox.getBoundingClientRect().left : Infinity;
    const leftBox = card.querySelector(LEFT_BOX_SELECTOR);
    const scope = leftBox || card;
    const out = [];
    for (const el of scope.querySelectorAll('*')) {
      if (el.closest('[data-mxp]')) continue;
      if (rightBox && (el === rightBox || rightBox.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20 || r.left >= limit) continue;
      out.push(el);
    }
    return out;
  }
  function isSquarish(r) { const ratio = r.width / r.height; return ratio > 0.8 && ratio < 1.25; }
  function isRound(el, r) {
    const raw = getComputedStyle(el).borderTopLeftRadius;
    const v = parseFloat(raw);
    if (!v) return false;
    return raw.includes('%') ? v >= 40 : v >= r.width * 0.4;
  }
  function findAvatar(card) {
    const cached = avatarCache.get(card);
    if (cached && card.contains(cached)) return cached;
    const cands = leftSideCandidates(card).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 30 && r.height >= 30 && isSquarish(r);
    });
    let pick = cands.find((el) => isRound(el, el.getBoundingClientRect()))
      || cands.find((el) => el.tagName === 'IMG' || el.tagName === 'SVG')
      || cands.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
      || null;
    if (pick) avatarCache.set(card, pick);
    return pick;
  }

  // ------------------------------------------------------------------ rendering
  let styleEl = null;
  function applyStyles() {
    const css = `
    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700&display=swap');
    .mxp-avatar { width: ${state.avatarSize}px !important; height: ${state.avatarSize}px !important;
                  min-width: ${state.avatarSize}px !important; min-height: ${state.avatarSize}px !important;
                  max-width: ${state.avatarSize}px !important; max-height: ${state.avatarSize}px !important;
                  font-size: 11px !important; overflow: hidden !important; }
    .mxp-avatar img, .mxp-avatar svg { max-width: 100% !important; max-height: 100% !important; }
    .mxp-leftcol { display: flex !important; flex-direction: column !important; align-items: center !important;
                   gap: ${GAP}px !important; }
    .mxp-kn { font-family: "Barlow Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif;
              font-weight: 700; font-size: ${state.numberSize}px; line-height: 1; letter-spacing: .01em;
              font-variant-numeric: tabular-nums; color: #212529; white-space: nowrap; pointer-events: none; }
    .mxp-kn.mxp-none { opacity: .35; }
    .mxp-kn.mxp-abs { position: absolute; transform: translateX(-50%); }
    .mxp-status-green, .mxp-status-orange, .mxp-status-red {
      border-width: 1px !important; border-style: solid !important;
    }
    .mxp-status-green  { background-color: #eeffee !important; border-color: green !important; }
    .mxp-status-orange { background-color: #f7f1cd !important; border-color: orange !important; }
    .mxp-status-red    { background-color: #ffeeee !important; border-color: red !important; }
    `;
    if (!styleEl) styleEl = GM_addStyle(css);
    else styleEl.textContent = css;
  }
  applyStyles();

  /**
   * Shrinks the avatar (class + inline sizes, belt and braces against React re-applying styles)
   * and returns the number element placed under it, creating it when missing.
   * Layout mode when the avatar has its own column, absolute mode otherwise.
   */
  function ensureNumber(card, avatar) {
    const px = state.avatarSize + 'px';
    if (!avatar.classList.contains('mxp-avatar') || avatar.style.width !== px) {
      avatar.classList.add('mxp-avatar');
      avatar.style.width = avatar.style.height = px;
      avatar.style.minWidth = avatar.style.minHeight = px;
    }
    let kn = card.querySelector('[data-mxp="kn"]');
    if (!kn) {
      kn = document.createElement('span');
      kn.className = 'mxp-kn';
      kn.dataset.mxp = 'kn';
    }
    const col = avatar.parentElement;
    const rightBox = card.querySelector(RIGHT_BOX_SELECTOR);
    const ownColumn = col && col !== card && !(rightBox && col.contains(rightBox));
    if (ownColumn) {
      if (!col.classList.contains('mxp-leftcol')) col.classList.add('mxp-leftcol');
      if (kn.previousElementSibling !== avatar || kn.parentElement !== col) avatar.insertAdjacentElement('afterend', kn);
      kn.classList.remove('mxp-abs');
      kn.style.left = kn.style.top = '';
      card.dataset.mxpMode = 'layout';
    } else {
      if (kn.parentElement !== card) card.appendChild(kn);
      kn.classList.add('mxp-abs');
      const cs = getComputedStyle(card);
      if (cs.position === 'static') card.style.position = 'relative';
      const cr = card.getBoundingClientRect(), ar = avatar.getBoundingClientRect();
      kn.style.left = Math.round(ar.left - cr.left + ar.width / 2) + 'px';
      const top = Math.round(ar.bottom - cr.top + GAP);
      kn.style.top = top + 'px';
      const needed = top + state.numberSize + (parseFloat(cs.paddingBottom) || 0);
      if (needed > cr.height) card.style.minHeight = Math.ceil(needed) + 'px';
      card.dataset.mxpMode = 'absolute';
    }
    return kn;
  }

  function render(card, value) {
    const avatar = findAvatar(card);
    if (!avatar) return false;
    const kn = ensureNumber(card, avatar);
    const sig = value || '';
    if (kn.dataset.sig !== sig) {          // idempotent: no flicker on every poll
      kn.dataset.sig = sig;
      kn.textContent = value || '—';
      kn.classList.toggle('mxp-none', !value);
      kn.title = value ? 'Numer kuchenny GoPOS' : 'Zamówienie nie ma numeru kuchennego';
    }
    return true;
  }

  /** Undo everything the script did to the page (kill switch). */
  function removeAll() {
    document.querySelectorAll('[data-mxp="kn"]').forEach((el) => el.remove());
    document.querySelectorAll('.mxp-avatar').forEach((el) => {
      el.classList.remove('mxp-avatar');
      el.style.width = el.style.height = el.style.minWidth = el.style.minHeight = '';
    });
    document.querySelectorAll('.mxp-leftcol').forEach((el) => el.classList.remove('mxp-leftcol'));
    document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
      if (card.dataset.mxpMode) { card.style.minHeight = ''; delete card.dataset.mxpMode; }
      clearStatusColor(card);
    });
  }

  // ------------------------------------------------------------------ order age status color
  const STATUS_CLASSES = ['mxp-status-green', 'mxp-status-orange', 'mxp-status-red'];

  /** Mirrors backend isDelayed(): true when the gap between created_at and the order's estimated
   *  delivery/preparation time exceeds DELAYED_ORDER_THRESHOLD_MINUTES. */
  function isOrderDelayed(order) {
    const created = new Date(order.created_at).getTime();
    const timeStr = order.estimated_delivery_at || order.estimated_preparation_at;
    if (!timeStr || !Number.isFinite(created)) return false;
    const time = new Date(timeStr).getTime();
    if (!Number.isFinite(time)) return false;
    return (time - created) / 60000 > DELAYED_ORDER_THRESHOLD_MINUTES;
  }

  /** Later of estimated_preparation_at / estimated_delivery_at as epoch ms, or null if neither parses. */
  function calculatedDeliveryAt(order) {
    const prep = order.estimated_preparation_at ? new Date(order.estimated_preparation_at).getTime() : NaN;
    const delivery = order.estimated_delivery_at ? new Date(order.estimated_delivery_at).getTime() : NaN;
    if (!Number.isFinite(prep) && !Number.isFinite(delivery)) return null;
    if (!Number.isFinite(prep)) return delivery;
    if (!Number.isFinite(delivery)) return prep;
    return Math.max(prep, delivery);
  }

  /** Anchor time (epoch ms) for the age-based status color: created_at, or for a delayed order,
   *  calculated_delivery_at minus the delayed-queue threshold. Falls back to created_at when the
   *  threshold or the delivery time isn't available (fail-open). */
  function statusStartTime(order) {
    const created = new Date(order.created_at).getTime();
    if (!isOrderDelayed(order)) return created;
    const delayedQueueMin = state.prepTime.delayedQueueMin;
    if (!Number.isFinite(delayedQueueMin) || delayedQueueMin <= 0) return created;
    const deliveryAt = calculatedDeliveryAt(order);
    if (deliveryAt == null) return created;
    return deliveryAt - delayedQueueMin * 60000;
  }

  /** 'mxp-status-green'/'orange'/'red' from order age vs state.prepTime, or null (no thresholds
   *  yet / bad date / a delayed order whose anchor time hasn't arrived yet). */
  function statusClassFor(order) {
    if (!state.prepTime || !order || !order.created_at) return null;
    const start = statusStartTime(order);
    if (!Number.isFinite(start)) return null;
    const elapsedMin = (Date.now() - start) / 60000;
    if (elapsedMin < 0) return null;   // delayed order not due for prep yet: stay uncolored
    if (elapsedMin < state.prepTime.greenMin) return 'mxp-status-green';
    if (elapsedMin < state.prepTime.orangeMin) return 'mxp-status-orange';
    return 'mxp-status-red';
  }

  function clearStatusColor(card) {
    if (!card.dataset.mxpStatus) return;
    card.classList.remove(...STATUS_CLASSES);
    delete card.dataset.mxpStatus;
  }

  /**
   * Colors the card border/background by order age; skips GoPOS "external" cards entirely, and
   * cards past `eligible` (only the first STATUS_COLOR_LIMIT `.live-orders-table-item` get colored).
   */
  function applyStatusColor(card, order, eligible) {
    if (!eligible || card.classList.contains('external')) { clearStatusColor(card); return; }
    const cls = statusClassFor(order);
    if (!cls) { clearStatusColor(card); return; }
    if (card.dataset.mxpStatus === cls) return;   // idempotent: no flicker on every poll
    card.classList.remove(...STATUS_CLASSES);
    card.classList.add(cls);
    card.dataset.mxpStatus = cls;
  }

  // ------------------------------------------------------------------ remote config
  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    const enabled = cfg.enabled !== false;
    let sizesChanged = false;
    if (Number.isFinite(cfg.avatarSize) && cfg.avatarSize >= 24 && cfg.avatarSize <= 80 && cfg.avatarSize !== state.avatarSize) {
      state.avatarSize = cfg.avatarSize; sizesChanged = true;
    }
    if (Number.isFinite(cfg.numberSize) && cfg.numberSize >= 12 && cfg.numberSize <= 48 && cfg.numberSize !== state.numberSize) {
      state.numberSize = cfg.numberSize; sizesChanged = true;
    }
    if (sizesChanged) applyStyles();
    const wasEnabled = state.enabled;
    if (enabled !== wasEnabled) {
      state.enabled = enabled;
      log(enabled ? 'enabled by config' : 'disabled by config');
      if (!enabled) removeAll();
    }
    if (enabled && (sizesChanged || !wasEnabled)) scheduleScan();   // re-render right away, not on the next tick
  }

  function fetchConfig() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: CONFIG_URL + '?t=' + Date.now(),      // cache-buster: GitHub Pages caches for 10 minutes
      timeout: 10000,
      onload: (res) => {
        if (res.status < 200 || res.status >= 300) { log('config http', res.status); return; }
        try { applyConfig(JSON.parse(res.responseText)); }
        catch (e) { log('config parse failed', e); }
      },
      onerror: () => log('config fetch failed'),
      ontimeout: () => log('config fetch timeout'),
    });
  }

  function applyPrepTime(data) {
    if (!data || typeof data !== 'object') return;
    const { statusGreenMinutes: g, statusOrangeMinutes: o, statusRedMinutes: r, delayedOrderQueueThresholdMinutes: d } = data;
    if (![g, o, r].every((n) => Number.isFinite(n) && n > 0) || !(g < o)) {
      log('prep-time rejected (bad thresholds)', data);
      return;
    }
    state.prepTime = { greenMin: g, orangeMin: o, redMin: r, delayedQueueMin: d };
    log('prep-time updated', state.prepTime);
    scheduleScan();   // re-color right away, not on the next tick
  }

  function fetchPrepTime() {
    const orgId = orgIdFromPath();
    if (!orgId) return;
    GM_xmlhttpRequest({
      method: 'GET',
      url: PREP_TIME_URL(orgId),
      headers: { 'Accept': 'application/json' },   // the endpoint serves XML without this header
      timeout: 10000,
      onload: (res) => {
        if (res.status < 200 || res.status >= 300) { log('prep-time http', res.status); return; }
        try { applyPrepTime(JSON.parse(res.responseText)); }
        catch (e) { log('prep-time parse failed', e); }
      },
      onerror: () => log('prep-time fetch failed'),
      ontimeout: () => log('prep-time fetch timeout'),
    });
  }

  // ------------------------------------------------------------------ scan loop
  let loggedMode = false;
  function scan() {
    if (!state.enabled) return;                    // kill switch from config.json
    if (!onLiveOrdersPage()) return;               // cheap gate: the observer runs on every GoPOS page
    const items = collectCards();
    if (!items.length) return;
    const coloredWrappers = new Set(
      Array.prototype.slice.call(document.querySelectorAll(TABLE_ITEM_SELECTOR), 0, STATUS_COLOR_LIMIT)
    );
    let withNumber = 0, noAvatar = 0;
    for (const { card, order } of items) {
      const kn = kitchenNumberFrom(order);
      if (kn) withNumber++;
      if (!render(card, kn)) noAvatar++;
      const wrapper = card.closest(TABLE_ITEM_SELECTOR);
      applyStatusColor(card, order, !wrapper || coloredWrappers.has(wrapper));
    }
    if (!loggedMode && items.length) {
      loggedMode = true;
      const card = items[0].card;
      const av = findAvatar(card);
      log('avatar', { found: !!av, mode: card.dataset.mxpMode, ...(av ? describe(av) : {}) });
      if (!av) {
        // Nothing recognised: dump what is on the left of the card so the heuristic can be fixed.
        log('left-side candidates', leftSideCandidates(card).slice(0, 15).map(describe));
        log('card children', [...card.children].map(describe));
      }
    }
    log('scan', { cards: items.length, withNumber, noAvatar });
  }

  // Throttle, not debounce: GoPOS re-renders the time badges every second, so a trailing
  // debounce that resets on every mutation could be starved. Here the first mutation of a
  // burst arms a single 300 ms timer and later mutations do not touch it.
  let timer = null;
  function scheduleScan() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, 300);
  }

  const observer = new MutationObserver((mutations) => {
    // ignore our own writes
    for (const m of mutations) {
      const t = m.target;
      if (t && t.closest && t.closest('[data-mxp]')) continue;
      scheduleScan();
      return;
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // SPA navigation: React swaps views without a reload, which the observer above sees as DOM
  // mutations, so no history hooks are needed. popstate covers the browser back button as well.
  window.addEventListener('popstate', scheduleScan);
  setInterval(scheduleScan, 15000);   // safety net when GoPOS updates state without touching the DOM
  fetchConfig();
  setInterval(fetchConfig, CONFIG_POLL_MS);
  fetchPrepTime();
  setInterval(fetchPrepTime, PREP_TIME_POLL_MS);
  scheduleScan();
  if (state.debug) window.__mxpState = state;   // inspection hook, debug mode only
  log('started', { version: SCRIPT_VERSION, path: location.pathname, liveOrders: onLiveOrdersPage() });3
})();
