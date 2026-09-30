export type Product = {
  id: number;
  name: string;
  description: string | null;
  price: string | number;
  category: string | null;
  stock: number;
  image_url: string | null;
};

export type BrandConfig = {
  shopName: string;
  assistantName: string;
  greeting: string;
  brandColor: string;
  currency: string;
};

export const DEFAULT_BRAND: BrandConfig = {
  shopName: "Paketshop.uz",
  assistantName: "Malika",
  greeting: "Salom! Sizga qanday yordam bera olaman?",
  brandColor: "amber",
  currency: "so'm",
};
