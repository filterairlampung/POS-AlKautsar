/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.0 — AUTENTIKASI, RBAC 5 PERAN, SWITCHER & PWA iOS
 * File: js/auth.js
 * ============================================================================
 */

window.POS_AUTH = (function () {
  "use strict";

  let currentSession = null;
  let pendingLoginSession = null;
  let activePageId = "page-home";
  let deferredInstallPrompt = null;
  let toastTimer = null;

  // ==========================================================================
  // 1. MANAJEMEN SESI (LOCAL STORAGE)
  // ==========================================================================

  function saveSession(sessionObj) {
    currentSession = sessionObj;
    if (sessionObj) {
      localStorage.setItem(window.POS_CONFIG.SESSION_STORAGE_KEY, JSON.stringify(sessionObj));
    } else {
      localStorage.removeItem(window.POS_CONFIG.SESSION_STORAGE_KEY);
    }
  }

  function loadStoredSession() {
    try {
      const raw = localStorage.getItem(window.POS_CONFIG.SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.token) return null;
      if (parsed.expiresAtMs && Date.now() > Number(parsed.expiresAtMs)) {
        localStorage.removeItem(window.POS_CONFIG.SESSION_STORAGE_KEY);
        return null;
      }
      return parsed;
    } catch (e) {
      localStorage.removeItem(window.POS_CONFIG.SESSION_STORAGE_KEY);
      return null;
    }
  }

  function getSession() {
    return currentSession;
  }

  function isAuthenticated() {
    return Boolean(currentSession && currentSession.token);
  }

  function canVoid() {
    if (!currentSession) return false;
    return window.POS_CONFIG.VOID_ALLOWED_ROLES.includes(currentSession.activeRole);
  }

  function getAllowedBranchesResolved(allowedCabangList) {
    const list = Array.isArray(allowedCabangList) ? allowedCabangList : [];
    if (list.includes("all")) {
      return ["korpri", "pringsewu", "all"];
    }
    return list.filter((cb) => Boolean(window.POS_CONFIG.BRANCHES[cb]));
  }

  // ==========================================================================
  // 2. TEMA DINAMIS OTOMATIS PER CABANG (KORPRI / PRINGSEWU / GABUNGAN)
  // ==========================================================================

  function applyBranchTheme(cabangId) {
    const cb = window.POS_CONFIG.BRANCHES[cabangId] ? cabangId : "korpri";
    const info = window.POS_CONFIG.BRANCHES[cb];

    document.body.setAttribute("data-branch", cb);

    // Perbarui warna status bar browser mobile (Chrome Android & Safari)
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute("content", info.themeColor);
    }

    // Perbarui label header sidebar & badge cabang
    const sidebarBranchEl = document.getElementById("sidebar-branch-label");
    if (sidebarBranchEl) {
      sidebarBranchEl.textContent = info.label;
    }

    const mobileBadgeEl = document.getElementById("topbar-branch-badge");
    if (mobileBadgeEl) {
      mobileBadgeEl.textContent = info.shortLabel;
    }
  }

  // ==========================================================================
  // 3. ALUR LOGIN 2 LANGKAH (KREDENSIAL -> PILIH PERAN & CABANG RESMI SERVER)
  // ==========================================================================

  function setLoginError(msg) {
    const el = document.getElementById("pesan-error");
    if (el) {
      el.textContent = msg || "";
      el.style.display = msg ? "block" : "none";
    }
  }

  function toggleLoginStep(step) {
    const step1 = document.getElementById("login-step-1");
    const step2 = document.getElementById("login-step-2");
    if (step1) step1.style.display = step === 1 ? "block" : "none";
    if (step2) step2.style.display = step === 2 ? "block" : "none";
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();
    setLoginError("");

    const usernameEl = document.getElementById("login-username");
    const passwordEl = document.getElementById("login-password");
    const btnEl = document.getElementById("btn-login-submit");

    const username = (usernameEl ? usernameEl.value : "").trim();
    const password = passwordEl ? passwordEl.value : "";

    if (!username || !password) {
      setLoginError("Username dan Password wajib diisi.");
      return;
    }

    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memverifikasi...';
    }

    const res = await window.POS_API.login({ username, password });

    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = '<i class="fas fa-sign-in-alt"></i> Masuk';
    }

    if (!res.sukses || !res.data) {
      setLoginError(res.pesan || "Login gagal. Periksa kembali username dan password.");
      return;
    }

    const sess = res.data;
    const allowedRoles = Array.isArray(sess.allowedRoles) ? sess.allowedRoles : [sess.activeRole];
    const resolvedBranches = getAllowedBranchesResolved(sess.allowedCabang);

    // Jika user hanya memiliki 1 peran & 1 cabang -> langsung masuk Dashboard
    if (allowedRoles.length <= 1 && resolvedBranches.length <= 1) {
      saveSession(sess);
      enterDashboard();
      return;
    }

    // Jika user memiliki >1 peran atau >1 cabang -> tampilkan Langkah 2 (Pilih Peran & Cabang)
    pendingLoginSession = sess;
    saveSession(sess); // Simpan sementara agar switchContext membawa token sah

    const greetEl = document.getElementById("login-step2-greeting");
    if (greetEl) {
      greetEl.textContent = `Halo, ${sess.namaLengkap}! Pilih peran & cabang aktif:`;
    }

    const roleSelect = document.getElementById("login-select-role");
    if (roleSelect) {
      roleSelect.innerHTML = allowedRoles
        .map(
          (r) =>
            `<option value="${r}" ${r === sess.activeRole ? "selected" : ""}>${r}</option>`
        )
        .join("");
      roleSelect.disabled = allowedRoles.length <= 1;
    }

    const branchSelect = document.getElementById("login-select-branch");
    if (branchSelect) {
      branchSelect.innerHTML = resolvedBranches
        .map((cbId) => {
          const b = window.POS_CONFIG.BRANCHES[cbId];
          return `<option value="${cbId}" ${cbId === sess.activeCabang ? "selected" : ""}>${b.label}</option>`;
        })
        .join("");
      branchSelect.disabled = resolvedBranches.length <= 1;
    }

    toggleLoginStep(2);
  }

  async function handleContextConfirm(event) {
    event.preventDefault();
    setLoginError("");

    if (!pendingLoginSession) {
      toggleLoginStep(1);
      return;
    }

    const roleSelect = document.getElementById("login-select-role");
    const branchSelect = document.getElementById("login-select-branch");
    const btnEl = document.getElementById("btn-context-confirm");

    const targetRole = roleSelect ? roleSelect.value : pendingLoginSession.activeRole;
    const targetCabang = branchSelect ? branchSelect.value : pendingLoginSession.activeCabang;

    const butuhSwitch =
      targetRole !== pendingLoginSession.activeRole ||
      targetCabang !== pendingLoginSession.activeCabang;

    if (butuhSwitch) {
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyiapkan Ruang Kerja...';
      }

      const res = await window.POS_API.switchContext({ targetRole, targetCabang });

      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerHTML = '<i class="fas fa-arrow-right"></i> Lanjut ke Dashboard';
      }

      if (!res.sukses || !res.data) {
        setLoginError(res.pesan || "Gagal mengatur peran/cabang aktif.");
        return;
      }

      saveSession(res.data);
    }

    pendingLoginSession = null;
    enterDashboard();
  }

  async function cancelContextStep() {
    if (currentSession && currentSession.token) {
      window.POS_API.logout().catch(() => {});
    }
    pendingLoginSession = null;
    saveSession(null);
    toggleLoginStep(1);
    setLoginError("");
  }

  // ==========================================================================
  // 4. ROLE SWITCHER & BRANCH SWITCHER DI HEADER/TOPBAR
  // ==========================================================================

  function renderHeaderSwitchers() {
    if (!currentSession) return;

    const roleSelect = document.getElementById("header-role-switcher");
    const roleBadge = document.getElementById("header-role-static");
    const branchSelect = document.getElementById("header-branch-switcher");
    const branchBadge = document.getElementById("header-branch-static");

    const allowedRoles = currentSession.allowedRoles || [currentSession.activeRole];
    const resolvedBranches = getAllowedBranchesResolved(currentSession.allowedCabang);

    // Role Switcher: tampilkan dropdown jika punya >1 peran, badge statis jika 1 peran
    if (roleSelect && roleBadge) {
      if (allowedRoles.length > 1) {
        roleSelect.style.display = "inline-block";
        roleBadge.style.display = "none";
        roleSelect.innerHTML = allowedRoles
          .map(
            (r) =>
              `<option value="${r}" ${r === currentSession.activeRole ? "selected" : ""}>Peran: ${r}</option>`
          )
          .join("");
      } else {
        roleSelect.style.display = "none";
        roleBadge.style.display = "inline-flex";
        roleBadge.textContent = currentSession.activeRole;
      }
    }

    // Branch Switcher: tampilkan dropdown jika punya >1 cabang, badge statis jika 1 cabang
    if (branchSelect && branchBadge) {
      if (resolvedBranches.length > 1) {
        branchSelect.style.display = "inline-block";
        branchBadge.style.display = "none";
        branchSelect.innerHTML = resolvedBranches
          .map((cbId) => {
            const b = window.POS_CONFIG.BRANCHES[cbId];
            return `<option value="${cbId}" ${cbId === currentSession.activeCabang ? "selected" : ""}>${b.shortLabel}</option>`;
          })
          .join("");
      } else {
        branchSelect.style.display = "none";
        branchBadge.style.display = "inline-flex";
        const b = window.POS_CONFIG.BRANCHES[currentSession.activeCabang];
        branchBadge.textContent = b ? b.shortLabel : currentSession.activeCabang;
      }
    }

    const userNameEl = document.getElementById("sidebar-user-name");
    const userRoleEl = document.getElementById("sidebar-user-role");
    if (userNameEl) userNameEl.textContent = currentSession.namaLengkap || currentSession.username;
    if (userRoleEl) userRoleEl.textContent = currentSession.activeRole;
  }

  async function switchContextFromHeader(targetRole, targetCabang) {
    if (!currentSession) return;
    const prevRole = currentSession.activeRole;
    const prevCabang = currentSession.activeCabang;

    if (targetRole === prevRole && targetCabang === prevCabang) return;

    showToast("Memperbarui konteks peran/cabang...", "info");

    const res = await window.POS_API.switchContext({ targetRole, targetCabang });
    if (!res.sukses || !res.data) {
      showToast(res.pesan || "Gagal mengganti konteks.", "error");
      renderHeaderSwitchers(); // Kembalikan nilai dropdown ke posisi lama
      return;
    }

    saveSession(res.data);
    applyBranchTheme(currentSession.activeCabang);
    renderHeaderSwitchers();
    renderSidebarAndHomeCards();

    // Pastikan halaman aktif masih diizinkan untuk peran baru; jika tidak, kembali ke Beranda
    const allowedPages = getAllowedMenuItems().map((m) => m.id);
    const targetPage = allowedPages.includes(activePageId) ? activePageId : "page-home";
    navigateTo(targetPage, { skipRefresh: true });

    showToast(
      `Aktif: ${currentSession.activeRole} — ${window.POS_CONFIG.BRANCHES[currentSession.activeCabang].shortLabel}`,
      "success"
    );

    if (window.POS_RETAIL && typeof window.POS_RETAIL.onContextReady === "function") {
      await window.POS_RETAIL.onContextReady(currentSession);
    }
  }

  function onRoleSwitch(newRole) {
    if (!currentSession) return;
    switchContextFromHeader(newRole, currentSession.activeCabang);
  }

  function onBranchSwitch(newCabang) {
    if (!currentSession) return;
    switchContextFromHeader(currentSession.activeRole, newCabang);
  }

  // ==========================================================================
  // 5. SIDEBAR RBAC 5 PERAN & NAVIGASI HALAMAN
  // ==========================================================================

  function getAllowedMenuItems() {
    if (!currentSession) return [];
    const role = currentSession.activeRole;
    return window.POS_CONFIG.MENU_ITEMS.filter((item) => item.roles.includes(role));
  }

  function renderSidebarAndHomeCards() {
    const menuEl = document.getElementById("sidebar-menu-list");
    const homeGridEl = document.getElementById("home-menu-grid");
    const items = getAllowedMenuItems();

    if (menuEl) {
      let html = "";
      let lastGroup = "";
      items.forEach((item) => {
        if (item.group !== lastGroup) {
          html += `<li class="sidebar-group-title">${item.group}</li>`;
          lastGroup = item.group;
        }
        const badgeHtml = item.implemented
          ? ""
          : `<span class="menu-phase-badge">F${item.phase}</span>`;
        html += `
          <li>
            <a href="javascript:void(0)" data-page="${item.id}" class="${item.id === activePageId ? "active" : ""}" onclick="POS_AUTH.navigateTo('${item.id}')">
              <i class="fas ${item.icon}"></i>
              <span class="menu-label-text">${item.label}</span>
              ${badgeHtml}
            </a>
          </li>
        `;
      });

      html += `
        <li class="sidebar-divider"></li>
        <li>
          <a href="javascript:void(0)" class="menu-logout-link" onclick="POS_AUTH.logout()">
            <i class="fas fa-right-from-bracket"></i>
            <span class="menu-label-text">Keluar (Logout)</span>
          </a>
        </li>
      `;
      menuEl.innerHTML = html;
    }

    if (homeGridEl) {
      const quickItems = items.filter((it) => it.id !== "page-home");
      homeGridEl.innerHTML = quickItems
        .map((item) => {
          const tag = item.implemented
            ? ""
            : `<span class="card-phase-pill">Fase ${item.phase}</span>`;
          return `
            <div class="menu-card ${item.implemented ? "" : "menu-card-upcoming"}" onclick="POS_AUTH.navigateTo('${item.id}')">
              ${tag}
              <i class="fas ${item.icon}"></i>
              <h3>${item.label}</h3>
            </div>
          `;
        })
        .join("");
    }
  }

  function navigateTo(pageId, options = {}) {
    if (!currentSession) return;

    const menuDef = window.POS_CONFIG.MENU_ITEMS.find((m) => m.id === pageId);
    const isStrukPage = pageId === "page-struk";

    if (!isStrukPage && (!menuDef || !menuDef.roles.includes(currentSession.activeRole))) {
      showToast("Akses ditolak untuk peran aktif Anda.", "error");
      return;
    }

    // Tutup sidebar di HP
    toggleSidebar(false);

    // Sembunyikan semua section
    document.querySelectorAll(".page-section").forEach((sec) => {
      sec.classList.remove("active");
    });

    // Tentukan elemen target (halaman asli Fase 2 atau halaman kerangka Fase 3-6)
    let targetEl = document.getElementById(pageId);
    if (!targetEl && menuDef && !menuDef.implemented) {
      targetEl = document.getElementById("page-placeholder");
      renderPlaceholderPage(menuDef);
    }

    if (targetEl) {
      targetEl.classList.add("active");
    }

    activePageId = pageId;

    // Update judul topbar & tombol kembali
    const titleEl = document.getElementById("topbar-page-title");
    if (titleEl) {
      titleEl.textContent = isStrukPage
        ? "Cetak Struk"
        : menuDef
        ? menuDef.label
        : "Beranda";
    }

    const backBtn = document.getElementById("btn-topbar-back");
    if (backBtn) {
      backBtn.style.display = pageId === "page-home" ? "none" : "inline-flex";
    }

    // Highlight menu aktif di sidebar
    document.querySelectorAll("#sidebar-menu-list a").forEach((a) => {
      a.classList.toggle("active", a.getAttribute("data-page") === pageId);
    });

    // Cek apakah halaman operasional dibuka dalam mode Gabungan ('all')
    const branchGuardEl = document.getElementById("operational-branch-guard");
    if (branchGuardEl) {
      const perluCabangOps =
        menuDef && menuDef.requireOperationalBranch && currentSession.activeCabang === "all";
      branchGuardEl.style.display = perluCabangOps ? "flex" : "none";
    }

    // Beri tahu modul retail saat halaman berpindah
    if (
      !options.skipRefresh &&
      window.POS_RETAIL &&
      typeof window.POS_RETAIL.onPageActivated === "function"
    ) {
      window.POS_RETAIL.onPageActivated(pageId);
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderPlaceholderPage(menuDef) {
    const iconEl = document.getElementById("placeholder-icon");
    const titleEl = document.getElementById("placeholder-title");
    const badgeEl = document.getElementById("placeholder-phase-badge");
    const descEl = document.getElementById("placeholder-desc");
    const roleInfoEl = document.getElementById("placeholder-roles");

    if (iconEl) iconEl.className = `fas ${menuDef.icon}`;
    if (titleEl) titleEl.textContent = menuDef.label;
    if (badgeEl) badgeEl.textContent = `Jadwal Implementasi: Fase ${menuDef.phase}`;
    if (descEl) descEl.textContent = menuDef.placeholderDesc || "Modul ini siap dikembangkan pada fase berikutnya.";
    if (roleInfoEl) roleInfoEl.textContent = `Akses Peran: ${menuDef.roles.join(", ")}`;
  }

  // ==========================================================================
  // 6. MASUK DASHBOARD, LOGOUT & UTILITAS UI
  // ==========================================================================

  async function enterDashboard() {
    const loginPage = document.getElementById("halaman-login");
    const appPage = document.getElementById("dashboard-app");

    if (loginPage) loginPage.style.display = "none";
    if (appPage) appPage.style.display = "flex";

    applyBranchTheme(currentSession.activeCabang);
    renderHeaderSwitchers();
    renderSidebarAndHomeCards();

    const welcomeNameEl = document.getElementById("home-welcome-name");
    const welcomeRoleEl = document.getElementById("home-welcome-role");
    if (welcomeNameEl) welcomeNameEl.textContent = currentSession.namaLengkap || currentSession.username;
    if (welcomeRoleEl) welcomeRoleEl.textContent = currentSession.activeRole;

    navigateTo("page-home", { skipRefresh: true });

    if (window.POS_RETAIL && typeof window.POS_RETAIL.onContextReady === "function") {
      await window.POS_RETAIL.onContextReady(currentSession);
    }
  }

  function showLoginScreen(errorMsg = "") {
    const loginPage = document.getElementById("halaman-login");
    const appPage = document.getElementById("dashboard-app");

    if (appPage) appPage.style.display = "none";
    if (loginPage) loginPage.style.display = "flex";

    toggleLoginStep(1);
    setLoginError(errorMsg);
    applyBranchTheme("korpri");

    const passEl = document.getElementById("login-password");
    if (passEl) passEl.value = "";
  }

  async function logout() {
    const konfirm = window.confirm("Keluar dari sesi POS Al-Kautsar?");
    if (!konfirm) return;

    showToast("Mengakhiri sesi...", "info");
    if (currentSession && currentSession.token) {
      await window.POS_API.logout().catch(() => {});
    }
    saveSession(null);
    pendingLoginSession = null;
    showLoginScreen("");
  }

  function handleForcedLogout(reason) {
    saveSession(null);
    pendingLoginSession = null;
    showLoginScreen(reason || "Sesi Anda telah berakhir. Silakan login kembali.");
  }

  function toggleSidebar(forceState) {
    const sidebar = document.getElementById("app-sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    if (!sidebar || !overlay) return;

    const shouldOpen =
      typeof forceState === "boolean" ? forceState : !sidebar.classList.contains("active");

    sidebar.classList.toggle("active", shouldOpen);
    overlay.classList.toggle("active", shouldOpen);
  }

  function togglePasswordVisibility() {
    const input = document.getElementById("login-password");
    const icon = document.getElementById("login-pass-icon");
    if (!input || !icon) return;
    const isPass = input.type === "password";
    input.type = isPass ? "text" : "password";
    icon.className = isPass ? "fas fa-eye-slash" : "fas fa-eye";
  }

  function showToast(message, type = "info") {
    const toast = document.getElementById("toast-sistem");
    const textEl = document.getElementById("toast-sistem-text");
    if (!toast || !textEl) return;

    textEl.textContent = message;
    toast.className = `toast-sistem show toast-${type}`;

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, 3200);
  }

  // ==========================================================================
  // 7. DETEKSI PWA (ANDROID INSTALL PROMPT & BANNER PANDUAN SAFARI iOS)
  // ==========================================================================

  function isIosDevice() {
    const ua = window.navigator.userAgent || "";
    const isStandardIos = /iPad|iPhone|iPod/.test(ua);
    const isIpadOs13Plus =
      navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    return isStandardIos || isIpadOs13Plus;
  }

  function isSafariBrowser() {
    const ua = window.navigator.userAgent || "";
    return /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  }

  function isStandalonePwa() {
    return (
      window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches
    );
  }

  function initPwaAndIosBanner() {
    // 1. Registrasi Service Worker v3.0
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch((err) => {
          console.warn("SW registrasi gagal:", err);
        });
      });
    }

    // 2. Tangkap event install PWA Android / Desktop Chrome
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      const btnInstall = document.getElementById("btn-install-pwa");
      if (btnInstall) btnInstall.style.display = "inline-flex";
    });

    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      const btnInstall = document.getElementById("btn-install-pwa");
      if (btnInstall) btnInstall.style.display = "none";
      showToast("Aplikasi POS v3.0 berhasil terpasang!", "success");
    });

    // 3. Banner Panduan Safari iOS (Add to Home Screen)
    const iosBanner = document.getElementById("ios-pwa-banner");
    const sudahDitutup =
      localStorage.getItem(window.POS_CONFIG.IOS_BANNER_DISMISS_KEY) === "1";

    if (iosBanner && isIosDevice() && isSafariBrowser() && !isStandalonePwa() && !sudahDitutup) {
      iosBanner.style.display = "flex";
    }
  }

  function dismissIosBanner() {
    const iosBanner = document.getElementById("ios-pwa-banner");
    if (iosBanner) iosBanner.style.display = "none";
    localStorage.setItem(window.POS_CONFIG.IOS_BANNER_DISMISS_KEY, "1");
  }

  async function triggerInstallPwa() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    const btnInstall = document.getElementById("btn-install-pwa");
    if (btnInstall) btnInstall.style.display = "none";
  }

  // ==========================================================================
  // 8. INISIALISASI APLIKASI
  // ==========================================================================

  function init() {
    initPwaAndIosBanner();

    const formStep1 = document.getElementById("form-login-step1");
    if (formStep1) formStep1.addEventListener("submit", handleLoginSubmit);

    const formStep2 = document.getElementById("form-login-step2");
    if (formStep2) formStep2.addEventListener("submit", handleContextConfirm);

    const stored = loadStoredSession();
    if (stored) {
      currentSession = stored;
      enterDashboard();
    } else {
      showLoginScreen("");
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  return {
    getSession,
    isAuthenticated,
    canVoid,
    applyBranchTheme,
    handleLoginSubmit,
    handleContextConfirm,
    cancelContextStep,
    onRoleSwitch,
    onBranchSwitch,
    navigateTo,
    logout,
    handleForcedLogout,
    toggleSidebar,
    togglePasswordVisibility,
    showToast,
    isIosDevice,
    isStandalonePwa,
    dismissIosBanner,
    triggerInstallPwa
  };
})();