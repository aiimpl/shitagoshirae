// Chrome を外から動かすための小さな道具（開発用。公開する画面では使わない）
// 使い方: import { openTab } from './cdp.mjs'
const PORT = Number(process.env.CDP_PORT || 9223);

/**
 * 開いているタブにつなぐ。url を渡すと新しいタブで開く
 * @param {string} [url]
 * @returns {Promise<Tab>}
 */
export async function openTab(url) {
  const target = url
    ? await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
    : (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page');
  const tab = new Tab(target.webSocketDebuggerUrl);
  await tab.ready;
  await tab.send('Runtime.enable');
  await tab.send('Page.enable');
  return tab;
}

export class Tab {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    /** @type {Map<string, ((params: any) => void)[]>} */
    this.handlers = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve) => { this.ws.onopen = resolve; });
    this.ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
  }

  /**
   * 出来事を受け取る（Page.fileChooserOpened など）
   * @param {string} method
   * @param {(params: any) => void} fn
   */
  on(method, fn) {
    const list = this.handlers.get(method) || [];
    list.push(fn);
    this.handlers.set(method, list);
  }

  onMessage(msg) {
    if (msg.method && this.handlers.has(msg.method)) {
      for (const fn of this.handlers.get(msg.method) || []) {
        fn(msg.params);
      }
    }
    if (msg.id && this.pending.has(msg.id)) {
      this.pending.get(msg.id)(msg);
      this.pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      this.logs.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      this.logs.push('[例外] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * ページの中で式を動かして、結果を持ち帰る
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const details = r.result?.exceptionDetails;
    if (details) {
      throw new Error(details.exception?.description || details.text);
    }
    return r.result?.result?.value;
  }

  /**
   * 条件が成り立つまで待つ
   * @param {string} expression
   * @param {number} [timeoutMs]
   */
  async waitFor(expression, timeoutMs = 60000) {
    const start = Date.now();
    for (;;) {
      const ok = await this.evaluate(`(() => { try { return !!(${expression}); } catch (e) { return false; } })()`);
      if (ok) {
        return;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error('待ちきれませんでした: ' + expression);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** @param {string} url */
  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"');
  }

  close() {
    this.ws.close();
  }
}
