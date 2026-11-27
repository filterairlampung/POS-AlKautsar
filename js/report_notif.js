/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.3.1 — MODUL LAPORAN BOS & NOTIFIKASI REAL-TIME
 * File: js/report_notif.js (PATCH EVENT DELEGATION & ANTI-STUCK LOADING)
 * ============================================================================
 */

window.POS_REPORT_NOTIF = (function () {
  "use strict";

  const POLL_INTERVAL_MS = 60000;
  const LAST_SEEN_NOTIF_KEY = "pos_alkautsar_v3_last_seen_notif_id";

  const EVENT_LABELS = {
    TRANSAKSI_BARU: "Transaksi Baru",
    VOID_TRANSAKSI: "Void / Batal Transaksi",
    SUPIR_SELESAI: "Supir Selesai Antar",
    PROYEK_DAMIU: "Update Proyek DAMIU",
    PIUTANG_LUNAS: "Pelunasan Piutang",
    MUTASI_CABANG: "Mutasi Antar Cabang"
  };

  const DEFAULT_EVENTS = Object.keys(EVENT_LABELS);

  const state = {
    initialized: false,
    bosCabang: "all",
    bosPeriode: "hari_ini",
    bosBulan: "",
    bosLoading: false,
    bosLastData: null,
    searchTipe: "semua",
    searchLoading: false,
    notifItems: [],
    myPref: null,
    botConfigured: false,
    adminUsers: [],
    adminEvents: DEFAULT_EVENTS,
    pollTimer: null,
    isPolling: false
  };

  function getSession() {
    if (window.POS_AUTH && typeof window.POS_AUTH.getSession === "function") {
      return window.POS_AUTH.getSession();
    }
    try {
      const key =
        (window.POS_CONFIG && window.POS_CONFIG.SESSION_STORAGE_KEY) ||
        "pos_alkautsar_v3_session";
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function escapeHtml(str) {
    return String(str === null || str === undefined ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatRp(num) {
    const n = Math.round(Number(num) || 0);
    const absStr = Math.abs(n).toLocaleString("id-ID");
    return (n < 0 ? "-Rp " : "Rp ") + absStr;
  }

  function getCurrentMonthStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  function showToast(msg, type = "info") {
    if (window.POS_UI && typeof window.POS_UI.showToast === "function") {
      window.POS_UI.showToast(msg, type);
      return;
    }
    if (typeof window.showToast === "function") {
      window.showToast(msg, type);
      return;
    }
    let el = document.getElementById("rn-fallback-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "rn-fallback-toast";
      el.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;padding:12px 20px;border-radius:10px;color:#fff;font-weight:600;font-size:15px;box-shadow:0 6px 20px rgba(0,0,0,0.25);max-width:90vw;text-align:center;";
      document.body.appendChild(el);
    }
    el.style.background =
      type === "error" ? "#dc2626" : type === "success" ? "#059669" : "#1e293b";
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.display = "none";
    }, 3500);
  }

  function cabangLabel(cb) {
    const c = String(cb || "all").toLowerCase();
    if (c === "korpri") return "Cabang Korpri";
    if (c === "pringsewu") return "Cabang Pringsewu";
    return "Gabungan (Korpri + Pringsewu)";
  }

  function callApi(actionName, payload = {}) {
    if (!window.POS_API) {
      return Promise.resolve({
        sukses: false,
        pesan: "Modul js/api.js belum dimuat. Periksa error sintaks di js/api.js."
      });
    }
    if (typeof window.POS_API[actionName] === "function") {
      return window.POS_API[actionName](payload);
    }
    if (typeof window.POS_API.request === "function") {
      return window.POS_API.request(actionName, payload, {
        cabang: payload && payload.cabang ? payload.cabang : undefined
      });
    }
    return Promise.resolve({
      sukses: false,
      pesan: `Fungsi API '${actionName}' belum tersedia di js/api.js.`
    });
  }

  function navigateToPage(pageId) {
    const navBtn = document.querySelector(`[data-page="${pageId}"], [data-target="${pageId}"]`);
    if (navBtn) {
      navBtn.click();
      return;
    }
    if (window.POS_APP && typeof window.POS_APP.showPage === "function") {
      window.POS_APP.showPage(pageId);
      return;
    }
    document.querySelectorAll(".page-section").forEach((sec) => sec.classList.remove("active"));
    const target = document.getElementById(pageId);
    if (target) target.classList.add("active");
  }

  // ==========================================================================
  // BAGIAN 1: LAPORAN BOS RAMAH LANSIA (#page-laporan-bos)
  // ==========================================================================

  function syncBosFilterUI() {
    document.querySelectorAll(".bos-cabang-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-cabang") === state.bosCabang);
    });
    document.querySelectorAll(".bos-periode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-periode") === state.bosPeriode);
    });
    const bulanWrap = document.getElementById("bos-pilih-bulan-wrap");
    if (bulanWrap) {
      bulanWrap.style.display = state.bosPeriode === "pilih_bulan" ? "flex" : "none";
    }
    const bulanInput = document.getElementById("bos-input-bulan");
    if (bulanInput && !bulanInput.value) {
      bulanInput.value = state.bosBulan || getCurrentMonthStr();
    }
  }

  async function loadLaporanBos() {
    const session = getSession();
    const statusEl = document.getElementById("bos-status-bar");
    const container = document.getElementById("bos-kpi-container");

    if (!session || !session.token) {
      if (container) {
        container.innerHTML = `<div class="bos-alert-box bos-alert-warning">Sesi login tidak ditemukan. Silakan login ulang.</div>`;
      }
      return;
    }

    if (session.activeRole !== "Bos" && session.activeRole !== "Admin") {
      if (container) {
        container.innerHTML = `
          <div class="bos-alert-box bos-alert-danger">
            <strong>Akses Dibatasi:</strong> Halaman Laporan Keuangan Bos hanya dapat dibuka oleh peran <b>Bos</b> atau <b>Admin</b>.
          </div>
        `;
      }
      return;
    }

    if (state.bosLoading) return;
    state.bosLoading = true;

    if (statusEl) statusEl.textContent = "Sedang menghitung laporan terbaru...";
    if (container) {
      container.innerHTML = `
        <div class="bos-loading-box">
          <i class="fas fa-spinner fa-spin"></i>
          <div>Sedang mengambil data ${escapeHtml(cabangLabel(state.bosCabang))}...</div>
        </div>
      `;
    }

    try {
      const res = await callApi("getLaporanBos", {
        cabang: state.bosCabang,
        periode: state.bosPeriode,
        bulan: state.bosBulan || getCurrentMonthStr()
      });

      if (!res || !res.sukses || !res.data) {
        const errMsg = (res && res.pesan) || "Gagal memuat Laporan Bos.";
        if (statusEl) statusEl.textContent = errMsg;
        if (container) {
          container.innerHTML = `
            <div class="bos-alert-box bos-alert-danger">
              <strong>Gagal Memuat Laporan:</strong> ${escapeHtml(errMsg)}
            </div>
          `;
        }
        showToast(errMsg, "error");
        return;
      }

      state.bosLastData = res.data;
      renderLaporanBos(res.data);

      if (statusEl) {
        statusEl.textContent = `Menampilkan: ${cabangLabel(res.data.cabang)} • ${res.data.periode.label} • Diperbarui ${res.data.generatedAtWIB} WIB`;
      }
    } catch (err) {
      const msg = "Gangguan koneksi saat memuat laporan: " + (err.message || err);
      if (statusEl) statusEl.textContent = msg;
      if (container) {
        container.innerHTML = `<div class="bos-alert-box bos-alert-danger">${escapeHtml(msg)}</div>`;
      }
      showToast(msg, "error");
    } finally {
      state.bosLoading = false;
    }
  }

  function renderLaporanBos(data) {
    const container = document.getElementById("bos-kpi-container");
    if (!container) return;

    const kpi = data.kpi || {};
    const penj = kpi.penjualan || { total: 0, ritel: 0, damiu: 0 };
    const peng = kpi.pengeluaranOps || { total: 0 };
    const laba = kpi.labaBersih || { total: 0, totalHpp: 0, marginPersen: 0 };
    const uang = kpi.perputaranUang || {
      totalSemuaKas: 0,
      kasLaci: 0,
      rekeningToko: 0,
      rekeningBunda: 0,
      setoranPrivePeriode: 0
    };
    const stok = kpi.stokBarang || {
      nilaiAsetModal: 0,
      totalSkuAktif: 0,
      jumlahStokMenipis: 0,
      daftarStokMenipis: []
    };
    const topBarang = Array.isArray(kpi.top5BarangTerlaris) ? kpi.top5BarangTerlaris : [];
    const topPengeluaran = Array.isArray(kpi.top5PengeluaranTerbanyak)
      ? kpi.top5PengeluaranTerbanyak
      : [];

    let bandingCabangHtml = "";
    if (data.cabang === "all" && data.ringkasanPerCabang) {
      const kData = data.ringkasanPerCabang.korpri || {};
      const pData = data.ringkasanPerCabang.pringsewu || {};
      bandingCabangHtml = `
        <div class="bos-compare-grid">
          <div class="bos-compare-item bos-compare-korpri">
            <div class="bos-compare-title">Cabang Korpri</div>
            <div class="bos-compare-row"><span>Penjualan:</span> <b>${formatRp(kData.totalPenjualan)}</b></div>
            <div class="bos-compare-row"><span>Pengeluaran:</span> <b>${formatRp(kData.pengeluaranOps)}</b></div>
            <div class="bos-compare-row"><span>Laba Bersih:</span> <b>${formatRp(kData.labaBersih)}</b></div>
          </div>
          <div class="bos-compare-item bos-compare-pringsewu">
            <div class="bos-compare-title">Cabang Pringsewu</div>
            <div class="bos-compare-row"><span>Penjualan:</span> <b>${formatRp(pData.totalPenjualan)}</b></div>
            <div class="bos-compare-row"><span>Pengeluaran:</span> <b>${formatRp(pData.pengeluaranOps)}</b></div>
            <div class="bos-compare-row"><span>Laba Bersih:</span> <b>${formatRp(pData.labaBersih)}</b></div>
          </div>
        </div>
      `;
    }

    let stokMenipisHtml = `<div class="bos-empty-note">Semua stok barang masih aman (minimal 10 unit).</div>`;
    if (stok.daftarStokMenipis && stok.daftarStokMenipis.length > 0) {
      stokMenipisHtml = `<div class="bos-list-wrap">${stok.daftarStokMenipis
        .slice(0, 15)
        .map((it) => {
          const cbBadge =
            data.cabang === "all"
              ? `<span class="bos-mini-badge">${escapeHtml(String(it.cabang || "").toUpperCase())}</span>`
              : "";
          return `
            <div class="bos-list-row">
              <div class="bos-list-left">
                <div class="bos-list-name">${escapeHtml(it.nama)} ${cbBadge}</div>
              </div>
              <div class="bos-list-right bos-text-danger">
                Sisa ${escapeHtml(it.stok)} ${escapeHtml(it.satuan || "Pcs")}
              </div>
            </div>
          `;
        })
        .join("")}</div>`;
    }

    let topBarangHtml = `<div class="bos-empty-note">Belum ada penjualan barang pada periode ini.</div>`;
    if (topBarang.length > 0) {
      topBarangHtml = `<div class="bos-list-wrap">${topBarang
        .map(
          (b, idx) => `
          <div class="bos-list-row">
            <div class="bos-list-left">
              <span class="bos-rank-badge">${idx + 1}</span>
              <div>
                <div class="bos-list-name">${escapeHtml(b.nama)}</div>
                <div class="bos-list-sub">Terjual ${Number(b.qty || 0).toLocaleString("id-ID")} unit</div>
              </div>
            </div>
            <div class="bos-list-right bos-text-primary">${formatRp(b.omzet)}</div>
          </div>
        `
        )
        .join("")}</div>`;
    }

    let topPengHtml = `<div class="bos-empty-note">Belum ada pengeluaran operasional pada periode ini.</div>`;
    if (topPengeluaran.length > 0) {
      topPengHtml = `<div class="bos-list-wrap">${topPengeluaran
        .map(
          (pg, idx) => `
          <div class="bos-list-row">
            <div class="bos-list-left">
              <span class="bos-rank-badge bos-rank-red">${idx + 1}</span>
              <div>
                <div class="bos-list-name">${escapeHtml(pg.label)}</div>
                <div class="bos-list-sub">${Number(pg.frekuensi || 0)} kali pengeluaran</div>
              </div>
            </div>
            <div class="bos-list-right bos-text-danger">${formatRp(pg.total)}</div>
          </div>
        `
        )
        .join("")}</div>`;
    }

    const labaClass = laba.total >= 0 ? "bos-kpi-green" : "bos-kpi-red";

    container.innerHTML = `
      ${bandingCabangHtml}

      <div class="bos-kpi-card bos-kpi-blue">
        <div class="bos-kpi-header">
          <span class="bos-kpi-num">1</span>
          <span class="bos-kpi-title">Total Penjualan (Omzet)</span>
        </div>
        <div class="bos-kpi-value">${formatRp(penj.total)}</div>
        <div class="bos-kpi-breakdown">
          <div class="bos-breakdown-row"><span>Penjualan Toko / Ritel</span><strong>${formatRp(penj.ritel)}</strong></div>
          <div class="bos-breakdown-row"><span>Proyek Pemasangan DAMIU</span><strong>${formatRp(penj.damiu)}</strong></div>
        </div>
      </div>

      <div class="bos-kpi-card bos-kpi-red">
        <div class="bos-kpi-header">
          <span class="bos-kpi-num">2</span>
          <span class="bos-kpi-title">Pengeluaran Operasional Murni</span>
        </div>
        <div class="bos-kpi-value">${formatRp(peng.total)}</div>
        <div class="bos-kpi-note">
          <i class="fas fa-shield-halved"></i> Tidak termasuk Setoran ke Bunda (Prive) &amp; Kiriman Uang Antar Cabang.
        </div>
      </div>

      <div class="bos-kpi-card ${labaClass}">
        <div class="bos-kpi-header">
          <span class="bos-kpi-num">3</span>
          <span class="bos-kpi-title">Perkiraan Laba Bersih</span>
        </div>
        <div class="bos-kpi-value">${formatRp(laba.total)}</div>
        <div class="bos-kpi-breakdown">
          <div class="bos-breakdown-row"><span>Modal Barang Terjual (HPP)</span><strong>${formatRp(laba.totalHpp)}</strong></div>
          <div class="bos-breakdown-row"><span>Persentase Keuntungan</span><strong>${Number(laba.marginPersen || 0)}%</strong></div>
        </div>
      </div>

      <div class="bos-kpi-card bos-kpi-teal">
        <div class="bos-kpi-header">
          <span class="bos-kpi-num">4</span>
          <span class="bos-kpi-title">Posisi Uang Saat Ini (3 Akun Kas)</span>
        </div>
        <div class="bos-kpi-value">${formatRp(uang.totalSemuaKas)}</div>
        <div class="bos-kpi-breakdown">
          <div class="bos-breakdown-row"><span><i class="fas fa-cash-register"></i> Kas Laci (Tunai Toko)</span><strong>${formatRp(uang.kasLaci)}</strong></div>
          <div class="bos-breakdown-row"><span><i class="fas fa-building-columns"></i> Rekening Toko</span><strong>${formatRp(uang.rekeningToko)}</strong></div>
          <div class="bos-breakdown-row"><span><i class="fas fa-wallet"></i> Rekening Bunda</span><strong>${formatRp(uang.rekeningBunda)}</strong></div>
          ${
            uang.setoranPrivePeriode > 0
              ? `<div class="bos-breakdown-row bos-row-muted"><span>Info Setoran ke Bunda (Periode ini)</span><strong>${formatRp(uang.setoranPrivePeriode)}</strong></div>`
              : ""
          }
        </div>
      </div>

      <div class="bos-kpi-card bos-kpi-amber">
        <div class="bos-kpi-header">
          <span class="bos-kpi-num">5</span>
          <span class="bos-kpi-title">Nilai Aset Stok &amp; Barang Menipis</span>
        </div>
        <div class="bos-kpi-value">${formatRp(stok.nilaiAsetModal)}</div>
        <div class="bos-kpi-note">
          Total ${Number(stok.totalSkuAktif || 0)} jenis barang aktif • <b>${Number(stok.jumlahStokMenipis || 0)} barang stoknya menipis (&lt; 10)</b>
        </div>
        <div class="bos-subcard-title">Daftar Barang Perlu Segera Dibelanja:</div>
        ${stokMenipisHtml}
      </div>

      <div class="bos-kpi-card bos-kpi-slate">
        <div class="bos-kpi-header">
          <span class="bos-kpi-num">6</span>
          <span class="bos-kpi-title">5 Barang Paling Laris</span>
        </div>
        ${topBarangHtml}
      </div>

      <div class="bos-kpi-card bos-kpi-slate">
        <div class="bos-kpi-header">
          <span class="bos-kpi-num">7</span>
          <span class="bos-kpi-title">5 Jenis Pengeluaran Terbanyak</span>
        </div>
        ${topPengHtml}
      </div>
    `;
  }

  // ==========================================================================
  // BAGIAN 2: CARI & HITUNG REKAP BOS
  // ==========================================================================

  async function jalankanCariRekapBos() {
    const inputEl = document.getElementById("bos-search-keyword");
    const resultEl = document.getElementById("bos-search-result");
    if (!inputEl || !resultEl) return;

    const keyword = String(inputEl.value || "").trim();
    if (keyword.length < 2) {
      showToast("Ketik minimal 2 huruf untuk mencari (contoh: Bensin, Parlan, Supir).", "error");
      inputEl.focus();
      return;
    }

    if (state.searchLoading) return;
    state.searchLoading = true;

    resultEl.innerHTML = `<div class="bos-loading-box"><i class="fas fa-spinner fa-spin"></i> Mencari "${escapeHtml(keyword)}"...</div>`;

    try {
      const res = await callApi("cariRekapBos", {
        keyword,
        tipe: state.searchTipe,
        cabang: state.bosCabang,
        periode: state.bosPeriode,
        bulan: state.bosBulan || getCurrentMonthStr()
      });

      if (!res || !res.sukses || !res.data) {
        resultEl.innerHTML = `<div class="bos-alert-box bos-alert-danger">${escapeHtml((res && res.pesan) || "Gagal mencari data rekap.")}</div>`;
        return;
      }

      renderHasilCariRekap(res.data);
    } catch (err) {
      resultEl.innerHTML = `<div class="bos-alert-box bos-alert-danger">Error: ${escapeHtml(err.message || err)}</div>`;
    } finally {
      state.searchLoading = false;
    }
  }

  function renderHasilCariRekap(data) {
    const resultEl = document.getElementById("bos-search-result");
    if (!resultEl) return;

    const r = data.ringkasan || {};
    const items = Array.isArray(data.items) ? data.items : [];

    if (items.length === 0) {
      resultEl.innerHTML = `<div class="bos-empty-note" style="padding:16px;">Tidak ditemukan catatan dengan kata kunci <b>"${escapeHtml(data.keyword)}"</b> pada periode ini.</div>`;
      return;
    }

    const listHtml = items
      .map((it) => {
        const isOut = it.jenis === "Pengeluaran";
        return `
          <div class="bos-search-item">
            <div class="bos-search-top">
              <span class="bos-search-date">${escapeHtml(it.tanggal)} • ${escapeHtml(String(it.cabang || "").toUpperCase())}</span>
              <span class="bos-pill ${isOut ? "bos-pill-red" : "bos-pill-green"}">${escapeHtml(it.jenis)}</span>
            </div>
            <div class="bos-search-ket">${escapeHtml(it.keterangan)}</div>
            <div class="bos-search-bottom">
              <span class="bos-search-akun">${escapeHtml(it.akunKas)} ${it.refId ? `• ${escapeHtml(it.refId)}` : ""}</span>
              <strong class="${isOut ? "bos-text-danger" : "bos-text-success"}">${formatRp(it.nominal)}</strong>
            </div>
          </div>
        `;
      })
      .join("");

    resultEl.innerHTML = `
      <div class="bos-search-summary">
        <div class="bos-search-sum-title">Hasil "${escapeHtml(data.keyword)}" (${Number(r.jumlahData || 0)} catatan)</div>
        <div class="bos-search-sum-grid">
          <div class="bos-sum-box bos-sum-in"><span>Total Pemasukan Kas</span><strong>${formatRp(r.totalPemasukanKas)}</strong></div>
          <div class="bos-sum-box bos-sum-out"><span>Total Pengeluaran Kas</span><strong>${formatRp(r.totalPengeluaranKas)}</strong></div>
          ${r.totalNotaPenjualan > 0 ? `<div class="bos-sum-box bos-sum-nota"><span>Total Nota Penjualan</span><strong>${formatRp(r.totalNotaPenjualan)}</strong></div>` : ""}
        </div>
      </div>
      <div class="bos-search-list">${listHtml}</div>
    `;
  }

  // ==========================================================================
  // BAGIAN 3: LONCENG TOPBAR & HALAMAN NOTIFIKASI
  // ==========================================================================

  function updateTopbarBadge(items) {
    const badge = document.getElementById("topbar-notif-badge");
    if (!badge) return;
    if (!Array.isArray(items) || items.length === 0) {
      badge.style.display = "none";
      badge.textContent = "0";
      return;
    }
    const lastSeenId = localStorage.getItem(LAST_SEEN_NOTIF_KEY) || "";
    let unreadCount = 0;
    if (!lastSeenId) {
      unreadCount = Math.min(items.length, 9);
    } else {
      for (let i = 0; i < items.length; i++) {
        if (items[i].notifId === lastSeenId) break;
        unreadCount++;
      }
    }
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
      badge.style.display = "inline-flex";
    } else {
      badge.style.display = "none";
      badge.textContent = "0";
    }
  }

  function markAllNotifSeen() {
    if (state.notifItems && state.notifItems.length > 0) {
      localStorage.setItem(LAST_SEEN_NOTIF_KEY, state.notifItems[0].notifId);
    }
    updateTopbarBadge(state.notifItems);
  }

  async function pollNotifInApp(silent = true) {
    const session = getSession();
    if (!session || !session.token) return { sukses: false, pesan: "Belum login." };
    if (silent && document.visibilityState === "hidden") return { sukses: false };
    if (state.isPolling) return { sukses: false };

    state.isPolling = true;
    try {
      const res = await callApi("getNotifInApp", { limit: 40 });
      if (res && res.sukses && res.data) {
        state.notifItems = Array.isArray(res.data.items) ? res.data.items : [];
        state.myPref = res.data.myPreference || null;
        state.botConfigured = Boolean(res.data.botConfigured);

        const notifPage = document.getElementById("page-notifikasi");
        if (notifPage && notifPage.classList.contains("active")) {
          markAllNotifSeen();
          renderMyNotifPreference();
          renderNotifHistoryList();
        } else {
          updateTopbarBadge(state.notifItems);
        }
      }
      return res;
    } catch (e) {
      return { sukses: false, pesan: e.message || String(e) };
    } finally {
      state.isPolling = false;
    }
  }

  function startNotifPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    pollNotifInApp(true);
    state.pollTimer = setInterval(() => pollNotifInApp(true), POLL_INTERVAL_MS);
  }

  async function loadNotifPage() {
    const session = getSession();
    const prefWrap = document.getElementById("notif-my-pref-body");
    const listEl = document.getElementById("notif-history-list");

    if (!session || !session.token) {
      if (prefWrap) prefWrap.innerHTML = `<div class="bos-alert-box bos-alert-warning">Silakan login ulang.</div>`;
      return;
    }

    if (listEl && state.notifItems.length === 0) {
      listEl.innerHTML = `<div class="bos-loading-box"><i class="fas fa-spinner fa-spin"></i> Memuat riwayat notifikasi...</div>`;
    }

    const res = await pollNotifInApp(false);
    if (!res || !res.sukses) {
      const msg = (res && res.pesan) || "Gagal memuat notifikasi dari server.";
      if (prefWrap) prefWrap.innerHTML = `<div class="bos-alert-box bos-alert-danger">${escapeHtml(msg)}</div>`;
      if (listEl) listEl.innerHTML = `<div class="bos-alert-box bos-alert-danger">${escapeHtml(msg)}</div>`;
    } else {
      markAllNotifSeen();
      renderMyNotifPreference();
      renderNotifHistoryList();
    }

    const adminSection = document.getElementById("notif-admin-panel");
    if (adminSection) {
      if (session.activeRole === "Admin") {
        adminSection.style.display = "block";
        loadAdminNotifUsers();
      } else {
        adminSection.style.display = "none";
      }
    }
  }

  function renderMyNotifPreference() {
    const wrap = document.getElementById("notif-my-pref-body");
    if (!wrap) return;

    const pref = state.myPref || {
      notifAllowed: false,
      notifEnabled: false,
      telegramChatId: "",
      notifEvents: []
    };

    const botWarnHtml = !state.botConfigured
      ? `<div class="bos-alert-box bos-alert-warning" style="margin-bottom:12px;">
          <b>Info Sistem:</b> <code>TELEGRAM_BOT_TOKEN</code> belum diisi di Script Properties Google Apps Script. Notifikasi Lonceng In-App tetap berjalan normal.
        </div>`
      : "";

    if (!pref.notifAllowed) {
      wrap.innerHTML = `
        ${botWarnHtml}
        <div class="notif-locked-box">
          <i class="fas fa-lock"></i>
          <div>
            <strong>Izin notifikasi belum diaktifkan oleh Admin</strong>
            <p>Hubungi Admin Al-Kautsar untuk mengaktifkan hak akses notifikasi Telegram pada akun Anda.</p>
          </div>
        </div>
      `;
      return;
    }

    const eventsText =
      pref.notifEvents && pref.notifEvents.length > 0
        ? pref.notifEvents.map((ev) => EVENT_LABELS[ev] || ev).join(", ")
        : "Semua Notifikasi Cabang";

    wrap.innerHTML = `
      ${botWarnHtml}
      <div class="notif-pref-form">
        <div class="notif-toggle-row">
          <div>
            <div class="notif-pref-label">Aktifkan Notifikasi Telegram Saya</div>
            <div class="notif-pref-sub">Kontrol Ganda aktif: Admin sudah mengizinkan akun Anda.</div>
          </div>
          <label class="rn-switch">
            <input type="checkbox" id="notif-my-enabled" ${pref.notifEnabled ? "checked" : ""} />
            <span class="rn-slider"></span>
          </label>
        </div>

        <div class="notif-field-group">
          <label for="notif-my-chat-id">Telegram Chat ID Anda</label>
          <input
            type="text"
            id="notif-my-chat-id"
            class="rn-input"
            placeholder="Contoh: 5123456789 (cek lewat @userinfobot)"
            value="${escapeHtml(pref.telegramChatId || "")}"
          />
          <small class="notif-help-text">
            Pastikan Anda sudah klik <b>Start</b> di bot Telegram Al-Kautsar sebelum menekan tombol Tes.
          </small>
        </div>

        <div class="notif-events-info">
          <span>Jenis Notifikasi Diizinkan Admin:</span>
          <strong>${escapeHtml(eventsText)}</strong>
        </div>

        <div class="notif-action-row">
          <button type="button" id="btn-save-my-notif" class="rn-btn rn-btn-primary">
            <i class="fas fa-save"></i> Simpan Pengaturan
          </button>
          <button type="button" id="btn-test-my-telegram" class="rn-btn rn-btn-secondary">
            <i class="fas fa-paper-plane"></i> Kirim Tes Telegram
          </button>
        </div>
      </div>
    `;
  }

  async function handleSaveMyNotifPref(btn) {
    const chk = document.getElementById("notif-my-enabled");
    const inp = document.getElementById("notif-my-chat-id");
    if (!chk || !inp) return;

    const notifEnabled = chk.checked;
    const telegramChatId = String(inp.value || "").trim();

    if (btn) btn.disabled = true;
    try {
      const res = await callApi("updateNotifPreference", { notifEnabled, telegramChatId });
      if (!res || !res.sukses) {
        showToast((res && res.pesan) || "Gagal menyimpan pengaturan notifikasi.", "error");
        return;
      }
      if (state.myPref) {
        state.myPref.notifEnabled = notifEnabled;
        state.myPref.telegramChatId = telegramChatId;
      }
      showToast(res.pesan || "Pengaturan notifikasi disimpan.", "success");
    } catch (err) {
      showToast("Gagal menyimpan: " + (err.message || err), "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleTestMyTelegram(btn) {
    const inp = document.getElementById("notif-my-chat-id");
    const telegramChatId = inp ? String(inp.value || "").trim() : "";
    if (!telegramChatId) {
      showToast("Isi Telegram Chat ID Anda terlebih dahulu.", "error");
      if (inp) inp.focus();
      return;
    }

    if (btn) btn.disabled = true;
    try {
      const res = await callApi("testNotifTelegram", { telegramChatId });
      if (!res || !res.sukses) {
        showToast((res && res.pesan) || "Tes Telegram gagal dikirim.", "error");
        return;
      }
      showToast(res.pesan || "Pesan tes terkirim ke Telegram Anda!", "success");
    } catch (err) {
      showToast("Error tes Telegram: " + (err.message || err), "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderNotifHistoryList() {
    const listEl = document.getElementById("notif-history-list");
    if (!listEl) return;

    if (!state.notifItems || state.notifItems.length === 0) {
      listEl.innerHTML = `<div class="bos-empty-note" style="padding:20px;">Belum ada riwayat notifikasi masuk.</div>`;
      return;
    }

    listEl.innerHTML = state.notifItems
      .map((it) => {
        const isDanger = it.eventType === "VOID_TRANSAKSI";
        const evLabel = EVENT_LABELS[it.eventType] || it.eventType;
        return `
          <div class="notif-item-card">
            <div class="notif-item-top">
              <div class="notif-badges">
                <span class="bos-pill ${isDanger ? "bos-pill-red" : "bos-pill-blue"}">${escapeHtml(evLabel)}</span>
                <span class="bos-mini-badge">${escapeHtml(String(it.cabang || "all").toUpperCase())}</span>
              </div>
              <span class="notif-time">${escapeHtml(it.timestampWIB)} WIB</span>
            </div>
            <div class="notif-item-title">${escapeHtml(it.judul)}</div>
            <div class="notif-item-msg">${escapeHtml(it.pesan)}</div>
            <div class="notif-item-meta">
              ${it.refId ? `<span>Ref: <b>${escapeHtml(it.refId)}</b></span>` : ""}
              ${it.triggeredBy ? `<span>Oleh: ${escapeHtml(it.triggeredBy)}</span>` : ""}
            </div>
          </div>
        `;
      })
      .join("");
  }

  // ==========================================================================
  // BAGIAN 4: PANEL ADMIN — KELOLA AKSES NOTIFIKASI TIM
  // ==========================================================================

  async function loadAdminNotifUsers() {
    const wrap = document.getElementById("notif-admin-list");
    if (!wrap) return;

    wrap.innerHTML = `<div class="bos-loading-box"><i class="fas fa-spinner fa-spin"></i> Memuat daftar user tim...</div>`;
    try {
      const res = await callApi("kelolaAksesNotifAdmin", { mode: "LIST" });
      if (!res || !res.sukses || !res.data) {
        wrap.innerHTML = `<div class="bos-alert-box bos-alert-danger">${escapeHtml((res && res.pesan) || "Gagal memuat daftar akses tim.")}</div>`;
        return;
      }
      state.adminUsers = Array.isArray(res.data.users) ? res.data.users : [];
      state.adminEvents = Array.isArray(res.data.availableEvents) ? res.data.availableEvents : DEFAULT_EVENTS;
      renderAdminNotifUsers();
    } catch (err) {
      wrap.innerHTML = `<div class="bos-alert-box bos-alert-danger">Error: ${escapeHtml(err.message || err)}</div>`;
    }
  }

  function renderAdminNotifUsers() {
    const wrap = document.getElementById("notif-admin-list");
    if (!wrap) return;
    if (state.adminUsers.length === 0) {
      wrap.innerHTML = `<div class="bos-empty-note">Tidak ada data user di tab USERS.</div>`;
      return;
    }

    wrap.innerHTML = state.adminUsers
      .map((u, idx) => {
        const checksHtml = state.adminEvents
          .map((ev) => {
            const checked = u.notifEvents.includes("ALL") || u.notifEvents.includes(ev);
            return `
              <label class="admin-ev-chip">
                <input type="checkbox" class="admin-ev-cb" data-user-idx="${idx}" value="${escapeHtml(ev)}" ${checked ? "checked" : ""} />
                <span>${escapeHtml(EVENT_LABELS[ev] || ev)}</span>
              </label>
            `;
          })
          .join("");

        return `
          <div class="admin-user-card" data-username="${escapeHtml(u.username)}">
            <div class="admin-user-head">
              <div>
                <div class="admin-user-name">${escapeHtml(u.nama)} <small>(@${escapeHtml(u.username)})</small></div>
                <div class="admin-user-meta">
                  Peran: <b>${escapeHtml(u.roles || "-")}</b> • Cabang: <b>${escapeHtml(String(u.allowedCabang || "all").toUpperCase())}</b>
                  • Sakelar User: <b>${u.notifEnabled ? "ON" : "OFF"}</b>
                  • Chat ID: <code>${escapeHtml(u.telegramChatId || "Belum diisi")}</code>
                </div>
              </div>
              <label class="rn-switch" title="Izinkan Notifikasi (Admin)">
                <input type="checkbox" class="admin-allowed-cb" data-user-idx="${idx}" ${u.notifAllowed ? "checked" : ""} />
                <span class="rn-slider"></span>
              </label>
            </div>
            <div class="admin-ev-grid">${checksHtml}</div>
            <div class="admin-user-footer">
              <button type="button" class="rn-btn rn-btn-primary rn-btn-sm btn-save-admin-user" data-user-idx="${idx}">
                <i class="fas fa-check"></i> Simpan Akses ${escapeHtml(u.username)}
              </button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  async function handleSaveAdminUserAccess(userIdx, btnEl) {
    const user = state.adminUsers[userIdx];
    if (!user) return;

    const allowedCb = document.querySelector(`.admin-allowed-cb[data-user-idx="${userIdx}"]`);
    const evCbs = document.querySelectorAll(`.admin-ev-cb[data-user-idx="${userIdx}"]:checked`);
    const notifAllowed = allowedCb ? allowedCb.checked : false;
    const notifEvents = Array.from(evCbs).map((el) => el.value);

    if (btnEl) btnEl.disabled = true;
    try {
      const res = await callApi("kelolaAksesNotifAdmin", {
        mode: "UPDATE",
        targetUsername: user.username,
        notifAllowed,
        notifEvents
      });

      if (!res || !res.sukses) {
        showToast((res && res.pesan) || "Gagal memperbarui akses user.", "error");
        return;
      }

      user.notifAllowed = notifAllowed;
      user.notifEvents = notifEvents;
      showToast(res.pesan || `Akses ${user.username} diperbarui.`, "success");

      const session = getSession();
      if (session && session.username === user.username) {
        await pollNotifInApp(false);
        renderMyNotifPreference();
      }
    } catch (err) {
      showToast("Error simpan akses: " + (err.message || err), "error");
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  // ==========================================================================
  // EVENT DELEGATION GLOBAL (TOMBOL PASTI MERESPONS 100%)
  // ==========================================================================

  function bindGlobalDelegation() {
    document.addEventListener("click", (e) => {
      const t = e.target;

      // 1. Pilih Cabang Laporan Bos
      const cabangBtn = t.closest(".bos-cabang-btn");
      if (cabangBtn) {
        state.bosCabang = cabangBtn.getAttribute("data-cabang") || "all";
        syncBosFilterUI();
        loadLaporanBos();
        return;
      }

      // 2. Pilih Periode Laporan Bos
      const periodeBtn = t.closest(".bos-periode-btn");
      if (periodeBtn) {
        state.bosPeriode = periodeBtn.getAttribute("data-periode") || "hari_ini";
        syncBosFilterUI();
        if (state.bosPeriode !== "pilih_bulan") loadLaporanBos();
        return;
      }

      // 3. Terapkan Pilih Bulan
      if (t.closest("#btn-bos-apply-bulan")) {
        const inp = document.getElementById("bos-input-bulan");
        state.bosBulan = (inp && inp.value) || getCurrentMonthStr();
        loadLaporanBos();
        return;
      }

      // 4. Refresh Laporan Bos
      if (t.closest("#btn-bos-refresh")) {
        loadLaporanBos();
        return;
      }

      // 5. Tipe Search Rekap
      const tipeBtn = t.closest(".bos-search-tipe-btn");
      if (tipeBtn) {
        state.searchTipe = tipeBtn.getAttribute("data-tipe") || "semua";
        document.querySelectorAll(".bos-search-tipe-btn").forEach((b) => b.classList.toggle("active", b === tipeBtn));
        return;
      }

      // 6. Tombol Cari Rekap
      if (t.closest("#btn-bos-search")) {
        jalankanCariRekapBos();
        return;
      }

      // 7. Tombol Lonceng Topbar
      if (t.closest("#btn-topbar-notif")) {
        navigateToPage("page-notifikasi");
        setTimeout(() => loadNotifPage(), 80);
        return;
      }

      // 8. Refresh Notifikasi
      if (t.closest("#btn-notif-refresh")) {
        loadNotifPage();
        return;
      }

      // 9. Simpan & Tes Notifikasi Saya
      const btnSaveMy = t.closest("#btn-save-my-notif");
      if (btnSaveMy) {
        handleSaveMyNotifPref(btnSaveMy);
        return;
      }
      const btnTestMy = t.closest("#btn-test-my-telegram");
      if (btnTestMy) {
        handleTestMyTelegram(btnTestMy);
        return;
      }

      // 10. Simpan Akses Admin
      const btnAdmin = t.closest(".btn-save-admin-user");
      if (btnAdmin) {
        const idx = parseInt(btnAdmin.getAttribute("data-user-idx"), 10);
        handleSaveAdminUserAccess(idx, btnAdmin);
        return;
      }

      // 11. Cadangan klik menu sidebar langsung (jika router tidak memakai class 'active')
      const menuLink = t.closest('[data-page="page-laporan-bos"], [data-target="page-laporan-bos"]');
      if (menuLink) {
        setTimeout(() => {
          syncBosFilterUI();
          loadLaporanBos();
        }, 120);
        return;
      }
      const notifLink = t.closest('[data-page="page-notifikasi"], [data-target="page-notifikasi"]');
      if (notifLink) {
        setTimeout(() => loadNotifPage(), 120);
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target && e.target.id === "bos-search-keyword") {
        e.preventDefault();
        jalankanCariRekapBos();
      }
    });
  }

  function observePages() {
    const bosSec = document.getElementById("page-laporan-bos");
    const notifSec = document.getElementById("page-notifikasi");

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        if (m.attributeName !== "class") return;
        const target = m.target;
        if (target === bosSec && bosSec.classList.contains("active")) {
          syncBosFilterUI();
          loadLaporanBos();
        } else if (target === notifSec && notifSec.classList.contains("active")) {
          loadNotifPage();
        }
      });
    });

    if (bosSec) observer.observe(bosSec, { attributes: true });
    if (notifSec) observer.observe(notifSec, { attributes: true });
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    state.bosBulan = getCurrentMonthStr();

    const session = getSession();
    if (session && session.activeCabang) {
      state.bosCabang =
        session.activeCabang === "korpri" || session.activeCabang === "pringsewu"
          ? session.activeCabang
          : "all";
    }

    bindGlobalDelegation();
    syncBosFilterUI();
    observePages();

    if (session && session.token) {
      startNotifPolling();
    }

    // Jika salah satu halaman sudah aktif saat halaman baru selesai muat
    const bosSec = document.getElementById("page-laporan-bos");
    const notifSec = document.getElementById("page-notifikasi");
    if (bosSec && bosSec.classList.contains("active")) loadLaporanBos();
    if (notifSec && notifSec.classList.contains("active")) loadNotifPage();

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && getSession()) {
        pollNotifInApp(true);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    init,
    loadLaporanBos,
    jalankanCariRekapBos,
    loadNotifPage,
    pollNotifInApp,
    startNotifPolling
  };
})();