import type {
  ProxyAddresses,
  ProxyMergeGroup,
  ProxyMergeSettings,
  ProxyNodeIdentity,
} from "@/api/configClient";
import type { Json } from "@/shared/types";

export type AvailableProxyNode = ProxyNodeIdentity & {
  protocol: string;
};

type ProxyMergeCrypto = {
  randomUUID?: () => string;
  getRandomValues: (array: Uint8Array) => Uint8Array;
};

export function createProxyMergeGroupId(
  cryptoSource: ProxyMergeCrypto = globalThis.crypto as ProxyMergeCrypto,
) {
  try {
    if (typeof cryptoSource.randomUUID === "function") return cryptoSource.randomUUID();
  } catch {
    // Some non-secure browser contexts expose the method but reject calls.
  }
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function proxyIdentityKey(identity: ProxyNodeIdentity) {
  return `${identity.provider}\u0000${identity.name}`;
}

export function cloneMergeSettings(settings: ProxyMergeSettings): ProxyMergeSettings {
  return structuredClone(settings);
}

export const beginProxyMergeDraft = cloneMergeSettings;

export async function persistProxyMergeDraft(
  draft: ProxyMergeSettings,
  save: (value: ProxyMergeSettings) => Promise<ProxyMergeSettings>,
) {
  return save(draft);
}

export function persistLoadedProxyMergeDraft(
  draft: ProxyMergeSettings,
  sessionLoaded: boolean,
  saving: boolean,
  save: (value: ProxyMergeSettings) => Promise<ProxyMergeSettings>,
) {
  if (!sessionLoaded || saving) return Promise.resolve(null);
  return persistProxyMergeDraft(draft, save);
}

export function availableProxyNodes(
  proxyMap: Record<string, Json>,
  providerByNode: Record<string, string>,
) {
  const names = new Set<string>();
  Object.values(proxyMap).forEach((entry) => {
    if (!Array.isArray(entry.all)) return;
    entry.all.forEach((name) => names.add(String(name)));
  });
  return [...names]
    .filter((name) => isSelectableProxyNode(proxyMap[name]))
    .map((name) => ({
      provider: providerByNode[name] || "",
      name,
      protocol: String(proxyMap[name]?.type || "未知"),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

const REAL_PROXY_ADAPTER_TYPES = new Set([
  "shadowsocks",
  "shadowsocksr",
  "snell",
  "socks5",
  "http",
  "vmess",
  "vless",
  "trojan",
  "hysteria",
  "hysteria2",
  "wireguard",
  "tuic",
  "ssh",
  "mieru",
  "anytls",
  "sudoku",
  "masque",
  "trusttunnel",
  "openvpn",
  "tailscale",
  "gostrelay",
]);

export function isSelectableProxyNode(entry: Json | undefined) {
  if (!entry || Array.isArray(entry.all)) return false;
  const type = String(entry.type || "").replace(/[^a-z\d]/gi, "").toLowerCase();
  return REAL_PROXY_ADAPTER_TYPES.has(type);
}

export function assignedIdentityKeys(settings: ProxyMergeSettings) {
  return new Set(settings.groups.flatMap((group) => group.members.map(proxyIdentityKey)));
}

export function createManualMergeGroup(
  settings: ProxyMergeSettings,
  id: string,
  displayName: string,
  members: ProxyNodeIdentity[],
) {
  const assigned = assignedIdentityKeys(settings);
  const uniqueMembers = members.filter((member, index) => (
    members.findIndex((candidate) => proxyIdentityKey(candidate) === proxyIdentityKey(member)) === index
    && !assigned.has(proxyIdentityKey(member))
  ));
  if (uniqueMembers.length < 2 || displayName.length > 120) return settings;
  const selected = new Set(uniqueMembers.map(proxyIdentityKey));
  return {
    ...settings,
    groups: [...settings.groups, {
      id,
      displayName: displayName.trim(),
      source: "manual" as const,
      members: uniqueMembers,
    }],
    exclusions: settings.exclusions.filter((entry) => !selected.has(proxyIdentityKey(entry))),
  };
}

export function renameMergeGroup(settings: ProxyMergeSettings, id: string, displayName: string) {
  return {
    ...settings,
    groups: settings.groups.map((group) => group.id === id ? { ...group, displayName } : group),
  };
}

export function addMergeGroupMembers(
  settings: ProxyMergeSettings,
  id: string,
  members: ProxyNodeIdentity[],
) {
  const assigned = assignedIdentityKeys(settings);
  const additions = members.filter((member) => {
    const key = proxyIdentityKey(member)
    if (assigned.has(key)) return false
    assigned.add(key)
    return true
  });
  const added = new Set(additions.map(proxyIdentityKey));
  return {
    ...settings,
    groups: settings.groups.map((group) => group.id === id
      ? { ...group, source: "manual" as const, members: [...group.members, ...additions] }
      : group),
    exclusions: settings.exclusions.filter((entry) => !added.has(proxyIdentityKey(entry))),
  };
}

export function removeMergeGroupMember(
  settings: ProxyMergeSettings,
  id: string,
  member: ProxyNodeIdentity,
) {
  return {
    ...settings,
    groups: settings.groups.flatMap((group) => {
      if (group.id !== id) return [group];
      const remaining = group.members.filter((entry) => proxyIdentityKey(entry) !== proxyIdentityKey(member));
      return remaining.length >= 2
        ? [{ ...group, source: "manual" as const, members: remaining }]
        : [];
    }),
  };
}

export function moveMergeGroupMember(
  settings: ProxyMergeSettings,
  member: ProxyNodeIdentity,
  targetGroupId: string,
  targetIndex?: number,
) {
  const key = proxyIdentityKey(member);
  const target = settings.groups.find((group) => group.id === targetGroupId);
  if (!target) return settings;
  const source = settings.groups.find((group) => group.members.some((entry) => proxyIdentityKey(entry) === key));
  if (source?.id === targetGroupId) {
    const from = source.members.findIndex((entry) => proxyIdentityKey(entry) === key);
    const without = source.members.filter((entry) => proxyIdentityKey(entry) !== key);
    const requested = targetIndex ?? without.length;
    const index = Math.max(0, Math.min(requested > from ? requested - 1 : requested, without.length));
    const members = [...without.slice(0, index), member, ...without.slice(index)];
    if (members.every((entry, position) => proxyIdentityKey(entry) === proxyIdentityKey(source.members[position]!))) return settings;
    return {
      ...settings,
      groups: settings.groups.map((group) => group.id === source.id
        ? { ...group, source: "manual" as const, members }
        : group),
    };
  }
  if (target.members.some((entry) => proxyIdentityKey(entry) === key)) return settings;
  const groups = settings.groups.flatMap((group) => {
    if (group.id === source?.id) {
      const remaining = group.members.filter((entry) => proxyIdentityKey(entry) !== key);
      return remaining.length >= 2
        ? [{ ...group, source: "manual" as const, members: remaining }]
        : [];
    }
    if (group.id === targetGroupId) {
      const index = Math.max(0, Math.min(targetIndex ?? group.members.length, group.members.length));
      return [{
        ...group,
        source: "manual" as const,
        members: [...group.members.slice(0, index), member, ...group.members.slice(index)],
      }];
    }
    return [group];
  });
  return {
    ...settings,
    groups,
    exclusions: settings.exclusions.filter((entry) => proxyIdentityKey(entry) !== key),
  };
}

export interface ProxyMergeDragSession {
  original: ProxyMergeSettings;
  base: ProxyMergeSettings;
  preview: ProxyMergeSettings;
  member: ProxyNodeIdentity | null;
  draggedGroup: ProxyMergeGroup | null;
  sourceGroup: ProxyMergeGroup | null;
  valid: boolean;
  overKey: string | null;
}

export function beginProxyMergeDrag(
  settings: ProxyMergeSettings,
  member: ProxyNodeIdentity,
): ProxyMergeDragSession {
  const key = proxyIdentityKey(member)
  const sourceGroup = settings.groups.find((group) => (
    group.members.some((entry) => proxyIdentityKey(entry) === key)
  )) ?? null
  const groups = sourceGroup
    ? settings.groups.map((group) => {
        if (group.id !== sourceGroup.id) return group
        const remaining = group.members.filter((entry) => proxyIdentityKey(entry) !== key)
        return { ...group, members: remaining }
      })
    : settings.groups
  const base = groups === settings.groups ? settings : { ...settings, groups }
  return {
    original: settings,
    base,
    preview: base,
    member,
    draggedGroup: null,
    sourceGroup,
    valid: false,
    overKey: null,
  }
}

export function beginProxyMergeGroupDrag(
  settings: ProxyMergeSettings,
  groupId: string,
): ProxyMergeDragSession | null {
  const draggedGroup = settings.groups.find((group) => group.id === groupId)
  if (!draggedGroup) return null
  const base = { ...settings, groups: settings.groups.filter((group) => group.id !== groupId) }
  return {
    original: settings,
    base,
    preview: base,
    member: null,
    draggedGroup,
    sourceGroup: null,
    valid: false,
    overKey: null,
  }
}

function resetProxyMergeDragPreview(session: ProxyMergeDragSession) {
  if (!session.valid && session.preview === session.base && session.overKey === null) return session
  return { ...session, preview: session.base, valid: false, overKey: null }
}

export function previewProxyMergeDrag(
  session: ProxyMergeDragSession,
  targetGroupId: string | null,
  targetIndex?: number,
  targetMember?: ProxyNodeIdentity,
): ProxyMergeDragSession {
  if (!targetGroupId || !session.member || session.draggedGroup) {
    return resetProxyMergeDragPreview(session)
  }
  const member = session.member
  let target = session.base.groups.find((group) => group.id === targetGroupId)
  let base = session.base
  if (!target && session.sourceGroup?.id === targetGroupId) {
    const key = proxyIdentityKey(member)
    target = {
      ...session.sourceGroup,
      members: session.sourceGroup.members.filter((member) => proxyIdentityKey(member) !== key),
    }
    base = { ...base, groups: [...base.groups, target] }
  }
  if (!target) return resetProxyMergeDragPreview(session)
  const stableTargetIndex = targetMember
    ? target.members.findIndex((member) => proxyIdentityKey(member) === proxyIdentityKey(targetMember))
    : -1
  const requestedIndex = stableTargetIndex >= 0 ? stableTargetIndex : targetIndex
  const index = Math.max(0, Math.min(requestedIndex ?? target.members.length, target.members.length))
  const overKey = `group:${targetGroupId}:${index}`
  if (session.valid && session.overKey === overKey) return session
  const members = [...target.members.slice(0, index), member, ...target.members.slice(index)]
  if (members.length < 2) return resetProxyMergeDragPreview(session)
  return {
    ...session,
    preview: {
      ...base,
      groups: base.groups.map((group) => group.id === targetGroupId
        ? { ...group, source: "manual" as const, members }
        : group),
      exclusions: base.exclusions.filter((entry) => proxyIdentityKey(entry) !== proxyIdentityKey(member)),
    },
    valid: true,
    overKey,
  }
}

export function previewProxyMergeDragToUnmerged(
  session: ProxyMergeDragSession,
): ProxyMergeDragSession {
  if (session.overKey === "unmerged" && session.valid) return session
  if (session.draggedGroup || session.sourceGroup) {
    return { ...session, preview: session.base, valid: true, overKey: "unmerged" }
  }
  return resetProxyMergeDragPreview(session)
}

export function cancelProxyMergeDrag(session: ProxyMergeDragSession) {
  return session.original
}

export function endProxyMergeDrag(session: ProxyMergeDragSession) {
  if (!session.valid) return session.original
  if (session.draggedGroup) return session.preview
  if (!session.sourceGroup) return session.preview
  return {
    ...session.preview,
    groups: session.preview.groups.filter((group) => (
      group.id !== session.sourceGroup?.id || group.members.length >= 2
    )),
  }
}

export function splitMergeGroup(settings: ProxyMergeSettings, id: string) {
  if (!settings.groups.some((entry) => entry.id === id)) return settings;
  return {
    ...settings,
    groups: settings.groups.filter((entry) => entry.id !== id),
  };
}

function autoCandidates(addresses: ProxyAddresses) {
  return Object.entries(addresses.groups).flatMap(([provider, groups]) => groups.flatMap((group) => {
    const displayName = group.suffix.trim()
    const seen = new Set<string>()
    const members = group.members.flatMap(({ name }) => {
      const member = { provider, name }
      const key = proxyIdentityKey(member)
      if (!validProxyIdentity(member) || seen.has(key)) return []
      seen.add(key)
      return [member]
    })
    return displayName && displayName.length <= 120 && members.length >= 2
      ? [{ provider, displayName, members: members.slice(0, 256) }]
      : []
  }));
}

function validProxyIdentity(identity: ProxyNodeIdentity) {
  return identity.provider.length <= 256
    && Boolean(identity.name.trim())
    && identity.name.length <= 256
}

function validExistingMergeGroups(groups: ProxyMergeGroup[]) {
  if (groups.length > 512) return false
  const ids = new Set<string>()
  const assigned = new Set<string>()
  for (const group of groups) {
    if (
      !group.id
      || group.id.length > 128
      || ids.has(group.id)
      || group.displayName.length > 120
      || (group.source !== "manual" && group.source !== "automatic")
      || group.members.length < 2
      || group.members.length > 256
    ) return false
    ids.add(group.id)
    for (const member of group.members) {
      const key = proxyIdentityKey(member)
      if (!validProxyIdentity(member) || assigned.has(key)) return false
      assigned.add(key)
    }
  }
  return true
}

export function suggestMergeName(members: ProxyNodeIdentity[], addresses: ProxyAddresses) {
  const keys = new Set(members.map(proxyIdentityKey));
  return autoCandidates(addresses).find((candidate) => (
    members.length >= 2
    && candidate.members.every((member) => keys.has(proxyIdentityKey(member)))
    && members.every((member) => candidate.members.some((candidateMember) => (
      proxyIdentityKey(candidateMember) === proxyIdentityKey(member)
    )))
  ))?.displayName || "";
}

export function applyAutomaticRecognition(
  settings: ProxyMergeSettings,
  addresses: ProxyAddresses,
  available: AvailableProxyNode[],
  createId: () => string,
) {
  if (!validExistingMergeGroups(settings.groups)) return settings
  const availableKeys = new Set(available.map(proxyIdentityKey));
  let groups = settings.groups;
  for (const candidate of autoCandidates(addresses)) {
    const candidateKeys = new Set(candidate.members.map(proxyIdentityKey));
    const matches = groups.filter((group) => (
      group.members.length >= 2
      && group.members.every((member) => candidateKeys.has(proxyIdentityKey(member)))
    ));
    const owners = new Map(groups.flatMap((group) => (
      group.members.map((member) => [proxyIdentityKey(member), group.id] as const)
    )));
    if (matches.length === 1) {
      const match = matches[0]!;
      const existing = new Set(match.members.map(proxyIdentityKey));
      const additions = candidate.members.filter((member) => {
        const key = proxyIdentityKey(member);
        return availableKeys.has(key)
          && !existing.has(key)
          && !owners.has(key);
      }).slice(0, 256 - match.members.length);
      if (additions.length) {
        groups = groups.map((group) => group.id === match.id
          ? { ...group, members: [...group.members, ...additions] }
          : group);
      }
      continue;
    }
    if (matches.length > 1) continue;
    const members = candidate.members.filter((member) => {
      const key = proxyIdentityKey(member);
      return availableKeys.has(key) && !owners.has(key);
    });
    if (members.length < 2 || groups.length >= 512) continue;
    const id = createId();
    if (!id || id.length > 128 || groups.some((group) => group.id === id)) continue;
    groups = [...groups, { id, displayName: candidate.displayName, source: "automatic", members }];
  }
  const assigned = assignedIdentityKeys({ ...settings, groups });
  const exclusionKeys = new Set<string>();
  const exclusions = settings.exclusions.filter((entry) => {
    const key = proxyIdentityKey(entry);
    if (assigned.has(key) || exclusionKeys.has(key)) return false;
    exclusionKeys.add(key);
    return true;
  });
  const exclusionsChanged = exclusions.length !== settings.exclusions.length
    || exclusions.some((entry, index) => entry !== settings.exclusions[index]);
  return groups === settings.groups && !exclusionsChanged ? settings : { ...settings, groups, exclusions };
}

export function automaticRecognitionFeedback(before: ProxyMergeSettings, after: ProxyMergeSettings, addresses: ProxyAddresses, available: AvailableProxyNode[]) {
  const readable = available.filter((node) => node.provider
    ? addresses.providers[node.provider]?.[node.name]
    : addresses.inline[node.name]).length;
  if (!readable) return "没有读到当前节点的可用地址，请核对配置来源和集合文件";
  const addedGroups = after.groups.length - before.groups.length;
  const addedMembers = after.groups.reduce((count, group) => count + group.members.length, 0)
    - before.groups.reduce((count, group) => count + group.members.length, 0);
  if (addedMembers > 0) return `已读取 ${readable} 个节点地址，新增 ${addedGroups} 组、加入 ${addedMembers} 个节点；保存后生效`;
  const availableKeys = new Set(available.map(proxyIdentityKey));
  const candidates = autoCandidates(addresses).filter((candidate) => candidate.members.filter((member) => availableKeys.has(proxyIdentityKey(member))).length >= 2).length;
  return candidates
    ? `已读取 ${readable} 个节点地址，发现 ${candidates} 组候选；节点已合并或受已有人工分组约束，没有新增成员`
    : `已读取 ${readable} 个节点地址，没有符合自动合并条件的候选组`;
}

export function mergeGroupAvailability(group: ProxyMergeGroup, available: AvailableProxyNode[]) {
  const availableKeys = new Set(available.map(proxyIdentityKey));
  return group.members.map((member, index) => ({
    ...member,
    index,
    available: availableKeys.has(proxyIdentityKey(member)),
  }));
}

// This is a display projection; the full settings remain the edit/save source.
export function proxyMergeGroupsForDisplay(settings: ProxyMergeSettings, available: AvailableProxyNode[] | null) {
  const current: ProxyMergeGroup[] = [];
  const absent: ProxyMergeGroup[] = [];
  const keys = available && new Set(available.map(proxyIdentityKey));
  for (const group of settings.groups) {
    (keys && !group.members.some((member) => keys.has(proxyIdentityKey(member))) ? absent : current).push(group);
  }
  return { current, absent };
}
