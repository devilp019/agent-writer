/**
 * Agent Writer - 扩展菜单项
 *
 * 挂在酒馆的扩展菜单里，和「织幕」「变量管理器」这些并列。
 * 菜单项右侧带行内状态，点开菜单不用开面板也能看到进度。
 *
 * 关于菜单容器的选择：酒馆没有承诺过 #extensionsMenu 这个 id，
 * 所以这里做多路探测 + 持续观察。找不到不算致命（悬浮球还在），
 * 但会记日志，并且菜单重建后能自动补挂。
 */

import { subscribe, isBusy } from '../state.js?v=0.8.22';

const ITEM_ID = 'aw-menu-item';

const STATUS_TEXT = {
    drafting: '草稿中',
    checking: '校验中',
    rewriting: '改写中',
    done: '完成',
    error: '出错',
};

/** 已知的扩展菜单项文字，用来反推菜单容器 */
const KNOWN_ITEMS = ['织幕', '变量管理器', 'Translate Chat', 'Token Counter', 'Open Data Bank'];

let item = null;
let statusEl = null;
let observer = null;
let unsubscribe = null;
let onToggleRef = null;
let warned = false;
let latest = { state: 'idle', detail: null };

// ---------------------------------------------------------------------------
// 查找菜单容器
// ---------------------------------------------------------------------------

function findMenuContainer() {
    for (const selector of ['#extensionsMenu', '.extensionsMenu', '#extensions_menu']) {
        const el = document.querySelector(selector);
        if (el) return { el, how: selector };
    }

    // 退路：按已知菜单项的文字反推父容器
    for (const node of document.querySelectorAll('li, .list-group-item, div')) {
        const text = (node.textContent || '').slice(0, 40);
        if (!KNOWN_ITEMS.some((known) => text.includes(known))) continue;

        const parent = node.parentElement;
        if (parent && parent !== document.body) {
            return { el: parent, how: `已知项「${text.trim().slice(0, 12)}」的父容器` };
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render(state, detail) {
    if (!statusEl) return;

    const label = STATUS_TEXT[state] ?? '';
    statusEl.textContent = label && detail?.badge ? `${label} · ${detail.badge}` : label;
    statusEl.dataset.active = label ? 'true' : 'false';
    item?.classList.toggle('aw-menu-busy', isBusy());
}

function createItem() {
    const el = document.createElement('div');
    el.id = ITEM_ID;
    el.className = 'list-group-item flex-container flexGrow flexGap5 interactable';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.title = 'Agent Writer';
    el.innerHTML = `
        <div class="fa-solid fa-wand-magic-sparkles"></div>
        <span>Agent Writer</span>
        <span class="aw-menu-status" data-active="false"></span>
    `;

    const activate = (event) => {
        event.stopPropagation();
        onToggleRef?.();
    };
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate(event);
        }
    });

    return el;
}

// ---------------------------------------------------------------------------
// 挂载 / 补挂
// ---------------------------------------------------------------------------

function ensureMounted() {
    const found = findMenuContainer();

    if (!found) {
        if (!warned) {
            warned = true;
            console.warn('[AgentWriter] 暂未找到扩展菜单容器，菜单项会在它出现后补挂');
        }
        return false;
    }

    const existing = document.getElementById(ITEM_ID);
    if (existing && existing.parentElement === found.el) {
        item = existing;
        statusEl = existing.querySelector('.aw-menu-status');
        render(latest.state, latest.detail);
        return true;
    }

    existing?.remove();
    item = createItem();
    statusEl = item.querySelector('.aw-menu-status');
    found.el.appendChild(item);
    render(latest.state, latest.detail);

    console.log(`[AgentWriter] 菜单项已挂载（容器来源：${found.how}）`);
    warned = false;
    return true;
}

/**
 * 挂载菜单项。
 * @param {() => void} onToggle
 */
export function mountMenuItem(onToggle = () => {}) {
    onToggleRef = onToggle;

    unsubscribe?.();
    unsubscribe = subscribe((state, detail) => {
        latest = { state, detail };
        render(state, detail);
    });

    ensureMounted();

    // 持续观察：菜单可能是异步渲染的，也可能被酒馆重建
    observer?.disconnect();
    observer = new MutationObserver(() => {
        // 自己刚插进去的节点也会触发回调，用 isConnected 早退避免反复重建
        if (document.getElementById(ITEM_ID)?.isConnected) return;
        ensureMounted();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return item;
}

export function unmountMenuItem() {
    unsubscribe?.();
    unsubscribe = null;
    observer?.disconnect();
    observer = null;
    document.getElementById(ITEM_ID)?.remove();
    item = null;
    statusEl = null;
    warned = false;
}

/** 菜单项当前是否已挂上（自检用） */
export function isMenuItemMounted() {
    return !!document.getElementById(ITEM_ID)?.isConnected;
}

/**
 * 菜单容器探测结果，供自检报告。
 * 这里刻意不触发弹窗，避免自检本身打扰用户。
 */
export function describeMenuContainer() {
    const found = findMenuContainer();
    if (!found) return '未找到扩展菜单容器';
    return `已找到（${found.how}，子项 ${found.el.children?.length ?? '?'} 个）`;
}
