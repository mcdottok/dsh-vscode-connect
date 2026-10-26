import React, { useEffect, useRef, useState } from "react";
import css from "./style.css";
import { CONNECT_PATH } from "./api.mjs";

export const inject = ["slots", "locale"];
const PACKAGE = "dsh-vscode-connect";
const LOCALE = "vscodeConnect";
const en = {
  title: "VS Code connection",
  description:
    "Continue this Harness workspace in VS Code. All DSH Desktop modes work; browser access can stay off.",
  copy: "Copy connection address",
  copying: "Copying…",
  copied: "Copied. Paste it into DSH: Connect to Desktop in VS Code.",
  failed:
    "Could not obtain the local connection address. Check that this plugin is enabled, then retry.",
  clipboardFailed:
    "Clipboard access failed. Allow clipboard access and try again.",
  checking: "Checking local connection…",
  ready: "Local connection service is ready",
  unavailable: "Local connection service is unavailable",
  enabled: "Enable VS Code connection entry",
  disabled: "Connection entry is off",
  switchHint:
    "Enable connection and automatic reconnection from VS Code. Turning off closes dedicated connections and stops issuing new addresses.",
  switchFailed: "Could not save the switch. Check the current state and retry.",
  retry: "Check again",
  steps: "Connect automatically",
  step1: "Keep Harness running with VS Code connection enabled. New installations enable it by default.",
  step2:
    "Install the DSH extension in VS Code and open a trusted project folder. On Windows, the plugins discover and connect automatically on the same machine.",
  step3:
    "Select the same workspace and an existing conversation to continue it.",
  credentials:
    "For manual setup, copy the address above and run DSH: Connect to Desktop in VS Code. The address contains credentials; do not share it.",
  restart:
    "Automatic connection requires the local Windows DSH extension 0.1.48+. Saved manual connections take precedence. Other platforms, remote environments and discovery failures use manual setup. Previously disabled settings remain off until you enable them.",
};
const zh = {
  title: "VS Code 连接",
  description: "在 VS Code 中接续当前工作区和会话。DSH Desktop 任意模式均可使用，无需开启浏览器访问。",
  copy: "复制连接地址",
  copying: "正在复制…",
  copied: "已复制，请在 VS Code 中执行「DSH: 连接桌面端」并粘贴。",
  failed: "无法获取本机连接地址，请确认插件已启用后重试。",
  clipboardFailed: "无法写入剪贴板，请允许剪贴板访问后重试。",
  checking: "正在检查本机连接…",
  ready: "本机连接服务已就绪",
  unavailable: "本机连接服务暂不可用",
  enabled: "启用 VS Code 连接入口",
  disabled: "连接入口已关闭",
  switchHint:
    "开启后允许 VS Code 连接与自动重连。关闭后断开专用连接并停止提供新地址。",
  switchFailed: "开关保存失败，请重新检查当前状态后重试。",
  retry: "重新检查",
  steps: "自动连接",
  step1: "保持 DSH 运行并开启 VS Code 连接。首次安装默认开启，无需复制地址。",
  step2:
    "在 VS Code 中安装 DSH 扩展，打开并信任项目文件夹。Windows 同机环境下会自动发现并连接。",
  step3: "选择同一个工作区和已有会话，即可继续。",
  credentials: "需要手动连接时，复制上方地址，在 VS Code 执行「DSH: 连接桌面端」并粘贴。地址包含凭据，请勿分享。",
  restart:
    "自动连接需要 Windows 本机和 VS Code DSH 扩展 0.1.48+，已有手动连接配置优先。其他平台、远程环境或自动发现不可用时，请手动连接。曾保存的关闭设置需自行重新开启。",
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
      <div className="vsc-connect__actions">
        <button
          type="button"
          className="vsc-connect__button"
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
          <h3>{t("steps")}</h3>
          <ol className="vsc-connect__steps">
            <li>{t("step1")}</li>
            <li>{t("step2")}</li>
            <li>{t("step3")}</li>
          </ol>
          <p className="vsc-connect__muted">{t("credentials")}</p>
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
