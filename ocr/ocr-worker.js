// Starts the Tesseract.js worker. The English language data is published as
// eng.traineddata.gz.wasm because some hosts (claude.ai artifacts) only serve
// a fixed set of file types; this maps Tesseract's request onto that name.
(function () {
  var realFetch = self.fetch.bind(self);
  self.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (/\/eng\.traineddata\.gz$/.test(url)) return realFetch(url + '.wasm', init);
    return realFetch(input, init);
  };
})();
importScripts('worker.min.js');
