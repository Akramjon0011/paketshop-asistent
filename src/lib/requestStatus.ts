// Request statuses as the admin shows them. CRM_STATUS: the paketshop.uz CRM, worded as on the site's "Leadlar" page;
// LOCAL_STATUS: requests that never reached the site and are handled in this admin.
export const CRM_STATUS: Record<string, { label: string; tone: string }> = {
  NEW: { label: 'Yangi', tone: 'bg-blue-50 text-blue-700 border-blue-100' },
  CONTACTED: { label: "Bog'lanildi", tone: 'bg-amber-50 text-amber-700 border-amber-100' },
  IN_PROGRESS: { label: 'Jarayonda', tone: 'bg-purple-50 text-purple-700 border-purple-100' },
  WON: { label: 'Yutildi', tone: 'bg-green-50 text-green-700 border-green-100' },
  LOST: { label: "Yo'qotildi", tone: 'bg-red-50 text-red-700 border-red-100' },
};

export const LOCAL_STATUS: Record<string, string> = {
  pending: 'Kutilmoqda',
  processing: "Jo'natilmoqda",
  delivered: 'Yetkazildi',
  cancelled: 'Bekor qilindi',
};

export const SITE_ADMIN_URL = 'https://www.paketshop.uz/uz/admin';
