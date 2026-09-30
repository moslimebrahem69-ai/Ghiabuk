// تثبيت المنصة كتطبيق على الموبايل (PWA)
(function () {
  const DISMISS_KEY = "ghiyabak_install_dismissed";
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installBtn = document.getElementById("installBtn");
  let deferred = null;
  let banner = null;

  if ("serviceWorker" in navigator) {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  if (standalone) return;

  const dismissed = () => { try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; } };

  function hideBanner() { banner?.remove(); banner = null; }

  function showBanner(ios) {
    if (banner || dismissed()) return;
    banner = document.createElement("div");
    banner.className = "install-banner";
    banner.setAttribute("role", "dialog");
    banner.innerHTML = `
      <img src="icons/icon-96.png" alt="" width="44" height="44">
      <div class="ib-text">
        <b>ثبّت غيابك على موبايلك</b>
        <span>${ios
          ? 'اضغط زرار المشاركة <svg class="ic" viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg> وبعدين «إضافة إلى الشاشة الرئيسية»'
          : "افتحه زي أي تطبيق، من غير متصفح"}</span>
      </div>
      ${ios ? "" : '<button class="btn sm" type="button" data-install>تثبيت</button>'}
      <button class="ib-close" type="button" aria-label="إغلاق">✕</button>`;
    banner.querySelector("[data-install]")?.addEventListener("click", install);
    banner.querySelector(".ib-close").addEventListener("click", () => {
      try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
      hideBanner();
    });
    document.body.appendChild(banner);
  }

  async function install() {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    if (installBtn) installBtn.hidden = true;
    hideBanner();
  }

  addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferred = e;
    if (installBtn) installBtn.hidden = false;
    showBanner(false);
  });
  installBtn?.addEventListener("click", install);
  addEventListener("appinstalled", () => {
    if (installBtn) installBtn.hidden = true;
    hideBanner();
  });

  // آيفون: مفيش زرار تثبيت تلقائي، فبنشرح الطريقة
  if (isIOS) addEventListener("load", () => setTimeout(() => showBanner(true), 1200));
})();
