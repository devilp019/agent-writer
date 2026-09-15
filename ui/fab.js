/**
 * Agent Writer - 悬浮球
 *
 * 职责：状态指示灯 + 面板开关。
 * - 位置按设备存 localStorage（手机和电脑屏幕尺寸不同，同步过去只会跑到屏幕外）
 * - resize / 旋转屏幕时重新夹取位置
 * - 图标一律 inline SVG，不用 emoji（三端字形不一致）
 */

import { subscribe, STATES } from '../state.js?v=0.8.14';

const FAB_ID = 'aw-fab';
const SIZE = 48;
const MARGIN = 16;
const POS_KEY = 'aw_fab_pos_v1';

/** 每个状态的图标（24x24 viewBox） */
const ICONS = {
    idle: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"/>',
    off: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"/>',
    drafting: '<path d="M4 20h4l10.5-10.5a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5zM14 6.5l3.5 3.5"/>',
    checking: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
    rewriting: '<path d="M20.2 5.8a2.3 2.3 0 0 0-3.2-3.2L6 13.6V18h4.4z"/><path d="M4 21h16"/>',
    done: '<path d="m5 13 4.5 4.5L19 7"/>',
    error: '<path d="M12 3 1.5 21h21zM12 9.5v5M12 18h.01"/>',
};

let fab = null;
let unsubscribe = null;

// ---------------------------------------------------------------------------
// 位置
// ---------------------------------------------------------------------------

function getViewport() {
    return {
        W: window.innerWidth || document.documentElement.clientWidth || 1200,
        H: window.innerHeight || document.documentElement.clientHeight || 800,
    };
}

function clampPos(x, y) {
    const { W, H } = getViewport();
    return {
        x: Math.max(MARGIN, Math.min(W - SIZE - MARGIN, x)),
        y: Math.max(MARGIN, Math.min(H - SIZE - MARGIN, y)),
    };
}

function defaultPos() {
    const { W, H } = getViewport();
    return { x: W - SIZE - MARGIN, y: H - SIZE - MARGIN };
}

function loadPos() {
    try {
        const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            return clampPos(saved.x, saved.y);
        }
    } catch { /* 忽略损坏的存储 */ }
    return null;
}

function savePos(x, y) {
    try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
    } catch { /* 隐私模式下可能失败，不影响功能 */ }
}

function applyPos(x, y) {
    if (!fab) return;
    fab.style.left = `${x}px`;
    fab.style.top = `${y}px`;
}

// ---------------------------------------------------------------------------
// 拖拽
// ---------------------------------------------------------------------------

function makeDraggable(el, onTap) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;
    let moved = false;
    let lastTouchAt = 0;

    const onDown = (event) => {
        const isTouch = !!event.touches;
        if (isTouch) {
            lastTouchAt = Date.now();
        } else if (Date.now() - lastTouchAt < 700) {
            // 触摸结束后浏览器会补发一对合成鼠标事件（mousedown/mouseup）。
            // 不挡住的话一次点击会走两遍 onTap，点开又立刻关掉，看起来就是"点了没反应"。
            return;
        }
        if (event.button !== undefined && event.button !== 0 && !isTouch) return;
        const point = isTouch ? event.touches[0] : event;
        dragging = true;
        moved = false;
        startX = point.clientX;
        startY = point.clientY;
        const rect = el.getBoundingClientRect();
        originLeft = rect.left;
        originTop = rect.top;
        el.classList.add('is-dragging');
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
        document.addEventListener('touchmove', onMove, { passive: false, capture: true });
        document.addEventListener('touchend', onUp, true);
        document.addEventListener('touchcancel', onUp, true);
    };

    const onMove = (event) => {
        if (!dragging) return;
        const point = event.touches ? event.touches[0] : event;
        const dx = point.clientX - startX;
        const dy = point.clientY - startY;
        // 5px 以内算点击，避免手指轻微抖动被当成拖拽
        if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        moved = true;
        if (event.cancelable) event.preventDefault();
        const pos = clampPos(originLeft + dx, originTop + dy);
        applyPos(pos.x, pos.y);
    };

    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('is-dragging');
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        document.removeEventListener('touchmove', onMove, { capture: true });
        document.removeEventListener('touchend', onUp, true);
        document.removeEventListener('touchcancel', onUp, true);

        if (moved) {
            // 吸附到最近的屏幕边缘
            const rect = el.getBoundingClientRect();
            const { W, H } = getViewport();
            const cx = rect.left + SIZE / 2;
            const cy = rect.top + SIZE / 2;
            const distances = [
                { edge: 'left', value: cx },
                { edge: 'right', value: W - cx },
                { edge: 'top', value: cy },
                { edge: 'bottom', value: H - cy },
            ];
            const nearest = distances.reduce((a, b) => (a.value <= b.value ? a : b));

            let nx = rect.left;
            let ny = rect.top;
            if (nearest.edge === 'left') nx = MARGIN;
            else if (nearest.edge === 'right') nx = W - SIZE - MARGIN;
            else if (nearest.edge === 'top') ny = MARGIN;
            else ny = H - SIZE - MARGIN;

            const pos = clampPos(nx, ny);
            applyPos(pos.x, pos.y);
            savePos(pos.x, pos.y);
        } else {
            onTap();
        }
    };

    el.addEventListener('mousedown', onDown);
    el.addEventListener('touchstart', onDown, { passive: true });
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderFab(state, detail) {
    if (!fab) return;

    // 扩展热重载后 fab 可能已脱离 DOM，补回去
    if (!fab.isConnected) {
        document.body.appendChild(fab);
        const pos = loadPos() || defaultPos();
        applyPos(pos.x, pos.y);
    }

    fab.dataset.state = state;

    const icon = fab.querySelector('.aw-fab-icon');
    if (icon) icon.innerHTML = ICONS[state] ?? ICONS.idle;

    const badge = fab.querySelector('.aw-fab-badge');
    const text = detail?.badge ? String(detail.badge).slice(0, 3) : '';
    if (badge) badge.textContent = text;
    fab.dataset.badge = text ? 'true' : 'false';

    fab.title = titleFor(state, detail);
}

function titleFor(state, detail) {
    const names = {
        off: 'Agent Writer（自动模式已关闭）',
        idle: 'Agent Writer',
        drafting: '① 草稿生成中',
        checking: '② 校验中',
        rewriting: '③ 改写中',
        done: '✓ 完成',
        error: '✗ 出错',
    };
    const base = names[state] ?? 'Agent Writer';
    return detail?.badge ? `${base} · ${detail.badge}` : base;
}

function ensureFab() {
    let el = document.getElementById(FAB_ID);
    if (el) return el;

    el = document.createElement('button');
    el.id = FAB_ID;
    el.type = 'button';
    el.dataset.state = 'idle';
    el.setAttribute('aria-label', 'Agent Writer');
    el.innerHTML = `
        <span class="aw-fab-pulse"></span>
        <span class="aw-fab-ring"></span>
        <span class="aw-fab-core">
            <svg class="aw-fab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></svg>
        </span>
        <span class="aw-fab-badge"></span>
    `;
    document.body.appendChild(el);
    return el;
}

let onResize = null;

/**
 * 创建悬浮球。
 * @param {() => void} onToggle 点击时调用（不传则不响应点击）
 */
export function mountFab(onToggle = () => {}) {
    fab = ensureFab();
    const pos = loadPos() || defaultPos();
    applyPos(pos.x, pos.y);
    makeDraggable(fab, onToggle);

    // 手机横竖屏切换 / 窗口缩放后，球可能落在可视区外
    onResize = () => {
        if (!fab) return;
        const rect = fab.getBoundingClientRect();
        const pos2 = clampPos(rect.left, rect.top);
        applyPos(pos2.x, pos2.y);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    unsubscribe?.();
    unsubscribe = subscribe(renderFab);
    return fab;
}

export function unmountFab() {
    unsubscribe?.();
    unsubscribe = null;
    if (onResize) {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('orientationchange', onResize);
        onResize = null;
    }
    document.getElementById(FAB_ID)?.remove();
    fab = null;
}

/** 把球复位到默认位置（右下角） */
export function resetFabPosition() {
    const pos = defaultPos();
    applyPos(pos.x, pos.y);
    savePos(pos.x, pos.y);
}

export { STATES };
