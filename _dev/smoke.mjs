/**
 * 本地验证脚本（不随扩展分发，放在 _dev/ 下）
 *
 * 目的：平板后端开不了控制台，所以把真实的 UI 模块跑在一个最小 DOM 桩上，
 * 把「点了没反应」这类问题在本地摁掉。
 *
 * 用法：node _dev/smoke.mjs
 */

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 最小 DOM 桩
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source']);

class ClassList {
    constructor(el) { this.el = el; }
    get set() {
        return new Set(String(this.el.attributes.class || '').split(/\s+/).filter(Boolean));
    }
    _write(set) { this.el.attributes.class = [...set].join(' '); }
    add(...names) { const s = this.set; names.forEach((n) => s.add(n)); this._write(s); }
    remove(...names) { const s = this.set; names.forEach((n) => s.delete(n)); this._write(s); }
    contains(name) { return this.set.has(name); }
    toggle(name, force) {
        const has = this.contains(name);
        const on = force === undefined ? !has : !!force;
        if (on) this.add(name); else this.remove(name);
        return on;
    }
}

class El {
    constructor(tag = 'div') {
        this.tagName = String(tag).toUpperCase();
        this.attributes = {};
        this.children = [];
        this.parentElement = null;
        this.listeners = {};
        this.textNodes = [];
        this._ownText = '';
        this._textOverride = null;
        this.style = new Proxy({}, { get: (t, k) => t[k] ?? '', set: (t, k, v) => { t[k] = v; return true; } });
        // dataset 直接映射到 data-* 属性（双向），这样 HTML 里写的 data-* 也能被读到
        this.dataset = new Proxy({}, {
            get: (t, k) => {
                if (typeof k !== 'string') return undefined;
                return this.attributes[`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`];
            },
            set: (t, k, v) => {
                this.attributes[`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = String(v);
                return true;
            },
            has: (t, k) => typeof k === 'string' && `data-${k}` in this.attributes,
        });
        this.classList = new ClassList(this);
    }

    get id() { return this.attributes.id || ''; }
    set id(v) { this.attributes.id = v; }
    get className() { return this.attributes.class || ''; }
    set className(v) { this.attributes.class = v; }
    get isConnected() { return !!(this.parentElement || this === doc.body); }

    // textContent 聚合所有后代文本，和真实 DOM 一致
    get textContent() {
        if (this._textOverride !== null) return this._textOverride;
        return this._ownText + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) { this._textOverride = String(v); }

    get value() { return this._value ?? ''; }
    set value(v) { this._value = v; }
    get hidden() { return this.attributes.hidden === true; }
    set hidden(v) { if (v) this.attributes.hidden = true; else delete this.attributes.hidden; }

    set innerHTML(html) {
        this.children = [];
        this._html = html;
        parseHTML(html, this);
    }
    get innerHTML() { return this._html || ''; }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }
    remove() {
        if (!this.parentElement) return;
        const i = this.parentElement.children.indexOf(this);
        if (i >= 0) this.parentElement.children.splice(i, 1);
        this.parentElement = null;
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    hasAttribute(name) { return name in this.attributes; }
    focus() {}
    closest(sel) {
        let cur = this;
        while (cur) { if (matches(cur, sel)) return cur; cur = cur.parentElement; }
        return null;
    }
    removeEventListener(type, fn) {
        const list = this.listeners[type];
        if (!list) return;
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
    }
    /** 触发事件（测试用） */
    fire(type, event = {}) {
        const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
        for (const fn of this.listeners[type] ?? []) fn(ev);
        return ev;
    }
    dispatchEvent(ev) { return this.fire(ev.type, ev); }
    select() {}

    *walk() {
        yield this;
        for (const c of this.children) yield* c.walk();
    }
    querySelectorAll(sel) {
        return [...this.walk()].filter((el) => el !== this && matches(el, sel));
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
    getBoundingClientRect() {
        return { left: parseFloat(this.style.left) || 0, top: parseFloat(this.style.top) || 0, width: 0, height: 0 };
    }
}

function matches(el, sel) {
    return String(sel).split(',').map((s) => s.trim()).filter(Boolean).some((one) => {
        if (one.startsWith('#')) return el.attributes.id === one.slice(1);
        if (one.startsWith('.')) return el.classList.contains(one.slice(1));
        if (one.startsWith('[')) {
            const m = one.match(/^\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/);
            if (!m) return false;
            return m[2] === undefined ? m[1] in el.attributes : el.attributes[m[1]] === m[2];
        }
        return el.tagName === one.toUpperCase();
    });
}

function parseHTML(html, root) {
    const tokenRe = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
    const stack = [root];
    let last = 0;
    let m;

    const addText = (text) => {
        const trimmed = text.trim();
        if (trimmed) stack[stack.length - 1]._ownText += trimmed;
    };

    while ((m = tokenRe.exec(html)) !== null) {
        addText(html.slice(last, m.index));
        last = tokenRe.lastIndex;

        const [full, tag, rawAttrs, selfClose] = m;
        const closing = full.startsWith('</');
        if (closing) {
            if (stack.length > 1) stack.pop();
            continue;
        }

        const el = new El(tag);
        const attrRe = /([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        let a;
        while ((a = attrRe.exec(rawAttrs)) !== null) {
            const key = a[1];
            const val = a[2] ?? a[3] ?? a[4] ?? '';
            el.attributes[key] = val === '' ? true : val;
        }
        stack[stack.length - 1].appendChild(el);
        if (!selfClose && !VOID_TAGS.has(tag.toLowerCase())) stack.push(el);
    }
    addText(html.slice(last));
}

// ---------------------------------------------------------------------------
// 全局注入
// ---------------------------------------------------------------------------

const doc = new El('body');
doc.body = doc;
doc.documentElement = doc;
doc.createElement = (tag) => new El(tag);
doc.getElementById = (id) => [...doc.walk()].find((el) => el.attributes.id === id) ?? null;
doc.addEventListener = () => {};
doc.removeEventListener = () => {};

globalThis.document = doc;
globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 900;
globalThis.devicePixelRatio = 1;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false });
// Node 24 的 globalThis.navigator 只有 getter，得用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
});
globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
};
globalThis.console.log = globalThis.console.log.bind(globalThis);

const results = [];

// ---------------------------------------------------------------------------
// 用例 1：面板能挂载，且 toggle 能打开
// ---------------------------------------------------------------------------

const panel = await import('../ui/panel.js');

const el = panel.mountPanel({});
results.push(['mountPanel 返回元素', !!el]);
results.push(['#aw-panel 已入 DOM', !!document.getElementById('aw-panel')]);
results.push(['初始 display 非 flex', el.style.display !== 'flex']);

panel.togglePanel();
results.push(['togglePanel 后 display === flex', el.style.display === 'flex']);

panel.togglePanel();
results.push(['再次 toggle 后隐藏', el.style.display === 'none']);

// ---------------------------------------------------------------------------
// 用例 2：面板未挂载时 toggle 会就地补挂（这是"点了没反应"的修复点）
// ---------------------------------------------------------------------------

document.getElementById('aw-panel').remove();
panel.unmountPanel();
results.push(['卸载后 #aw-panel 不存在', !document.getElementById('aw-panel')]);

panel.togglePanel();
const remounted = document.getElementById('aw-panel');
results.push(['未挂载时 toggle 能就地补挂', !!remounted]);
results.push(['补挂后是打开的', remounted?.style.display === 'flex']);

// ---------------------------------------------------------------------------
// 用例 3：模板完整性 —— 所有 JS 引用的 id 都要在模板里
// ---------------------------------------------------------------------------

const REQUIRED_IDS = [
    'aw-header', 'aw-close', 'aw-auto', 'aw-log', 'aw-log-clear',
    'aw-diag-run', 'aw-diag-probe', 'aw-diag-copy', 'aw-diag-output',
    'aw-draft', 'aw-report', 'aw-final',
];
for (const id of REQUIRED_IDS) {
    results.push([`模板含 #${id}`, !!remounted?.querySelector(`#${id}`)]);
}
results.push(['模板含 7 个状态演示按钮', remounted.querySelectorAll('[data-state-demo]').length === 7]);
results.push(['模板含 4 个页签', remounted.querySelectorAll('.aw-tab').length === 4]);

// 页签切换
const outputTab = remounted.querySelectorAll('.aw-tab').find((b) => b.dataset.tab === 'output');
outputTab.fire('click');
const outputPanel = remounted.querySelectorAll('.aw-tab-panel').find((s) => s.dataset.panel === 'output');
const paramsPanel = remounted.querySelectorAll('.aw-tab-panel').find((s) => s.dataset.panel === 'params');
results.push(['切到「输出」后 output 可见', outputPanel.hidden === false]);
results.push(['切到「输出」后 params 隐藏', paramsPanel.hidden === true]);

// ---------------------------------------------------------------------------
// 用例 4：状态演示驱动悬浮球
// ---------------------------------------------------------------------------

const state = await import('../state.js');
const fabApi = await import('../ui/fab.js');

fabApi.mountFab(() => {});
const fab = document.getElementById('aw-fab');
results.push(['悬浮球已入 DOM', !!fab]);

remounted.querySelectorAll('[data-state-demo]').forEach((btn) => {
    const target = btn.dataset.stateDemo;
    btn.fire('click');
    results.push([`演示按钮「${target}」→ fab data-state`, fab.dataset.state === target]);
});

// 徽标
state.setState('checking', { badge: '1620' });
results.push(['徽标模式下 data-badge=true', fab.dataset.badge === 'true']);
results.push(['徽标文字被截到 3 位', fab.querySelector('.aw-fab-badge').textContent === '162']);

// 瞬时状态自动清徽标
state.setState('done');
results.push(['done 状态清空徽标', fab.dataset.badge === 'false']);

// 连点同一个状态也要重新触发（先回 idle 的手法）
state.setState('idle');
state.setState('error', { badge: '3' });
results.push(['error 状态显示条数', fab.querySelector('.aw-fab-badge').textContent === '3']);

// ---------------------------------------------------------------------------
// 用例 5：菜单项挂载 + 行内状态
// ---------------------------------------------------------------------------

const menu = await import('../ui/menu.js');

// 模拟酒馆的扩展菜单容器
const extMenu = document.createElement('div');
extMenu.id = 'extensionsMenu';
doc.appendChild(extMenu);

let toggled = 0;
menu.mountMenuItem(() => { toggled++; });

const item = document.getElementById('aw-menu-item');
results.push(['菜单项挂到 #extensionsMenu', item?.parentElement === extMenu]);
results.push(['菜单项显示名称', item?.textContent.includes('Agent Writer')]);

const statusEl = item.querySelector('.aw-menu-status');
state.setState('checking', { badge: '1620' });
results.push(['菜单项行内状态更新', statusEl.textContent.includes('校验中')]);
results.push(['生成中数据 active=true', statusEl.dataset.active === 'true']);

state.setState('idle');
results.push(['回到待命后状态隐藏', statusEl.dataset.active === 'false']);

item.fire('click');
results.push(['点菜单项调用 onToggle', toggled === 1]);

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

let failed = 0;
console.log('\n=== Agent Writer 本地烟测 ===\n');
for (const [name, pass] of results) {
    if (!pass) failed++;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n共 ${results.length} 项，失败 ${failed} 项\n`);

if (failed > 0) {
    process.exitCode = 1;
} else {
    console.log('全部通过 —— 面板挂载、就地补挂、模板完整性、状态机、菜单项均正常。\n');
}
assert.ok(true);
