# Neakasa Litter Card

Carte Lovelace pour la litière connectée Neakasa M1 (intégration hass-neakasa) :
- **Cadran 24 h × 7 jours** : chaque passage du chat positionné selon son heure, le jour en anneau concentrique
- **Rythme du jour** : passages, habitudes et pastille d'écart (aucun passage, plus que d'habitude, dans ses habitudes)
- **Poids par chat** : poids actuel, mini-tendance 7 jours, delta sur la période réellement couverte
- **Histogramme 7 jours** des passages
- **Litière** : niveau en « grains » et état (suffisante / moyenne / à recharger)
- **Bac à déchets** : un « grumeau » dessiné par cycle de nettoyage, **prévision du plein** selon le rythme réel
- Multi-chats : détection automatique des capteurs `sensor.<prefix>_cat_*`, ou liste explicite
- Bouton de nettoyage avec confirmation en deux appuis
- Accessibilité clavier sur tous les éléments interactifs

## Installation

Manuelle :
1. Copier `neakasa-litter-card.js` dans `/config/www/`
2. Paramètres → Tableaux de bord → ⋮ → Ressources → Ajouter :
   URL `/local/neakasa-litter-card.js`, type Module JavaScript
3. Ajouter une carte manuelle

HACS : Dépôts personnalisés → `https://github.com/junkoku38/neakasa-litter-card`, catégorie Lovelace.

## Configuration

```yaml
type: custom:neakasa-litter-card
name: Litière            # optionnel, titre affiché
room: Salle de bain       # optionnel, sous-titre
cat_name: Minou          # chat principal
cats: [Minou, Nana]      # optionnel : multi-chats explicite
                         # (sinon détection auto de sensor.<prefix>_cat_*)
bin_capacity: 15          # optionnel : cycles avant « bac plein » (défaut 15)
prefix: neakasa_m1       # optionnel : préfixe des entity_id
entities:                # optionnel : surcharge fine
  status: sensor.neakasa_m1_device_status
  clean: button.neakasa_m1_clean
```

## Entités utilisées

| Rôle | Entité par défaut | Usage |
|---|---|---|
| Statut | `sensor.<prefix>_device_status` | état (idle, cat_present, cleaning…), cycles via historique |
| Dernier passage | `sensor.<prefix>_last_usage` | passages par jour, cadran, histogramme |
| Durée de séjour | `sensor.<prefix>_last_stay_time` | durée affichée au centre |
| Litière | `sensor.<prefix>_cat_litter_level` / `_state` | niveau et état |
| Bac à déchets | `sensor.<prefix>_bin_state` | normal / full / missing, vidage via historique |
| Poids | `sensor.<prefix>_cat_<chat>` | poids et tendance par chat |
| Nettoyage | `button.<prefix>_clean` | lancement d'un cycle |

## Licence

MIT