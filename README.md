# Neakasa Litter Card

Carte Lovelace pour la litière connectée Neakasa M1, compatible avec les deux intégrations :
- **ha-neakasa-litterbox** (roquerodrigo) — détectée automatiquement
- **hass-neakasa**

- **Cadran 24 h × 7 jours** : chaque passage du chat positionné selon son heure, le jour en anneau concentrique
- **Rythme du jour** : passages, habitudes et pastille d'écart (aucun passage, plus que d'habitude, dans ses habitudes)
- **Poids par chat** : poids actuel, mini-tendance 7 jours, delta sur la période réellement couverte
- **Histogramme 7 jours** des passages
- **Litière** : niveau en « grains » et état (suffisante / moyenne / à recharger)
- **Bac à déchets** : un « grumeau » dessiné par cycle de nettoyage, **prévision du plein** selon le rythme réel
- Multi-chats : détection automatique, identification du chat présent par son dernier passage
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
cat_name: Minou          # chat principal (secours si détection auto impossible)
cats: [Minou, Nana]      # optionnel : multi-chats explicite
bin_capacity: 15          # optionnel : cycles avant « bac plein » (défaut 15)
prefix: neakasa_m1       # optionnel : préfixe des entity_id (défaut neakasa_m1)
```

Aucune configuration n'est normalement nécessaire : la carte détecte l'intégration
installée et résout les entités (statut, visites, litière, bac, nettoyage, poids).

## Entités utilisées

**ha-neakasa-litterbox** (roquerodrigo) — détection via `sensor.<prefix>_status` :

| Rôle | Entité |
|---|---|
| Statut | `sensor.<prefix>_status` (idle / cleaning / restoring / leveling / cat_appears) |
| Dernier passage | `sensor.<prefix>_last_visit` |
| Litière | `sensor.<prefix>_sand_level` |
| Bac à déchets | `binary_sensor.<prefix>_waste_bucket_full` |
| Poids par chat | `sensor.<chat>_weight`, `sensor.<chat>_last_visit` |
| Nettoyage | `button.<prefix>_clean_now` |

**hass-neakasa** (legacy) :

| Rôle | Entité |
|---|---|
| Statut | `sensor.<prefix>_device_status` |
| Dernier passage | `sensor.<prefix>_last_usage` |
| Durée de séjour | `sensor.<prefix>_last_stay_time` |
| Litière | `sensor.<prefix>_cat_litter_level` / `_state` |
| Bac à déchets | `sensor.<prefix>_bin_state` (normal / full / missing) |
| Poids par chat | `sensor.<prefix>_cat_<chat>` |
| Nettoyage | `button.<prefix>_clean` |

## Licence

MIT