// Daily refresh of products and knowledge from paketshop.uz (called by Vercel Cron), so quoted prices never go stale.
// It only applies changes when the read looks sane; anything suspicious is reported to the managers instead.

import type { Sql } from './db.js';
import { applyCatalogSync, planCatalogSync, readSite, type Embedder, type SiteData, type SyncPlan } from './catalog.js';
import { sendToAdmins } from './notify.js';
import { recordEvent } from './events.js';

export type ScheduledSyncDeps = {
  embed: Embedder;
  readSite?: () => Promise<SiteData>;          // injectable for tests
  notify?: (text: string) => Promise<void>;    // injectable for tests
};

export type ScheduledSyncResult =
  | { status: 'unchanged' }
  | { status: 'applied'; summary: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

// Never delete more than this share of the imported catalog in one automatic run (a half-loaded site must not wipe products)
const MAX_DEACTIVATE_SHARE = 0.3;

function describeChanges(plan: SyncPlan): string {
  const lines = [`🔄 paketshop.uz katalogi yangilandi: yangi ${plan.newProducts.length}, narx/holat o'zgargan ${plan.changed.length}, yashirilgan ${plan.deactivate.length}${plan.contentChanged ? `, tavsif/rasm o'zgargan ${plan.contentChanged}` : ''}.`];
  if (plan.changed.length) lines.push('', ...plan.changed.slice(0, 10).map(c => `• ${c.sku}: ${c.changes.join(', ')}`));
  if (plan.newProducts.length) lines.push('', 'Yangi:', ...plan.newProducts.slice(0, 5).map(n => `• ${n}`));
  if (plan.deactivate.length) lines.push('', 'Saytdan olib tashlangan (yashirildi):', ...plan.deactivate.slice(0, 5).map(d => `• ${d.name}`));
  return lines.join('\n').slice(0, 3800);
}

export async function runScheduledSync(db: Sql, deps: ScheduledSyncDeps): Promise<ScheduledSyncResult> {
  const notify = deps.notify ?? ((text: string) => sendToAdmins(text, false));
  const skip = async (reason: string): Promise<ScheduledSyncResult> => {
    await recordEvent('catalog_auto_sync_skipped', reason);
    await notify(`⚠️ Avtomatik sinxronlash bajarilmadi: ${reason}\nTekshirish uchun botga /sync yuboring.`);
    return { status: 'skipped', reason };
  };

  try {
    const site = await (deps.readSite ?? readSite)();
    const plan = await planCatalogSync(db, site);

    if (plan.firstSync) return await skip("birinchi sinxronlashni qo'lda bajaring (/sync apply): u eski mahsulotlarni yashiradi");
    if (plan.problems.length) return await skip(plan.problems.join('; '));
    const limit = Math.max(3, Math.ceil(plan.existingSiteProducts * MAX_DEACTIVATE_SHARE));
    if (plan.deactivate.length > limit) {
      return await skip(`saytdan ${plan.deactivate.length} ta mahsulot yo'qolgandek ko'rinyapti (chegara ${limit}), bu xato bo'lishi mumkin`);
    }

    if (!plan.needsWrite) {
      await recordEvent('catalog_auto_checked', `no changes (${site.products.length} products)`);   // proof that the daily run happened
      return { status: 'unchanged' };
    }

    const result = await applyCatalogSync(db, plan, deps.embed);
    await recordEvent('catalog_auto_synced', JSON.stringify(result));

    const visible = plan.newProducts.length + plan.changed.length + plan.deactivate.length + plan.contentChanged > 0;
    const summary = describeChanges(plan);
    if (visible) await notify(summary);
    return { status: 'applied', summary };
  } catch (err) {
    const error = String((err as any)?.message || err).slice(0, 300);
    await recordEvent('catalog_auto_sync_failed', error);
    await notify(`⚠️ Avtomatik sinxronlashda xatolik: ${error}\nQo'lda urinib ko'rish: /sync`);
    return { status: 'failed', error };
  }
}
