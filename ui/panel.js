/**
 * Agent Writer - 面板
 *
 * 复用原脚本的悬浮面板形态（平板/手机上一根手指就能开），不走酒馆的扩展设置抽屉。
 * 位置按设备存 localStorage，resize / 转屏后重新夹取。
 */

import { demoState } from '../state.js?v=0.8.19';

const PANEL_ID = 'aw-panel';
const POS_KEY = 'aw_panel_pos_v1';
const MARGIN = 12;

let panel = null;
let logLines = [];
let onAutoChange = null;
let mountOptions = {};

// ---------------------------------------------------------------------------
// 阶段配置控件
// ---------------------------------------------------------------------------

const STAGE_LABELS = { critic: '② 校验', final: '③ 改写' };

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 动态生成一个阶段的配置控件。
 * 动态生成而不是写死在模板里：字段会随阶段增减，写死容易漏 id（烟测能发现，但没必要）。
 */
function stageFieldsHTML(stage, settings, proxyNames = []) {
    const s = settings?.[stage] ?? {};
    const id = (name) => `aw-${stage}-${name}`;

    const options = [
        `<option value="">（用当前连接）</option>`,
        ...proxyNames.map((n) => `<option value="${esc(n)}" ${n === s.proxyPreset ? 'selected' : ''}>${esc(n)}</option>`),
    ];
    if (s.proxyPreset && !proxyNames.includes(s.proxyPreset)) {
        options.push(`<option value="${esc(s.proxyPreset)}" selected>${esc(s.proxyPreset)}（已不在列表里）</option>`);
    }

    return `
        <label class="aw-field">
            <span>注入槽位条目名（在预设里手工新建的条目）</span>
            <input type="text" id="${id('slot')}" value="${esc(s.slotName ?? '')}" placeholder="例如 AW-校验">
            <em class="aw-tip">指令写进这个条目，位置和身份由你在预设里控制 —— 末尾注入盖不住预设里更靠后的强提示词。</em>
        </label>

        <label class="aw-field">
            <span>换渠道：API 地址（留空 = 用当前连接）</span>
            <input type="text" id="${id('apiurl')}" value="${esc(s.apiUrl ?? '')}" placeholder="例如 https://api.cline.bot/api/v1">
            <em class="aw-tip">填 <b>base 地址</b>（到 /v1 为止）就行，/chat/completions 由酒馆自己补。指向 OpenAI 兼容端点。填了它就用这个地址发请求，下面两项都不用管。</em>
        </label>

        <label class="aw-field">
            <span>换渠道：API 密钥</span>
            <input type="password" id="${id('apikey')}" value="${esc(s.apiKey ?? '')}" placeholder="sk-...">
            <em class="aw-tip">明文存在扩展设置里。不分享设置的话只影响你自己。注意别把「账号登录 token」当成 API key —— Cline 这类服务两者不通用，拿错了会返回 401。</em>
        </label>

        <label class="aw-field">
            <span>换渠道：酒馆代理预设（多数情况下用不了，见下）</span>
            <select id="${id('proxy')}">${options.join('')}</select>
            <em class="aw-tip">酒馆的代理预设是挂在具体厂商下面的（DeepSeek / Gemini 等），只换该厂商的 base url，没法指向 Cline 这类自定义端点。地址+密钥填了的话这一项会被忽略。</em>
        </label>

        <label class="aw-field">
            <span>模型覆盖（留空 = 不覆盖）</span>
            <input type="text" id="${id('model')}" value="${esc(s.model ?? '')}" placeholder="留空 = 不覆盖">
        </label>

        <label class="aw-field">
            <span>附加请求体字段（原文发送，可以写不严格的 JSON）</span>
            <textarea id="${id('bodyfields')}" rows="4">${esc(bodyFieldsText(s))}</textarea>
            <em class="aw-tip">这里的内容会**原样**发给上游（走 custom_include_body，酒馆不解析它）。所以你可以写不严格的 JSON —— 例如故意留个尾逗号，反而能让酒馆不去过滤它不认识的字段（providerOptions 这类）。<br>DeepSeek 官方 API 的思考开关：关 <code>{"thinking":{"type":"disabled"}}</code>，开 <code>{"thinking":{"type":"enabled"}}</code>。<b>Cline 例外：</b>实测它把 <code>thinking</code> 和 <code>reasoning_effort</code> 都静默忽略，关不掉。</em>
            <em class="aw-tip">指向 Cline 时，<b>「流式」必须打开</b>：它的非流式响应会多包一层 <code>data</code>，酒馆解析不到正文，会得到「成功但返回为空」。</em>
        </label>

        <div class="aw-grid">
            <label class="aw-field">
                <span>temperature</span>
                <input type="number" step="0.05" id="${id('temp')}" value="${esc(s.temperature)}">
            </label>
            <label class="aw-field">
                <span>max_tokens</span>
                <input type="number" step="256" id="${id('maxtokens')}" value="${esc(s.maxTokens)}">
            </label>
        </div>

        <label class="aw-switch aw-switch-block">
            <input type="checkbox" id="${id('stream')}" ${s.useStream !== false ? 'checked' : ''}>
            <span>走流式</span>
            <em class="aw-tip">部分上游（如 Cline）非流式解析不了，建议保持开启</em>
        </label>
    `;
}

/**
 * 文本框里该显示什么。
 *
 * 优先用**原文**（bodyFieldsRaw），而不是解析后的对象 ——
 * 用户写不严格 JSON 时解析会失败、bodyFields 变成 {}，
 * 如果拿它去渲染，用户写的内容会在面板重绘时被抹掉。
 * 表现就是「填了但没存住」。（这正是一个实测报上来的 bug。）
 */
function bodyFieldsText(s) {
    const raw = s.bodyFieldsRaw;
    if (typeof raw === 'string' && raw.trim()) return raw;
    const obj = s.bodyFields ?? {};
    return Object.keys(obj).length ? JSON.stringify(obj, null, 2) : '{}';
}

/** 从控件读回一个阶段的配置 */
function readStage(el, stage, current) {
    const get = (name) => el.querySelector(`#aw-${stage}-${name}`);
    const next = { ...current };

    next.slotName = (get('slot')?.value ?? '').trim();
    next.apiUrl = (get('apiurl')?.value ?? '').trim();
    next.apiKey = (get('apikey')?.value ?? '').trim();
    next.proxyPreset = get('proxy')?.value ?? '';
    next.model = (get('model')?.value ?? '').trim();
    next.temperature = parseFloat(get('temp')?.value) || current.temperature;
    next.maxTokens = parseInt(get('maxtokens')?.value, 10) || current.maxTokens;
    next.useStream = !!get('stream')?.checked;

    try {
        const raw = get('bodyfields')?.value ?? '{}';
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        next.bodyFields = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        next.bodyFieldsRaw = raw;
    } catch {
        // JSON 写坏了就保留原来那份，别把用户刚写的内容丢掉。
        // 但把原文留着 —— 诊断要靠它区分「没填」和「填了但解析失败」。
        next.bodyFieldsRaw = get('bodyfields')?.value ?? '';
        log(`${STAGE_LABELS[stage]} 的附加请求体不是合法 JSON，本次未采纳`);
    }

    return next;
}

/**
 * 面板里当前两个阶段的配置（由 renderStageCards 维护）。
 *
 * 诊断按钮要靠它拿到「用户现在配的这套」，而不是 settings 里那份可能还没保存的。
 */
let currentStageState = null;

/** 渲染两个阶段的配置控件并绑定事件 */
function renderStageCards(el, settings) {
    const state = { critic: { ...settings.critic }, final: { ...settings.final } };
    // 给诊断按钮用：它要读「面板里现在这套配置」，而这里就是唯一的真相源
    currentStageState = state;
    const proxyNames = getProxyNames();

    if (proxyNames.length === 0) {
        console.warn('[AgentWriter] 代理预设列表为空 —— 要么没装酒馆助手，要么酒馆里还没建代理预设');
    }

    for (const stage of ['critic', 'final']) {
        const holder = el.querySelector(`#aw-fields-${stage}`);
        if (!holder) continue;
        holder.innerHTML = stageFieldsHTML(stage, settings, proxyNames);

        // 控件变化 ⇒ 收集并保存
        const collect = () => {
            state[stage] = readStage(el, stage, state[stage]);
            mountOptions.onStageChange?.(stage, state[stage]);
        };
        holder.addEventListener('input', collect);
        holder.addEventListener('change', collect);
    }

    return state;
}

/**
 * 取酒馆代理预设名列表（来自酒馆助手）。
 * 拿不到不算致命 —— 下拉框会只剩「用当前连接」一项，
 * 用户仍可手填槽位名走当前连接。
 */
function getProxyNames() {
    try {
        const names = globalThis.TavernHelper?.getProxyPresetNames?.();
        return Array.isArray(names) ? names.filter((n) => n && n !== 'None') : [];
    } catch (e) {
        console.warn('[AgentWriter] 读取代理预设列表失败', e);
        return [];
    }
}

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

/**
 * 面板自己的一份版本号，只给自检显示用。
 * 真正的版本源是 index.js 的 VERSION —— 这里刻意不去 import 它，
 * 否则会形成 index → panel → index 的循环依赖。
 * check-version.mjs 会核对两者一致。
 */
export const VERSION = '0.8.19';

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
// 输出区
// ---------------------------------------------------------------------------

const OUTPUT_IDS = {
    draft: { text: 'aw-draft', stats: 'aw-draft-stats' },
    critic: { text: 'aw-report', stats: 'aw-report-stats', reasoning: 'aw-critic-reasoning', reasoningStats: 'aw-critic-reasoning-stats' },
    final: { text: 'aw-final', stats: 'aw-final-stats', reasoning: 'aw-final-reasoning', reasoningStats: 'aw-final-reasoning-stats' },
};

/**
 * 写入输出区。流式过程中会被高频调用，所以只碰必要节点。
 * @param {'draft'|'critic'|'final'} stage
 */
export function writeOutput(stage, text, reasoning) {
    const ids = OUTPUT_IDS[stage];
    if (!ids) return;

    const textEl = document.getElementById(ids.text);
    if (textEl) textEl.value = text ?? '';
    const statsEl = document.getElementById(ids.stats);
    if (statsEl) statsEl.textContent = text ? `${text.length} 字` : '';

    if (ids.reasoning) {
        const rEl = document.getElementById(ids.reasoning);
        if (rEl) rEl.value = reasoning ?? '';
        const rStats = document.getElementById(ids.reasoningStats);
        if (rStats) rStats.textContent = reasoning ? `${reasoning.length} 字` : '(无)';
    }
}

export function clearOutputs() {
    for (const stage of Object.keys(OUTPUT_IDS)) writeOutput(stage, '', '');
}

/** 运行按钮的忙碌态 */
export function setRunning(busy, label) {
    const run = document.getElementById('aw-run');
    const stop = document.getElementById('aw-stop');
    if (run) {
        run.disabled = !!busy;
        run.textContent = busy ? (label ?? '⏳ 运行中…') : '▶ 用最后一条 AI 回复作草稿';
    }
    if (stop) stop.disabled = !busy;
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
    mountOptions.onTabChange?.(tab);
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

    el.querySelector('#aw-run')?.addEventListener('click', () => {
        mountOptions.onRun?.();
    });
    el.querySelector('#aw-stop')?.addEventListener('click', () => {
        mountOptions.onStop?.();
    });

    // 自检与连通性测试由 index.js 注入，避免 panel 依赖 diagnostics
    el.querySelector('#aw-diag-run')?.addEventListener('click', () => {
        window.awDiagnose?.();
    });
    el.querySelector('#aw-diag-probe')?.addEventListener('click', () => {
        window.awProbe?.();
    });
    el.querySelector('#aw-diag-secret')?.addEventListener('click', () => {
        window.awProbeSecret?.();
    });
    /**
     * 点诊断按钮时现读面板里的两个阶段。
     *
     * 为什么不直接用 currentStageState：它靠 input/change 事件更新，
     * 而那假设「事件一定触发过」。实测踩到过 —— 用户明明填了附加参数，
     * 诊断里却显示 {}（空）。现从 DOM 读就没有这个假设，
     * 代价只是多解析几次 JSON。
     */
    const readStagesNow = () => {
        const base = { critic: {}, final: {} };
        return {
            critic: readStage(el, 'critic', currentStageState?.critic ?? base.critic),
            final: readStage(el, 'final', currentStageState?.final ?? base.final),
        };
    };

    el.querySelector('#aw-diag-channel')?.addEventListener('click', () => {
        // 用面板里 ② 的实际值（含流式开关）—— 这个诊断要验的就是「扩展配的那套」
        const stage = readStagesNow().critic;
        window.awProbeChannel?.(
            stage.apiUrl,
            stage.apiKey,
            stage.model,
            stage.useStream !== false,
        );
    });
    el.querySelector('#aw-diag-requests')?.addEventListener('click', () => {
        window.awLastRequests?.();
    });
    el.querySelector('#aw-diag-plan')?.addEventListener('click', () => {
        // 不发请求，只把扩展实际会构造的 custom_api 打出来
        window.awChannelPlan?.(readStagesNow());
    });
    el.querySelector('#aw-diag-exact')?.addEventListener('click', () => {
        // 用面板里真实的 temperature / max_tokens / 附加字段复现 ② 的请求 ——
        // 换渠道诊断用的是它自己编的参数，测不出「实跑才失败」这类问题。
        window.awProbeExact?.(readStagesNow());
    });
    el.querySelector('#aw-diag-via-th')?.addEventListener('click', () => {
        // 真正走 TavernHelper（和流水线同一个函数），并截获它发出的 generate_data。
        // 前面反复「诊断通、实跑不通」，就是因为诊断一直绕过 TavernHelper。
        window.awProbeViaTh?.(readStagesNow().critic);
    });
    el.querySelector('#aw-diag-snapshot')?.addEventListener('click', () => {
        // 拍设置快照 / 与上一次对比。
        // 用途：查「改某处设置会不会连带关掉正则」这类联动 —— 改前拍、改后拍。
        window.awSnapshot?.();
    });
    el.querySelector('#aw-diag-shape')?.addEventListener('click', () => {
        const model = el.querySelector('#aw-diag-model')?.value ?? '';
        window.awProbeShape?.(model);
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
 * @param {() => void} [options.onRun] 手动触发流水线
 * @param {() => void} [options.onStop]
 * @param {(stage: string, next: object) => void} [options.onStageChange]
 * @param {(tab: string) => void} [options.onTabChange]
 * @param {object} [options.settings] 当前设置（用来初始化控件）
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
    wired = true;
    if (options.settings) renderStageCards(el, options.settings);
    fillPromptEditors(el, options.settings);
    switchTab(options.settings?.ui?.tab ?? 'params');
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
    if (!ensurePanelReady()) {
        console.error('[AgentWriter] 面板挂载失败，无法显示');
        return;
    }
    applyLayout();
    panel.style.display = 'flex';
    mountOptions.onBeforeShow?.();
}

export function hidePanel() {
    if (panel) panel.style.display = 'none';
}

export function togglePanel() {
    // 关键：面板可能因为初始化时序问题还没挂上，这里就地补挂，避免"球能点但没反应"
    if (!ensurePanelReady()) return;
    if (panel.style.display === 'flex') hidePanel();
    else showPanel();
}

let wired = false;

/**
 * 确保面板已装配（事件已绑定）。
 *
 * 不能只依赖 mountPanel 被调用过：如果面板是通过别的路径出现在 DOM 里的，
 * 运行按钮的 handler 就永远不会接上，表现是「点了没反应」。
 * 所以每次显示前再确认一次。
 */
function ensurePanelReady() {
    if (!ensurePanelMounted()) return false;
    if (!wired) {
        try {
            bindEvents(panel);
            wired = true;
        } catch (e) {
            console.error('[AgentWriter] 补装配面板事件失败', e);
        }
    }
    return true;
}

/**
 * 用当前持久化配置刷新面板上的提示词。
 *
 * 面板里的提示词必须是配置里的那一份 —— 否则界面显示的和后台实际发送的会对不上，
 * 而且用户根本没法判断哪一份在生效。
 *
 * 正在编辑的框不覆盖：不打断输入。
 */
export function refreshPrompts(settings) {
    if (!panel || !settings) return;

    const critic = panel.querySelector('#aw-critic-prompt');
    if (critic && document.activeElement !== critic) {
        const next = settings.critic?.systemPrompt ?? '';
        if (critic.value !== next) critic.value = next;
    }

    const rewrite = panel.querySelector('#aw-rewrite-prompt');
    if (rewrite && document.activeElement !== rewrite) {
        const next = settings.final?.systemPrompt ?? '';
        if (rewrite.value !== next) rewrite.value = next;
    }
}

export function isPanelOpen() {
    return panel?.style.display === 'flex';
}

export function unmountPanel() {
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('orientationchange', onViewportChange);
    panel?.remove();
    panel = null;
    wired = false;
}

/**
 * 把提示词编辑器填上当前值。
 *
 * 之前这里只放了 placeholder，面板打开是空的 —— 看起来像"没有默认提示词"。
 */
function fillPromptEditors(el, settings) {
    if (!settings) return;

    const critic = el.querySelector('#aw-critic-prompt');
    if (critic) {
        critic.value = settings.critic?.systemPrompt ?? '';
        critic.addEventListener('input', () => {
            mountOptions.onPromptChange?.('critic', critic.value);
        });
    }

    const rewrite = el.querySelector('#aw-rewrite-prompt');
    if (rewrite) {
        rewrite.value = settings.final?.systemPrompt ?? '';
        rewrite.addEventListener('input', () => {
            mountOptions.onPromptChange?.('final', rewrite.value);
        });
    }

    const restore = el.querySelector('#aw-prompt-restore');
    if (restore) {
        restore.addEventListener('click', () => {
            mountOptions.onPromptRestore?.();
        });
    }
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
                <b>② 校验 / ③ 改写</b> 用下面各自选的连接配置，在后台跑，不往聊天记录里写东西。
            </div>

            <div class="aw-card" id="aw-stage-card-critic">
                <div class="aw-card-title">② 校验</div>
                <p class="aw-hint">只找逻辑问题，输出结构化清单 —— <b>这一阶段要开思考</b>。开思考时正文会变啰嗦，所以别指望它写稿；它的产出只是给 ③ 的修改意见。</p>
                <div id="aw-fields-critic"></div>
            </div>

            <div class="aw-card" id="aw-stage-card-final">
                <div class="aw-card-title">③ 改写</div>
                <p class="aw-hint">按清单改稿，保住原稿文风 —— <b>这一阶段要关思考</b>。开思考会让它一边写一边盘算剧情，正文反而不能用。</p>
                <div id="aw-fields-final"></div>
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
                    <button id="aw-diag-secret" class="aw-btn">密钥来源对照</button>
                    <button id="aw-diag-copy" class="aw-btn">复制结果</button>
                    <button id="aw-diag-requests" class="aw-btn">查看实际请求体</button>
                    <button id="aw-diag-channel" class="aw-btn">换渠道诊断</button>
                    <button id="aw-diag-plan" class="aw-btn">看扩展实际发什么</button>
                    <button id="aw-diag-exact" class="aw-btn">用真实参数复现 ②</button>
                    <button id="aw-diag-via-th" class="aw-btn">走酒馆助手跑一次（最接近实跑）</button>
                    <button id="aw-diag-snapshot" class="aw-btn">拍设置快照 / 对比</button>
                </div>
                <label class="aw-field">
                    <span>请求体形状对照 —— 可填一个你确认能用的模型名（留空则用配置里的）</span>
                    <input type="text" id="aw-diag-model" placeholder="例如 cline-pass/deepseek-v4.1-flash">
                </label>
                <div class="aw-row">
                    <button id="aw-diag-shape" class="aw-btn">开始形状对照</button>
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
            <div class="aw-row">
                <button id="aw-prompt-restore" class="aw-btn">↺ 恢复默认提示词</button>
            </div>
            <div class="aw-card">
                <div class="aw-card-title">校验提示词</div>
                <p class="aw-hint">输出格式要求由扩展在发送时自动追加，这里只写你希望的检查重点。</p>
                <textarea id="aw-critic-prompt" rows="14"></textarea>
            </div>
            <div class="aw-card">
                <div class="aw-card-title">改写提示词</div>
                <textarea id="aw-rewrite-prompt" rows="14"></textarea>
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
        <button id="aw-run" class="aw-btn aw-btn-primary aw-grow"
                title="用最后一条 AI 回复作为草稿，跑 ② 校验 与 ③ 改写">▶ 用最后一条 AI 回复作草稿</button>
        <button id="aw-stop" class="aw-btn aw-btn-danger" disabled>⏹ 停止</button>
    </div>
</div>
`;
