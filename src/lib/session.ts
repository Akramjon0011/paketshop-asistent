// Anonymous per-browser id used to link chat history, saved customer details and orders.
// Same storage key the chat page has always used, so existing visitors keep their history.
let memo: string | null = null;

export function getWebSessionId(): string {
  if (memo) return memo;
  let id: string | null = null;
  try { id = localStorage.getItem('webSessionId'); } catch { /* storage blocked in some webviews */ }
  if (!id) {
    id = 'session_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now();
    try { localStorage.setItem('webSessionId', id); } catch { /* ignore */ }
  }
  memo = id;
  return id;
}
