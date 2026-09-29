// Races `promise` against a `ms` deadline; rejects with `onTimeout()`'s error
// if the deadline wins first. The panel wraps chrome.scripting.executeScript
// with it, since that call has no deadline of its own (security review
// 2026-09-26, finding #2).
export function withDeadline(promise, ms, onTimeout) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
