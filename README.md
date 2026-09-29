# Dojo Quiz

L'enfant photographie sa leçon (manuel ou cahier). L'application reconnaît la matière et en tire un QCM de compréhension de niveau 6e, avec correction commentée, combos et étoiles. Les mascottes Rose et Gabin accompagnent l'enfant. Aucun profil ni nom : l'appareil ne garde que les réglages et le dernier défi.

## Architecture

```
Téléphone / tablette ──► index.html (GitHub Pages, public)
                              │  photos compressées + code familial
                              ▼
                        worker/worker.js (Cloudflare Worker)
                              │  clé API secrète
                              ▼
                        API Claude (Anthropic) ──► QCM au format JSON
```

- `index.html` : toute l'application (photo, quiz, résultats). Rien n'est enregistré sur l'enfant ; seuls les réglages et le dernier défi restent sur l'appareil.
- `worker/worker.js` : relais serveur. Il détient la clé API, vérifie le code familial, appelle Claude (qui détecte la matière et rédige le QCM) et contrôle le format de la réponse.
- Les photos ne sont **jamais stockées** : elles transitent vers l'API, puis sont oubliées.

## Mise en ligne (≈ 20 minutes)

### 1. Clé API Anthropic
1. Créer un compte sur <https://console.anthropic.com>, ajouter un moyen de paiement.
2. **Settings > Limits** : fixer un plafond mensuel (par ex. 10 €).
3. **API Keys > Create Key** : copier la clé (`sk-ant-…`).

### 2. Relais Cloudflare (gratuit)
1. Créer un compte sur <https://dash.cloudflare.com>.
2. **Workers & Pages > Create > Create Worker**, nom `dojo-quiz`, puis **Deploy**.
3. **Edit code** : remplacer tout le contenu par `worker/worker.js`, puis **Deploy**.
4. **Settings > Variables and Secrets**, ajouter :
   | Nom | Type | Valeur |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Secret | la clé `sk-ant-…` |
   | `ACCESS_CODE` | Secret | un code familial (ex. `ninja-2026`) |
   | `ALLOWED_ORIGIN` | Text | `https://VOTRE-PSEUDO.github.io` (mettre `*` le temps des essais) |
5. Noter l'adresse du Worker : `https://dojo-quiz.VOTRE-COMPTE.workers.dev`.

### 3. Site sur GitHub Pages
1. Créer un dépôt (ex. `dojo-quiz`) et y déposer `index.html`, `README.md`, `.gitignore` et le dossier `worker/`.
2. **Settings > Pages** : Source = *Deploy from a branch*, branche `main`, dossier `/ (root)`.
3. Le site est disponible sous `https://VOTRE-PSEUDO.github.io/dojo-quiz/`.

### 4. Relier le site au serveur
1. Dans `index.html`, en haut du script, coller l'adresse du Worker : `const DEFAULT_WORKER_URL = "https://dojo-quiz.VOTRE-COMPTE.workers.dev";`
2. Déposer cette version sur GitHub.

### 5. Activer chaque appareil (une seule fois)
1. Sur l'iPhone, ouvrir dans Safari le lien d'activation :
   `https://VOTRE-PSEUDO.github.io/dojo-quiz/#cle=VOTRE-CODE`
   (VOTRE-CODE = la valeur de `ACCESS_CODE`). L'appli confirme : « C'est prêt ! ».
2. Partager → « Sur l'écran d'accueil ».
3. Le code reste enregistré sur l'appareil et n'apparaît jamais dans le code public. Ne partagez pas ce lien.

Tant qu'un appareil n'est pas activé, l'accueil propose un **défi d'exemple** pour découvrir l'appli.

## Personnaliser les mascottes
En haut du script de `index.html`, l'objet `TWINS` règle le prénom (Rose, Gabin), le teint, la couleur des cheveux et des yeux, ainsi que les couleurs des tenues. Le nombre de questions se règle avec `QUESTION_COUNT` (8 par défaut).

## Coût
Un QCM de 8 questions à partir de 2 photos représente un appel API. Le prix dépend du modèle choisi (variable `MODEL`) : consulter la grille tarifaire en vigueur sur <https://www.anthropic.com/pricing>. Le plafond défini dans la console Anthropic limite de toute façon la dépense.

## Confidentialité
- Le dépôt et le site sont publics : n'y déposer **aucune photo** des enfants (le `.gitignore` bloque les images par précaution).
- La clé API n'existe que dans Cloudflare. Le code familial empêche un tiers d'utiliser le relais.
