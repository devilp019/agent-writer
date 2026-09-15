/**
 * Agent Writer - 入口
 *
 * 装配：悬浮球（状态灯）+ 扩展菜单项 + 面板，
 * 并把酒馆的原生生成事件接到 ②③ 流水线上。
 *
 * ① 草稿 = 酒馆原生生成；② 校验 / ③ 改写 = 后台 HTTP 请求，
 * 不往 chat 里写任何东西，所以不需要把草稿摘出去再放回来。
 */

// 部署版本号。所有相对 import 都带上 ?v=<VERSION>：
// 换版本时浏览器会当作新 URL 重新拉取，避免旧模块缓存和新代码混在一起。
const VERSION = '0.8.26';

import { setState, setDemoHandler, idleState } from './state.js?v=0.8.26';
import { mountFab, unmountFab, resetFabPosition } from './ui/fab.js?v=0.8.26';
import { mountMenuItem, unmountMenuItem } from './ui/menu.js?v=0.8.26';
import {
    mountPanel,
    unmountPanel,
    togglePanel,
    isPanelOpen,
    log,
    setDiagOutput,
    getAutoCheckbox,
    writeOutput,
    clearOutputs,
    setRunning as setPanelRunning,
    refreshPrompts,
} from './ui/panel.js?v=0.8.26';
import { diagnose, probe, exposeGlobals } from './diagnostics.js?v=0.8.26';
import { getSettings, saveSettings, DEFAULT_CRITIC_PROMPT, DEFAULT_REWRITE_PROMPT } from './config.js?v=0.8.26';
import { runPipeline, findLastAssistantIndex, extractReasoning, recoverSlots } from './pipeline.js?v=0.8.26';
import { probeTavernHelper, getProxyPresets } from './tavern.js?v=0.8.26';
import { patchFetch } from './stream-hook.js?v=0.8.26';
import * as notice from './notice.js?v=0.8.26';

const MODULE_NAME = 'agent_writer';

// ---------------------------------------------------------------------------
// 加载即崩溃的兜底报告
//
// 如果模块加载阶段就出错（最典型：浏览器缓存了旧版模块，
// 新版 index.js 去 import 一个不存在的导出），onActivate 根本不会被调用，
// startUI() 也不会执行 —— 表现就是「什么都没有」，而且毫无线索。
// 所以这里放一个零依赖的报错出口，不 import 任何东西。
// ---------------------------------------------------------------------------

function drawFatal(message) {
    try {
        let box = document.getElementById('aw-fatal');
        if (!box) {
            box = document.createElement('div');
            box.id = 'aw-fatal';
            box.style.cssText = [
                'position:fixed', 'z-index:2147483647', 'left:50%', 'transform:translateX(-50%)',
                'top:calc(12px + env(safe-area-inset-top, 0px))', 'max-width:min(92vw, 520px)',
                'padding:12px 16px', 'border-radius:12px',
                'background:rgba(28,16,18,0.97)', 'border:1px solid #e05565',
                'box-shadow:0 16px 40px rgba(0,0,0,0.6)', 'color:#f0d8dc',
                'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif',
                'font-size:13px', 'line-height:1.6', 'white-space:pre-wrap', 'word-break:break-word',
                'pointer-events:auto',
            ].join(';');
            box.addEventListener('click', () => box.remove());
            document.body?.appendChild(box);
        }
        box.textContent = `Agent Writer 启动失败\n${message}\n\n（点一下关掉；完整信息在控制台）`;
    } catch {
        // 连这个都失败就只剩控制台了
    }
}

function reportFatal(where, err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[AgentWriter] ${where}失败`, err);
    drawFatal(`${where}失败\n${message}`);
}

export { drawFatal };

const DEFAULT_SETTINGS = Object.freeze({
    version: 1,
    auto: false,
    logLines: true,
});

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

// getSettings / saveSettings 来自 config.js（那里处理默认值合并与防抖保存）

// ---------------------------------------------------------------------------
// 触发：酒馆原生生成 → ②③
// ---------------------------------------------------------------------------

let pendingRewrite = false;
let preGenSnapshot = null;
let lastGenerationType = null;
let runner = null;
let hooksBound = false;

function describeChat() {
    const context = getContext();
    const chat = context?.chat ?? [];
    const last = findLastAssistantIndex(chat);
    return {
        chat,
        index: last,
        draft: last >= 0 ? String(chat[last]?.mes ?? '') : '',
    };
}

/** 酒馆生成了新内容才值得跑流水线；纯属重绘就跳过 */
function hasNewContent() {
    const { chat, draft } = describeChat();
    const before = preGenSnapshot;
    preGenSnapshot = null;
    if (!before) return true;
    if (chat.length > before.chatLen) return true;
    return before.lastAssistantMes !== null && before.lastAssistantMes !== draft;
}

async function runPipelineNow(source) {
    if (runner) {
        log('流水线已在运行，忽略本次触发');
        return;
    }

    const settings = getSettings();
    const { chat, index, draft } = describeChat();

    if (index < 0) {
        log('没有找到 AI 回复，跳过');
        return;
    }
    if (!draft.trim()) {
        log('最后一条 AI 回复是空的，跳过');
        return;
    }

    // 已经处理过的楼层不再处理 —— 否则自动模式下写回的正文会被当成本轮草稿，
    // 于是「跑完一遍又自动开始下一遍」，无限循环。
    const already = chat[index]?.extra?.agent_writer?.draft;
    if (already !== undefined && already === draft) {
        log('这一层已经处理过且内容未变，跳过（避免自动模式循环）');
        return;
    }

    const draftReasoning = extractReasoning(chat[index]);

    const controller = new AbortController();
    runner = { controller, source };
    setPanelRunning(true, '⏳ 校验中…');
    log(`=== 开始流水线（${source}）草稿 ${draft.length} 字 ===`);

    try {
        const result = await runPipeline({
            settings,
            messageIndex: index,
            draft,
            draftReasoning,
            signal: controller.signal,
            onStage: (stage, info) => {
                const isCritic = stage === 'critic';

                if (info.phase === 'start') {
                    setState(isCritic ? 'checking' : 'rewriting');
                    setPanelRunning(true, isCritic ? '⏳ 校验中…' : '⏳ 改写中…');
                    return;
                }

                if (info.phase === 'progress') {
                    // 徽标显示已收字数，不点开面板也能看到它在动
                    setState(isCritic ? 'checking' : 'rewriting', {
                        badge: info.text ? String(info.text.length) : null,
                    });
                    writeOutput(stage, info.text, info.reasoning);
                    return;
                }

                if (info.phase === 'done') {
                    writeOutput(stage, info.text, info.reasoning);
                    if (info.retried) {
                        log(`${isCritic ? '②' : '③'} 换了一种模式重试后成功（${info.mode}）`);
                    }
                    if (isCritic && info.parsed) {
                        log(`② 校出 ${info.parsed.issues?.length ?? 0} 条问题`);
                    }
                    return;
                }

                if (info.phase === 'skipped') {
                    log(`③ 跳过：${info.reason}`);
                    return;
                }

                if (info.phase === 'error') {
                    log(`${isCritic ? '②' : '③'} 出错：${info.message}`);
                    notice.error(`${isCritic ? '② 校验' : '③ 改写'}出错：${info.message}`);
                }
            },
        });

        if (!result.ok) {
            setState('error', { badge: '!' });
            log(`流水线中断于 ${result.stage}：${result.reason}`);
            // 光写日志没用 —— 悬浮球上只有一个「!」，不点开面板看不见原因
            notice.error(
                `流水线中断（${result.stage === 'critic' ? '② 校验' : '③ 改写'}）\n${result.reason}`,
                'Agent Writer 已中止',
            );
            return;
        }

        if (!result.replaced) {
            setState('done');
            log('校验判定无需修改，保留原草稿');
            return;
        }

        setState('done');
        log(`=== 完成：草稿 ${draft.length} 字 → 正文 ${result.finalText.length} 字 ===`);
    } catch (error) {
        if (controller.signal.aborted) {
            setState('idle');
            log('流水线已停止');
            return;
        }
        setState('error', { badge: '!' });
        log(`流水线出错：${error?.message ?? error}`);
        console.error('[AgentWriter] 流水线出错', error);
        notice.fail('流水线', error);
    } finally {
        runner = null;
        setPanelRunning(false);
        const settings2 = getSettings();
        setTimeout(() => {
            // done / error 态会自己回落，这里只在空闲时校准一下
            if (!runner) setState(idleState(settings2));
        }, 4200);
    }
}

function stopPipeline() {
    if (!runner) return;
    log('请求停止…');
    try {
        runner.controller.abort();
    } catch (e) {
        console.warn('[AgentWriter] 停止失败', e);
    }
}

function bindGenerationHooks() {
    if (hooksBound) return;
    const context = getContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (!eventSource?.on || !eventTypes) {
        console.warn('[AgentWriter] 拿不到酒馆事件，自动模式不可用');
        return;
    }
    hooksBound = true;

    eventSource.on(eventTypes.GENERATION_STARTED, (type, _option, dryRun) => {
        lastGenerationType = type;
        const settings = getSettings();

        // 每个可能导致跳过的情况都留下日志 —— 平板开不了控制台，
        // 「自动没用」这种问题只能靠日志区分是哪一环没满足条件。
        if (dryRun) { log(`[触发] 跳过：dryRun（type=${type}）`); return; }
        if (!settings.auto) { log(`[触发] 跳过：自动模式未开启（type=${type}）`); return; }
        if (type === 'continue') { log('[触发] 跳过：continue'); return; }
        if (type === 'quiet') { log('[触发] 跳过：quiet'); return; }
        if (runner) { log('[触发] 跳过：流水线正在运行'); return; }

        const { chat, draft } = describeChat();
        preGenSnapshot = { chatLen: chat.length, lastAssistantMes: findLastAssistantIndex(chat) >= 0 ? draft : null };
        pendingRewrite = true;
        setState('drafting');
        log(`① 酒馆原生生成中（type=${type}）`);
    });

    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        const settings = getSettings();
        log(`[触发] GENERATION_ENDED type=${lastGenerationType} 自动=${settings.auto} pending=${pendingRewrite} 运行中=${!!runner}`);

        if (!settings.auto) return;
        if (lastGenerationType === 'quiet') return;
        if (!pendingRewrite) return;
        pendingRewrite = false;
        if (runner) return;

        // 等酒馆把楼层渲染完再动它
        setTimeout(() => {
            if (!hasNewContent()) {
                log('[触发] 本次生成没有产生新内容，跳过');
                setState(idleState(getSettings()));
                return;
            }
            log('[触发] 条件满足，启动流水线');
            runPipelineNow('自动');
        }, 500);
    });

    log('✓ 已接上 GENERATION_STARTED / GENERATION_ENDED');
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

let uiStarted = false;
let panelMounted = false;

/**
 * 悬浮球和菜单项共用的开关动作。
 *
 * 这里包一层 try/catch 并对失败给出可见反馈 —— 你看到的"点击有反馈但没面板"，
 * 之前就是被静默吞掉的异常，界面上完全看不出来。
 */
function safeToggle() {
    try {
        if (!document.getElementById('aw-panel')) {
            const mounted = mountPanelOnce();
            if (!mounted) {
                reportFatal('打开面板', new Error('面板挂载失败（详细原因见控制台）'));
                return;
            }
            // 刚挂上就是关闭态，直接显示
            togglePanel();
            return;
        }
        togglePanel();
    } catch (err) {
        reportFatal('打开面板', err);
    }
}

/**
 * 挂载悬浮球和菜单项。这两件事在加载期就能做，不依赖 UI 就绪。
 *
 * 关键：分成三个独立 try，任何一环炸掉都不能连累其它两环。
 * 之前整块共用一个 try，结果球挂上了、后面的静默失败，表现就是"只有一个球"。
 */
function startUI() {
    const settings = getSettings();
    exposeGlobals();
    setDemoHandler((state, detail) => setState(state, detail));

    if (!uiStarted) {
        uiStarted = true;
        let fabOk = false;
        let menuOk = false;

        try {
            mountFab(safeToggle);
            fabOk = true;
        } catch (err) {
            reportFatal('挂载悬浮球', err);
        }

        try {
            mountMenuItem(safeToggle);
            menuOk = true;
        } catch (err) {
            reportFatal('挂载扩展菜单项', err);
        }

        setState(idleState(settings));
        log(`Agent Writer v${VERSION} 就绪（悬浮球 ${fabOk ? '✔' : '✘'} / 菜单项 ${menuOk ? '✔' : '✘'}）`);
        bindGenerationHooks();
        checkTavernHelper(settings);
        recoverSlotsOnBoot(settings);

        // 两个都没成，说明环境本身有问题，别让用户对着空白界面猜
        if (!fabOk && !menuOk) {
            reportFatal('挂载界面', new Error('悬浮球和菜单项都没能挂上，请把这条信息截图'));
        }
    }
    return settings;
}

/**
 * 检查酒馆助手是否可用。
 *
 * ②③ 走的是酒馆助手的 generate()，没它整个流水线都跑不了 ——
 * 所以启动时就要说清楚，而不是等用户点了运行才报错。
 *
 * ⚠️ 但**不能只查一次**。酒馆助手的 manifest 里 loading_order 也是 100，
 * 和本扩展同序号时加载顺序不确定。早先这里同步查一次、查不到就报「缺依赖」
 * 并且不再重试 —— 如果酒馆助手恰好后加载，就会误报，而且整个扩展都废掉。
 * 症状还很迷惑：时好时坏，取决于这次刷新谁先加载。
 *
 * 所以改成轮询等它出现（和面板挂载那套一样的思路）。
 */
const TH_WAIT_INTERVAL_MS = 500;
const TH_WAIT_MAX_MS = 20000;
let thWaitTimer = null;
let thReportedMissing = false;

function checkTavernHelper(settings) {
    if (thWaitTimer) return;

    const probe = probeTavernHelper();
    if (probe.ok) {
        thReportedMissing = false;
        reportTavernHelperReady(probe, settings);
        return;
    }

    // 还没出现 —— 等一等再查，别急着报错
    const startedAt = Date.now();
    log('等待酒馆助手（JS-Slash-Runner）加载…');

    thWaitTimer = setInterval(() => {
        const now = probeTavernHelper();
        if (now.ok) {
            clearInterval(thWaitTimer);
            thWaitTimer = null;
            thReportedMissing = false;
            log(`✓ 酒馆助手在 ${Math.round((Date.now() - startedAt) / 1000)} 秒后加载完成`);
            reportTavernHelperReady(now, getSettings());
            return;
        }
        if (Date.now() - startedAt >= TH_WAIT_MAX_MS) {
            clearInterval(thWaitTimer);
            thWaitTimer = null;
            if (thReportedMissing) return;
            thReportedMissing = true;
            log(`✘ ${now.missing.join('；')}`);
            console.warn('[AgentWriter] 等了 20 秒仍未见酒馆助手。请确认 JS-Slash-Runner 已安装并启用。');
            notice.error(
                `等了 20 秒仍没等到酒馆助手（JS-Slash-Runner），②③ 无法运行。\n`
                + `缺：${now.missing.join('；')}\n`
                + '请到「扩展管理」确认它已安装且处于启用状态，然后刷新页面。',
                'Agent Writer 缺依赖',
            );
        }
    }, TH_WAIT_INTERVAL_MS);
}

/** 酒馆助手可用之后的正常检查 */
function reportTavernHelperReady(probe, settings) {
    const presets = getProxyPresets();
    log(`✓ 酒馆助手可用${probe.version ? `（v${probe.version}）` : ''}；代理预设 ${presets.length} 个`);

    const missing = [];
    if (!settings.critic.slotName) missing.push('② 校验');
    if (!settings.final.slotName) missing.push('③ 改写');
    if (missing.length) {
        log(`⚠ ${missing.join(' / ')} 还没填注入槽位条目名，请到「参数」页设置`);
        notice.warn(
            `${missing.join(' / ')} 还没填注入槽位条目名，流水线会在启动时直接失败。\n请到面板「参数」页填写。`,
            'Agent Writer 配置不完整',
        );
    }
}

/**
 * 启动时恢复槽位。
 *
 * 槽位注入是改用户预设的操作。万一上次没还原成功（刷新、崩溃、断电），
 * 残留在槽位里的内容会被当成正常提示词发出去 —— 必须在启动时清掉。
 */
async function recoverSlotsOnBoot(settings) {
    try {
        const { recovered } = await recoverSlots([settings.critic.slotName, settings.final.slotName]);
        if (recovered.length) {
            log(`✓ 已还原上次未清理的槽位：${recovered.join('、')}`);
        }
    } catch (e) {
        console.warn('[AgentWriter] 槽位恢复失败', e);
    }
}

/**
 * 挂载面板。
 *
 * 这个函数必须和 startUI() 分开：之前它被塞在带 `started` 闸门的 boot() 里，
 * 而 onEnable 钩子会在加载期先跑一次，把闸门置位，导致随后 APP_READY 的回调
 * 直接 return —— 面板永远不会被创建。
 *
 * @returns {boolean} 是否已挂载
 */
function mountPanelOnce() {
    if (document.getElementById('aw-panel')) {
        panelMounted = true;
        return true;
    }

    let el = null;
    const settings = getSettings();
    try {
        el = mountPanel({
            settings,
            onAutoChange: (auto) => {
                const s = getSettings();
                s.auto = !!auto;
                saveSettings({ immediate: true });
                setState(idleState(s));
                log(`自动模式：${auto ? '开' : '关'}`);
            },
            onDemoState: (state, detail) => setState(state, detail),
            onRun: () => {
                runPipelineNow('手动');
            },
            onStop: () => stopPipeline(),
            onStageChange: (stage, next) => {
                const s = getSettings();
                s[stage] = { ...s[stage], ...next };
                saveSettings();
            },
            onPromptChange: (stage, text) => {
                const s = getSettings();
                if (s[stage]) s[stage].systemPrompt = text;
                saveSettings();
            },
            onPromptRestore: () => {
                const s = getSettings();
                s.critic.systemPrompt = DEFAULT_CRITIC_PROMPT;
                s.final.systemPrompt = DEFAULT_REWRITE_PROMPT;
                saveSettings({ immediate: true });
                const panel = document.getElementById('aw-panel');
                const critic = panel?.querySelector('#aw-critic-prompt');
                const rewrite = panel?.querySelector('#aw-rewrite-prompt');
                if (critic) critic.value = DEFAULT_CRITIC_PROMPT;
                if (rewrite) rewrite.value = DEFAULT_REWRITE_PROMPT;
                log('已恢复默认提示词');
            },
            onBeforeShow: () => {
                // 面板显示的提示词必须就是配置里那一份
                refreshPrompts(getSettings());
            },
            onTabChange: (tab) => {
                const s = getSettings();
                s.ui = { ...s.ui, tab };
                saveSettings();
            },
        });
    } catch (err) {
        reportFatal('挂载面板', err);
        return false;
    }

    if (!el) {
        reportFatal('挂载面板', new Error('模板解析后拿不到 #aw-panel'));
        return false;
    }

    panelMounted = true;

    try {
        const autoBox = getAutoCheckbox();
        if (autoBox) autoBox.checked = !!settings.auto;
        setState(idleState(settings));

        log('提示：「参数」页可点「运行自检」；「输出」页看 ①②③ 的结果');

        if (!settings.diagnosedOnce) {
            settings.diagnosedOnce = true;
            saveSettings();
            diagnose().catch((err) => console.error('[AgentWriter] 自检失败', err));
        }
    } catch (err) {
        // 面板本体已经挂上，这里出错不算致命
        console.error('[AgentWriter] 面板初始化后置步骤出错', err);
    }

    return true;
}

// ---------------------------------------------------------------------------
// 生命周期钩子（由 manifest.json 的 hooks 指定）
// ---------------------------------------------------------------------------

export function onActivate() {
    // 同步初始化：酒馆加载期、loader 还在转的时候。
    // 只挂悬浮球和菜单项，面板等 APP_READY / 兜底定时器。
    try {
        // 拦截上游流式 —— 实时正文和思维链都从这儿来。越早装越好，
        // 免得第一次生成发生在拦截之前（那样那次就没有思维链可看）。
        patchFetch();
    } catch (error) {
        console.error('[AgentWriter] 装上游拦截失败（思维链会看不到，正文不受影响）', error);
    }

    try {
        startUI();
    } catch (error) {
        console.error('[AgentWriter] UI 启动失败', error);
    }
}

export function onInstall() {
    console.log('[AgentWriter] onInstall');
}

export function onUpdate() {
    console.log('[AgentWriter] onUpdate');
}

export function onEnable() {
    try {
        startUI();
    } catch (error) {
        console.error('[AgentWriter] UI 启动失败', error);
    }
}

export function onDisable() {
    teardown();
}

export function onDelete() {
    teardown();
}

export async function onClean() {
    const context = getContext();
    if (context?.extensionSettings) {
        delete context.extensionSettings[MODULE_NAME];
        delete context.extensionSettings.agent_writer_diag;
        context.saveSettingsDebounced?.();
    }
    localStorage.removeItem('aw_fab_pos_v1');
    localStorage.removeItem('aw_panel_pos_v1');
    teardown();
}

function teardown() {
    unmountFab();
    unmountMenuItem();
    unmountPanel();
    uiStarted = false;
    panelMounted = false;
}

// ---------------------------------------------------------------------------
// 启动时机
// ---------------------------------------------------------------------------

let retryTimer = null;

function schedulePanelMount() {
    if (mountPanelOnce()) return;

    // 面板还没挂上（还没到 APP_READY），后台重试，保证它一定会出现
    if (retryTimer) return;
    let attempts = 0;
    retryTimer = setInterval(() => {
        attempts++;
        if (mountPanelOnce()) {
            clearInterval(retryTimer);
            retryTimer = null;
            console.log(`[AgentWriter] 面板已挂载（第 ${attempts} 次重试）`);
            return;
        }
        if (attempts >= 50) {
            clearInterval(retryTimer);
            retryTimer = null;
            reportFatal('挂载面板', new Error('30 秒内未能挂载。悬浮球仍可点击，点一下会再试一次'));
        }
    }, 600);
}

function onAppReady() {
    startUI();
    // APP_READY 的处理函数会被 await，耗时的初始化延后一拍
    setTimeout(() => mountPanelOnce(), 0);
}

// 双保险：无论钩子和事件谁先到，UI 和面板都会被拉起来。
//
// 整块包起来是必要的 —— 模块加载过程中抛出的异常是同步的，
// 而它一旦发生，onActivate 钩子都不会被调用，界面上什么都没有，
// 只有控制台里一行。这里至少要让信息冒出来。
try {
    const appContext = getContext();
    if (appContext?.eventSource?.on && appContext?.eventTypes?.APP_READY) {
        // 若 APP_READY 已触发过，eventSource.on 会自动补发
        appContext.eventSource.on(appContext.eventTypes.APP_READY, onAppReady);
    } else {
        console.warn('[AgentWriter] 拿不到 APP_READY 事件，退化为定时启动');
    }

    startUI();
    schedulePanelMount();

    window.addEventListener('pagehide', teardown);

    globalThis.aw = {
        version: VERSION,
        diagnose,
        probe,
        startUI,
        mountPanel: mountPanelOnce,
        teardown,
        state: setState,
        togglePanel: safeToggle,
        isPanelOpen,
        resetFabPosition,
        getSettings,
        log,
        setDiagOutput,
        show: () => {
            try {
                startUI();
                mountPanelOnce();
                if (!isPanelOpen()) safeToggle();
            } catch (err) {
                reportFatal('打开面板', err);
            }
        },
    };
} catch (err) {
    reportFatal('模块初始化', err);
}
