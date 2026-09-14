// ==UserScript==
// @name         Maxipizza · GoPOS Live Orders
// @namespace    https://maxipizza.pl/gopos-live-orders
// @version      0.5.1
// @description  Pokazuje numer kuchenny zamówienia pod awatarem źródła na kartach Live Orders w GoPOS
// @author       Maxipizza
// @match        https://app.gopos.io/*
// @run-at       document-idle
// @noframes
// @updateURL    https://maxipizzasa.github.io/gopos-live-orders/maxipizza-live-orders.user.js
// @downloadURL  https://maxipizzasa.github.io/gopos-live-orders/maxipizza-live-orders.user.js
// @connect      maxipizzasa.github.io
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
 */
(function () {
  'use strict';

  const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.0.0';
  /** Live-orders route of the SPA, e.g. /2876/live_orders/list. Evaluated on every scan, never cached. */
  const onLiveOrdersPage = () => /^\/\d+\/live_orders(\/|$)/.test(location.pathname);

  const CARD_SELECTOR = '.live-orders-list-item';
  const RIGHT_BOX_SELECTOR = '.live-orders-list-item-right-box';
  const LEFT_BOX_SELECTOR = '.live-orders-list-item-left-box';   // best guess, optional
  const CONFIG_URL = 'https://maxipizzasa.github.io/gopos-live-orders/config.json';
  const CONFIG_POLL_MS = 60000;
  const GAP = 6;

  const state = {
    debug: !!GM_getValue('debug', false),
    enabled: true,
    avatarSize: 44,      // GoPOS default is 60; both sizes can be overridden by config.json
    numberSize: 22,
  };
  const log = (...args) => { if (state.debug) console.log('[mxp]', ...args); };

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
    });
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

  // ------------------------------------------------------------------ scan loop
  let loggedMode = false;
  function scan() {
    if (!state.enabled) return;                    // kill switch from config.json
    if (!onLiveOrdersPage()) return;               // cheap gate: the observer runs on every GoPOS page
    const items = collectCards();
    if (!items.length) return;
    let withNumber = 0, noAvatar = 0;
    for (const { card, order } of items) {
      const kn = kitchenNumberFrom(order);
      if (kn) withNumber++;
      if (!render(card, kn)) noAvatar++;
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
  scheduleScan();
  if (state.debug) window.__mxpState = state;   // inspection hook, debug mode only
  log('started', { version: SCRIPT_VERSION, path: location.pathname, liveOrders: onLiveOrdersPage() });
})();
