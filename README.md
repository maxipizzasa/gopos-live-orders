# Maxipizza · GoPOS Live Orders

Userscript for Tampermonkey. On `https://app.gopos.io/{orgId}/live_orders/list` it shows the **kitchen
number** of every order (GoPOS custom field `kitchenOrderNumber`, e.g. `M57`) under a smaller source
avatar on each card. The number is read from the GoPOS page itself; the script has no backend and
makes no requests of its own apart from its remote config.

| File | Purpose |
|---|---|
| `maxipizza-live-orders.user.js` | the script; install URL and auto-update source |
| `config.json` | remote control: `enabled` (kill switch), `avatarSize`, `numberSize` |

Served from GitHub Pages: <https://maxipizzasa.github.io/gopos-live-orders/>

## Instalacja na komputerze (Chrome, Windows / macOS)

1. Zainstaluj **Tampermonkey** ze sklepu Chrome.
2. `chrome://extensions` → Tampermonkey → **Szczegóły** → włącz **Zezwalaj na skrypty użytkownika**
   (Chrome 138+; w starszym Chrome włącz **Tryb dewelopera** na `chrome://extensions`).
3. Otwórz w tej samej przeglądarce:
   **<https://maxipizzasa.github.io/gopos-live-orders/maxipizza-live-orders.user.js>**
   i kliknij **Zainstaluj** w oknie Tampermonkey.
4. Otwórz GoPOS → Live Orders. Pod kółkiem źródła każdego zamówienia pojawia się numer kuchenny;
   `—` oznacza zamówienie bez numeru.

Nic więcej nie trzeba konfigurować. Aktualizacje instalują się same.

## Updates

Bump `@version` in the script header and push to `main`. Tampermonkey compares `@updateURL` with the
installed version on its schedule (Tampermonkey → Settings → *Script Update* → check interval; set it
to a few hours) and installs the new file silently. GitHub Pages caches files for up to 10 minutes.

Do not change `@grant`, `@connect`, `@match` or `@run-at` in an update unless unavoidable: Tampermonkey
then asks every machine to confirm the new permissions.

## Kill switch and tuning

Edit `config.json` on GitHub (web editor is fine), commit to `main`:

```json
{ "enabled": false, "avatarSize": 44, "numberSize": 22 }
```

Every machine polls the file once a minute with a cache-buster, so `enabled: false` removes the numbers
and pauses the script within about a minute; setting it back to `true` restores them. `avatarSize`
(24–80) and `numberSize` (12–48) restyle the cards live, without a new script version. If the file is
unreachable the script keeps its last state.

## Order age colors

Each card's border/background is colored by how long ago the order was created, using per-org
thresholds from `https://api.maxipizza.org/public/{orgId}/order-preparation-time/` (org id read from
the URL, e.g. `2876` in `/2876/live_orders/list`), polled once a minute:

```json
{ "statusGreenMinutes": 15, "statusOrangeMinutes": 30, "statusRedMinutes": 45, "delayedOrderQueueThresholdMinutes": 60 }
```

Green while the order is younger than `statusGreenMinutes`, orange until `statusOrangeMinutes`, red
from there on (`statusRedMinutes` and `delayedOrderQueueThresholdMinutes` are fetched but not used
for coloring). Cards with the GoPOS class `external` are never colored. If the endpoint is
unreachable no card is colored until it first succeeds; after that, fetch failures keep the last
known thresholds.

## Debug

Tampermonkey menu → **Maxipizza: debug on/off**, reload. Console, filter `[mxp]`:
`started {version, path, liveOrders}`, `avatar {found, mode, tag, class, w, h}` for the first card,
`scan {cards, withNumber, noAvatar}` on every pass. When `found` is false the script also prints
`left-side candidates` and `card children` so the avatar heuristic can be fixed.

## History

Earlier versions (0.1–0.2) fetched customer history, loyalty and reputation from a dedicated endpoint
in maxipizza-api; 0.3 went standalone with a footer band; 0.4 moved the number under the avatar; 0.5
added GitHub Pages distribution and `config.json`; 0.6 added per-org order age status colors.
