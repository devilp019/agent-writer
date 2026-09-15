/**
 * Agent Writer - 可见的错误反馈
 *
 * 平板后端没法开控制台，任何静默失败都等于「什么都没发生」。
 * 所以关键路径上的失败必须冒泡到界面上。
 *
 * 优先用酒馆自带的 toastr；拿不到就退化成一个自绘的角标。
 */

let fallbackEl = null;
let fallbackTimer = null;

function fallbackToast(message, kind) {
    const colors = { error: '#e05565', warn: '#e0a355', info: '#9b8cff' };
    const color = colors[kind] ?? colors.info;

    if (!fallbackEl) {
        fallbackEl = document.createElement('div');
        fallbackEl.id = 'aw-toast';
        fallbackEl.style.cssText = [
            'position:fixed',
            'z-index:2147483600',
            'left:50%',
            'transform:translateX(-50%)',
            'top:calc(12px + env(safe-area-inset-top, 0px))',
            'max-width:min(92vw, 460px)',
            'padding:10px 14px',
            'border-radius:10px',
            'background:rgba(20,20,25,0.96)',
            'border:1px solid rgba(255,255,255,0.16)',
            'box-shadow:0 12px 32px rgba(0,0,0,0.5)',
            'color:#e8e8ec',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif',
            'font-size:13px',
            'line-height:1.5',
            'white-space:pre-wrap',
            'word-break:break-word',
            'pointer-events:none',
        ].join(';');
        document.body?.appendChild(fallbackEl);
    }

    fallbackEl.style.borderColor = color;
    fallbackEl.textContent = message;
    fallbackEl.style.display = 'block';

    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
        if (fallbackEl) fallbackEl.style.display = 'none';
    }, kind === 'error' ? 12000 : 6000);
}

function show(message, kind, title) {
    console[kind === 'error' ? 'error' : 'log']('[AgentWriter]', message);

    const toastr = globalThis.toastr;
    if (toastr && typeof toastr[kind] === 'function') {
        try {
            toastr[kind](String(message), title ?? 'Agent Writer', {
                timeOut: kind === 'error' ? 12000 : 6000,
                extendedTimeOut: kind === 'error' ? 6000 : 2000,
                preventDuplicates: false,
            });
            return;
        } catch {
            // toastr 挂了就走自绘
        }
    }

    fallbackToast(String(message), kind);
}

export function info(message, title) {
    show(message, 'info', title);
}

export function success(message, title) {
    show(message, 'success', title);
}

export function warn(message, title) {
    show(message, 'warning', title);
}

export function error(message, title) {
    show(message, 'error', title);
}

/**
 * 把异常连同调用位置一起报出来。
 * @param {string} where 出错的环节
 * @param {unknown} err
 */
export function fail(where, err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const stack = err instanceof Error && err.stack
        ? `\n${String(err.stack).split('\n').slice(1, 3).join('\n').trim()}`
        : '';
    error(`${where}失败\n${message}${stack}`, 'Agent Writer 出错');
}
