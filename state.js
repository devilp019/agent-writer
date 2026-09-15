/**
 * Agent Writer - 状态机
 *
 * 单一事实来源：任何地方要改变悬浮球/菜单项的外观，都必须走 setState()。
 * 后续接入 ①②③ 流水线时，只在阶段切换处调用 setState 即可。
 */

/** @typedef {'off'|'idle'|'drafting'|'checking'|'rewriting'|'done'|'error'} AwState */

/**
 * 状态定义。
 * - `spin`   环旋转周期（秒），只动 transform，不动布局属性
 * - `breathe` 呼吸周期（秒）
 * - `badge`  徽标文字；null 表示显示图标
 */
export const STATES = Object.freeze({
    off: { spin: 0, breathe: 0, badge: null },
    idle: { spin: 0, breathe: 4.0, badge: null },
    drafting: { spin: 1.6, breathe: 1.6, badge: null },
    checking: { spin: 1.1, breathe: 1.1, badge: null },
    rewriting: { spin: 0.9, breathe: 0.9, badge: null },
    done: { spin: 0, breathe: 0, badge: null },
    error: { spin: 0, breathe: 0, badge: null },
});

/** 进入这些状态时，徽标应被清空 */
const TRANSIENT = new Set(['off', 'idle', 'done']);

/** 自动回落到 idle 的状态及其延时（毫秒） */
const AUTO_FALLBACK = { done: 4000 };

let current = 'idle';
let currentDetail = null;
let fallbackTimer = null;
const listeners = new Set();

/**
 * 状态演示处理器。
 * 由 panel.js 注册，让面板的演示按钮能驱动状态机，
 * 同时避免 panel.js 反向 import index.js 造成循环依赖。
 * @type {((state: AwState, detail: {badge?: string}|null) => void)|null}
 */
let demoHandler = null;

export function setDemoHandler(fn) {
    demoHandler = fn;
}

/** 供面板演示按钮调用 */
export function demoState(state, detail = null) {
    if (demoHandler) {
        demoHandler(state, detail);
        return;
    }
    setState(state, detail);
}

/**
 * 订阅状态变化。
 * @param {(state: AwState, detail: {badge?: string}) => void} fn
 * @returns {() => void} 取消订阅
 */
export function subscribe(fn) {
    listeners.add(fn);
    fn(current, currentDetail);
    return () => listeners.delete(fn);
}

/**
 * @returns {{state: AwState, detail: {badge?: string}|null}}
 */
export function getState() {
    return { state: current, detail: currentDetail };
}

export function isBusy() {
    return current === 'drafting' || current === 'checking' || current === 'rewriting';
}

/** 根据自动模式开关给出闲置时应显示的状态 */
export function idleState(settings) {
    const enabled = settings?.enabled !== false;
    if (!enabled) return 'off';
    return settings?.auto ? 'idle' : 'off';
}

/**
 * 切换状态。
 * @param {AwState} state
 * @param {{badge?: string}} [detail] 徽标（如问题条数、已收字数）
 */
export function setState(state, detail = null) {
    if (!Object.hasOwn(STATES, state)) {
        console.warn('[AgentWriter] 未知状态:', state);
        return;
    }

    clearTimeout(fallbackTimer);
    fallbackTimer = null;

    // 瞬时状态自动清空徽标，避免"✓"残留成"3"
    const nextDetail = TRANSIENT.has(state) ? null : detail;
    const changed = state !== current || JSON.stringify(nextDetail) !== JSON.stringify(currentDetail);

    current = state;
    currentDetail = nextDetail;

    if (Object.hasOwn(AUTO_FALLBACK, state)) {
        fallbackTimer = setTimeout(() => setState('idle'), AUTO_FALLBACK[state]);
    }

    if (changed) {
        for (const fn of listeners) {
            try {
                fn(current, currentDetail);
            } catch (error) {
                console.error('[AgentWriter] 状态订阅回调出错:', error);
            }
        }
    }
}

/**
 * 流式进度专用：不改状态，只更新徽标。
 * 生成长文本时球上的数字会持续变化，让你不点开也知道它在动。
 * @param {string} badge
 */
export function setBadge(badge) {
    if (!isBusy()) return;
    currentDetail = { ...(currentDetail ?? {}), badge };
    for (const fn of listeners) {
        try {
            fn(current, currentDetail);
        } catch (error) {
            console.error('[AgentWriter] 状态订阅回调出错:', error);
        }
    }
}
