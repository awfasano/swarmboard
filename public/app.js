// Renders math with KaTeX and keeps [data-live] regions fresh while a project
// changes. Loaded with `defer`, after KaTeX, so the DOM is ready.
(() => {
  const renderMath = root => {
    if (!window.renderMathInElement) return;
    (root || document).querySelectorAll(".prose").forEach(el =>
      renderMathInElement(el, {
        delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }],
        throwOnError: false,
      }));
  };
  renderMath();

  const slug = document.body.dataset.project;
  if (!slug) return;
  const es = new EventSource(`/p/${encodeURIComponent(slug)}/live`);
  let busy = false;
  es.addEventListener("change", async () => {
    if (busy) return;
    busy = true;
    try {
      const doc = new DOMParser().parseFromString(await (await fetch(location.href)).text(), "text/html");
      document.querySelectorAll("[data-live]").forEach(el => {
        const fresh = doc.getElementById(el.id);
        if (fresh) {
          el.replaceWith(fresh);
          renderMath(fresh.parentNode);
        }
      });
    } finally {
      busy = false;
    }
  });
})();
