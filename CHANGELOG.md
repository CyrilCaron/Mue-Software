# Nouveautés de Mue

## 1.2 (30 octobre 2026)

Espace Vidéo, avec des réglages complets (moteur : ffmpeg 6, livré dans l'app).
- Sortie MP4, MKV, WebM, MOV ; H.264, H.265, AV1, VP9, ProRes, copie ; encodage matériel VideoToolbox.
- Qualité constante (RF), débit moyen ou poids visé ; trois vitesses ; neuf préréglages.
- Rognage auto des bandes noires ou manuel, résolution, rotation, miroir ; désentrelacement, débruitage, netteté, noir et blanc ; images par seconde.
- Pistes audio au choix (AAC, Opus, MP3, AC3, FLAC, copie), mixage mono / stéréo / 5.1, normalisation EBU R128.
- Sous-titres gardés ou incrustés, ajout de .srt / .ass / .vtt ; chapitres et métadonnées.
- Découpe début / fin, aperçu image par image avec les réglages, file d'attente avec progression, temps restant et annulation.

## 1.1 (30 octobre 2026)

Mue ouvre maintenant les PDF. L'espace PDF a cinq onglets : Lire, Organiser, Découper, Compresser et Convertir.

**Lire et annoter**
- Lecteur avec miniatures, zoom et recherche dans le texte (accents ignorés).
- Surlignage, texte, notes et dessin à main levée ; déplacer, recolorer, supprimer, Cmd + Z pour annuler.
- Signature dessinée ou écrite, gardée sur le Mac.
- Remplissage des formulaires, avec option pour les aplatir.
- Protection par mot de passe à l'enregistrement ; ouverture des PDF protégés (utilitaire PDFKit `native/pdfkit.swift`).

**Organiser, découper, compresser, convertir**
- Pages en miniatures à réordonner, pivoter, dupliquer, supprimer ; fusion de plusieurs PDF.
- Découpe par page, toutes les N pages ou par plages.
- Compression en trois niveaux (images réencodées, texte intact).
- PDF → images (JPEG, PNG, WebP ; 72, 150, 300 ppp) et images → PDF.

**Autres**
- Numéro de version dans les réglages, icône de roue crantée.

## 1.0 (30 octobre 2026)

Première version, consacrée aux images : conversion (dont HEIC), compression avec estimation du poids, redimensionnement en pixels ou en pourcentage, réduction du bruit avec aperçu, recadrage, rotation et redressement automatique, préréglages personnels, renommage, retrait des métadonnées, thème clair ou sombre.
