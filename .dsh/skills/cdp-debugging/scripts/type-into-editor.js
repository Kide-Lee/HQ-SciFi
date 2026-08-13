(async () => {
  const req = (typeof require === 'function') ? require : (m) => process.mainModule.require(m);
  const { BrowserWindow } = req('electron');
  const fs = req('fs');
  const wins = BrowserWindow.getAllWindows();
  if (!wins.length) return { error: 'no windows' };
  const wc = wins[0].webContents;
  const out = { winTitle: wc.getTitle(), winUrl: wc.getURL() };
  try { wc.debugger.attach('1.3'); } catch (e) { return { ...out, attachError: String(e) }; }
  const S = (m, p) => wc.debugger.sendCommand(m, p);
  try {
    // 1) 定位编辑器内容区中心（Milkdown/ProseMirror 优先，CodeMirror 兜底）
    const r = await S('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const el = document.querySelector('.ProseMirror') || document.querySelector('.cm-content') || document.querySelector('.cm-editor');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, before: el.innerText.slice(0, 80) };
      })())`,
      returnByValue: true,
    });
    const pos = JSON.parse(r.result.value);
    if (!pos) return { ...out, error: '未找到编辑器 (.ProseMirror/.cm-content/.cm-editor)' };
    out.editor = pos;
    // 2) 真实鼠标点击聚焦（按下+抬起）
    await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(pos.x), y: Math.round(pos.y), button: 'left', clickCount: 1 });
    await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(pos.x), y: Math.round(pos.y), button: 'left', clickCount: 1 });
    // 3) 键入文本
    const text = '【CDP 调试输入】你好，黄芪饮片！typed via DevTools protocol 12345。';
    await S('Input.insertText', { text });
    // 4) 校验编辑器内容
    const v = await S('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const el = document.querySelector('.ProseMirror') || document.querySelector('.cm-content');
        return {
          after: el ? el.innerText.slice(0, 200) : null,
          bodySnippet: document.body.innerText.slice(0, 120),
        };
      })())`,
      returnByValue: true,
    });
    out.verify = JSON.parse(v.result.value);
    // 5) 截图留证
    await S('Page.enable').catch(() => {});
    const shot = await S('Page.captureScreenshot', { format: 'png' });
    const p = '/home/kidelee/Projects/HQ-SciFi/.devtools/hqsf-typed.png';
    fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
    out.screenshot = { path: p, bytes: Buffer.from(shot.data, 'base64').length };
  } finally {
    wc.debugger.detach();
  }
  return out;
})()
