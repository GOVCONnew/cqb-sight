# NEWTON · CQB SIGHT

Mobile web "sight" for airsoft CQB drills: rear camera + on-device TensorFlow.js COCO-SSD
(person + COCO animals), labeled boxes, center reticle with ON TARGET, drill timer with
per-target time-to-reticle, run history (localStorage) and CSV/JSON export.

* `index.html`, `css/app.css`, `js/detector.js` (model/geometry/tracker/drawing), `js/app.js` (camera/HUD/drills)
* `test/harness.html` – static-image detector test; `test/run_tests.js` – headless Chrome suite (puppeteer-core)
* Must be served over HTTPS for iOS camera access. `./deploy_pages.sh` publishes to GitHub Pages once `gh auth login` is done.
* Local: `python3 -m http.server 8090` then open http://localhost:8090/ (localhost counts as secure on desktop browsers).
