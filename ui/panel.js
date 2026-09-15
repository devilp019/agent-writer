/**
 * Agent Writer - 面板
 *
 * 复用原脚本的悬浮面板形态（平板/手机上一根手指就能开），不走酒馆的扩展设置抽屉。
 * 位置按设备存 localStorage，resize / 转屏后重新夹取。
 */

import { demoState } from '../state.js';

const PANEL_ID = 'aw-panel';
const POS_KEY = 'aw_panel_pos_v1';
const MARGIN = 12;

let panel = null;
let logLines = [];
let onAutoChange = null;
let mountOptions = {};

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

function bindEvents(el) {
    el.querySelector('#aw-close')?.addEventListener('click', () => hidePanel());

    el.querySelectorAll('.aw-tab').forEach((btn) => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    el.querySelector('#aw-log-clear')?.addEventListener('click', clearLog);

    // 状态演示：确认三端动画表现
    el.querySelectorAll('[data-state-demo]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const state = btn.dataset.stateDemo;
            log(`预览状态: ${state}`);
            const detail = state === 'checking' ? { badge: '1620' } : state === 'error' ? { badge: '3' } : null;
            // 先回 idle，保证连点同一个状态也能重新触发动画
            mountOptions.onDemoState?.('idle', null);
            mountOptions.onDemoState?.(state, detail);
        });
    });

    el.querySelector('#aw-auto')?.addEventListener('change', (event) => {
        onAutoChange?.(event.target.checked);
    });

    // 自检与连通性测试由 index.js 注入，避免 panel 依赖 diagnostics
    el.querySelector('#aw-diag-run')?.addEventListener('click', () => {
        window.awDiagnose?.();
    });
    el.querySelector('#aw-diag-probe')?.addEventListener('click', () => {
        window.awProbe?.();
    });
    el.querySelector('#aw-diag-copy')?.addEventListener('click', async () => {
        const output = el.querySelector('#aw-diag-output');
        if (!output?.value) return;
        try {
            await navigator.clipboard.writeText(output.value);
            log('自检结果已复制到剪贴板');
        } catch {
            // 剪贴板 API 在非 HTTPS 下不可用，退回选中让用户手动复制
            output.select();
            log('剪贴板不可用，已选中文本，请手动复制');
        }
    });
}

/**
 * 渲染并挂载面板。
 *
 * 模板直接内联在下面的 PANEL_HTML 里，不走 renderExtensionTemplateAsync：
 * 那个函数依赖酒馆按扩展文件夹名去解析模板路径，一旦路径不对就静默失败，
 * 表现为「球能点但面板打不开」。内联之后这条失败路径根本不存在。
 *
 * @param {object} options
 * @param {(auto: boolean) => void} [options.onAutoChange]
 * @param {(state: string, detail: object|null) => void} [options.onDemoState] 状态演示回调
 * @returns {HTMLElement|null}
 */
export function mountPanel(options = {}) {
    if (!options.onDemoState) {
        options.onDemoState = (state, detail) => demoState(state, detail);
    }
    mountOptions = options;

    const holder = document.createElement('div');
    holder.innerHTML = PANEL_HTML;
    const el = holder.querySelector(`#${PANEL_ID}`);
    if (!el) {
        console.error('[AgentWriter] 面板 HTML 解析失败');
        return null;
    }

    document.getElementById(PANEL_ID)?.remove();
    panel = el;
    document.body.appendChild(panel);

    makeHeaderDraggable(panel, panel.querySelector('#aw-header'));
    bindEvents(el);
    switchTab('params');
    applyLayout();

    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);

    return panel;
}

/** 幂等挂载：已挂上就直接返回 */
export function ensurePanelMounted() {
    if (panel?.isConnected) return panel;
    return mountPanel(mountOptions ?? {});
}

function onViewportChange() {
    if (!panel) return;
    applyLayout();
}

export function showPanel() {
    if (!ensurePanelMounted()) {
        console.error('[AgentWriter] 面板挂载失败，无法显示');
        return;
    }
    applyLayout();
    panel.style.display = 'flex';
}

export function hidePanel() {
    if (panel) panel.style.display = 'none';
}

export function togglePanel() {
    // 关键：面板可能因为初始化时序问题还没挂上，这里就地补挂，避免"球能点但没反应"
    if (!ensurePanelMounted()) return;
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

// ---------------------------------------------------------------------------
// 面板模板（内联，不依赖任何异步加载）
// ---------------------------------------------------------------------------

const PANEL_HTML = `
<div id="aw-panel">
    <div id="aw-header">
        <div class="aw-title">
            <span class="aw-logo" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                    <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"/>
                </svg>
            </span>
            <div>
                <div class="aw-name">Agent Writer</div>
                <div class="aw-sub">原生草稿 · 校验 · 重写</div>
            </div>
        </div>
        <div class="aw-header-actions">
            <label class="aw-switch" title="开启后，酒馆每次发送都会自动跑 ②③">
                <input type="checkbox" id="aw-auto">
                <span>自动</span>
            </label>
            <button id="aw-close" class="aw-icon-btn" title="关闭">&#10005;</button>
        </div>
    </div>

    <div class="aw-tabs" role="tablist">
        <button class="aw-tab" data-tab="params">参数</button>
        <button class="aw-tab" data-tab="prompts">提示词</button>
        <button class="aw-tab" data-tab="output">输出</button>
        <button class="aw-tab" data-tab="log">日志</button>
    </div>

    <div class="aw-content">
        <section class="aw-tab-panel" data-panel="params">
            <div class="aw-note">
                <b>① 草稿</b> = 酒馆原生生成（用你当前连接）。<br>
                <b>②③</b> 的接入是下一步，本版本只验证运行环境。
            </div>

            <div class="aw-card">
                <div class="aw-card-title">运行环境自检</div>
                <p class="aw-hint">
                    确认扩展装对了、酒馆 API 拿得到、连接配置能发请求。
                    点「运行自检」后把结果截图发出来即可。
                </p>
                <div class="aw-row">
                    <button id="aw-diag-run" class="aw-btn aw-btn-primary">运行自检</button>
                    <button id="aw-diag-probe" class="aw-btn">测试当前连接配置</button>
                    <button id="aw-diag-copy" class="aw-btn">复制结果</button>
                </div>
                <textarea id="aw-diag-output" readonly rows="10" placeholder="尚未运行"></textarea>
            </div>

            <div class="aw-card">
                <div class="aw-card-title">悬浮球状态演示</div>
                <p class="aw-hint">点击可预览各状态下的动态效果，确认平板/手机上的表现。</p>
                <div class="aw-row">
                    <button class="aw-btn" data-state-demo="idle">待命</button>
                    <button class="aw-btn" data-state-demo="drafting">草稿</button>
                    <button class="aw-btn" data-state-demo="checking">校验</button>
                    <button class="aw-btn" data-state-demo="rewriting">改写</button>
                    <button class="aw-btn" data-state-demo="done">完成</button>
                    <button class="aw-btn" data-state-demo="error">出错</button>
                    <button class="aw-btn" data-state-demo="off">停用</button>
                </div>
            </div>
        </section>

        <section class="aw-tab-panel" data-panel="prompts" hidden>
            <div class="aw-card">
                <div class="aw-card-title">校验提示词</div>
                <textarea id="aw-critic-prompt" rows="12" placeholder="下一步接入"></textarea>
            </div>
            <div class="aw-card">
                <div class="aw-card-title">改写提示词</div>
                <textarea id="aw-rewrite-prompt" rows="12" placeholder="下一步接入"></textarea>
            </div>
        </section>

        <section class="aw-tab-panel" data-panel="output" hidden>
            <div class="aw-card">
                <div class="aw-head"><span>① 草稿</span><span class="aw-stat" id="aw-draft-stats"></span></div>
                <textarea id="aw-draft" rows="5" readonly></textarea>
            </div>
            <div class="aw-card">
                <div class="aw-head"><span>② 校验</span><span class="aw-stat" id="aw-report-stats"></span></div>
                <textarea id="aw-report" rows="5" readonly></textarea>
                <details class="aw-details">
                    <summary>思维链 <span class="aw-stat" id="aw-critic-reasoning-stats"></span></summary>
                    <textarea id="aw-critic-reasoning" rows="6" readonly class="aw-reasoning"></textarea>
                </details>
            </div>
            <div class="aw-card">
                <div class="aw-head"><span>③ 最终正文</span><span class="aw-stat" id="aw-final-stats"></span></div>
                <textarea id="aw-final" rows="6" readonly></textarea>
                <details class="aw-details">
                    <summary>思维链 <span class="aw-stat" id="aw-final-reasoning-stats"></span></summary>
                    <textarea id="aw-final-reasoning" rows="6" readonly class="aw-reasoning"></textarea>
                </details>
            </div>
        </section>

        <section class="aw-tab-panel" data-panel="log" hidden>
            <div class="aw-card">
                <div class="aw-head">
                    <span>调试日志</span>
                    <button id="aw-log-clear" class="aw-icon-btn">清空</button>
                </div>
                <div id="aw-log" class="aw-log"></div>
            </div>
        </section>
    </div>

    <div class="aw-footer">
        <button id="aw-run" class="aw-btn aw-btn-primary aw-grow" disabled
                title="流水线尚未接入">▶ 用最后一条 AI 回复作草稿</button>
        <button id="aw-stop" class="aw-btn aw-btn-danger" disabled>⏹ 停止</button>
    </div>
</div>
`;
