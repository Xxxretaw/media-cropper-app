export type QueueThumbnailView = {
  active: boolean;
  disabled: boolean;
  previewSrc: string;
  fallbackLabel: string;
  name: string;
  detail: string;
  ratio: string;
  detectionLabel?: string;
  detectionStatus?: string;
};

function appendTextElement(parent: HTMLElement, className: string, text: string) {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

export function createQueueThumbnail(
  view: QueueThumbnailView,
  onSelect: () => void,
  onDelete: () => void,
) {
  const thumb = document.createElement("button");
  thumb.type = "button";
  thumb.disabled = view.disabled;
  thumb.className = `thumb${view.active ? " active" : ""}`;

  if (view.previewSrc) {
    const image = document.createElement("img");
    image.src = view.previewSrc;
    image.alt = "";
    thumb.appendChild(image);
  } else {
    appendTextElement(thumb, "thumb-fallback", view.fallbackLabel);
  }

  const meta = document.createElement("div");
  meta.className = "thumb-meta";
  appendTextElement(meta, "thumb-name", view.name);
  appendTextElement(meta, "thumb-info", view.detail);

  const footer = document.createElement("div");
  footer.className = "thumb-footer";
  const ratio = document.createElement("span");
  ratio.className = "thumb-ratio";
  ratio.textContent = view.ratio;
  footer.appendChild(ratio);

  if (view.detectionLabel && view.detectionStatus) {
    const detection = document.createElement("div");
    detection.className = `thumb-detection status-${view.detectionStatus}`;
    detection.textContent = view.detectionLabel;
    footer.appendChild(detection);
  }

  meta.appendChild(footer);
  thumb.appendChild(meta);

  const deleteButton = document.createElement("span");
  deleteButton.className = "thumb-delete";
  deleteButton.dataset.delete = "true";
  deleteButton.setAttribute("role", "button");
  deleteButton.setAttribute("aria-label", `移除 ${view.name}`);
  deleteButton.textContent = "×";
  thumb.appendChild(deleteButton);

  thumb.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-delete='true']")) {
      event.stopPropagation();
      onDelete();
      return;
    }
    onSelect();
  });

  return thumb;
}
