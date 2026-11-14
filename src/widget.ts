import { readFile } from 'node:fs/promises';
import { VERSION } from './version.js';

// Stable within a release: hosts cache tool declarations across process restarts.
export const UI_URI = `ui://phone-use/screen-${VERSION}.html`;
export async function widgetHtml() {
  const [html, js, rtc, host] = await Promise.all([
    readFile(new URL('../../ui/screen.html', import.meta.url), 'utf8'),
    readFile(new URL('../../ui/screen.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ui/rtc.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ui/host-stream.js', import.meta.url), 'utf8'),
  ]);
  return html.replace(
    '/*__PHONE_USE_SCRIPT__*/',
    `${rtc}\n${host}\n${js}`
      .replaceAll('__PHONE_USE_VERSION__', VERSION)
      .replaceAll('</script', '<\\/script'),
  );
}
