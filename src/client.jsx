import React, { useEffect, useRef, useState } from "react";
import css from "./style.css";
import { CONNECT_PATH } from "./api.mjs";

export const inject = ["slots", "locale"];
const PACKAGE = "dsh-vscode-connect";
const LOCALE = "vscodeConnect";
const en = {
  title: "VS Code connection",
  description:
    "Connect this Desktop instance to DSH Coding Agent in VS Code and continue the same workspace and conversation.",
  copy: "Copy connection address",
  copying: "Copying…",
  copied: "Copied. Paste it into DSH: Connect to Desktop in VS Code.",
  failed:
    "Could not obtain the local connection address. Check that this plugin is enabled, then retry.",
  clipboardFailed:
    "Clipboard access failed. Allow clipboard access and try again.",
  checking: "Checking local connection…",
  ready:
    "Desktop connection entry is ready; check connection status in VS Code",
  unavailable: "Local connection service is unavailable",
  enabled: "Enable VS Code connection entry",
  disabled: "Connection entry is off",
  switchHint:
    "Enabled by default on first installation. Keep Desktop running; browser access and a specific layout are not required. Turning this off disconnects VS Code and stops automatic discovery.",
  switchFailed: "Could not save the switch. Check the current state and retry.",
  retry: "Check again",
  companion:
    "DSH Coding Agent has temporarily been removed from the VS Code Marketplace; the reason is not yet clear. We hope to republish it later. In the meantime, download the .vsix from ",
  companionInstall:
    " and use Extensions: Install from VSIX... in VS Code to install it. If you have any questions or suggestions, please submit feedback in the ",
  companionFeedbackLink: "GitHub repository",
  companionFeedbackEnd: ".",
  manual: "Manual connection",
  steps: "Connect automatically",
  step1:
    "Download and install DSH Coding Agent using the link above, then open and trust your project folder in VS Code.",
  step2:
    "Keep Desktop running with this connection entry enabled. In the extension, select DSH Desktop. On local Windows, discovery and connection are automatic.",
  step3:
    "Select the same workspace and an existing conversation to continue it.",
  credentials:
    "For manual setup, click Copy connection address below and run DSH: Connect to Desktop in VS Code. The address contains credentials; do not share it.",
  restart:
    "If connection fails, check that both plugins and this entry are enabled. Then copy a fresh address and reconnect in VS Code. Other platforms and remote environments require manual connection; use the latest companion extension.",
};
const zh = {
  title: "VS Code 连接",
  description:
    "配合 VS Code 中的 DSH Coding Agent，在编辑器中接续此桌面端的工作区和会话。",
  copy: "复制连接地址",
  copying: "正在复制…",
  copied: "已复制，请在 VS Code 中执行「DSH: 连接桌面端」并粘贴。",
  failed: "无法获取本机连接地址，请确认插件已启用后重试。",
  clipboardFailed: "无法写入剪贴板，请允许剪贴板访问后重试。",
  checking: "正在检查本机连接…",
  ready: "桌面端连接入口已就绪，连接状态请在 VS Code 中查看",
  unavailable: "本机连接服务暂不可用",
  enabled: "启用 VS Code 连接入口",
  disabled: "连接入口已关闭",
  switchHint:
    "首次安装默认开启。保持桌面端运行即可，无需开启浏览器访问或切换布局。关闭后会断开 VS Code 连接并停止自动发现。",
  switchFailed: "开关保存失败，请重新检查当前状态后重试。",
  retry: "重新检查",
  companion:
    "DSH Coding Agent 暂时被 VS Code 扩展商城下架（具体原因尚未明确™d），等待后续重新上架。期间请从 ",
  companionInstall:
    " 下载 .vsix 文件，在 VS Code 中选择「从 VSIX 安装…」。若有任何使用问题和建议， 请在 ",
  companionFeedbackLink: "GitHub 仓库",
  companionFeedbackEnd: "中提交反馈。",
  manual: "手动连接",
  steps: "自动连接",
  step1:
    "通过上方链接下载并安装 DSH Coding Agent，在 VS Code 中打开并信任项目文件夹。",
  step2:
    "保持桌面端运行且此连接入口开启，在扩展中选择「DSH Desktop」。Windows 同机环境下自动发现并连接，无需复制地址。",
  step3: "选择同一个工作区和已有会话，即可继续。",
  credentials:
    "需要手动连接时，点击下方「复制连接地址」，在 VS Code 执行「DSH: 连接桌面端」并粘贴。地址包含凭据，请勿分享。",
  restart:
    "连接失败时，先确认两端插件及此入口已启用，再复制最新地址，在 VS Code 中重新连接。其他平台或远程环境请手动连接，建议使用最新版配套扩展。",
};

export async function requestConnection(method, signal, body) {
  const response = await fetch(CONNECT_PATH, {
    method,
    signal,
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) throw new Error("Connection unavailable");
  const result = await response.json();
  if (method === "GET" || method === "PATCH") {
    if (
      result?.available !== true ||
      typeof result.enabled !== "boolean" ||
      !Number.isSafeInteger(result.revision) ||
      result.revision < 0
    )
      throw new Error("Connection unavailable");
    return { enabled: result.enabled, revision: result.revision };
  }
  if (typeof result?.url !== "string" || result.url.length > 8192)
    throw new Error("Connection unavailable");
  const url = new URL(result.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Connection unavailable");
  return result.url;
}

function ConnectionControls({ t, compact = false }) {
  const [status, setStatus] = useState("checking");
  const [notice, setNotice] = useState();
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState();
  const lifecycle = useRef();
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    const refresh = () => {
      const version = ++generation.current;
      void requestConnection("GET", controller.signal).then(
        (value) => {
          if (!controller.signal.aborted && version === generation.current) {
            setState(value);
            setStatus(value.enabled ? "ready" : "disabled");
          }
        },
        () => {
          if (!controller.signal.aborted && version === generation.current)
            setStatus("unavailable");
        },
      );
    };
    refresh();
    window.addEventListener("vsc-connect-change", refresh);
    return () => {
      controller.abort();
      lifecycle.current = undefined;
      generation.current++;
      window.removeEventListener("vsc-connect-change", refresh);
    };
  }, []);
  const copy = async () => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || busy || !state?.enabled)
      return;
    setBusy(true);
    setNotice(undefined);
    let obtained = false;
    try {
      const url = await requestConnection("POST", controller.signal);
      controller.signal.throwIfAborted();
      obtained = true;
      await navigator.clipboard.writeText(url);
      if (!controller.signal.aborted) {
        setStatus("ready");
        setNotice("copied");
      }
    } catch {
      if (!controller.signal.aborted)
        setNotice(obtained ? "clipboardFailed" : "failed");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const check = async () => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || busy) return;
    setBusy(true);
    setStatus("checking");
    try {
      const value = await requestConnection("GET", controller.signal);
      if (!controller.signal.aborted) {
        setState(value);
        setStatus(value.enabled ? "ready" : "disabled");
      }
    } catch {
      if (!controller.signal.aborted) setStatus("unavailable");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const toggle = async () => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || busy || !state) return;
    setBusy(true);
    setNotice(undefined);
    generation.current++;
    try {
      const value = await requestConnection("PATCH", controller.signal, {
        enabled: !state.enabled,
        revision: state.revision,
      });
      if (!controller.signal.aborted) {
        setState(value);
        setStatus(value.enabled ? "ready" : "disabled");
        window.dispatchEvent(new Event("vsc-connect-change"));
      }
    } catch {
      if (!controller.signal.aborted) {
        setStatus("unavailable");
        setNotice("switchFailed");
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className={`vsc-connect ${compact ? "vsc-connect--compact" : ""}`}>
      <div className="vsc-connect__row">
        <div className="vsc-connect__intro">
          <div className="vsc-connect__title">{t("title")}</div>
          <div className="vsc-connect__muted">{t("description")}</div>
        </div>
        <button
          type="button"
          className="vsc-connect__switch"
          role="switch"
          aria-label={t("enabled")}
          aria-checked={state?.enabled === true}
          disabled={busy || !state || status === "unavailable"}
          onClick={() => void toggle()}
        >
          <span />
        </button>
      </div>
      <p className="vsc-connect__muted">{t("switchHint")}</p>
      <p className="vsc-connect__companion">
        {t("companion")}
        <a
          href="https://github.com/mcdottok/vscode-dsh/releases"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub Releases ↗
        </a>
        {t("companionInstall")}
        <a
          href="https://github.com/mcdottok/vscode-dsh/issues"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("companionFeedbackLink")}
        </a>
        {t("companionFeedbackEnd")}
      </p>
      {!compact ? (
        <>
          <h3>{t("steps")}</h3>
          <ol className="vsc-connect__steps">
            <li>{t("step1")}</li>
            <li>{t("step2")}</li>
            <li>{t("step3")}</li>
          </ol>
        </>
      ) : null}
      <h3>{t("manual")}</h3>
      <p className="vsc-connect__muted">{t("credentials")}</p>
      <div className="vsc-connect__actions">
        <button
          type="button"
          className="vsc-connect__button vsc-connect__button--primary"
          disabled={busy || !state?.enabled || status === "unavailable"}
          onClick={() => void copy()}
        >
          {t(busy ? "copying" : "copy")}
        </button>
      </div>
      {notice ? (
        <p
          className="vsc-connect__notice"
          role={notice === "copied" ? "status" : "alert"}
        >
          {t(notice)}
        </p>
      ) : null}
      {!compact ? (
        <>
          <div className="vsc-connect__status" role="status">
            <span className={`vsc-connect__dot vsc-connect__dot--${status}`} />
            {t(status)}
            {status === "unavailable" ? (
              <button
                type="button"
                disabled={busy}
                className="vsc-connect__button"
                onClick={() => void check()}
              >
                {t("retry")}
              </button>
            ) : null}
          </div>
          <p className="vsc-connect__muted">{t("restart")}</p>
        </>
      ) : null}
    </section>
  );
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(LOCALE, { en, zh }));
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = PACKAGE;
    style.textContent = css;
    document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "vscode-connect",
        order: 85,
        locale: LOCALE,
      },
      (props) => <ConnectionControls {...props} compact />,
    ),
  );
  ctx.slots.inject("plugins.bundle.config", () =>
    ctx.slots.register(
      {
        name: "plugins.bundle.config",
        key: PACKAGE,
        locale: LOCALE,
      },
      ConnectionControls,
    ),
  );
}
