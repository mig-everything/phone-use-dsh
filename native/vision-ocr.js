// JavaScript for Automation (osascript), using macOS Vision without Xcode or model downloads.
ObjC.import('Foundation');
ObjC.import('Vision');
function run() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const input = JSON.parse(
    ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)),
  );
  const image = $.NSData.alloc.initWithBase64EncodedStringOptions(input.image, 0);
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = input.level === 'fast' ? 1 : 0;
  request.usesLanguageCorrection = false;
  if (input.languages && input.languages.length) request.recognitionLanguages = $(input.languages);
  const handler = $.VNImageRequestHandler.alloc.initWithDataOptions(image, $({}));
  const error = Ref();
  if (!handler.performRequestsError($([request]), error))
    throw new Error('Vision text recognition failed.');
  const items = [],
    results = request.results;
  for (let i = 0; i < results.count && items.length < 250; i++) {
    const observation = results.objectAtIndex(i),
      candidates = observation.topCandidates(1);
    if (!candidates.count) continue;
    const candidate = candidates.objectAtIndex(0),
      box = observation.boundingBox;
    items.push({
      text: ObjC.unwrap(candidate.string),
      confidence: candidate.confidence,
      bounds: {
        x: box.origin.x,
        y: 1 - box.origin.y - box.size.height,
        width: box.size.width,
        height: box.size.height,
      },
    });
  }
  return JSON.stringify({ items });
}
