# Logiciels tiers

Mue s'appuie sur les projets libres suivants. Merci à leurs auteurs.

| Projet | Rôle dans Mue | Licence |
| --- | --- | --- |
| [Electron](https://www.electronjs.org) | Application de bureau | MIT |
| [sharp](https://sharp.pixelplumbing.com) et [libvips](https://www.libvips.org) | Lecture, conversion et compression des images | Apache-2.0 (sharp), LGPL-3.0 (libvips) |
| [pdf-lib](https://pdf-lib.js.org) | Assemblage, découpe, annotations et formulaires PDF | MIT |
| [PDF.js](https://mozilla.github.io/pdf.js/) | Affichage des PDF (copie dans `src/renderer/vendor/pdfjs`) | Apache-2.0 |
| [FFmpeg](https://ffmpeg.org), via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | Conversion des vidéos | GPL-3.0 (build avec x264, x265) |
| [Gloock](https://fonts.google.com/specimen/Gloock) et [Onest](https://fonts.google.com/specimen/Onest) | Polices de l'interface | SIL Open Font License 1.1 |
| [electron-builder](https://www.electron.build) | Création de l'installeur | MIT |

FFmpeg est livré comme programme séparé (`app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg`) ; ses sources sont disponibles sur [ffmpeg.org](https://ffmpeg.org/download.html).
