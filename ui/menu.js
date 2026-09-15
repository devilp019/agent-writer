/**
 * Agent Writer - 扩展菜单项
 *
 * 挂在酒馆 #extensionsMenu 里，和「织幕」「变量管理器」这些并列。
 * 相比原脚本的启发式查找（匹配「织幕」的兄弟节点），直接取 #extensionsMenu 稳定得多。
 *
 * 菜单项右侧带行内状态，点开菜单不用开面板也能看到进度。
 */

import { subscribe, isBusy } from '../state.js';

const ITEM_ID = 'aw-menu-item';
const STATUS_TEXT = {
    drafting: '草稿中',
    checking: '校验中',
    rewriting: '改写中',
    done: '完成',
    error: '出错',
};

let item = null;
let statusEl = null;
let observer = null;
let unsubscribe = null;
let latest = { state: 'idle', detail: null };

function render(state, detail) {
    if (!statusEl) return;

    const label = STATUS_TEXT[state] ?? '';
    statusEl.textContent = label && detail?.badge ? `${label} · ${detail.badge}` : label;
    statusEl.dataset.active = label ? 'true' : 'false';
    item?.classList.toggle('aw-menu-busy', isBusy());
}

function createItem(onToggle) {
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
        onToggle();
    };
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate(event);
        }
    });

    statusEl = el.querySelector('.aw-menu-status');
    return el;
}

function tryMount(onToggle) {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;

    const existing = document.getElementById(ITEM_ID);
    if (existing && existing.parentElement === menu) {
        item = existing;
        statusEl = existing.querySelector('.aw-menu-status');
        render(latest.state, latest.detail);
        return true;
    }

    existing?.remove();
    item = createItem(onToggle);
    statusEl = item.querySelector('.aw-menu-status');
    menu.appendChild(item);
    render(latest.state, latest.detail);
    return true;
}

/**
 * 挂载菜单项。若菜单尚未渲染，会等它出现。
 * @param {() => void} onToggle
 */
export function mountMenuItem(onToggle = () => {}) {
    unsubscribe?.();
    unsubscribe = subscribe((state, detail) => {
        latest = { state, detail };
        render(state, detail);
    });

    if (tryMount(onToggle)) return item;

    observer?.disconnect();
    observer = new MutationObserver(() => {
        if (tryMount(onToggle)) {
            observer?.disconnect();
            observer = null;
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
        observer?.disconnect();
        observer = null;
        if (!document.getElementById(ITEM_ID)) {
            console.warn('[AgentWriter] 未找到 #extensionsMenu，菜单项未能挂载');
        }
    }, 15000);

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
}
