# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This repo is the **published GitHub Pages site** (https://akhileshkmr340-oss.github.io/estimation-web/), served from `main` (`.nojekyll`, so every file is served as-is). It holds the output of `flutter build web`, not the Dart source. Do not hand-edit compiled files (`main.dart.js`, `worker/extract.js`, `flutter*.js`, `canvaskit/`, `assets/`): change the source, rebuild, and copy the build output over the repo root.

Files here that are hand-written and also live in the source's `web/` folder: `index.html`, `estimation.js`, `auth.js`, `accounts-config.js`, `dwg/dwg-read.js`, `dwg/dwg-worker.js`, `ocr/ocr-worker.js`. `accounts/` (the Apps Script and its README) is copied from the source's `accounts/`. Keep both copies the same.

The website is a browser version of the Estimation Android app (repo `akhileshkmr340-oss/estimation-app`). It turns drawings and documents into a bill of quantities in Excel (S. No., Description, Ratings, UOM, Make, Quantity). Everything runs in the browser: files and outputs are never uploaded or stored.

## Source and build

The Flutter web source is not in this repo. In Claude projects it is kept in `/mnt/project-files/estimation-web/`, next to the app at `/mnt/project-files/estimation-app/`. Its `pubspec.yaml` depends on the app with `estimation_app: path: ../estimation-app`, so the two folders must sit side by side.

Flutter 3.47.7, run from the source folder:

```sh
flutter pub get
tool/build_web.sh        # dart compile js lib/worker/extract_worker.dart -> web/worker/extract.js,
                         # then flutter build web --release --no-web-resources-cdn --pwa-strategy=none
flutter test             # test/pdf_legend_test.dart, pdf_sld_test.dart, sheet_devices_test.dart
flutter test --plain-name "fire alarm layout"
```

The result is in `build/web`. Rebuild the worker (`build_web.sh` does this) whenever code under `lib/worker/` or `lib/drawing/`, or the app's `lib/core`, changes. The page and the worker are compiled separately.

Command-line test tools (in `tool/`) run the readers on one file and can write the Excel:
- `dart run tool/pdf_job.dart drawing.pdf [out.xlsx "Project"]` runs the worker's whole job.
- `dart run tool/pdf_legend.dart`, `tool/pdf_text.dart` (SLD and stroked-text PDFs) and `tool/sheet_devices.dart` run single readers.
- `dart run tool/analyze_flat.dart flat.json out.xlsx` and `tool/sld_flat.dart` run on DWG JSON flattened by `web/dwg/dwg-read.js`.

## Architecture

- **Shared core:** the app's `lib/core` (`package:estimation_app/core/...`) does PDF/Word/Excel/CSV/DXF reading, cleaning and merging (`ItemBuilder`) and the Excel writer. A fix there reaches both the app and the site.
- **Web-only drawing readers** are in the source's `lib/drawing/`. `drawing_analyzer.dart` builds the BOQ from DWG legends. `pdf_legend.dart` counts legend symbols on vector PDF plans and produces the Floor-wise sheet. `sld_analyzer.dart` and `sld_panel.dart` read single line diagrams for the separate SLD workbook. `shx_text.dart` and `shx_font.dart` read lettering plotted as strokes by matching Hershey Simplex shapes; other SHX fonts are marked "Needs action". `sheet_devices.dart` counts symbols on layout sheets that have no legend. The app keeps its own copies under `lib/core/drawing`, and changes are carried across by hand.
- **Workers:** `lib/worker/extract_job.dart` is the pure-Dart reading step and returns plain JSON tagged with a `type`. `doc_codec.dart` serializes documents. `extract_worker.dart` is the worker entry point. `lib/services/processing_service.dart` (on the page) sends each file to a worker. Large PDFs are split into page ranges and read by up to four workers at once, and the results are merged on the page.
- **Browser glue:** `estimation.js` does file picking and drag-and-drop, downloads (through `window.claude.use('downloads')` when shown inside a claude.ai artifact), Tesseract OCR and pdf.js rendering. Dart calls it through `lib/services/browser.dart` (`dart:js_interop`).
- **DWG:** `dwg/dwg-worker.js` (a module worker) runs LibreDWG compiled to WebAssembly (@mlightcad/libredwg-web 0.8.0). `dwg-read.js` flattens model space, with blocks expanded, into texts and block counts. Dart reads that JSON with `FlatDrawing.fromJson`.
- **Storage:** none. Projects live in memory for the open tab (`lib/services/project_store.dart`), and each file's bytes are released once it has been read.
- **UI** (`lib/ui`): copies of the app's screens with the web services swapped in, plus `auth_screen.dart`.

## Accounts

Sign-up and login use Firebase Authentication with email and password, loaded lazily by `auth.js` from `firebase/`. Profiles are rows of a Google Sheet written by `accounts/profiles.gs`, an Apps Script web app. It checks the caller's Firebase ID token and only touches that user's row. Passwords never reach the Sheet. `accounts-config.js` holds the Firebase web config and the script's `/exec` URL. These values are public by design. If either is empty, accounts are off and the site opens straight to the projects screen. When `profiles.gs` changes, redeploy it as a new version of the same deployment so the URL stays the same. Setup and local emulator tests are in `accounts/README.md`.

## Constraints

- **Hosting limits:** the site must work on hosts that only serve a fixed set of file types, such as claude.ai artifacts. That is why the OCR data is named `ocr/lang/eng.traineddata.gz.wasm` (`ocr-worker.js` rewrites the fetch to this name) and why control bytes in `pdfjs/pdf.worker.min.js` are written as `\xNN` escapes. Keep these when updating either library.
- **No CDN:** `--no-web-resources-cdn` bundles CanvasKit, so the site loads nothing from Google's servers apart from Firebase sign-in.
- **Licence:** LibreDWG is GPL-3.0 (`dwg/NOTICE.txt`), so publishing `dwg/` means the site's source is offered under the GPL. It must never be bundled into the Android app.
- **Older browsers:** the site must work in older Safari, and text-reader regexes were already fixed once for it. Avoid newer regex features such as lookbehind.
