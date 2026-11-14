// Dedicated, disposable process: killing it also stops WASM/worker initialization.
// All assets resolve locally; no telemetry, image files or recognition-time downloads.
const { createWorker, OEM, PSM } = require('tesseract.js');
let worker;
process.on('message', async ({ image, models, languages }) => {
  try {
    worker ??= await createWorker(languages, OEM.LSTM_ONLY, {
      langPath: models,
      gzip: false,
      cacheMethod: 'none',
      errorHandler: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
    const lines = (data.blocks ?? [])
      .flatMap((b) => b.paragraphs ?? [])
      .flatMap((p) => p.lines ?? []);
    process.send({
      items: lines
        .flatMap((line) => line.words ?? [])
        .slice(0, 250)
        .map((word) => ({
          text: word.text.trim(),
          confidence: word.confidence / 100,
          bounds: {
            x: word.bbox.x0,
            y: word.bbox.y0,
            width: word.bbox.x1 - word.bbox.x0,
            height: word.bbox.y1 - word.bbox.y0,
          },
        })),
    });
  } catch {
    process.send({ error: 'OCR_ENGINE_FAILED' });
  }
});
