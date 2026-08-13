(async () => {
  const req = (typeof require === 'function') ? require : (m) => process.mainModule.require(m);
  const { BrowserWindow } = req('electron');
  const wins = BrowserWindow.getAllWindows();
  if (!wins.length) return { error: 'no windows' };
  const wc = wins[0].webContents;
  const out = { windows: wins.length, winTitle: wc.getTitle(), winUrl: wc.getURL(), winSize: wins[0].getSize() };
  try { wc.debugger.attach('1.3'); } catch (e) { return { ...out, attachError: String(e) }; }
  try {
    const r = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: `JSON.stringify({
        title: document.title,
        url: location.href,
        text: document.body ? document.body.innerText.slice(0, 600) : '(no body)',
        editables: [...document.querySelectorAll('[contenteditable]')].map(e => ({ cls: String(e.className).slice(0, 80), role: e.getAttribute('role') })),
        proseMirror: !!document.querySelector('.ProseMirror'),
        cmEditor: !!document.querySelector('.cm-editor'),
        buttons: document.querySelectorAll('button').length,
        inputs: document.querySelectorAll('input').length,
      })`,
      returnByValue: true,
    });
    out.page = JSON.parse(r.result.value);
  } finally { wc.debugger.detach(); }
  return out;
})()
