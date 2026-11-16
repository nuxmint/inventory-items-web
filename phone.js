// Inventory Items on the iPhone: read-only. Unlocks the encrypted library once, then shows stock,
// daily reports and invoices. Everything is entered on the Mac.
(function () {
  'use strict';
  const app = document.getElementById('app');
  const toastBox = document.getElementById('toast');
  const TAB_KEY = 'inventory-items-tab';
  const FILTER_KEY = 'inventory-items-phone-filter';
  const SIDES = { cafe: '카페', kitchen: '주방', both: '공용' };
  const STATE_NAMES = { none: '판매 입력 없음', unanalyzed: '분석 전', stale: '다시 분석 필요', incomplete: '미완료 (! 있음)', done: '분석 완료' };
  let key = null;
  let library = null;
  let tab = localStorage.getItem(TAB_KEY) || 'stock';
  let filter = localStorage.getItem(FILTER_KEY) || 'all';
  let dayIndex = 0;

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') node.className = value;
      else if (name === 'text') node.textContent = value;
      else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
      else if (name === 'hidden' || name === 'disabled') node[name] = Boolean(value);
      else node.setAttribute(name, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function toast(message) {
    toastBox.textContent = message;
    toastBox.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastBox.classList.remove('show'), 3000);
  }

  function fmt(value, unit) {
    if (value === null || value === undefined) return '-';
    let shown = Number(value);
    let label = unit;
    if (unit === 'g' && Math.abs(shown) >= 1000) { shown /= 1000; label = 'kg'; }
    else if (unit === 'ml' && Math.abs(shown) >= 1000) { shown /= 1000; label = 'L'; }
    const digits = Math.abs(shown) >= 100 ? 0 : Math.abs(shown) >= 10 ? 1 : 2;
    const text = shown.toLocaleString('ko-KR', { maximumFractionDigits: digits });
    return unit === '개' ? `${text}개` : `${text} ${label}`;
  }

  function fmtPack(value, pack) {
    if (!pack || value === null || value === undefined) return '';
    return `≈ ${(value / pack.factor).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} ${pack.unit}`;
  }

  /** In the item's count unit (3.2 Bag) when it has one; the other unit goes underneath. */
  function stockMain(value, item) {
    if (value !== null && value !== undefined && item.pack && item.pack.own) {
      return `${(value / item.pack.factor).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} ${item.pack.unit}`;
    }
    return fmt(value, item.unit);
  }
  function stockSub(value, item) {
    if (item.pack && item.pack.own) return value === null || value === undefined ? '' : fmt(value, item.unit);
    return fmtPack(value, item.pack);
  }

  function money(value) {
    return value === null || value === undefined ? '' : `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function dayLabel(text) {
    if (!text) return '';
    const [year, month, day] = text.split('-').map(Number);
    return `${month}월 ${day}일 (${'일월화수목금토'[new Date(year, month - 1, day).getDay()]})`;
  }

  function shows(side) {
    return filter === 'all' || side === 'both' || side === filter;
  }

  // ---------- Key (IndexedDB keeps the key itself; it cannot be read back out) ----------

  function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('inventory-items', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function stored(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = action(db.transaction('keys', mode).objectStore('keys'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const loadSavedKey = () => stored('readonly', (store) => store.get('main')).catch(() => null);
  const saveKey = (record) => stored('readwrite', (store) => store.put(record, 'main'));
  const forgetKey = () => stored('readwrite', (store) => store.delete('main'));

  function bytes(base64) {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  async function deriveKey(passphrase, info) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(info.salt), iterations: info.iterations },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }

  function open(cryptoKey, buffer) {
    const data = new Uint8Array(buffer);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, cryptoKey, data.slice(12));
  }

  // ---------- Loading ----------

  async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    let info;
    try {
      const response = await fetch('data/key.json', { cache: 'no-cache' });
      if (response.status === 404) {
        message('아직 게시된 재고가 없습니다', '맥의 Inventory Items에서 [Publish to Phone]를 누른 뒤 1~2분 후 다시 열어 주세요.');
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      info = await response.json();
    } catch (problem) {
      message('불러오지 못했습니다', '인터넷에 연결한 뒤 다시 열어 주세요.');
      return;
    }
    const saved = await loadSavedKey();
    if (saved && saved.salt === info.salt) {
      key = saved.key;
      await loadLibrary();
    } else {
      showLock(info, Boolean(saved));
    }
  }

  async function loadLibrary() {
    try {
      const response = await fetch('data/library.bin', { cache: 'no-cache' });
      if (!response.ok) throw new Error(String(response.status));
      library = JSON.parse(new TextDecoder().decode(await open(key, await response.arrayBuffer())));
    } catch (problem) {
      message('재고를 열지 못했습니다', '인터넷에 연결한 뒤 다시 열어 주세요. 계속 안 되면 아래 [잠그기]로 비밀번호를 다시 입력하세요.', true);
      return;
    }
    render();
  }

  function lockButton() {
    return h('button', { type: 'button', class: 'button quiet', text: '잠그기', onclick: async () => {
      await forgetKey();
      key = null;
      library = null;
      start();
    } });
  }

  function message(title, text, withLock = false) {
    app.replaceChildren(h('section', { class: 'message' }, h('h1', { text: title }), h('p', { class: 'muted', text }), withLock ? lockButton() : null));
  }

  function showLock(info, changed) {
    const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: '게시 비밀번호' });
    const error = h('p', { class: 'error', hidden: true });
    const go = h('button', { type: 'submit', class: 'button primary', text: '열기' });
    const form = h('form', { class: 'lock' }, h('img', { src: 'icons/icon-180.png', alt: '' }), h('h1', { text: 'Inventory Items' }),
      h('p', { class: 'muted', text: changed ? '맥에서 게시 비밀번호를 새로 정했습니다. 새 비밀번호를 입력하세요.' : '맥에서 게시할 때 정한 비밀번호를 한 번 입력하세요. 이 iPhone에서는 다시 묻지 않습니다.' }),
      input, error, go);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      go.disabled = true;
      go.textContent = '확인 중…';
      error.hidden = true;
      try {
        const candidate = await deriveKey(input.value, info);
        await open(candidate, bytes(info.check));
        key = candidate;
        input.value = '';
        await saveKey({ key: candidate, salt: info.salt });
        await loadLibrary();
      } catch (problem) {
        error.textContent = '비밀번호가 맞지 않습니다.';
        error.hidden = false;
        go.disabled = false;
        go.textContent = '열기';
      }
    });
    app.replaceChildren(form);
    input.focus();
  }

  // ---------- Screens ----------

  function render() {
    const items = library.items.filter((item) => shows(item.side));
    const head = h('header', { class: 'top' },
      h('div', { class: 'title' }, h('h1', { text: 'Inventory Items' }), h('span', { class: 'muted', text: `${dayLabel(library.latest)} 기준 · 게시 ${library.generated_at.replace('T', ' ')}` })),
      h('div', { class: 'segmented' }, ['all', 'cafe', 'kitchen'].map((name) => h('button', { type: 'button', class: name === filter ? 'active' : null,
        text: { all: '전체', cafe: '카페', kitchen: '주방' }[name], onclick: () => { filter = name; localStorage.setItem(FILTER_KEY, name); render(); } }))));
    const tabs = h('nav', { class: 'tabs' }, [['stock', '재고'], ['days', '일일 분석'], ['invoices', '입고']].map(([name, label]) => h('button', {
      type: 'button', class: name === tab ? 'active' : null, text: label, onclick: () => { tab = name; localStorage.setItem(TAB_KEY, name); render(); window.scrollTo(0, 0); },
    })));
    const body = tab === 'days' ? renderDays(items) : tab === 'invoices' ? renderInvoices() : renderStock(items);
    const issues = library.issues.length ? h('details', { class: 'issues' }, h('summary', {}, h('span', { class: 'bang', text: '!' }), ` 확인할 것 ${library.issues.length}개 — 맥에서 입력하세요`),
      h('ul', {}, library.issues.slice(0, 40).map((issue) => h('li', {}, h('strong', { text: issue.title }), h('div', { class: 'muted small', text: `${dayLabel(issue.date)}${issue.where ? ` · ${issue.where}` : ''}` }))))) : null;
    app.replaceChildren(head, tabs, issues, body, h('footer', {}, lockButton()));
  }

  function renderStock(items) {
    const low = items.filter((item) => item.low || item.negative);
    const rest = items.filter((item) => !item.low && !item.negative);
    const row = (item) => h('li', { class: `stock ${item.low ? 'low' : ''} ${item.negative ? 'negative' : ''}` },
      h('div', {}, h('strong', { text: item.name }), ' ', h('span', { class: `tag ${item.side}`, text: SIDES[item.side] }),
        h('div', { class: 'muted small', text: item.threshold === null ? '한계량 없음' : `한계량 ${stockMain(item.threshold, item)}` })),
      h('div', { class: 'amount' }, h('strong', { text: stockMain(item.end, item) }), h('div', { class: 'muted small', text: stockSub(item.end, item) }),
        item.negative ? h('span', { class: 'tag warn', text: '! 0보다 적음' }) : item.low ? h('span', { class: 'tag low', text: '부족' }) : null));
    if (!items.length) return h('section', { class: 'card' }, h('p', { class: 'muted', text: '재고 품목이 없습니다.' }));
    return h('div', {},
      low.length ? h('section', { class: 'card alert' }, h('h2', { text: `부족 재료 ${low.length}개` }), h('ul', { class: 'list' }, low.map(row))) : null,
      h('section', { class: 'card' }, h('h2', { text: low.length ? '나머지 재고' : '재고 — 모두 충분합니다' }), h('ul', { class: 'list' }, rest.map(row))));
  }

  function renderDays(items) {
    const days = library.days;
    if (!days.length) return h('section', { class: 'card' }, h('p', { class: 'muted', text: '최근 30일 기록이 없습니다.' }));
    dayIndex = Math.min(dayIndex, days.length - 1);
    const day = days[dayIndex];
    const names = new Map(library.items.map((item) => [item.id, item]));
    const chips = h('div', { class: 'chips' }, days.map((entry, index) => h('button', { type: 'button', class: `${index === dayIndex ? 'active' : ''} ${entry.state}`,
      text: dayLabel(entry.date).replace(/ \(.+\)/, ''), onclick: () => { dayIndex = index; render(); } })));
    const usage = new Map(day.usage.map((entry) => [entry.item_id, entry.details]));
    const rows = day.rows.filter((row) => shows((names.get(row.item_id) || {}).side) && (row.in || row.used || row.manual || row.adjust));
    const list = h('ul', { class: 'list' }, rows.map((row) => {
      const item = names.get(row.item_id);
      const details = usage.get(row.item_id) || [];
      const parts = [];
      if (row.in) parts.push(`입고 +${fmt(row.in, item.unit)}`);
      if (row.used) parts.push(`사용 −${fmt(row.used, item.unit)}`);
      if (row.manual) parts.push(`수동 −${fmt(row.manual, item.unit)}`);
      if (row.adjust) parts.push(`실사 ${row.adjust > 0 ? '+' : ''}${fmt(row.adjust, item.unit)}`);
      return h('li', { class: `stock ${row.low ? 'low' : ''}` },
        h('div', {}, h('strong', { text: item.name }), h('div', { class: 'muted small', text: parts.join(' · ') }),
          details.length ? h('details', {}, h('summary', { class: 'small', text: '메뉴별 사용' }),
            h('ul', { class: 'small' }, details.map((entry) => h('li', { text: `${entry.menu}${entry.option ? ` · ${entry.option}` : ''} ${entry.count}${entry.kind === 'prep' ? '배치' : '개'} = ${fmt(entry.amount, item.unit)}` })))) : null),
        h('div', { class: 'amount' }, h('strong', { text: stockMain(row.end, item) }), h('div', { class: 'muted small', text: stockSub(row.end, item) }),
          row.low ? h('span', { class: 'tag low', text: '부족' }) : null));
    }));
    return h('div', {}, chips,
      h('section', { class: 'card' }, h('h2', {}, dayLabel(day.date), ' ', h('span', { class: `tag ${day.state === 'done' ? 'ok' : 'warn'}`, text: STATE_NAMES[day.state] || day.state })),
        rows.length ? list : h('p', { class: 'muted', text: '이날 재고 변화가 없습니다.' })),
      day.sales.length ? h('section', { class: 'card' }, h('h2', { text: '판매·프렙' }), h('ul', { class: 'list plain' }, day.sales.map((sale) => h('li', {},
        h('span', {}, h('strong', { text: sale.name || '' }), sale.option ? h('span', { class: 'muted', text: ` · ${sale.option}` }) : null),
        h('span', { text: `${sale.count}${sale.kind === 'prep' ? '배치' : '개'}` }))))) : null,
      day.issues.length ? h('section', { class: 'card' }, h('h2', { text: `확인할 것 ${day.issues.length}개` }), h('ul', { class: 'list plain' }, day.issues.map((issue) => h('li', {},
        h('div', {}, h('strong', { text: issue.title }), issue.where ? h('div', { class: 'small', text: issue.where }) : null,
          h('div', { class: 'muted small', text: issue.detail })))))) : null);
  }

  function renderInvoices() {
    if (!library.invoices.length) return h('section', { class: 'card' }, h('p', { class: 'muted', text: '최근 30일 인보이스가 없습니다.' }));
    const names = new Map(library.items.map((item) => [item.name, item]));
    return h('div', {}, library.invoices.map((invoice) => h('section', { class: 'card' },
      h('h2', {}, `${dayLabel(invoice.date)} · ${invoice.vendor || '거래처 미입력'}`, ' ', invoice.confirmed ? null : h('span', { class: 'tag warn', text: '확인 전' })),
      invoice.total !== null ? h('p', { class: 'muted small', text: `총액 ${money(invoice.total)}` }) : null,
      h('ul', { class: 'list plain' }, invoice.lines.map((line) => {
        const item = names.get(line.item);
        return h('li', {}, h('div', {}, h('div', { text: line.description || '' }),
          h('div', { class: 'muted small', text: line.excluded ? '재고 제외' : line.item ? `→ ${line.item}${line.stock_amount !== null && item ? ` +${fmt(line.stock_amount, item.unit)}` : ''}` : '! 재고 품목 미연결' })),
        h('span', { class: 'small', text: `${line.quantity ?? ''} ${line.unit || ''}` }));
      })))));
  }

  start();
})();
