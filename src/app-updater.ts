import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type UpdaterElements = {
  checkButton: HTMLButtonElement | null;
  overlay: HTMLElement | null;
  version: HTMLElement | null;
  notes: HTMLElement | null;
  status: HTMLElement | null;
  error: HTMLElement | null;
  progressShell: HTMLElement | null;
  progressFill: HTMLElement | null;
  progressText: HTMLElement | null;
  laterButton: HTMLButtonElement | null;
  installButton: HTMLButtonElement | null;
};

type UpdaterOptions = {
  canInstall: () => boolean;
};

const AUTO_CHECK_DELAY_MS = 3_500;
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

function isTauriRuntime() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error || "未知错误");
}

export function bindAppUpdater(elements: UpdaterElements, options: UpdaterOptions) {
  let pendingUpdate: Update | null = null;
  let checking = false;
  let installing = false;
  let downloadedBytes = 0;
  let contentLength = 0;
  let buttonResetTimer: number | null = null;

  const setButtonText = (text: string, reset = false) => {
    if (!elements.checkButton) return;
    elements.checkButton.textContent = text;
    if (buttonResetTimer !== null) {
      window.clearTimeout(buttonResetTimer);
      buttonResetTimer = null;
    }
    if (reset) {
      buttonResetTimer = window.setTimeout(() => {
        if (elements.checkButton) elements.checkButton.textContent = "检查更新";
        buttonResetTimer = null;
      }, 2_500);
    }
  };

  const setProgress = (percent: number | null, text: string) => {
    elements.progressShell?.classList.remove("hide");
    if (elements.progressFill) {
      elements.progressFill.style.width = percent === null ? "28%" : `${Math.max(0, Math.min(100, percent))}%`;
      elements.progressFill.classList.toggle("indeterminate", percent === null);
    }
    if (elements.progressText) elements.progressText.textContent = text;
  };

  const showError = (message: string) => {
    if (elements.error) {
      elements.error.textContent = message;
      elements.error.classList.remove("hide");
    }
  };

  const clearError = () => {
    elements.error?.classList.add("hide");
    if (elements.error) elements.error.textContent = "";
  };

  const showUpdate = (update: Update) => {
    if (elements.version) {
      elements.version.textContent = `${update.currentVersion} → ${update.version}`;
    }
    if (elements.notes) {
      elements.notes.textContent = update.body?.trim() || "此版本包含功能优化与稳定性改进。";
    }
    if (elements.status) elements.status.textContent = "发现新版本";
    elements.progressShell?.classList.add("hide");
    if (elements.progressFill) {
      elements.progressFill.style.width = "0%";
      elements.progressFill.classList.remove("indeterminate");
    }
    clearError();
    if (elements.installButton) {
      elements.installButton.classList.remove("hide");
      elements.installButton.disabled = false;
      elements.installButton.textContent = "立即更新";
    }
    if (elements.laterButton) {
      elements.laterButton.disabled = false;
      elements.laterButton.textContent = "稍后";
    }
    elements.overlay?.classList.remove("hide");
  };

  const closeDialog = async () => {
    if (installing) return;
    elements.overlay?.classList.add("hide");
    setButtonText("检查更新");
    const update = pendingUpdate;
    pendingUpdate = null;
    if (update) {
      await update.close().catch(() => undefined);
    }
  };

  const checkForUpdate = async (manual: boolean) => {
    if (checking || installing) return;
    if (!isTauriRuntime()) {
      if (manual) setButtonText("开发模式", true);
      return;
    }

    checking = true;
    if (elements.checkButton) elements.checkButton.disabled = true;
    if (manual) setButtonText("检查中…");
    try {
      const update = await check({ timeout: CHECK_TIMEOUT_MS });
      if (!update) {
        if (manual) setButtonText("已是最新", true);
        return;
      }
      if (pendingUpdate) await pendingUpdate.close().catch(() => undefined);
      pendingUpdate = update;
      setButtonText("发现更新");
      showUpdate(update);
    } catch (error) {
      if (manual) {
        if (elements.status) elements.status.textContent = "暂时无法检查更新";
        if (elements.version) elements.version.textContent = "请稍后重试";
        if (elements.notes) elements.notes.textContent = "未对当前应用进行任何修改。";
        showError(`检查失败：${errorMessage(error)}`);
        elements.progressShell?.classList.add("hide");
        if (elements.installButton) elements.installButton.classList.add("hide");
        if (elements.laterButton) elements.laterButton.textContent = "关闭";
        elements.overlay?.classList.remove("hide");
      }
      setButtonText("检查更新", false);
    } finally {
      checking = false;
      if (elements.checkButton) elements.checkButton.disabled = false;
    }
  };

  const installUpdate = async () => {
    if (!pendingUpdate || installing) return;
    if (!options.canInstall()) {
      showError("请等待当前导入、检测或导出任务结束后再更新。");
      return;
    }

    installing = true;
    downloadedBytes = 0;
    contentLength = 0;
    clearError();
    if (elements.status) elements.status.textContent = "正在更新";
    if (elements.installButton) {
      elements.installButton.disabled = true;
      elements.installButton.textContent = "更新中…";
    }
    if (elements.laterButton) elements.laterButton.disabled = true;
    if (elements.checkButton) elements.checkButton.disabled = true;
    setProgress(null, "正在准备下载…");

    try {
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength ?? 0;
          setProgress(contentLength > 0 ? 0 : null, "开始下载更新…");
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          const percent = contentLength > 0 ? (downloadedBytes / contentLength) * 100 : null;
          const downloadedMb = (downloadedBytes / 1024 / 1024).toFixed(1);
          const totalText = contentLength > 0 ? ` / ${(contentLength / 1024 / 1024).toFixed(1)} MB` : " MB";
          setProgress(percent, `已下载 ${downloadedMb}${totalText}`);
        } else {
          setProgress(100, "下载完成，正在安装…");
        }
      }, { timeout: DOWNLOAD_TIMEOUT_MS });
      if (elements.status) elements.status.textContent = "更新安装完成";
      setProgress(100, "正在重新启动应用…");
      await relaunch();
    } catch (error) {
      installing = false;
      if (elements.status) elements.status.textContent = "更新失败";
      showError(`安装失败：${errorMessage(error)}`);
      if (elements.installButton) {
        elements.installButton.disabled = false;
        elements.installButton.textContent = "重试";
      }
      if (elements.laterButton) {
        elements.laterButton.disabled = false;
        elements.laterButton.textContent = "关闭";
      }
      if (elements.checkButton) elements.checkButton.disabled = false;
    }
  };

  elements.checkButton?.addEventListener("click", () => void checkForUpdate(true));
  elements.laterButton?.addEventListener("click", () => void closeDialog());
  elements.installButton?.addEventListener("click", () => void installUpdate());
  elements.overlay?.addEventListener("click", (event) => {
    if (event.target === elements.overlay) void closeDialog();
  });

  window.setTimeout(() => void checkForUpdate(false), AUTO_CHECK_DELAY_MS);
}
