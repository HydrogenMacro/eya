const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = process.env.EYA_TEST_ROOT;
if (!root) throw Error('EYA_TEST_ROOT required');
(async () => {
  const browser = await chromium.launch({executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]});
  const page = await browser.newPage(); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  const oldPath=path.join(root,'audit-rename.py'), newPath=path.join(root,'audit-renamed.py');
  try {
    await fs.rm(newPath,{force:true}); await fs.writeFile(oldPath,'first = 1\n');
    await page.goto('http://127.0.0.1:18765/client.html'); await page.locator('#start-connection').click();
    await page.locator('#status').filter({hasText:'Connected'}).waitFor(); await page.locator('#files').click();
    await page.locator('#file-upload-input').evaluate(input => {
      const file = new File(['x'.repeat(150000)], 'audit-chunked.txt');
      file.arrayBuffer = () => { throw Error('Upload buffered the whole file'); };
      const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
      // Override the File returned by the input too; Blob slices remain readable.
      input.files[0].arrayBuffer = file.arrayBuffer;
      input.dispatchEvent(new Event('change', {bubbles:true}));
    });
    await page.locator('#file-list tr').filter({hasText:'audit-chunked.txt'}).waitFor();
    if ((await fs.stat(path.join(root,'audit-chunked.txt'))).size !== 150000) throw Error('Chunked File upload was incomplete');
    await page.evaluate(async path=>{await Promise.all([EyaPanels.openFile(path),EyaPanels.openFile(path)]);},oldPath);
    if(await page.locator('.cm-editor').count()!==1)throw Error('Concurrent opens duplicated the editor');
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.type('second = 2\n');
    await page.locator('[data-tab=browser]').click();
    const row=page.locator('#file-list tr').filter({hasText:'audit-rename.py'}); await row.click(); await row.focus();
    page.once('dialog',dialog=>dialog.accept('audit-renamed.py')); await page.keyboard.press('F2');
    await page.locator('#file-list tr').filter({hasText:'audit-renamed.py'}).waitFor();
    await page.locator('[data-tab]').filter({hasText:'audit-renamed.py'}).click();
    const edited = await page.locator('.cm-content').innerText();
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+z');
    if(await page.locator('.cm-content').innerText() === edited)throw Error('Rename lost editor undo history');
    await page.keyboard.press('Control+y'); await page.keyboard.press('Control+s');
    await page.waitForFunction(()=>!document.querySelector('.panel-tab-dirty')?.textContent.includes('●'));
    await page.waitForTimeout(150);
    if(!(await fs.readFile(newPath,'utf8')).includes('second = 2'))throw Error('Save did not follow rename');
    try {await fs.access(oldPath);throw Error('Save recreated old path');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(errors.length)throw Error(errors.join('; '));
    console.log('Chunked File uploads, coalesced opens, preserved rename edits/undo, and saving to renamed path passed');
  } finally {await page.evaluate(()=>document.getElementById('end-session')?.click()).catch(()=>{});await browser.close();await fs.rm(oldPath,{force:true});await fs.rm(newPath,{force:true});await fs.rm(path.join(root,'audit-chunked.txt'),{force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
