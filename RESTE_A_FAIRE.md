# Dashboard (openclaw-dash) — détail du reste à faire

Audit du 24/11/2026 (Luna) — app : `/home/lydstyl/apps/openclaw-dash` (dashboard.lan :3015)

## 1. Timestamp — fraîcheur des infos

**État actuel** : les cartes cachent leurs données avec des TTL hétérogènes,
sans aucun affichage de fraîcheur côté page :

| Donnée | Cache / source |
|---|---|
| Météo | TTL 15 min (stale accepté si API KO) |
| Statut LLM (Pour IA) | TTL 10 s |
| État watchdog | cache 60 s |
| Vitesse LLM | fichier `data/llm-speed.json` (collecteur) |
| Tâches Pour IA | fichier `data/pour-ia.json` (dispatch) |
| Énergie | `data/energy_prices.json` + relevés Zigbee |

**À faire** :
1. Backend : exposer `updated_at` (ISO) dans le JSON de chaque carte à données
   (GTD Pour IA, Vitesse LLM, Énergie, PC).
2. Front (`lib/page.js`) : ligne « maj il y a X min » sous le titre de chaque
   carte concernée.
3. Badge « ⚠️ infos > 2 min » (orange) si `updated_at` est plus vieux que 2 min —
   c'est le seuil demandé par Gabriel.
4. Test unitaire du calcul « il y a X min » + du badge stale (lib/dates.js existe déjà).

## 2. Archi — clean archi + tests + env dev  ✅ (25/11/2026, Luna)

**Fait (commits f3f48cd → 676fd68 → ce commit) :**
1. ✅ **Refacto commitée** : `lib/` (dates, energy, pc, pour-ia, render, usage, page)
   + `__tests__/` + `index.js` + compose + package — dans le dépôt (plus « volé »).
2. ✅ **Env dev dockerisé** : `docker-compose.dev.yml` (miroir prod, port 3028,
   `./index.js` + `./lib` en ro). Bug corrigé : le nginx stale routait
   `dev.dashboard.lan` → 3027 (« Liste Sites ») au lieu de 3028 ; régénéré via
   `gen-gab-lan.py`. Le process pm2 nu (openclaw-dash-dev) remplacé par le conteneur
   (`restart: unless-stopped`, survit au reboot). Vérifié : `dev.dashboard.lan` 200
   « Dashboard », prod 3015 intact.
3. ✅ **Tests e2e étendus** : +5 routes locales (card-visibility, card-order, links,
   energy-prices, top-processes). Les routes `/app/…` et `/host/…` = conteneur-only.
4. ⏳ **Extraction index.js** : `lib/plugs.js` (getPlugEntity, getPlugPowerEntity,
   smoothedPower — anti-clignotement testable via `now` injectable) + `lib/occ.js`
   (occSlotsStats) extraits. **106 tests verts** (vitest, ~3,2 s).

**Reste (prochain incrément — adaptateurs I/O, plus risqué) :**
- Isoler les adaptateurs I/O restants dans `lib/` : sonde SSH (sshReachable,
  sshLlmReady, runBootJob, runShutJob, killLlmOnPc), watchdog (loadWatchdogState),
  LLM224 (probeLlama224, occProbeNode, getOccupancy), HTTP HA (haSwitch*, haPlugPowerW),
  credits (getOllamaUsage, getKimi/DeepSeekCredits). index.js → routes + wiring.
- Chaque extraction : function auto-contenue + unit test + boot dev vérifié (pattern plugs/occ).


## 3. Freelance — commits + workly + synthèse heures + facture

**État actuel** : aucune carte Freelance dans le dashboard.
Sources : `2509-workly` (workly.lan) = front statique, données en **localStorage**
(clé dans `src/constants.js`), API `/health` + `/` uniquement.
`2510-invoices` = app facturation.

**À faire** :
1. **Export workly** : bouton « Exporter JSON » dans work-tracker (localStorage →
   fichier) ou endpoint POST ; déposer le JSON dans `openclaw-dash/data/`.
   Sans ça, le dashboard ne peut pas lire les heures.
2. **Carte Freelance** dans le dashboard (`lib/` + section page.js) :
   - Commits : `git log --author --since=7d --oneline` sur les repos freelances
     (liste à confirmer avec Gabriel : quels repos comptent ?)
   - Heures workly par jour/semaine (depuis le JSON exporté)
   - Synthèse : heures × taux → montant estimable
   - Facture : lien vers l'app invoices + statut (à faire / envoyée)
3. Décider du périmètre : quels clients/repos = « freelance » pour le comptage
   de commits (question à trancher avec Gabriel).

## Ordre suggéré
1. Commit de la refacto (5 min, débloque tout)
2. Timestamp + badge stale (petit, visible immédiatement)
3. Env dev (convention déjà posée sur l'autre dashboard)
4. Freelance (le plus gros — nécessite l'export workly + périmètre commits)
