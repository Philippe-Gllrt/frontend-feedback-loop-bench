// Injected into every page the side-by-side viewer serves (the trial's files are not changed).
// Reports the scroll position to the viewer, and scrolls when the viewer asks, so that both
// screens can scroll together.
(function () {
  if (window.parent === window) return;
  // No scrollbar: it would take ~15 px, and the page would be laid out narrower than the device.
  var style = document.createElement("style");
  style.textContent = "html{scrollbar-width:none}html::-webkit-scrollbar{display:none}";
  document.documentElement.appendChild(style);
  var applying = false, pending = false;
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.type !== "sbs-scroll-to") return;
    applying = true;
    window.scrollTo(d.x, d.y);
    setTimeout(function () { applying = false; }, 50);
  });
  window.addEventListener("scroll", function () {
    if (applying || pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      window.parent.postMessage({ type: "sbs-scroll", x: window.scrollX, y: window.scrollY }, "*");
    });
  }, { passive: true });
})();
