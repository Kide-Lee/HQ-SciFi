//! 内嵌 JS 运行时：KaTeX 与 turndown 共用一个 `rquickjs` Context。
//!
//! 内核里有两处必须**逐字节**复刻前端实现、而在 Rust 侧无法可靠重写的逻辑：
//!
//! 1. `katex.renderToString`（1.x `src/shared/markdownItMath.ts`）——渲染结果会经
//!    `contentsAdd` / `contentsUpdate` 写进服务端，是发布内容本身；
//! 2. `new TurndownService({...}).turndown(html)`（1.x `src/main/services/sync-service.ts:135`）
//!    ——拉取远端 `markdown:0` 的 Quill HTML 后转成 md 落盘。
//!
//! 两处都用「跑同一份 JS」而不是移植算法：KaTeX 的 `style` 浮点数、turndown 的
//! 空白/列表缩进规则都是实现细节，任何重写都会漂移。两份脚本互不依赖，放同一个
//! Context 里（`katex` 与 `TurndownService` 都是全局变量），一次初始化、按需 eval：
//! KaTeX 有 272 KB，只有真的出现公式才付这份初始化成本；turndown 26 KB 同理。
//!
//! 线程模型：`rquickjs::Runtime` 不是 `Send`，所以 Engine 放在 `thread_local!` 里，
//! 每线程一份（Tauri 的命令跑在 tokio worker 线程上，每个 worker 各自初始化一次）。

use std::cell::RefCell;

use rquickjs::{Context, Runtime};

use crate::{CoreError, CoreResult};

/// 与 `node_modules/katex@0.18.4` 同一份文件（MIT，见 `assets/katex.LICENSE`）。
const KATEX_JS: &str = include_str!("../../../assets/katex.min.js");

/// turndown 7.2.4 + `@mixmark-io/domino` 的自包含 node bundle（MIT，见
/// `assets/turndown.LICENSE`）：用 esbuild `--bundle --platform=node --format=iife`
/// 从 `import TurndownService from 'turndown'; globalThis.TurndownService = TurndownService`
/// 打包，再内联进内核（QuickJS 里没有浏览器 DOM，必须带 domino 的 HTML 解析器）。
const TURNDOWN_JS: &str = include_str!("../../../assets/turndown.js");

/// 初始化失败 / 渲染失败时的统一文案前缀（`App` 变体 = 用户可见）。
const ENGINE_ERROR: &str = "内嵌 JS 引擎初始化失败";

struct Engine {
    /// rquickjs 0.9 的 `Context` 自己持有 `Runtime` 的引用计数，无需自引用技巧。
    ctx: Context,
    katex_ready: bool,
    turndown_ready: bool,
}

impl Engine {
    fn new() -> CoreResult<Self> {
        let rt = Runtime::new().map_err(|e| CoreError::App(format!("{ENGINE_ERROR}：{e}")))?;
        let ctx = Context::full(&rt).map_err(|e| CoreError::App(format!("{ENGINE_ERROR}：{e}")))?;
        let engine = Self {
            ctx,
            katex_ready: false,
            turndown_ready: false,
        };
        engine.ctx.with(|ctx| -> CoreResult<()> {
            // 两个 bundle 都按浏览器全局脚本设计：
            // - KaTeX 是 UMD，清掉 CJS/AMD 分支让它挂到全局 `katex`；
            // - `console` 打桩：KaTeX 严格模式会对数学模式里的 CJK 字符 console.warn，
            //   输出与警告无关，静默即可；
            // - turndown 的 node bundle 内联了 @mixmark-io/domino，它的 WindowTimers
            //   在加载期就引用 setTimeout 等浏览器定时器，QuickJS 没有，打桩即可
            //   （turndown 同步解析 HTML，从不真的等定时器）。
            //
            // 注意：脚本必须是**带换行**的多行字符串——用 Rust 的 `\` 行连接会把
            // 注释和后续语句并到同一行，注释会把后面的桩全部吃掉。
            let bootstrap = concat!(
                "var module=undefined,exports=undefined,define=undefined;",
                "var console={log(){},info(){},debug(){},warn(){},error(){}};",
                "globalThis.console=console;",
                "var setTimeout=function(){return 0},clearTimeout=function(){},",
                "setInterval=function(){return 0},clearInterval=function(){};",
                "globalThis.setTimeout=setTimeout;globalThis.clearTimeout=clearTimeout;",
                "globalThis.setInterval=setInterval;globalThis.clearInterval=clearInterval;"
            );
            ctx.eval::<(), _>(bootstrap)
                .map_err(|e| CoreError::App(format!("{ENGINE_ERROR}：{e}")))?;
            Ok(())
        })?;
        Ok(engine)
    }

    fn ensure_katex(&mut self) -> CoreResult<()> {
        if self.katex_ready {
            return Ok(());
        }
        self.ctx.with(|ctx| -> CoreResult<()> {
            ctx.eval::<(), _>(KATEX_JS)
                .map_err(|e| CoreError::App(format!("{ENGINE_ERROR}：{e}")))?;
            let ok = ctx
                .eval::<bool, _>(
                    "typeof katex === 'object' && typeof katex.renderToString === 'function'",
                )
                .map_err(|e| CoreError::App(format!("{ENGINE_ERROR}：{e}")))?;
            if !ok {
                return Err(CoreError::App(format!("{ENGINE_ERROR}：katex 未注册")));
            }
            Ok(())
        })?;
        self.katex_ready = true;
        Ok(())
    }

    fn ensure_turndown(&mut self) -> CoreResult<()> {
        if self.turndown_ready {
            return Ok(());
        }
        self.ctx.with(|ctx| -> CoreResult<()> {
            ctx.eval::<(), _>(TURNDOWN_JS)
                .map_err(|e| CoreError::App(format!("{ENGINE_ERROR}：{e}")))?;
            let ok = ctx
                .eval::<bool, _>("typeof TurndownService === 'function'")
                .map_err(|e| CoreError::App(format!("{ENGINE_ERROR}：{e}")))?;
            if !ok {
                return Err(CoreError::App(format!(
                    "{ENGINE_ERROR}：TurndownService 未注册"
                )));
            }
            Ok(())
        })?;
        self.turndown_ready = true;
        Ok(())
    }

    /// `katex.renderToString(latex, {throwOnError:false, displayMode})`。
    fn render_math(&mut self, latex: &str, display: bool) -> CoreResult<String> {
        self.ensure_katex()?;
        // `serde_json::to_string` 产出的字符串字面量可直接嵌进 JS 源码
        // （转义规则与 JS 字符串字面量一致：引号、反斜杠、控制字符）。
        let lit = serde_json::to_string(latex)
            .map_err(|e| CoreError::App(format!("数学公式渲染失败：{e}")))?;
        let script =
            format!("katex.renderToString({lit}, {{throwOnError:false, displayMode:{display}}})");
        self.ctx.with(|ctx| {
            ctx.eval::<String, _>(script)
                .map_err(|e| CoreError::App(format!("数学公式渲染失败：{e}")))
        })
    }

    /// 1.x `sync-service.ts:135` 的 turndown 配置（逐字对齐）。
    fn turndown(&mut self, html: &str) -> CoreResult<String> {
        self.ensure_turndown()?;
        let lit = serde_json::to_string(html)
            .map_err(|e| CoreError::App(format!("HTML 转换失败：{e}")))?;
        let script = format!(
            "new TurndownService({{headingStyle:'atx',codeBlockStyle:'fenced',bulletListMarker:'-'}}).turndown({lit})"
        );
        self.ctx.with(|ctx| {
            ctx.eval::<String, _>(script)
                .map_err(|e| CoreError::App(format!("HTML 转换失败：{e}")))
        })
    }
}

thread_local! {
    /// 引擎按线程复用；首次用到某个脚本时才初始化 Runtime / eval 对应 bundle。
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
}

fn with_engine<R>(f: impl FnOnce(&mut Engine) -> CoreResult<R>) -> CoreResult<R> {
    ENGINE.with(|slot| {
        let mut guard = slot.borrow_mut();
        if guard.is_none() {
            *guard = Some(Engine::new()?);
        }
        match guard.as_mut() {
            Some(engine) => f(engine),
            None => Err(CoreError::App(format!("{ENGINE_ERROR}：引擎不可用"))),
        }
    })
}

/// 渲染一个公式，返回 KaTeX HTML（与 1.x `katex.renderToString(latex,{throwOnError:false,displayMode})`
/// 逐字节一致）。
pub(crate) fn render_math(latex: &str, display: bool) -> CoreResult<String> {
    with_engine(|engine| engine.render_math(latex, display))
}

/// HTML → Markdown（1.x `sync-service.ts` 的 turndown 实例）。
pub(crate) fn turndown(html: &str) -> CoreResult<String> {
    with_engine(|engine| engine.turndown(html))
}
