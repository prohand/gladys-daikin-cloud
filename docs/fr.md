# Daikin Cloud

Pilotez vos climatiseurs Daikin depuis Gladys, via **l'API cloud officielle
Daikin Onecta** — le même cloud que celui utilisé par l'application mobile
Onecta. Aucun matériel à ajouter, aucun bricolage : vos unités continuent de
fonctionner exactement comme aujourd'hui, Gladys devient simplement une
télécommande de plus.

## Ce que vous obtenez

Pour chaque climatiseur de votre compte Daikin, Gladys crée un appareil avec les
fonctionnalités que votre modèle prend réellement en charge :

| Fonctionnalité          | Rôle                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| Marche/Arrêt            | Allumer et éteindre l'unité                                         |
| Mode                    | Auto, Froid, Chaud, Déshumidification, Ventilation seule            |
| Température de consigne | La consigne du mode actuellement actif                              |
| Vitesse de ventilation  | Auto, Silencieux, et les vitesses fixes de votre unité              |
| Volets horizontaux      | Orienter les volets gauche/droite                                   |
| Volets verticaux        | Orienter les volets haut/bas                                        |
| Température intérieure  | La température mesurée par l'unité (capteur, historisé)             |
| Température extérieure  | La température mesurée par le groupe extérieur (capteur, historisé) |

Un modèle sans volets n'obtient pas de fonctionnalité d'orientation, un modèle
sans ventilateur n'obtient pas de vitesse de ventilation, etc. : seul ce que le
matériel déclare est publié. Les choix proposés dans l'interface sont également
limités à ce que l'unité accepte — une unité sans mode « Déshumidification » ne
l'affiche jamais.

> **La vitesse de ventilation et les volets nécessitent Gladys 4.84.3 ou plus
> récent.** Sur une version antérieure l'intégration fonctionne quand même :
> elle publie marche/arrêt, mode, température de consigne et les deux capteurs,
> et omet les fonctionnalités que cette version ne sait pas stocker.

Les pompes à chaleur (Altherma…) sont partiellement prises en charge : leur
marche/arrêt, leur mode et leur température extérieure fonctionnent, mais leur
consigne de température d'eau n'est pas exposée — cette intégration vise les
climatiseurs.

## Avant de commencer : créez votre application Daikin

L'API Onecta est gratuite, mais chaque utilisateur doit créer sa propre
application. Cela prend deux minutes :

1. Rendez-vous sur le [portail développeur Daikin](https://developer.cloud.daikineurope.com/)
   et créez un compte (vous pouvez utiliser la même adresse e-mail que votre
   compte Onecta).
2. Ouvrez **My apps** → **New app**.
3. Donnez un nom à l'application (par exemple `Gladys`).
4. Dans **Redirect URIs**, collez l'adresse que Gladys vous indique. Ouvrez
   l'onglet **Configuration** de l'intégration Daikin Cloud dans Gladys :
   l'adresse est affichée juste sous le bouton **Connecter**, avec un bouton de
   copie à côté. Par défaut il s'agit de :

   ```
   https://my.gladysassistant.com/redirect/oauth
   ```

   Cette page est hébergée par Gladys et ne fait que renvoyer le navigateur vers
   votre propre instance — Daikin, comme la plupart des fournisseurs, refuse une
   adresse en `http://` simple, qui est pourtant la façon dont la plupart des
   gens accèdent à leur Gladys à la maison. Si vous servez déjà Gladys en HTTPS,
   vous pouvez décocher l'option dans l'écran de configuration et déclarer votre
   propre adresse ; quelle que soit l'adresse affichée, c'est celle-là qu'il faut
   coller ici, caractère pour caractère.

5. Enregistrez l'application, puis copiez son **Client ID** et son
   **Client secret**.

## Configuration

1. Dans Gladys, ouvrez **Intégrations → Daikin Cloud → Configuration**.
2. Collez le **Client ID** et le **Client secret** de votre application Daikin.
3. **Enregistrez** — les identifiants doivent être stockés avant que la
   connexion puisse démarrer.
4. Cliquez sur **Connecter** à côté de _Compte Daikin_. Un nouvel onglet s'ouvre
   sur la page de connexion Daikin : identifiez-vous avec le compte auquel vos
   climatiseurs sont associés dans l'application Onecta, et acceptez
   l'autorisation.
5. Vous revenez dans Gladys, l'intégration lit votre compte, et vos unités
   apparaissent dans l'onglet **Découverte**. Ajoutez celles que vous souhaitez.

Gladys conserve les jetons obtenus et les renouvelle automatiquement. Vous ne
devriez pas avoir à refaire cette manipulation.

## Intervalle de rafraîchissement et quota d'API

Daikin limite un compte développeur à **200 appels d'API par jour et 20 par
minute**. C'est la seule vraie contrainte, et elle guide le comportement de
l'intégration :

- un rafraîchissement lit **toutes** vos unités en un seul appel : le nombre
  d'unités ne change donc rien au coût ;
- chaque commande envoyée (marche/arrêt, température, vitesse…) coûte un appel
  de plus — et régler une vitesse fixe en coûte deux ;
- l'intervalle par défaut de **900 secondes (15 minutes)** consomme 96 appels
  par jour et laisse le reste pour vos commandes.

Vous pouvez monter l'intervalle jusqu'à 6 heures, ou le descendre jusqu'à
10 minutes si vous pilotez peu vos unités depuis Gladys. En dessous, le budget
quotidien serait épuisé avant la fin de la journée : c'est pourquoi le champ
s'arrête là.

À cause de ce quota, l'intégration n'utilise **pas** l'interrogation par
appareil de Gladys (une minute au plus lent) : elle gère son propre calendrier.

## Actions

**Tester la connexion** lit votre compte Daikin immédiatement et indique combien
d'unités ont été trouvées et combien d'appels d'API restent pour aujourd'hui.
Utilisez-la après avoir connecté votre compte, ou pour forcer un
rafraîchissement.

## Badge d'état des appareils

Chaque appareil porte un badge indiquant comment Gladys l'atteint :

- **Cloud** — fonctionnement normal.
- **Cloud avec un point orange** — l'unité est joignable mais signale une
  erreur ; vérifiez-la dans l'application Onecta.
- **Injoignable** — Daikin ne joint plus l'unité (adaptateur Wi-Fi hors ligne,
  coupure de courant, changement de box…). Les commandes sont refusées avec un
  message explicite et aucun état n'est publié, pour éviter des courbes plates
  qui ressembleraient à de vraies mesures.

## Dépannage

**« Renseignez le client ID et le client secret d'abord, puis enregistrez. »**
Les identifiants sont vides ou n'ont pas été enregistrés. Remplissez les deux
champs, cliquez sur Enregistrer, puis sur Connecter.

**La page Daikin indique que la redirect URI est invalide.**
L'adresse déclarée dans votre application Daikin ne correspond pas à celle
utilisée par Gladys. Recopiez-la depuis l'écran de configuration, sous le bouton
Connecter — protocole compris, et sans barre oblique finale.

**« La session Daikin a expiré, reconnectez votre compte. »**
Le jeton de rafraîchissement a été révoqué (mot de passe modifié, application
supprimée sur le portail, accès au compte retiré). Cliquez à nouveau sur
Connecter.

**« Quota de l'API Daikin atteint, augmentez l'intervalle de rafraîchissement. »**
Vous avez atteint les 200 appels quotidiens, le plus souvent en combinant un
intervalle court et beaucoup de commandes, ou en utilisant la même application
Daikin depuis plusieurs intégrations. Le quota se réinitialise seul ; augmentez
l'intervalle pour ne pas le réatteindre.

**Un changement fait dans l'application Onecta met du temps à apparaître dans
Gladys.**
C'est normal : l'API Daikin n'envoie aucune notification, Gladys ne voit un
changement qu'au rafraîchissement suivant. Baissez l'intervalle, ou utilisez
l'action _Tester la connexion_ pour forcer une lecture.

**Rien n'apparaît dans l'onglet Découverte.**
Vérifiez que les unités sont bien visibles dans l'application Onecta avec le même
compte, puis lancez _Tester la connexion_ : le message indique combien d'unités
l'API a renvoyées.

L'intégration journalise chaque appel effectué : consultez les logs de
l'intégration dans l'interface de Gladys pour le détail complet.
