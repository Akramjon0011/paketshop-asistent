// 10000 -> "10 000" (space as thousands separator, the usual way prices are written in Uzbek)
export const formatPrice = (n: number | string) => Number(n).toLocaleString('en-US').replace(/,/g, ' ');
