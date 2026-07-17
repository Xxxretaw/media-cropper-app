export type ExportNamingItem = {
  id: string;
  materialName: string;
};

const MEDIA_EXTENSION_PATTERN = /\.(?:jpe?g|png|bmp|tiff?|mp4|mov|m4v|mkv|avi)$/i;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeMaterialName(value: string) {
  let normalized = value
    .normalize("NFKC")
    .trim()
    .replace(MEDIA_EXTENSION_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/^-+|-+$/g, "")
    .replace(/[. ]+$/g, "")
    .slice(0, 80)
    .trim()
    .replace(/[. ]+$/g, "");

  if (WINDOWS_RESERVED_NAME_PATTERN.test(normalized)) {
    normalized = `_${normalized}`;
  }
  return normalized;
}

function materialNameKey(value: string) {
  return sanitizeMaterialName(value).toLocaleLowerCase("en-US");
}

export function buildExportBaseNames(items: readonly ExportNamingItem[]) {
  const names = items.map((item) => sanitizeMaterialName(item.materialName));
  const counts = new Map<string, number>();
  for (const name of names) {
    const key = materialNameKey(name);
    if (key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const positions = new Map<string, number>();
  const result = new Map<string, string>();
  items.forEach((item, index) => {
    const name = names[index];
    const key = materialNameKey(name);
    if (!key) {
      result.set(item.id, "");
      return;
    }

    if ((counts.get(key) ?? 0) === 1) {
      result.set(item.id, name);
      return;
    }

    const position = (positions.get(key) ?? 0) + 1;
    positions.set(key, position);
    result.set(item.id, `${name}_${String(position).padStart(3, "0")}`);
  });
  return result;
}

export function buildExportFileName(
  items: readonly ExportNamingItem[],
  itemId: string,
  extension: string,
) {
  const baseName = buildExportBaseNames(items).get(itemId) ?? "";
  const safeExtension = extension.replace(/^\.+/, "").toLowerCase();
  return baseName && safeExtension ? `${baseName}.${safeExtension}` : "";
}
