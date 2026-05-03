"use client";

/** Re-export the SDK's folder-backed draft helpers under the legacy
 *  apps/pay path so existing imports keep working. The actual
 *  persistence lives in `@zkscatter/sdk/storage` (see
 *  `wizardDrafts.ts`) — drafts are stored in the user's File
 *  System Access workspace folder rather than browser localStorage,
 *  so they follow the operator across machines and survive
 *  private-mode browsing. */

export {
  loadWizardDraft,
  loadAllWizardDrafts,
  saveWizardDraft,
  clearWizardDraft,
  type WizardDraft,
} from "@zkscatter/sdk/storage";
