import { lstat } from "node:fs/promises";
import type { ProviderCategory } from "./collectionYaml.js";
import { providerFileNameKey, providerFilePath, readControlledFile, sameFileIdentity } from "./controlledFiles.js";
import { ProviderFileExistsError } from "./errors.js";
import type { ProviderOperationContext } from "./operationJournal.js";
import type { LocalProviderExtraction } from "./types.js";
import type { PublicSubscription } from "../subscriptions/types.js";

export function reservesProviderIdentity(item: Pick<PublicSubscription, "extractProvider" | "providerName" | "providerSha256">) {
  return Boolean(item.providerName && (item.extractProvider || item.providerSha256));
}

type SubscriptionReservation = Pick<PublicSubscription, "id" | "extractProvider" | "providerName" | "providerSha256">;
export interface ProviderNameContext extends Pick<ProviderOperationContext, "directory" | "maxContentBytes"> {
  readonly subscriptions: readonly SubscriptionReservation[];
  owner: {
    readonly current: Pick<ProviderOperationContext["owner"]["current"], "manual" | "local">;
  };
}

export function manualEntries(manual: ReadonlyArray<{ fileName: string; category: ProviderCategory }>, fileName: string, category?: ProviderCategory) {
  const key = providerFileNameKey(fileName);
  return manual.filter((entry) => providerFileNameKey(entry.fileName) === key && (!category || entry.category === category));
}

export function subscriptionReservations<T extends SubscriptionReservation>(subscriptions: readonly T[], fileName: string) {
  const key = providerFileNameKey(fileName);
  return subscriptions.filter((item) =>
    reservesProviderIdentity(item) &&
    providerFileNameKey(`${item.providerName}.yaml`) === key);
}

export function localReservations(local: readonly LocalProviderExtraction[], fileName: string) {
  const key = providerFileNameKey(fileName);
  return local.filter((entry) => providerFileNameKey(entry.fileName) === key);
}

export async function assertRenameTargetAvailable(context: ProviderNameContext, subscriptionId: string | null, fileName: string, sourceFileName?: string, category: ProviderCategory = "proxy") {
  const path = providerFilePath(context.directory, fileName);
  const sameKeyRename = sourceFileName !== undefined && sourceFileName !== fileName &&
    providerFileNameKey(sourceFileName) === providerFileNameKey(fileName);
  const manual = manualEntries(context.owner.current.manual, fileName, category);
  const currentManualAlias = sameKeyRename && subscriptionId === null && manual.length === 1 &&
    manual[0]?.fileName === sourceFileName;
  if (manual.length > 0 && !currentManualAlias) {
    throw new ProviderFileExistsError("provider file name is unavailable");
  }
  if (category === "proxy" && subscriptionReservations(context.subscriptions, fileName).some((item) => item.id !== subscriptionId)) {
    throw new ProviderFileExistsError("provider file name is unavailable");
  }
  if (category === "proxy" && localReservations(context.owner.current.local, fileName).some((item) => item.id !== subscriptionId)) {
    throw new ProviderFileExistsError("provider file name is unavailable");
  }
  try {
    await lstat(path);
    if (sameKeyRename) {
      const source = await readControlledFile(providerFilePath(context.directory, sourceFileName), context.maxContentBytes);
      const target = await readControlledFile(path, context.maxContentBytes);
      if (source && target && sameFileIdentity(source, target)) return;
    }
    throw new ProviderFileExistsError("provider file already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
