/**
 * Agent Writer - 面板
 *
 * 复用原脚本的悬浮面板形态（平板/手机上一根手指就能开），不走酒馆的扩展设置抽屉。
 * 位置按设备存 localStorage，resize / 转屏后重新夹取。
 */

import { setState } from '../state.js';

const PANEL_ID = 'aw-panel';
const POS_KEY = 'aw_panel_pos_v1';
const MARGIN = 12;

let panel = null;
let logLines = [];
let onAutoChange = null;

// ---------------------------------------------------------------------------
// 位置
// ---------------------------------------------------------------------------

function viewport() {
    return {
        W: window.innerWidth || document.documentElement.clientWidth || 1200,
        H: window.innerHeight || document.documentElement.clientHeight || 800,
    };
}

function panelSize() {
    const { W, H } = viewport();
    const isMobile = W < 720;
    return {
        isMobile,
        W: isMobile ? Math.max(300, W - 16) : Math.min(680, W - 60),
        H: isMobile ? Math.max(360, H - 16) : Math.min(840, H - 80),
    };
}

function defaultPanelPos() {
    const { W, H } = viewport();
    const size = panelSize();
    return {
        x: size.isMobile ? 8 : Math.max(MARGIN, (W - size.W) / 2),
        y: size.isMobile ? 8 : Math.max(MARGIN, (H - size.H) / 2 - 20),
    };
}

function clampPanelPos(x, y) {
    const { W, H } = viewport();
    const size = panelSize();
    return {
        x: Math.max(MARGIN, Math.min(W - size.W - MARGIN, x)),
        y: Math.max(MARGIN, Math.min(H - size.H - MARGIN, y)),
    };
}

function loadPanelPos() {
    try {
        const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            return clampPanelPos(saved.x, saved.y);
        }
    } catch { /* 忽略 */ }
    return null;
}

function savePanelPos(x, y) {
    try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
    } catch { /* 忽略 */ }
}

function applyLayout() {
    if (!panel) return;
    const size = panelSize();
    const pos = loadPanelPos() || defaultPanelPos();
    panel.style.width = `${size.W}px`;
    panel.style.height = `${size.H}px`;
    panel.style.left = `${pos.x}px`;
    panel.style.top = `${pos.y}px`;
}

// ---------------------------------------------------------------------------
// 拖拽（仅标题栏）
// ---------------------------------------------------------------------------

function makeHeaderDraggable(el, handle) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;

    const onDown = (event) => {
        if (event.button !== undefined && event.button !== 0 && !event.touches) return;
        if (event.target.closest('input, button, textarea, label, select')) return;
        const point = event.touches ? event.touches[0] : event;
        dragging = true;
        startX = point.clientX;
        startY = point.clientY;
        const rect = el.getBoundingClientRect();
        originLeft = rect.left;
        originTop = rect.top;
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
        document.addEventListener('touchmove', onMove, { passive: false, capture: true });
        document.addEventListener('touchend', onUp, true);
        document.addEventListener('touchcancel', onUp, true);
    };

    const onMove = (event) => {
        if (!dragging) return;
        const point = event.touches ? event.touches[0] : event;
        if (event.cancelable) event.preventDefault();
        const pos = clampPanelPos(
            originLeft + point.clientX - startX,
            originTop + point.clientY - startY,
        );
        el.style.left = `${pos.x}px`;
        el.style.top = `${pos.y}px`;
    };

    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        document.removeEventListener('touchmove', onMove, { capture: true });
        document.removeEventListener('touchend', onUp, true);
        document.removeEventListener('touchcancel', onUp, true);
        const rect = el.getBoundingClientRect();
        const pos = clampPanelPos(rect.left, rect.top);
        el.style.left = `${pos.x}px`;
        el.style.top = `${pos.y}px`;
        savePanelPos(pos.x, pos.y);
    };

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: true });
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

export function log(message) {
    const time = new Date().toLocaleTimeString();
    logLines.push(`[${time}] ${message}`);
    if (logLines.length > 500) logLines.shift();

    const el = document.getElementById('aw-log');
    if (el) {
        el.textContent = logLines.join('\n');
        el.scrollTop = el.scrollHeight;
    }
    console.log('[AgentWriter]', message);
}

export function clearLog() {
    logLines = [];
    const el = document.getElementById('aw-log');
    if (el) el.textContent = '';
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function switchTab(tab) {
    panel?.querySelectorAll('.aw-tab').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.tab === tab);
    });
    panel?.querySelectorAll('.aw-tab-panel').forEach((section) => {
        section.hidden = section.dataset.panel !== tab;
    });
}

function bindEvents() {
    panel.querySelector('#aw-close')?.addEventListener('click', () => hidePanel());

    panel.querySelectorAll('.aw-tab').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    panel.querySelector('#aw-log-clear')?.addEventListener('click', clearLog);

    // 状态演示：确认三端动画表现
    panel.querySelectorAll('[data-state-demo]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const state = btn.dataset.stateDemo;
            log(`预览状态: ${state}`);
            // 先回 idle，保证连点同一个状态也能重新触发动画
            setState('idle');
            setState(state, state === 'checking' ? { badge: '1620' } : state === 'error' ? { badge: '3' } : null);
        });
    });

    panel.querySelector('#aw-auto')?.addEventListener('change', (event) => {
        onAutoChange?.(event.target.checked);
    });

    // 自检与连通性测试由 index.js 注入，避免 panel 依赖 diagnostics
    panel.querySelector('#aw-diag-run')?.addEventListener('click', () => {
        window.awDiagnose?.();
    });
    panel.querySelector('#aw-diag-probe')?.addEventListener('click', () => {
        window.awProbe?.();
    });
    panel.querySelector('#aw-diag-copy')?.addEventListener('click', async () => {
        const el = panel.querySelector('#aw-diag-output');
        if (!el?.value) return;
        try {
            await navigator.clipboard.writeText(el.value);
            log('自检结果已复制到剪贴板');
        } catch {
            // 剪贴板 API 在非 HTTPS 下不可用，退回选中让用户手动复制
            el.select();
            log('剪贴板不可用，已选中文本，请手动复制');
        }
    });
}

/**
 * 渲染并挂载面板。
 * @param {object} options
 * @param {(html: string) => string} options.renderTemplate 用 context.renderExtensionTemplateAsync 包一层
 * @param {(auto: boolean) => void} [options.onAutoChange]
 */
export async function mountPanel({ renderTemplate, onAutoChange: autoCb } = {}) {
    onAutoChange = autoCb;

    const html = await renderTemplate('settings');
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const el = holder.querySelector(`#${PANEL_ID}`);
    if (!el) {
        throw new Error('面板模板里找不到 #aw-panel（settings.html 是否被改动？）');
    }

    document.getElementById(PANEL_ID)?.remove();
    panel = el;
    document.body.appendChild(panel);

    makeHeaderDraggable(panel, panel.querySelector('#aw-header'));
    bindEvents();
    switchTab('params');
    applyLayout();

    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);

    return panel;
}

function onViewportChange() {
    if (!panel) return;
    applyLayout();
}

export function showPanel() {
    if (!panel) return;
    applyLayout();
    panel.style.display = 'flex';
}

export function hidePanel() {
    if (panel) panel.style.display = 'none';
}

export function togglePanel() {
    if (!panel) return;
    if (panel.style.display === 'flex') hidePanel();
    else showPanel();
}

export function isPanelOpen() {
    return panel?.style.display === 'flex';
}

export function unmountPanel() {
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('orientationchange', onViewportChange);
    panel?.remove();
    panel = null;
}

/** 供 diagnostics 写入结果 */
export function setDiagOutput(text) {
    const el = document.getElementById('aw-diag-output');
    if (el) el.value = text;
}

export function getAutoCheckbox() {
    return document.getElementById('aw-auto');
}
