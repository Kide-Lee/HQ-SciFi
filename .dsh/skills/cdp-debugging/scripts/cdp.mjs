// cdp.mjs — 零依赖 CDP 客户端（Node 24 原生 WebSocket）
// 连接本机 --remote-debugging-port 暴露的浏览器/Electron，调试页面。
//
// 用法：
//   node .devtools/cdp.mjs targets                    列出可挂载的 target
//   node .devtools/cdp.mjs eval '<js表达式>'           页面上下文执行并打印 JSON 结果
//   node .devtools/cdp.mjs shot out.png [selector]    整页截图（可选：某元素截图）
//   node .devtools/cdp.mjs listen [秒]                收集 console/异常/日志事件流
//
// 环境变量：
//   CDP_PORT=9222   调试端口（默认 9222）
//   CDP_TARGET=url子串  选择挂载哪个 page target（默认第一个 page）

const PORT = process.env.CDP_PORT ?? '9222';
const TARGET_FILTER = process.env.CDP_TARGET ?? '';

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP 端点无响应: http://127.0.0.1:${PORT}/json/list -> ${res.status}`);
  return res.json();
}

function pickTarget(list) {
  const pages = list.filter((t) => t.type === 'page' || t.type === 'node');
  const t = TARGET_FILTER
    ? pages.find((p) => p.url.includes(TARGET_FILTER))
    : pages[0];
  if (!t) {
    throw new Error(
      '未找到 page target' + (TARGET_FILTER ? `（含 "${TARGET_FILTER}"）` : '') +
      '\n可用: ' + JSON.stringify(list.map((p) => ({ url: p.url, type: p.type })), null, 2),
    );
  }
  return t;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error('WebSocket 连接失败: ' + wsUrl));
  });
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      listeners.get(msg.method).forEach((fn) => fn(msg.params));
    }
  };
  return {
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close: () => ws.close(),
  };
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'targets': {
    const list = await getTargets();
    console.log(JSON.stringify(list.map((t) => ({ type: t.type, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl })), null, 2));
    break;
  }
  case 'eval': {
    const [expr] = rest;
    const t = pickTarget(await getTargets());
    const cdp = await connect(t.webSocketDebuggerUrl);
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      includeCommandLineAPI: true,
    });
    if (r.exceptionDetails) {
      console.error('页面异常:', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(r.result.value, null, 2));
    }
    cdp.close();
    break;
  }
  case 'shot': {
    const [out, selector] = rest;
    const t = pickTarget(await getTargets());
    const cdp = await connect(t.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    let params = { format: 'png', captureBeyondViewport: true };
    if (selector) {
      const { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const box = await cdp.send('DOM.getBoxModel', { nodeId });
      const [x, y, x2, y2] = box.model.border;
      params = { format: 'png', clip: { x, y, width: x2 - x, height: y2 - y, scale: 1 } };
    }
    const shot = await cdp.send('Page.captureScreenshot', params);
    await import('node:fs').then((fs) => fs.writeFileSync(out, Buffer.from(shot.data, 'base64')));
    console.log(`已保存: ${out}`);
    cdp.close();
    break;
  }
  case 'listen': {
    const seconds = Number(rest[0] ?? 10);
    const t = pickTarget(await getTargets());
    const cdp = await connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    const stamp = () => new Date().toISOString().slice(11, 23);
    cdp.on('Runtime.consoleAPICalled', (p) =>
      console.log(`[${stamp()}] console.${p.type}:`, p.args.map((a) => a.value ?? a.description ?? a.type).join(' ')),
    );
    cdp.on('Runtime.exceptionThrown', (p) =>
      console.error(`[${stamp()}] 异常:`, p.exceptionDetails.exception?.description ?? p.exceptionDetails.text),
    );
    cdp.on('Log.entryAdded', (p) =>
      console.log(`[${stamp()}] ${p.entry.level}:`, p.entry.text),
    );
    console.log(`监听 ${seconds}s（Ctrl+C 停止）...`);
    await new Promise((ok) => setTimeout(ok, seconds * 1000));
    cdp.close();
    break;
  }
  default:
    console.log(`用法:
  node cdp.mjs targets
  node cdp.mjs eval '<js表达式>'
  node cdp.mjs shot out.png [selector]
  node cdp.mjs listen [秒]
环境变量: CDP_PORT(默认9222) CDP_TARGET(url子串筛选 target)`);
}
