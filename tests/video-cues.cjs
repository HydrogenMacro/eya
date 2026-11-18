const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
(async () => {
  const code = buildSync({ entryPoints: ['client/video-cues.js'], bundle: true, format: 'iife', globalName: 'Cues', write: false }).outputFiles[0].text;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.goto('about:blank'); await page.addScriptTag({ content: code });
    const result = await page.evaluate(() => {
      const cue = new VTTCue(0, 10, '<i>Italic</i> <b>bold</b> <u>underline</u> <ruby>漢<rt>kan</rt></ruby> <c.yellow.bg_blue>color</c> <v Alice>voice</v> <lang ja>language</lang> <00:00:01.000>');
      const element = Cues.renderVideoCue(cue); document.body.append(element);
      const hostile = Cues.renderVideoCue({ getCueAsHTML() { const fragment = document.createDocumentFragment(); const img = document.createElement('img'); img.src = '/unexpected'; img.setAttribute('onerror', 'window.bad=true'); const span = document.createElement('span'); span.setAttribute('style', 'position:fixed'); span.setAttribute('onclick', 'window.bad=true'); span.textContent = 'Safe'; fragment.append(img, span); return fragment; } });
      document.body.append(hostile);
      const fallback = Cues.renderVideoCue({ text: '<i>MP4 italic</i>' });
      return { italic: element.querySelector('i')?.textContent, ruby: element.querySelector('ruby rt')?.textContent, color: element.querySelector('.yellow')?.style.color, background: element.querySelector('.bg_blue')?.style.backgroundColor, voice: element.querySelector('[data-voice]')?.dataset.voice, language: element.querySelector('[lang]')?.lang, hostile: hostile.innerHTML, fallback: fallback.querySelector('i')?.textContent };
    });
    assert.equal(result.italic, 'Italic'); assert.equal(result.ruby, 'kan'); assert.equal(result.color, 'rgb(255, 255, 0)'); assert.equal(result.background, 'rgb(0, 0, 255)'); assert.equal(result.voice, 'Alice'); assert.equal(result.language, 'ja'); assert.equal(result.hostile, '<span>Safe</span>'); assert.equal(result.fallback, 'MP4 italic');
    console.log('Safe WebVTT tags, color classes, annotations, and MP4 cue parsing passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
