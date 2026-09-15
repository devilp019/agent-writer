/**
 * Agent Writer - 上游流式拦截
 *
 * 为什么非要有这个东西
 * --------------------
 * 「实时正文」和「思维链」只能从这里拿。走酒馆助手的事件是拿不到的：
 *
 *   · 酒馆确实把思维链攒下来了 —— openai.js:3168 建了
 *     `state = { reasoning: '', ... }`，3291 对 custom 源做
 *     `state.reasoning += delta.reasoning_content ?? delta.reasoning`。
 *   · 但酒馆助手收下这些分片之后只读 `state.signature` 和
 *     `state.toolSignatures`（responseGenerator.ts:142-149），
 *     `state.reasoning` 直接丢掉，也没有任何事件把它带出来。
 *   · 唯一会 emit STREAM_REASONING_DONE 的是酒馆自己的
 *     public/scripts/reasoning.js:549（ReasoningHandler 类），
 *     而全仓库没有任何文件 import 这个类 —— 那个事件等于死的。
 *     （和 STREAM_TOKEN_RECEIVED 一样，只在 events.js 里定义过。）
 *
 * 所以只能自己拦。做法是包一层 window.fetch：
 * 酒馆前端是在 openai.js:3149 用**裸的全局 fetch** 打的
 * `/api/backends/chat-completions/generate`，没有存成局部引用，
 * 所以事后替换 window.fetch 是拦得住的。
 *
 * 怎么分清是哪一次请求
 * --------------------
 * 拦截时必须能回答「这坨分片属于哪个阶段」。这里不用「当前活动监听器」
 * 这种全局单槽做法 —— 那种做法有竞态：上一轮的 SSE 是异步解析的，
 * 它的分片完全可能在下一轮开始之后才到，于是第二轮里闪出第一轮的思维链。
 *
 * 改成按标记归属：槽位内容里本来就带了 `__AW_PAYLOAD_<generationId>__`
 * （见 tavern.js 的 makePayloadTag、injectSlot），它会随 messages 一起
 * 进到请求体 JSON 里。于是每个请求天然带着自己的身份，解析出来的分片
 * 只会发给订阅了那个标记的人，串不了。
 */

/** 酒馆前端的生成端点（openai.js:3148） */
const ENDPOINT = '/api/backends/chat-completions/generate';

/** 槽位里那个标记，用来认领请求 */
const TAG_RE = /__AW_PAYLOAD_([A-Za-z0-9_-]+)__/;

/** tag -> Set<handler> */
const sinks = new Map();

let patched = false;
let originalFetch = null;
let patchError = null;

/** 统计信息，给面板自检用 —— 「到底拦到没有」要是个可观测的事实 */
const stats = {
    seen: 0,
    matched: 0,
    streaming: 0,
    nonStreaming: 0,
    chunks: 0,
    reasoningChunks: 0,
    errors: [],
};

export function getStreamHookStats() {
    return { ...stats, patched, error: patchError, subscribers: sinks.size };
}

export function isFetchPatched() {
    return patched;
}

/**
 * 订阅某个标记的流。
 *
 * handler 会收到 `{ text, reasoning, done }`：
 *   text      —— 到目前为止的**累计正文**（不是增量）
 *   reasoning —— 到目前为止的**累计思维链**
 *   done      —— 流结束了
 *
 * @param {string} tag
 * @param {(evt: {text: string, reasoning: string, done: boolean}) => void} handler
 * @returns {() => void} 退订函数
 */
export function subscribeStream(tag, handler) {
    if (!tag || typeof handler !== 'function') return () => {};
    if (!sinks.has(tag)) sinks.set(tag, new Set());
    sinks.get(tag).add(handler);

    return () => {
        const set = sinks.get(tag);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) sinks.delete(tag);
    };
}

/**
 * 从请求体里认出这是哪一次请求，返回**完整的标记**。
 *
 * ⚠️ 返回的是整个 `__AW_PAYLOAD_<id>__`，不是里面的 id。
 * 因为订阅方拿到的就是 makePayloadTag() 的产物（带前缀后缀），两边必须
 * 是同一个字符串。这里曾经只返回捕获组里的 id，于是
 * `sinks.has('aw-critic-…')` 永远查不到 `'__AW_PAYLOAD_aw-critic-…__'` ——
 * 拦截一个都认领不上（自检里 seen 在涨、matched 一直是 0）。
 * 单元测试没发现是因为它拿裸 id 去订阅，正好和当时的实现自洽；
 * 是 test-pipeline.mjs 里那条端到端接线测试把它逼出来的。
 */
export function tagFromRequestBody(body) {
    if (typeof body !== 'string' || !body) return null;
    const m = body.match(TAG_RE);
    return m ? m[0] : null;
}

/** 请求体里 stream 是不是 true */
export function wantsStream(body) {
    if (typeof body !== 'string' || !body) return false;
    try {
        return JSON.parse(body)?.stream === true;
    } catch {
        // 解析不了就退回字符串判断 —— 宁可漏判也不要抛
        return /"stream"\s*:\s*true/.test(body);
    }
}

function emitTo(tag, evt) {
    const set = sinks.get(tag);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
        try {
            handler(evt);
        } catch (e) {
            console.warn('[AgentWriter] 流式回调出错', e);
        }
    }
}

/**
 * 解析 SSE。自己攒累计正文和累计思维链。
 *
 * 兼容两处上游怪癖：
 *   · Cline 的非流式响应会多包一层 `{ data: { choices: [...] } }`
 *     （流式分片是干净的，这里顺手兼容一下不亏）
 *   · 思维链字段名不统一：`reasoning_content`（DeepSeek 系）
 *     和 `reasoning`（OpenRouter 系）都要认
 */
async function parseSSE(body, tag) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;

                let json;
                try {
                    json = JSON.parse(payload);
                } catch {
                    continue;   // 半个分片，下一轮会拼上
                }

                if (json?.data?.choices && !json.choices) json = json.data;
                const choice = json?.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta ?? choice.message ?? {};

                if (typeof delta.content === 'string' && delta.content) {
                    text += delta.content;
                }
                const r = delta.reasoning_content ?? delta.reasoning;
                if (typeof r === 'string' && r) {
                    reasoning += r;
                    stats.reasoningChunks++;
                }

                stats.chunks++;
                emitTo(tag, { text, reasoning, done: false });
            }
        }
    } catch (e) {
        // 用户中止、连接断开都会走到这里。不是错误，只是流断了。
        stats.errors.push(String(e?.message ?? e).slice(0, 120));
    }

    emitTo(tag, { text, reasoning, done: true });
}

/** 非流式：思维链在 choices[0].message 里，读一份副本就好，不改动原响应 */
async function readNonStreaming(response, tag) {
    try {
        const json = await response.clone().json();
        const unpacked = json?.data?.choices && !json.choices ? json.data : json;
        const message = unpacked?.choices?.[0]?.message;
        if (!message) return;

        const text = typeof message.content === 'string' ? message.content : '';
        const reasoning = typeof message.reasoning_content === 'string' && message.reasoning_content
            ? message.reasoning_content
            : (typeof message.reasoning === 'string' ? message.reasoning : '');

        emitTo(tag, { text, reasoning, done: true });
    } catch {
        emitTo(tag, { text: '', reasoning: '', done: true });
    }
}

function makePatchedFetch() {
    return async function agentWriterFetch(resource, init) {
        const response = await originalFetch.call(this, resource, init);

        // 只关心生成端点；其它请求只做转发，一点开销都不加
        let url = '';
        try {
            url = typeof resource === 'string' ? resource : (resource?.url ?? '');
        } catch { /* 无所谓 */ }
        if (!url.includes(ENDPOINT)) return response;

        stats.seen++;

        const tag = tagFromRequestBody(init?.body);
        if (!tag) return response;
        if (!sinks.has(tag)) return response;

        stats.matched++;

        const contentType = response?.headers?.get?.('content-type') ?? '';
        const streaming = wantsStream(init?.body) || contentType.includes('text/event-stream');

        // clone() 必须在这里**同步**做掉：酒馆紧接着就会
        // `response.body.pipeThrough(...)` 把原始 body 锁住（openai.js:3162），
        // 那之后再 clone 就晚了。
        let clone;
        try {
            clone = response.clone();
        } catch {
            return response;   // 没 body 或者已经被读过，放弃这一路
        }

        if (streaming && clone.body) {
            stats.streaming++;
            parseSSE(clone.body, tag).catch(() => {
                emitTo(tag, { text: '', reasoning: '', done: true });
            });
        } else {
            stats.nonStreaming++;
            readNonStreaming(clone, tag).catch(() => { /* 读不出来就算了 */ });
        }

        return response;
    };
}

/**
 * 装上拦截。幂等 —— 重复调用不会套娃。
 *
 * 注意：装完之后要能被别的扩展再包一层（酒馆里有的是改 fetch 的），
 * 所以这里只包一次，并且包的是「当时那一层」。
 */
export function patchFetch() {
    if (patched) return true;

    const target = globalThis.fetch;
    if (typeof target !== 'function') {
        patchError = 'globalThis.fetch 不是函数';
        return false;
    }

    originalFetch = target;
    globalThis.fetch = makePatchedFetch();
    patched = true;

    // 让酒馆自己也能看出来是谁包的，排查时省事
    try {
        globalThis.fetch.__agentWriterPatched = true;
    } catch { /* 冻结的对象就算了 */ }

    console.log('[AgentWriter] ✓ 已拦上上游流式（思维链与实时正文都从这儿来）');
    return true;
}

/** 只在测试里用：把 fetch 还原回去 */
export function unpatchFetch() {
    if (!patched) return;
    globalThis.fetch = originalFetch;
    patched = false;
    originalFetch = null;
}

/** 只在测试里用：清掉统计 */
export function resetStreamHookStats() {
    stats.seen = 0;
    stats.matched = 0;
    stats.streaming = 0;
    stats.nonStreaming = 0;
    stats.chunks = 0;
    stats.reasoningChunks = 0;
    stats.errors.length = 0;
}
