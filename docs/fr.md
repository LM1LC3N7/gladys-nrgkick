# NRGkick pour Gladys

Affiche votre borne de recharge portable **NRGkick Gen2** dans Gladys par son
**API REST JSON locale** : sans cloud, sans compte, directement sur votre
réseau.

> **Jamais testé avec une vraie borne.** Sans lien avec DiniTech (le fabricant
> de la NRGkick). L'intégration parle à la borne comme la bibliothèque
> nrgkick-api (utilisée par Home Assistant). DiniTech peut changer son API
> lors d'une mise à jour.

## Ce que vous obtenez

Un appareil par borne, avec :

| Fonctionnalité                             | Contenu                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| État                                       | Aucun véhicule, branché sans charge, charge en pause, en charge, réveil, erreur |
| Connecteur                                 | Disponible, occupé, en défaut ou indisponible (catégorie « borne de recharge ») |
| État de charge                             | En charge, véhicule connecté, en pause par la borne, inactif                    |
| Véhicule branché, Charge en pause          | Oui / non                                                                       |
| Puissance, et puissance L1 / L2 / L3       | En W                                                                            |
| Courant L1 / L2 / L3, Tension L1 / L2 / L3 | En A et en V (une phase que l'adaptateur n'a pas reste vide)                    |
| Courant de charge réglé                    | En A, la consigne de la borne                                                   |
| Courant signalé au véhicule                | En A                                                                            |
| Énergie de la session                      | En kWh, un capteur simple (repart de 0 à chaque session)                        |
| Index d'énergie                            | En kWh, l'énergie totale chargée : un index, protégé (voir plus bas)            |
| Températures                               | Boîtier, adaptateur L1 / L2 / L3, en °C                                         |
| Erreur, avertissement, différentiel        | Oui / non, et le code d'erreur et d'avertissement en texte                      |
| Mettre la charge en pause                  | Bouton, toujours disponible                                                     |
| Reprendre la charge                        | Bouton (seulement si autorisé)                                                  |
| Régler le courant de charge                | Liste de 6 A au plafond (seulement si autorisé)                                 |

Lecture toutes les 30 secondes par défaut (de 10 s à 10 min, réglable).

## Installation

1. Donnez à la borne une **adresse IP fixe** dans votre box.
2. Dans l'**application NRGkick**, activez l'**API JSON locale** (sans elle,
   la borne répond que l'API doit être activée, et l'état de l'intégration
   le dit). Si vous y activez aussi **BasicAuth**, notez son nom
   d'utilisateur et son mot de passe.
3. Installez l'intégration depuis le store de Gladys. Dans sa configuration,
   saisissez l'**adresse IP de la borne**, et seulement si BasicAuth est
   activé, son **nom d'utilisateur** et son **mot de passe** (les deux, ou
   aucun).
   Un nom et un mot de passe collés dans l'adresse (`admin:…@`) sont
   ignorés et jamais réaffichés : utilisez les champs dédiés.
4. Enregistrez, puis ajoutez la borne depuis l'onglet **Découverte**.

Le mot de passe est **gardé par Gladys dans sa base, jamais réaffiché**, et
envoyé seulement à la borne. Il n'est jamais écrit dans les journaux, ni dans
`/data`, ni dans un état. La borne ne parle qu'en HTTP simple : le nom et le
mot de passe passent **en clair, en HTTP** sur votre réseau local. Gardez la
borne sur un réseau de confiance.

Le bouton **Tester la connexion** lit la borne une fois (au plus toutes les
10 secondes).

## Index d'énergie

L'énergie totale chargée par la borne est un **index** : Gladys en tire la
consommation et le coût, et compte chaque hausse en entier. L'intégration le
protège comme l'intégration P1 Monitor :

- jamais 0 ; une **baisse** ou un **saut** improbable (plus de 25 kW en
  moyenne depuis la dernière valeur, la borne en donne 22 au plus) est
  **retenu** : la dernière valeur acceptée est renvoyée, l'état de
  l'intégration et le badge de l'appareil montrent les kWh en attente, et le
  journal le dit ; la retenue est gardée dans `/data`, même après un
  redémarrage ;
- elle n'est jamais confirmée par la répétition ni par le temps : seule
  l'action **« Accepter l'index retenu »** de la configuration la prend, **en
  deux clics**. Le premier clic ne prend rien : il montre la valeur retenue
  (baisse ou saut, de → à, kWh). Un second clic dans les 60 secondes prend
  exactement cela — la valeur montrée, plus ce que la borne a pu charger
  depuis — et répond par ce qui est compté ; si la valeur a changé entre-temps,
  elle est montrée de nouveau. Enregistrer la configuration ou une
  reconnexion n'accepte jamais rien ;
- une borne ajoutée de nouveau repart d'une garde neuve.

La borne est en général derrière votre compteur principal : dans les réglages
d'énergie de Gladys, rangez-la sous ce compteur pour qu'elle ne soit pas
comptée deux fois. L'**énergie de la session** reste un capteur simple : elle
repart de 0 à chaque session, ce n'est jamais un index.

## Commandes

**« Mettre la charge en pause »** est toujours disponible, sans option : elle
ne fait qu'arrêter la charge (`charge_pause=1`). Elle n'est **jamais
retenue** : ni par une autre commande en cours (elle part tout de suite, et
elle est renvoyée une fois quand une reprise qu'elle a doublée se termine ;
une reprise ou un courant pas encore envoyé lui cède la place), ni par la
minute entre deux changements, ni par une pause 429 ou des identifiants
refusés (alors une seule requête), ni par l'absence de lecture (elle n'en a
pas besoin). Quand une reprise est restée sans confirmation, elle peut
encore atteindre la borne plus tard : une pause envoyée dans les 90 secondes
qui suivent est surveillée, et renvoyée (deux fois au plus) si une lecture
montre la charge reprise alors qu'aucune autre reprise n'est partie depuis
Gladys. **Attention** : une reprise faite dans ces 90 secondes depuis
l'application NRGkick ou par OCPP est donc annulée elle aussi (deux fois au
plus) ; refaites-la après.

**Une pause reste sur la borne jusqu'à une reprise.** Avec l'option
ci-dessous désactivée (par défaut), seule l'application NRGkick reprend la
charge : une pause oubliée (par une scène, le chat IA) peut empêcher la
charge suivante et laisser la voiture non chargée. La borne peut aussi
refuser une pause (par exemple quand la charge solaire la bloque) : Gladys
répond alors « La borne a refusé la commande ».

Avant la première lecture après un redémarrage (une pause 429 ou un blocage
gardés dans `/data`), la pause part vers l'adresse configurée pour la
dernière borne lue à cette adresse seulement.

**« Reprendre la charge »** et **« Régler le courant de charge »** refusent
toute commande tant que **Autoriser la reprise et le courant de charge** est
désactivé (par défaut). Activé :

- **Reprendre** remet `charge_pause=0` ; **refusé sans véhicule branché**, ou
  sur une erreur ou un état inconnu ;
- **Courant de charge** : de 6 A au **plafond** : le plus bas du « Plafond du
  courant de charge » de la configuration (16 A par défaut, 32 A au plus), du
  courant nominal de la borne et du courant maximal de son adaptateur. Si la
  borne prend une autre valeur que celle demandée, Gladys affiche « envoyée,
  sans confirmation ».
- **Un changement par minute au plus** (reprise ou courant) : pas de
  régulation fine depuis Gladys.

Ce sont des **boutons** et une **liste**, jamais des interrupteurs : un
« éteins tout » (depuis Gladys, Google Home, Alexa ou HomeKit) ne les atteint
jamais. Une scène peut les déclencher, seulement par une action explicite.
Notez que le chat IA de Gladys (MCP) peut créer et lancer une telle scène :
tant que les commandes sont autorisées, il peut reprendre la charge ou
changer le courant.

Avant une reprise ou un changement de courant, l'intégration **relit la
borne** et décide sur cette lecture seulement ; l'option est revérifiée juste
avant l'envoi. Une commande sans effet (déjà le cas) n'est pas envoyée. Une
commande qui ne peut pas partir dans les 3,5 secondes est refusée sans être
envoyée. Quand la borne ne confirme pas (silence, erreur 5xx, réponse
inattendue), Gladys affiche « Commande envoyée, sans confirmation » : vérifiez
l'état, relu 5 puis 20 secondes plus tard. Une commande à la fois : une autre
est refusée aussitôt, sauf la pause.

## Erreurs et limites

- **Borne injoignable** : seuls le connecteur (« indisponible ») et l'état
  (« Borne injoignable ») changent ; les autres valeurs gardent la dernière.
  Nouvel essai après 30 s, 1, 2, puis 5 minutes, jamais plus vite que
  l'intervalle.
- **API JSON désactivée** dans l'application : l'état le dit ; nouvel essai
  toutes les 5 minutes.
- **Identifiants refusés** (ou demandés alors qu'aucun n'est saisi) : l'état
  demande de les vérifier. Nouveaux essais après 15 minutes, 1 heure, puis
  toutes les 6 heures, jamais plus tôt (gardé dans `/data` après un
  redémarrage) ; enregistrer de nouveaux identifiants réessaie aussitôt.
- **429 (trop de requêtes)** ou **5xx** : une pause (de 1 minute à 6 heures
  pour un 429) pour les lectures et les commandes sauf la pause de la charge,
  jamais plus courte que l'intervalle, gardée dans `/data` après un
  redémarrage.
- Ni la limite d'énergie, ni le nombre de phases ne se changent depuis Gladys
  dans cette version. Une seule borne par intégration. Pas de Bluetooth.
- Si votre NRGkick parle aussi OCPP à un autre logiciel (par exemple
  l'intégration OCPP de Gladys), les deux peuvent se contredire sur la pause
  et le courant : n'en commandez qu'un.
- Les journaux ne contiennent jamais le texte des réponses d'erreur de la
  borne, ni le mot de passe.

## Crédits

Portage de [nrgkick-api](https://github.com/andijakl/nrgkick-api) (Andreas
Jakl, MIT, version 1.8.1), la bibliothèque de l'intégration NRGkick de Home
Assistant. Garde de l'index reprise de l'intégration P1 Monitor. Licence
Apache-2.0.
