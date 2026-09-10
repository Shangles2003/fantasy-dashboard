// Keep a URL fragment (e.g. the ESPN extension hand-off) across the sign-in redirect.
// The fragment is never sent to the server; browsers carry it over to the redirect target.
(() => {
  if (!location.hash) return;
  const form = document.querySelector('form');
  if (form) form.action = form.getAttribute('action') + location.hash;
})();
