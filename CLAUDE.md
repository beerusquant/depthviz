# CLAUDE.md — depthviz

> Règles propres à ce repo. Elles précisent le CLAUDE.md global, elles ne l'annulent pas.
> Chaque règle ci-dessous est née d'une erreur réelle ou d'une mesure faite dans ce repo :
> si tu en ajoutes une, ajoute la preuve avec.

---

## 1. La donnée avant l'affichage

Cet outil n'a qu'un seul produit : un carnet d'ordres juste. Un graphe qui rend bien
avec les mauvais chiffres est un bug plus grave qu'un graphe cassé, parce qu'il ne se
signale pas.

- **Une taille de carnet est en unités de base, toujours.** Trois venues ne cotent pas
  ainsi : OKX SWAP (`ctVal * ctMult`, et `/ prix` sur les inverses), MEXC perp
  (`contractSize`), Hyperliquid spot (contextes keyés par `ctx.coin`, **jamais** par
  index — l'alignement positionnel donne −99,9 % d'erreur). Une conversion oubliée est
  une erreur ×100 invisible : le graphe reste beau, seuls les zéros changent.
- **Jamais de chiffre sans protocole.** Une profondeur s'énonce avec sa venue, sa bande
  (±x %) et l'instant. « $70M de profondeur » ne veut rien dire.
- **Toute profondeur au-delà de ±0,6 % sur Binance et MEXC est une borne inférieure**,
  pas un fait. Ces carnets ne dépassent leur snapshot qu'en accumulant des diffs : les
  niveaux lointains présents avant la connexion et jamais retouchés nous sont invisibles
  à jamais. Le chiffre ne peut que monter. L'UI le dit, le code ne doit pas l'oublier.

## 2. ccxt est un juge, jamais une source

`fetchOrderBook` renvoie les tailles OKX et MEXC en **contrats bruts** : ccxt expose
`market.contractSize` et ne l'applique pas. Lire un carnet directement depuis ccxt est
une erreur ×100 sur `BTC-USDT-SWAP` et ~×780 sur l'inverse `BTC-USD-SWAP`. Mesuré, pas
supposé.

Il reste précieux comme **seconde implémentation indépendante** contre laquelle nos
adapters faits main peuvent avoir tort : `npm run crosscheck`. Sur les venues en
contrats, le ratio **attendu est le multiplicateur, pas 1**.

## 3. Un check qui crie au loup est pire que pas de check

- **Ni un `SKIP` ni un `INCONC` ne comptent comme un succès.** Les deux sont une absence
  de preuve et font sortir en code non nul. Un jour où tout est skip, le résumé ne doit
  pas dire « tout va bien » — il l'a dit une fois, c'était faux.
- **Un échantillon unique n'est pas un verdict.** Sur un carnet fin, une lecture peut
  être à 2× de la suivante sans que rien ne soit cassé. MEXC spot est sorti `FAIL 0.648`
  à n=3 alors que deux séries de n=20 le donnent à médiane 1.000. On juge sur la
  **médiane**, et les instruments fins prennent plus d'échantillons.
- **On compare sur la bande que les deux sources atteignent.** Nous facturer la
  profondeur que ccxt n'a jamais récupérée transforme notre avantage en faux bug.

## 4. Ne pas croire un outil sur parole

`smoke-feeds.mjs` a annoncé **les 11 feeds morts** en prod alors que le service était
sain : il visait un port codé en dur. Deux conséquences durables :

- **Tout outil qui parle au serveur lit `DEPTHVIZ_URL`** (défaut `ws://127.0.0.1:8787/ws`).
  Contre la prod : `DEPTHVIZ_URL=ws://127.0.0.1:8888/ws`.
- **Une erreur de connexion doit nommer l'URL réellement tentée.** Sans ça, un échec de
  configuration se lit comme une panne applicative.

Corollaire : quand un check échoue, chercher d'abord si c'est le check qui a tort. Ici
`verify-bitunix` et les carnets live passaient au même instant — l'incohérence était le
signal.

## 5. Réduire la charge utile ne doit jamais réduire la portée

`hub.trim` gardait les 2 500 niveaux **les plus proches du mid**, ce qui coupait la queue
et non le poids : Binance spot expédiait ±0,62 % d'un carnet qui atteignait ±11 %, soit
**64 % de la profondeur dans ±10 % jetée** (Coinbase 38 %, Bitunix perp 19 %).

La forme correcte est un bucket `[prixVWAP, quantitéSommée]` : elle conserve
**exactement** le notional cumulé, la quantité cumulée et le VWAP, puisque
`vwapPrice * summedQty === Σ(price * qty)` par construction. Toute réduction future doit
préserver cette identité, sinon elle ment.

## 6. Un resync ne doit pas effacer ce qu'il ne peut pas voir

Un snapshot est autoritaire **dans sa propre plage de prix**, pas au-delà. Vider le
carnet à chaque resync détruisait une portée accumulée en plusieurs minutes, et un seul
gap de séquence ramenait le graphe à ±1,1 % en silence.

Garder la queue impose deux garde-fous, non négociables : un niveau conservé doit avoir
été vu depuis moins de 5 min, et toute la queue est jetée si la coupure a dépassé 30 s.
Sans eux, un ordre annulé pendant la coupure devient de la profondeur fantôme —
sur-déclarer est pire que sous-déclarer. Couvert par `npm test`, sans réseau.

## 7. Exposition et déploiement

- **L'app n'a aucune authentification, et chaque visiteur fait ouvrir au host des
  connexions vers six exchanges depuis son IP.** Cette IP est celle sur laquelle a live trading bot
  est whitelisté chez OKX : un inconnu qui enchaîne les symboles dépense le budget de
  rate limit d'un bot qui trade en live. `HOST` vaut donc `127.0.0.1` par défaut et
  l'exposition est un choix explicite.
- **Déploiement par patch, jamais par rsync ni écrasement.** `/opt/depthviz` sur
  `my-vps` n'est pas un checkout git. Un patch qui ne s'applique pas t'apprend que la
  cible a dérivé — un écrasement détruit cette information.
- **Après déploiement, comparer les hashes fichier par fichier.** Un service qui démarre
  ne prouve pas que le bon code tourne.
- **Chercher sur toute la flotte avant de dire « pas déployé ».** J'ai conclu deux fois
  que depthviz était absent en cherchant `/opt/depthviz` et le port 8787 : les deux
  étaient faux. Balayer par `find -iname` et `systemctl list-unit-files`.

## 8. Preuves attendues

Un changement non exécuté n'existe pas. Selon ce qui est touché :

| Ce que tu touches | Ce que tu montres |
|---|---|
| `BookSide`, `hub.trim`, un resync | `npm test` (déterministe, sans réseau) |
| un adapter, une conversion d'unité | `npm run crosscheck` **et** `node tools/verify-conversions.mjs` |
| Bitunix (absent de ccxt) | `npm run verify:bitunix` |
| l'UI, le transport | `node tools/smoke-feeds.mjs`, et `smoke-ui.mjs` si le rendu bouge |

Si tu ne peux pas prouver, dis-le explicitement. « Ça devrait marcher » n'est pas un
résultat.
