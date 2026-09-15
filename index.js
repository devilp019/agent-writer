/**
 * Agent Writer - 入口
 *
 * 骨架阶段只做四件事：
 *   1. 挂悬浮球（状态灯 + 面板开关）
 *   2. 挂扩展菜单项（第二入口 + 行内状态）
 *   3. 挂面板（自检 + 状态演示）
 *   4. 把设置落到 settings.json（验证「后端保存」这条链路）
 *
 * ①②③ 流水线在下一步接入。
 */

// 部署版本号。所有相对 import 都带上 ?v=<VERSION>：
// 换版本时浏览器会当作新 URL 重新拉取，避免旧模块缓存和新代码混在一起。
const VERSION = '0.3.3';

import { setState, setDemoHandler } from './state.js?v=0.3.3';
import { mountFab, unmountFab, resetFabPosition } from './ui/fab.js?v=0.3.3';
import { mountMenuItem, unmountMenuItem, isMenuItemMounted, describeMenuContainer } from './ui/menu.js?v=0.3.3';
import {
    mountPanel,
    unmountPanel,
    togglePanel,
    isPanelOpen,
    log,
    setDiagOutput,
    getAutoCheckbox,
} from './ui/panel.js?v=0.3.3';
import { diagnose, probe, exposeGlobals } from './diagnostics.js?v=0.3.3';

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

function getSettings() {
    const context = getContext();
    if (!context) throw new Error('SillyTavern.getContext() 不可用');

    // extensionSettings 理论上一定存在，但不能指望 —— 它一旦是 undefined，
    // 下面这行就会抛 TypeError，而且是在最早的启动路径上，直接导致整个 UI 不出现。
    if (!context.extensionSettings || typeof context.extensionSettings !== 'object') {
        context.extensionSettings = {};
    }

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = context.extensionSettings[MODULE_NAME];
    // 补齐新增的默认键，便于后续版本升级
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = DEFAULT_SETTINGS[key];
        }
    }
    return settings;
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
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

        setState(settings.auto ? 'idle' : 'off');
        log(`Agent Writer v${VERSION} 就绪（悬浮球 ${fabOk ? '✔' : '✘'} / 菜单项 ${menuOk ? '✔' : '✘'}）`);

        // 两个都没成，说明环境本身有问题，别让用户对着空白界面猜
        if (!fabOk && !menuOk) {
            reportFatal('挂载界面', new Error('悬浮球和菜单项都没能挂上，请把这条信息截图'));
        }
    }
    return settings;
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
    try {
        el = mountPanel({
            onAutoChange: (auto) => {
                const settings = getSettings();
                settings.auto = !!auto;
                saveSettings();
                setState(auto ? 'idle' : 'off');
                log(`自动模式：${auto ? '开' : '关'}`);
            },
            onDemoState: (state, detail) => setState(state, detail),
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
        const settings = getSettings();
        const autoBox = getAutoCheckbox();
        if (autoBox) autoBox.checked = !!settings.auto;
        setState(settings.auto ? 'idle' : 'off');

        log('提示：在「参数」页点「运行自检」可确认运行环境');

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
