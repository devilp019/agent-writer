/**
 * Agent Writer - 面板
 *
 * 复用原脚本的悬浮面板形态（平板/手机上一根手指就能开），不走酒馆的扩展设置抽屉。
 * 位置按设备存 localStorage，resize / 转屏后重新夹取。
 */

const PANEL_ID = 'aw-panel';
const POS_KEY = 'aw_panel_pos_v1';
const MARGIN = 12;

let panel = null;
let logLines = [];
let mountOptions = {};

/**
 * 面板被重建的次数。
 *
 * > 1 说明有东西在反复重建它 —— 重建会清空所有输出框，
 * 用户报告的「框闪一下就不见了」很可能就是这个。诊断里会显示它。
 */
let mountCount = 0;

/** 给诊断用：面板被重建过几次 */
export function getMountCount() {
    return mountCount;
}

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
            <span>附加请求体字段（必须写能解析的 JSON）</span>
            <textarea id="${id('bodyfields')}" rows="4">${esc(bodyFieldsText(s))}</textarea>
            <em class="aw-tip">思考开关写这里。<br>DeepSeek 官方：关 <code>{"thinking":{"type":"disabled"}}</code>，开 <code>{"thinking":{"type":"enabled"}}</code>。<br><b>Cline 关不掉</b> —— <code>thinking</code> 和 <code>reasoning_effort</code> 都被它静默忽略。<br><b>必须写能解析的 JSON</b>，写坏了字段会一个都加不上。</em>
            <em class="aw-tip">指向 Cline 时<b>「流式」必须打开</b>：它的非流式响应多包一层 <code>data</code>，酒馆解析不到正文，会得到「成功但返回为空」。</em>
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
export function renderStageCards(el, settings) {
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
export const VERSION = '0.9.1';

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
/**
 * 最近一次写入的内容。
 *
 * 为什么要有它：面板可能被**重建**（重建会清空所有输出框），而重建的时机
 * 不受扩展控制 —— 实测用户遇到「框闪一下就不见了」。
 * 把内容留一份，重建后立刻恢复，输出就不会凭空消失。
 */
const lastOutputs = {
    draft: { text: '', reasoning: '' },
    critic: { text: '', reasoning: '' },
    final: { text: '', reasoning: '' },
};

export function writeOutput(stage, text, reasoning) {
    const ids = OUTPUT_IDS[stage];
    if (!ids) return;

    // 先留档，再写 DOM —— 中间任何异常都不至于两边都不对
    if (text !== undefined) lastOutputs[stage].text = text ?? '';
    if (reasoning !== undefined) lastOutputs[stage].reasoning = reasoning ?? '';

    const textEl = document.getElementById(ids.text);
    if (textEl) textEl.value = lastOutputs[stage].text;
    const statsEl = document.getElementById(ids.stats);
    if (statsEl) statsEl.textContent = lastOutputs[stage].text ? `${lastOutputs[stage].text.length} 字` : '';

    if (ids.reasoning) {
        const rEl = document.getElementById(ids.reasoning);
        if (rEl) rEl.value = lastOutputs[stage].reasoning;
        const rStats = document.getElementById(ids.reasoningStats);
        if (rStats) rStats.textContent = lastOutputs[stage].reasoning ? `${lastOutputs[stage].reasoning.length} 字` : '(无)';
    }
}

/** 面板重建后把留档的输出写回去 */
function restoreOutputs() {
    for (const stage of Object.keys(OUTPUT_IDS)) {
        const o = lastOutputs[stage];
        if (!o) continue;
        if (o.text || o.reasoning) writeOutput(stage, o.text, o.reasoning);
    }
}

export function clearOutputs() {
    for (const stage of Object.keys(OUTPUT_IDS)) writeOutput(stage, '', '');
}

/** 运行按钮的忙碌态 */
/**
 * 忙碌时的秒表。
 *
 * 为什么需要它：② 是开着思考跑的，思考期间上游只回思维链分片、正文一个字都没有。
 * 于是进度框必然长时间空着 —— 没有秒表的话，面板看上去就跟卡死了一样，
 * 而用户根本分不清「在思考」和「挂了」。（思维链本身取不到：
 * 酒馆助手把 state.reasoning 收下后就没往外给过，STREAM_REASONING_DONE
 * 只由 reasoning.js 里的 ReasoningHandler 发，而没有任何地方用它。）
 */
let busyStartedAt = 0;
let busyLabel = '';
let busyTimer = null;

function stopBusyTimer() {
    if (busyTimer) {
        clearInterval(busyTimer);
        busyTimer = null;
    }
    busyStartedAt = 0;
    busyLabel = '';
}

function paintBusyLabel() {
    const run = document.getElementById('aw-run');
    if (!run || !busyStartedAt) return;
    const secs = Math.floor((Date.now() - busyStartedAt) / 1000);
    run.textContent = `${busyLabel} ${secs}s`;
}

export function setRunning(busy, label) {
    const run = document.getElementById('aw-run');
    const stop = document.getElementById('aw-stop');
    if (run) {
        run.disabled = !!busy;
        if (busy) {
            const text = label ?? '⏳ 运行中…';
            // 只有标签真的换了或者刚开跑，才重置秒表 ——
            // ②③ 交接时不应该把已经跑掉的时间抹掉。
            if (text !== busyLabel || !busyStartedAt) {
                busyLabel = text;
                if (!busyStartedAt) busyStartedAt = Date.now();
            }
            paintBusyLabel();
            if (!busyTimer) {
                busyTimer = setInterval(paintBusyLabel, 1000);
            }
        } else {
            stopBusyTimer();
            run.textContent = '▶ 用最后一条 AI 回复作草稿';
        }
    }
    if (stop) stop.disabled = !busy;
}

// ---------------------------------------------------------------------------
// 存档（参数 / 提示词分开存）
// ---------------------------------------------------------------------------

/**
 * 画一边的存档列表。
 *
 * 每条要回答的问题：**「这份和现在差在哪」** —— 那才是决定要不要应用它的
 * 依据。差异由 mountOptions.archiveDiff 提供（它同时知道存档和当前设置）。
 *
 * @param {'params'|'prompts'} kind
 */
export function renderArchiveList(kind) {
    const box = document.getElementById(`aw-arch-${kind}-list`);
    const appliedEl = document.getElementById(`aw-arch-${kind}-applied`);
    if (!box) return;

    const items = mountOptions.listArchives?.(kind) ?? [];
    const applied = mountOptions.appliedArchive?.(kind) ?? null;

    if (appliedEl) {
        // 光说「应用了哪个」不够 —— 还得说「你有没有在它基础上又改过」
        if (!applied?.name) {
            appliedEl.textContent = '';
        } else if (applied.differs) {
            appliedEl.textContent = `当前基于「${applied.name}」，但已经被改过了`;
        } else {
            appliedEl.textContent = `当前正是「${applied.name}」`;
        }
    }

    if (items.length === 0) {
        box.innerHTML = '<p class="aw-hint">还没有存档。调好之后在上面起个名字，点「存为新版本」。</p>';
        return;
    }

    box.innerHTML = items.map((item) => {
        const diff = mountOptions.archiveDiff?.(kind, item.id) ?? [];
        const same = diff.length === 0;
        const diffHtml = same
            ? '<em class="aw-snap-same">和当前完全一致</em>'
            : `<ul class="aw-snap-diff">${diff.slice(0, 8).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`;
        const more = diff.length > 8 ? `<em class="aw-snap-same">…还有 ${diff.length - 8} 处</em>` : '';

        return `<div class="aw-snap" data-id="${esc(item.id)}">
            <div class="aw-snap-head">
                <span class="aw-snap-when">${esc(item.name)}<span class="aw-snap-at">${esc(item.when)}</span></span>
                <span class="aw-snap-actions">
                    <button class="aw-btn aw-btn-primary aw-arch-apply" data-id="${esc(item.id)}">${same ? '应用' : '应用…'}</button>
                    <button class="aw-btn aw-arch-overwrite" data-id="${esc(item.id)}" title="用当前的内容覆盖这一份">用当前覆盖</button>
                    <button class="aw-btn aw-arch-rename" data-id="${esc(item.id)}">改名</button>
                    <button class="aw-btn aw-btn-danger aw-arch-del" data-id="${esc(item.id)}">删</button>
                </span>
            </div>
            ${diffHtml}${more}
            <details class="aw-details">
                <summary>这份里存了什么</summary>
                <textarea rows="8" readonly class="aw-snap-body">${esc(item.summary)}</textarea>
            </details>
        </div>`;
    }).join('');
}

/** 两边一起重画 */
export function renderAllArchives() {
    renderArchiveList('params');
    renderArchiveList('prompts');
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

    el.querySelector('#aw-auto')?.addEventListener('change', (event) => {
        // ⚠️ 必须走 mountOptions。这里曾经调的是一个裸的模块级变量
        // `onAutoChange`（L16 声明为 null 之后**再也没有被赋过值**），
        // 所以 `onAutoChange?.(...)` 一直是空操作 ——
        // 勾选框在界面上会动，但 settings.auto 永远停在默认的 false。
        // 症状：日志里不管勾上还是取消都是「自动模式未开启」。
        mountOptions.onAutoChange?.(event.target.checked);
    });

    el.querySelector('#aw-run')?.addEventListener('click', () => {
        mountOptions.onRun?.();
    });

    el.querySelector('#aw-stop')?.addEventListener('click', () => {
        mountOptions.onStop?.();
    });

    // 存档。列表是动态画的，所以应用/覆盖/改名/删都走事件委托 ——
    // 每次重画之后不需要重新挂监听。
    for (const kind of ['params', 'prompts']) {
        el.querySelector(`#aw-arch-${kind}-save`)?.addEventListener('click', () => {
            const nameBox = el.querySelector(`#aw-arch-${kind}-name`);
            const name = String(nameBox?.value ?? '').trim();
            const result = mountOptions.saveArchive?.(kind, name) ?? {};

            // 重名：问一句要不要覆盖，而不是偷偷覆盖或者直接失败
            if (result.needsOverwrite) {
                const yes = globalThis.confirm?.(`已经有一个叫「${name}」的存档了，用当前内容覆盖它吗？`);
                if (yes) {
                    mountOptions.saveArchive?.(kind, name, { overwrite: true });
                    if (nameBox) nameBox.value = '';
                }
            } else if (result.ok && nameBox) {
                nameBox.value = '';
            }
            renderArchiveList(kind);
        });

        el.querySelector(`#aw-arch-${kind}-list`)?.addEventListener('click', (event) => {
            const pick = (cls) => event.target.closest?.(cls)?.dataset?.id ?? null;

            const applyId = pick('.aw-arch-apply');
            if (applyId) {
                // 确认放在这里而不是 index.js：面板本来就已经算出了差异
                // （列表上就显示着），再让下面重算一遍容易两边说法不一致。
                // 覆盖 / 改名 / 删也都在这一层确认，保持一致。
                const diff = mountOptions.archiveDiff?.(kind, applyId) ?? [];
                const name = event.target.closest('.aw-snap')
                    ?.querySelector('.aw-snap-when')?.textContent ?? '这一份';

                if (diff.length === 0) {
                    // 已经就是这个，不用打扰
                    mountOptions.applyArchive?.(kind, applyId);
                    renderArchiveList(kind);
                    return;
                }

                const label = kind === 'prompts' ? '提示词' : '参数';
                const yes = globalThis.confirm?.(
                    `应用${label}版本「${name}」？\n\n`
                    + `当前和它有 ${diff.length} 处不同，会被覆盖：\n\n`
                    + diff.slice(0, 10).map((d) => `· ${d}`).join('\n')
                    + (diff.length > 10 ? `\n…还有 ${diff.length - 10} 处` : ''),
                );
                if (yes) mountOptions.applyArchive?.(kind, applyId);
                renderArchiveList(kind);
                return;
            }

            const overId = pick('.aw-arch-overwrite');
            if (overId) {
                const name = event.target.closest('.aw-snap')?.querySelector('.aw-snap-when')?.textContent ?? '这一份';
                if (globalThis.confirm?.(`用当前的${kind === 'prompts' ? '提示词' : '参数'}覆盖「${name}」？覆盖后没法还原。`)) {
                    mountOptions.overwriteArchive?.(kind, overId);
                }
                renderArchiveList(kind);
                return;
            }

            const renameId = pick('.aw-arch-rename');
            if (renameId) {
                const item = (mountOptions.listArchives?.(kind) ?? []).find((x) => x.id === renameId);
                const next = globalThis.prompt?.('改成什么名字？', item?.name ?? '');
                if (next !== null && next !== undefined) {
                    mountOptions.renameArchive?.(kind, renameId, next);
                }
                renderArchiveList(kind);
                return;
            }

            const delId = pick('.aw-arch-del');
            if (delId) {
                const item = (mountOptions.listArchives?.(kind) ?? []).find((x) => x.id === delId);
                if (globalThis.confirm?.(`删掉存档「${item?.name ?? ''}」？删了就没了。`)) {
                    mountOptions.deleteArchive?.(kind, delId);
                }
                renderArchiveList(kind);
            }
        });
    }

    // 面板上不再摆诊断按钮了 —— 那排按钮是开发期用的，日常看着碍事。
    // 诊断能力本身**没有删**：diagnostics.js 里那些函数照旧通过
    // window.awXxx 暴露着（见 diagnostics.exposeGlobals），结果写进「日志」页。
    // 用法见 README 的「出问题时」。
    const readStagesNow = () => {
        const base = { critic: {}, final: {} };
        return {
            critic: readStage(el, 'critic', currentStageState?.critic ?? base.critic),
            final: readStage(el, 'final', currentStageState?.final ?? base.final),
        };
    };
    // 给控制台用：awStages() 拿到面板里当前填的两阶段（含附加字段的解析结果）
    window.awStages = readStagesNow;
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
 * @param {() => void} [options.onRun] 手动触发流水线
 * @param {() => void} [options.onStop]
 * @param {(stage: string, next: object) => void} [options.onStageChange]
 * @param {(tab: string) => void} [options.onTabChange]
 * @param {object} [options.settings] 当前设置（用来初始化控件）
 * @returns {HTMLElement|null}
 */
export function mountPanel(options = {}) {
    mountOptions = options;

    // 记下重建次数 —— 输出框「闪一下就不见了」多半就是重建导致的。
    // 有了这个计数，日志里能直接看出到底重建过几次。
    mountCount++;
    if (mountCount > 1) {
        console.warn(`[AgentWriter] 面板被重建（第 ${mountCount} 次）`);
    }

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

    // 面板可能是被重建的（那会清空所有输出框）。把留档写回去，
    // 免得用户看到「框里明明有过内容、闪一下就没了」。
    try {
        restoreOutputs();
    } catch (e) {
        console.warn('[AgentWriter] 恢复输出内容失败', e);
    }

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
export function fillPromptEditors(el, settings) {
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

/**
 * 诊断结果往哪儿写。
 *
 * 面板上原来有个专门的自检输出框，但那整张自检卡片已经撤掉了
 * （开发期用的按钮，日常碍事）。所以现在写进「日志」页 ——
 * 诊断能力一点没少，只是不再占着「参数」页。
 */
export function setDiagOutput(text) {
    const body = String(text ?? '');
    if (!body.trim()) return;

    for (const line of body.split('\n')) {
        log(line);
    }
    // 控制台也留一份，方便直接复制
    console.log('[AgentWriter] ==== 诊断结果开始 ====\n' + body + '\n[AgentWriter] ==== 诊断结果结束 ====');
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
        <button class="aw-tab" data-tab="history">版本</button>
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

        <section class="aw-tab-panel" data-panel="history" hidden>
            <div class="aw-note">
                当前这一份设置<b>改一下就自动保存</b>，不用管。<br>
                想留住某一份，把它存成<b>有名字的存档</b> —— 存下来之后当前怎么改都不会动到它。<br>
                <b>参数和提示词分开存</b>，可以几套参数配几套提示词混着用。
            </div>

            <div class="aw-card">
                <div class="aw-card-title">参数存档</div>
                <p class="aw-hint">槽位名、渠道、密钥、模型、温度、附加请求体、流式开关。</p>
                <div class="aw-row">
                    <input type="text" id="aw-arch-params-name" placeholder="给这套参数起个名字，例如：② Cline 开思考" style="flex:1;min-width:120px;">
                    <button id="aw-arch-params-save" class="aw-btn aw-btn-primary">存为新版本</button>
                </div>
                <div class="aw-row"><span class="aw-stat" id="aw-arch-params-applied"></span></div>
                <div id="aw-arch-params-list" class="aw-snap-list"></div>
            </div>

            <div class="aw-card">
                <div class="aw-card-title">提示词存档</div>
                <p class="aw-hint">② 校验提示词 + ③ 改写提示词，两份一起存。</p>
                <div class="aw-row">
                    <input type="text" id="aw-arch-prompts-name" placeholder="给这套提示词起个名字，例如：严格版" style="flex:1;min-width:120px;">
                    <button id="aw-arch-prompts-save" class="aw-btn aw-btn-primary">存为新版本</button>
                </div>
                <div class="aw-row"><span class="aw-stat" id="aw-arch-prompts-applied"></span></div>
                <div id="aw-arch-prompts-list" class="aw-snap-list"></div>
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
                    <em class="aw-tip">思维链从上游流式响应里直接读，和正文一样是实时的。一直是空的话，多半是该渠道没回 <code>reasoning_content</code> 字段（比如思考是关的）。</em>
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
