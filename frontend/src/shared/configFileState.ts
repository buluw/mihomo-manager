const SELECTED_CONFIG_KEY = "mihomo-selected-config-file";

function read(key: string) {
  try {
    return localStorage.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Selection identity remains optional when browser storage is unavailable.
  }
}

export function configFileState() {
  return {
    selectedName: read(SELECTED_CONFIG_KEY),
  };
}

export function setSelectedConfigFile(name: string | null) {
  write(SELECTED_CONFIG_KEY, name);
}
