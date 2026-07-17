import { getCurrentWindow } from "@tauri-apps/api/window";

export async function bindFileDropEvents(
  dropTarget: HTMLElement | null,
  onDrop: (paths: string[]) => void | Promise<void>,
) {
  const appWindow = getCurrentWindow();
  return appWindow.onDragDropEvent(({ payload }) => {
    if (payload.type === "enter" || payload.type === "over") {
      dropTarget?.classList.add("file-drag-active");
      return;
    }

    dropTarget?.classList.remove("file-drag-active");
    if (payload.type === "drop") {
      void onDrop(payload.paths);
    }
  });
}
