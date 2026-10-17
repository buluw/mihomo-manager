// 订阅地址供可信单用户前端读取和编辑，但不得进入日志或错误响应。
export interface Subscription {
  id: string;
  name: string;
  url: string;
  configFileName: string | null;
  extractProvider: boolean;
  providerName: string;
  providerNameMode: "follow" | "custom";
  providerSha256: string | null;
  mergeIntoConfig: boolean;
  configName: string;
  groupNames: string[];
  binding: SubscriptionBinding | null;
  autoUpdate: boolean;
  intervalMinutes: number;
  status: "idle" | "success" | "error";
  nodeCount: number;
  lastAttemptAt: string | null;
  lastUpdatedAt: string | null;
  nextUpdateAt: string | null;
  uploadBytes: number | null;
  downloadBytes: number | null;
  totalBytes: number | null;
  expiresAt: string | null;
  filterSettings: SubscriptionFilterSettings;
}

export interface SubscriptionFilterSettings {
  version: number;
  enabled: boolean;
  rules: string[];
}

export interface SubscriptionBinding {
  configName: string;
  providerName: string;
  providerPath: string;
  groupNames: string[];
  status: "pending-add" | "active" | "pending-remove";
}

export interface SubscriptionInput {
  name: string;
  url?: string;
  extractProvider?: boolean;
  providerName?: string;
  providerNameMode?: "follow" | "custom";
  mergeIntoConfig?: boolean;
  configName?: string;
  groupNames?: string[];
  autoUpdate: boolean;
  intervalMinutes: number;
}

export type PublicSubscription = Subscription & {
  urlConfigured: boolean;
};
