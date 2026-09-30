import { useSyncExternalStore } from 'react';
import type { Product } from './types';

export type CartLine = { product: Product; quantity: number };

const STORAGE_KEY = 'paketshop_cart_v1';
export const MAX_PER_LINE = 100; // the orders API rejects larger quantities

export const maxQuantity = (p: Product) => Math.max(0, Math.min(Number(p.stock) || 0, MAX_PER_LINE));

function isLine(x: any): x is CartLine {
  return !!x && !!x.product && Number.isInteger(x.product.id) && Number.isInteger(x.quantity) && x.quantity > 0;
}

function load(): CartLine[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isLine) : [];
  } catch {
    return [];
  }
}

// Tiny external store so the shop and chat pages share one cart
let lines: CartLine[] = load();
const listeners = new Set<() => void>();

function commit(next: CartLine[]) {
  lines = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(lines)); } catch { /* storage may be blocked */ }
  listeners.forEach(l => l());
}

export const cartActions = {
  add(product: Product, quantity = 1) {
    const max = maxQuantity(product);
    if (max === 0) return;
    if (lines.some(l => l.product.id === product.id)) {
      commit(lines.map(l => l.product.id === product.id
        ? { product, quantity: Math.min(l.quantity + quantity, max) }
        : l));
    } else {
      commit([...lines, { product, quantity: Math.min(quantity, max) }]);
    }
  },
  setQuantity(productId: number, quantity: number) {
    if (quantity <= 0) {
      commit(lines.filter(l => l.product.id !== productId));
      return;
    }
    commit(lines.map(l => l.product.id === productId
      ? { ...l, quantity: Math.min(quantity, maxQuantity(l.product)) }
      : l));
  },
  remove(productId: number) {
    commit(lines.filter(l => l.product.id !== productId));
  },
  clear() {
    commit([]);
  },
  // Refresh saved prices/stock from the live catalog; drop items that were removed or sold out
  sync(products: Product[]) {
    const byId = new Map(products.map(p => [p.id, p]));
    const next = lines.flatMap(l => {
      const fresh = byId.get(l.product.id);
      const max = fresh ? maxQuantity(fresh) : 0;
      return fresh && max > 0 ? [{ product: fresh, quantity: Math.min(l.quantity, max) }] : [];
    });
    if (JSON.stringify(next) !== JSON.stringify(lines)) commit(next);
  },
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCart() {
  const current = useSyncExternalStore(subscribe, () => lines, () => lines);
  const count = current.reduce((n, l) => n + l.quantity, 0);
  const total = current.reduce((sum, l) => sum + Number(l.product.price) * l.quantity, 0);
  return { lines: current, count, total };
}
