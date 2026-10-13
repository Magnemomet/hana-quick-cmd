// assets/theme-boot.js — 初始主题引导（普通脚本，在页面 <head> 里同步执行）
//
// 宿主只在主题「变化」时推送、不推初始值，所以页面必须自己从 hana-css 加载一次。
// 校验逻辑与宿主约定一致：只接受同源、路径恰好是 /api/apps/theme.css、且带 theme 参数的地址。
(function () {
  try {
    var advertisedUrl = new URLSearchParams(window.location.search).get("hana-css");
    if (!advertisedUrl) return;
    var stylesheetUrl = new URL(advertisedUrl, window.location.href);
    if (
      stylesheetUrl.origin !== window.location.origin ||
      (stylesheetUrl.protocol !== "http:" && stylesheetUrl.protocol !== "https:") ||
      stylesheetUrl.pathname !== "/api/apps/theme.css" ||
      !stylesheetUrl.searchParams.get("theme") ||
      stylesheetUrl.username ||
      stylesheetUrl.password ||
      stylesheetUrl.hash
    ) {
      throw new Error("invalid Hana theme stylesheet URL");
    }
    var link = document.createElement("link");
    link.id = "qc-theme-css";
    link.rel = "stylesheet";
    link.href = stylesheetUrl.href;
    document.head.appendChild(link);
  } catch (error) {
    console.warn("[quick-cmd] 无法加载 Hana 主题样式", error);
  }
})();
