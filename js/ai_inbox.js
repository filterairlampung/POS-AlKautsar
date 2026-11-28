/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.4 — ASISTEN AI ADMIN & INBOX SMART PASTE WA
 * File: js/ai_inbox.js
 * ============================================================================
 * Cakupan Modul:
 * 1. Halaman Asisten AI Admin (#page-asisten-ai) -> khusus peran ["Admin"]
 *    - Mode Pemilih Cepat (Auto / Cari Transaksi / Edit Master Barang / Ubah Config)
 *    - Hasil Pencarian Transaksi Historis Deterministik
 *    - Konfirmasi 2 Langkah Edit Master Barang (Diff Lama vs Baru + clientRequestId baru)
 *    - Dynamic Config Engine (APP_CONFIG) + 1-Klik Rollback bermodal konfirmasi
 * 2. Halaman Inbox Smart Paste WA (#page-inbox-paste) -> ["Admin","Manajer","Karyawan","Bos"]
 *    - Paste chat WA -> Analisa AI -> Pratinjau Edit Manual -> Simpan ke INBOX_PESANAN
 *    - Daftar Antrean (BARU / DIPROSES / SELESAI / BATAL) + Aksi Cepat Kasir/Supir/Batal
 * ============================================================================
 */

window.POS_AI_INBOX = (function () {
  "use strict";

  const INBOX_ALLOWED_ROLES = ["Admin", "Manajer", "Karyawan", "Bos"];
  const DRAFT_STORAGE_KEY = "pos_alkautsar_v3_inbox_active_draft";

  const state = {
    initialized: false,

    // Asisten AI Admin
    aiMode: "auto", // auto | cari | barang | config
    aiCabang: "korpri",
    aiBusy: false,
    execBarangBusy: false,
    pendingPreview: null, // { previewToken, cabang, diffs, ringkasan, peringatan }
    configItems: [],
    configLoading: false,
    configBusy: false,

    // Inbox Smart Paste WA
    inboxCabang: "korpri",
    inboxStatusFilter: "BARU",
    inboxQueue: [],
    inboxLoading: false,
    inboxAnalyzeBusy: false,
    inboxSaveBusy: false,
    activeDraft: null, // Draft hasil parsing yang sedang diedit manual

    // Modal Konfirmasi
    modalCallback: null
  };

  // ==========================================================================
  // HELPER UMUM (SESI, SANITASI XSS, FORMAT, TOAST, API)
  // ==========================================================================

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

  function showToast(msg, type = "info") {
    if (window.POS_UI && typeof window.POS_UI.showToast === "function") {
      window.POS_UI.showToast(msg, type);
      return;
    }
    if (typeof window.showToast === "function") {
      window.showToast(msg, type);
      return;
    }
    let el = document.getElementById("ai-fallback-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ai-fallback-toast";
      el.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;padding:12px 20px;border-radius:10px;color:#fff;font-weight:600;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,0.28);max-width:92vw;text-align:center;";
      document.body.appendChild(el);
    }
    el.style.background =
      type === "error" ? "#dc2626" : type === "success" ? "#059669" : "#1e293b";
    el.textContent = msg;
    el.style.display = "block";
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.display = "none";
    }, 3800);
  }

  function newReqId(prefix) {
    if (window.POS_API && typeof window.POS_API.generateClientRequestId === "function") {
      return window.POS_API.generateClientRequestId(prefix);
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function callApi(actionName, payload = {}, clientRequestId) {
    if (!window.POS_API) {
      return Promise.resolve({
        sukses: false,
        pesan: "Modul js/api.js belum dimuat."
      });
    }
    if (typeof window.POS_API[actionName] === "function") {
      return window.POS_API[actionName](payload, clientRequestId);
    }
    return window.POS_API.request(actionName, payload, {
      clientRequestId: clientRequestId || newReqId("AI"),
      cabang: payload && payload.cabang ? payload.cabang : undefined,
      timeoutMs: 45000
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

  function setBtnLoading(btn, isLoading, loadingText, defaultHtml) {
    if (!btn) return;
    if (isLoading) {
      if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(loadingText || "Memproses...")}`;
    } else {
      btn.disabled = false;
      btn.innerHTML = defaultHtml || btn.dataset.origHtml || btn.innerHTML;
    }
  }

  // ==========================================================================
  // MODAL KONFIRMASI UNIVERSAL (WAJIB INLINE FALLBACK flex / none)
  // ==========================================================================

  function ensureConfirmModal() {
    let modal = document.getElementById("ai-confirm-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "ai-confirm-modal";
      modal.className = "ai-modal-backdrop";
      modal.style.cssText =
        "display:none;position:fixed;inset:0;background:rgba(15,23,42,0.58);z-index:99990;align-items:center;justify-content:center;padding:16px;";
      modal.innerHTML = `
        <div class="ai-modal-card" style="background:#fff;border-radius:14px;max-width:460px;width:100%;padding:20px;box-shadow:0 20px 45px rgba(0,0,0,0.28);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <h3 id="ai-modal-title" style="margin:0;font-size:17px;color:#0f172a;">Konfirmasi</h3>
            <button type="button" id="btn-ai-modal-close" style="border:none;background:none;font-size:20px;cursor:pointer;color:#64748b;">&times;</button>
          </div>
          <div id="ai-modal-body" style="font-size:14px;color:#334155;line-height:1.5;margin-bottom:14px;"></div>
          <div id="ai-modal-reason-wrap" style="display:none;margin-bottom:14px;">
            <label for="ai-modal-reason-input" style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:#334155;">Alasan (wajib diisi, min. 3 huruf):</label>
            <input type="text" id="ai-modal-reason-input" class="ai-input" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;box-sizing:border-box;" placeholder="Tulis alasan..." />
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button type="button" id="btn-ai-modal-cancel" class="ai-btn ai-btn-secondary">Batal</button>
            <button type="button" id="btn-ai-modal-ok" class="ai-btn ai-btn-primary">Ya, Lanjutkan</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }
    return modal;
  }

  function openConfirmModal({ title, bodyHtml, okLabel = "Ya, Lanjutkan", danger = false, requireReason = false, onConfirm }) {
    const modal = ensureConfirmModal();
    const titleEl = document.getElementById("ai-modal-title");
    const bodyEl = document.getElementById("ai-modal-body");
    const reasonWrap = document.getElementById("ai-modal-reason-wrap");
    const reasonInput = document.getElementById("ai-modal-reason-input");
    const okBtn = document.getElementById("btn-ai-modal-ok");

    if (titleEl) titleEl.textContent = title || "Konfirmasi";
    if (bodyEl) bodyEl.innerHTML = bodyHtml || "";
    if (reasonWrap) reasonWrap.style.display = requireReason ? "block" : "none";
    if (reasonInput) reasonInput.value = "";
    if (okBtn) {
      okBtn.textContent = okLabel;
      okBtn.disabled = false;
      okBtn.className = danger ? "ai-btn ai-btn-danger" : "ai-btn ai-btn-primary";
    }

    state.modalCallback = { onConfirm, requireReason };
    // Aturan wajib: fallback inline display flex
    modal.style.display = "flex";
    if (requireReason && reasonInput) {
      setTimeout(() => reasonInput.focus(), 60);
    }
  }

  function closeConfirmModal() {
    const modal = document.getElementById("ai-confirm-modal");
    if (modal) {
      // Aturan wajib: fallback inline display none
      modal.style.display = "none";
    }
    state.modalCallback = null;
  }

  // ==========================================================================
  // BAGIAN 1: ASISTEN AI ADMIN (#page-asisten-ai) — KHUSUS PERAN ADMIN
  // ==========================================================================

  function isAdminRole() {
    const session = getSession();
    return Boolean(session && session.token && session.activeRole === "Admin");
  }

  function syncAiModeUI() {
    document.querySelectorAll(".ai-mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-mode") === state.aiMode);
    });
    const hintEl = document.getElementById("ai-prompt-hint");
    if (hintEl) {
      const hints = {
        auto: "Mode Auto: Ketik perintah bebas (cari transaksi, ubah harga/nama barang, atau kelola konfigurasi).",
        cari: "Mode Cari Transaksi: Contoh 'Pengeluaran bensin Korpri bulan ini' atau 'Nota pelanggan Parlan > 500rb'.",
        barang: "Mode Edit Master Barang (2 Langkah): Contoh 'Naikkan harga jual Housing 10 inch jadi 65000 dan stok min 15'.",
        config: "Mode Ubah Config: Kelola parameter APP_CONFIG atau rollback versi sebelumnya di panel bawah."
      };
      hintEl.textContent = hints[state.aiMode] || hints.auto;
    }
  }

  function detectAdminIntent(promptText) {
    if (state.aiMode !== "auto") return state.aiMode;
    const s = String(promptText || "").toLowerCase();
    if (
      /(ubah|ganti|edit|naikkan|turunkan|set)\s+(harga|nama|kategori|satuan|stok\s*min|master\s*barang)/.test(s) ||
      s.includes("master barang")
    ) {
      return "barang";
    }
    if (/(config|konfigurasi|footer\s*struk|threshold|rollback|app_config)/.test(s)) {
      return "config";
    }
    return "cari";
  }

  async function loadAsistenAiPage() {
    const guardEl = document.getElementById("ai-admin-guard");
    const mainEl = document.getElementById("ai-admin-main");

    if (!isAdminRole()) {
      if (guardEl) {
        guardEl.style.display = "block";
        guardEl.innerHTML = `
          <div class="ai-alert ai-alert-danger">
            <strong>Akses Ditolak (RBAC):</strong> Halaman Asisten AI Internal hanya dapat diakses oleh peran <b>Admin</b>.
          </div>
        `;
      }
      if (mainEl) mainEl.style.display = "none";
      return;
    }

    if (guardEl) guardEl.style.display = "none";
    if (mainEl) mainEl.style.display = "block";

    const cbSel = document.getElementById("ai-admin-cabang");
    if (cbSel) cbSel.value = state.aiCabang;

    syncAiModeUI();
    await loadAppConfigAdmin();
  }

  async function handleAiAdminSubmit(btn) {
    if (!isAdminRole()) {
      showToast("Akses ditolak: khusus Admin.", "error");
      return;
    }
    if (state.aiBusy) return;

    const promptEl = document.getElementById("ai-admin-prompt");
    const resultEl = document.getElementById("ai-admin-result");
    const cbSel = document.getElementById("ai-admin-cabang");

    const promptText = promptEl ? String(promptEl.value || "").trim() : "";
    const selectedCabang = cbSel ? String(cbSel.value || "korpri").toLowerCase() : state.aiCabang;
    state.aiCabang = selectedCabang;

    const resolvedMode = detectAdminIntent(promptText);

    if (resolvedMode === "config") {
      const cfgPanel = document.getElementById("ai-config-panel");
      if (cfgPanel) cfgPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      showToast("Gunakan panel Dynamic Config (APP_CONFIG) di bawah untuk ubah atau rollback.", "info");
      return;
    }

    if (promptText.length < 3) {
      showToast("Ketik perintah atau pertanyaan minimal 3 karakter.", "error");
      if (promptEl) promptEl.focus();
      return;
    }

    if (resolvedMode === "barang" && selectedCabang !== "korpri" && selectedCabang !== "pringsewu") {
      showToast("Edit Master Barang wajib memilih cabang spesifik (Korpri atau Pringsewu).", "error");
      if (cbSel) cbSel.focus();
      return;
    }

    state.aiBusy = true;
    state.pendingPreview = null;
    setBtnLoading(btn, true, "Memproses Gemini AI...");

    if (resultEl) {
      resultEl.innerHTML = `
        <div class="ai-loading-box">
          <i class="fas fa-robot fa-spin"></i>
          <div>Menghubungi Gemini AI (${resolvedMode === "barang" ? "Menyusun Preview Diff Master Barang" : "Menerjemahkan Filter Pencarian Historis"})...</div>
        </div>
      `;
    }

    try {
      if (resolvedMode === "barang") {
        const res = await callApi("previewEditMasterBarangAI", {
          cabang: selectedCabang,
          instruksi: promptText
        });
        if (!res || !res.sukses || !res.data) {
          renderAiError(resultEl, (res && res.pesan) || "Gagal membuat preview edit barang.");
          return;
        }
        state.pendingPreview = res.data;
        renderBarangPreviewCard(resultEl, res.data);
      } else {
        const res = await callApi("cariTransaksiHistorisAI", {
          pertanyaan: promptText,
          cabang: selectedCabang
        });
        if (!res || !res.sukses || !res.data) {
          renderAiError(resultEl, (res && res.pesan) || "Gagal mencari transaksi historis.");
          return;
        }
        renderHistoricalSearchResult(resultEl, res.data);
      }
    } catch (err) {
      renderAiError(resultEl, "Gangguan jaringan: " + (err.message || err));
    } finally {
      state.aiBusy = false;
      setBtnLoading(btn, false);
    }
  }

  function renderAiError(container, message) {
    if (!container) return;
    container.innerHTML = `
      <div class="ai-alert ai-alert-danger">
        <strong>Proses Gagal:</strong> ${escapeHtml(message)}
      </div>
    `;
    showToast(message, "error");
  }

  function renderHistoricalSearchResult(container, data) {
    if (!container) return;
    const f = data.parsedFilter || {};
    const r = data.ringkasan || {};
    const items = Array.isArray(data.items) ? data.items : [];

    const rowsHtml =
      items.length === 0
        ? `<tr><td colspan="6" style="text-align:center;padding:16px;color:#64748b;">Tidak ada transaksi yang cocok dengan filter tersebut.</td></tr>`
        : items
            .map((it) => {
              const voidBadge = it.isVoid ? `<span class="ai-badge ai-badge-red">VOID</span>` : "";
              return `
                <tr class="${it.isVoid ? "ai-row-void" : ""}">
                  <td>${escapeHtml(it.tanggal)}</td>
                  <td><span class="ai-badge ai-badge-slate">${escapeHtml(String(it.cabang || "").toUpperCase())}</span></td>
                  <td><span class="ai-badge ai-badge-blue">${escapeHtml(it.sumber)}</span> ${voidBadge}</td>
                  <td>
                    <div>${escapeHtml(it.keterangan)}</div>
                    <small style="color:#64748b;">${escapeHtml(it.akunKas)} ${it.coa ? "• " + escapeHtml(it.coa) : ""}</small>
                  </td>
                  <td><code>${escapeHtml(it.refId || "-")}</code></td>
                  <td style="text-align:right;font-weight:700;">${formatRp(it.nominal)}</td>
                </tr>
              `;
            })
            .join("");

    container.innerHTML = `
      <div class="ai-result-card">
        <div class="ai-result-head">
          <div>
            <strong>Hasil Pencarian Historis (100% Deterministik)</strong>
            <div class="ai-sub-meta">${escapeHtml(f.penjelasanFilter || "Filter diterapkan dari pertanyaan Anda")}</div>
          </div>
          <span class="ai-badge ai-badge-green">${Number(r.jumlahData || 0)} Baris</span>
        </div>

        <div class="ai-filter-chips">
          <span>Cabang: <b>${escapeHtml(String(f.cabang || "all").toUpperCase())}</b></span>
          <span>Rentang: <b>${escapeHtml(f.startDate)} s/d ${escapeHtml(f.endDate)}</b></span>
          <span>Sumber: <b>${escapeHtml(f.sumber || "ALL")}</b></span>
          ${f.keyword ? `<span>Kata Kunci: <b>${escapeHtml(f.keyword)}</b></span>` : ""}
        </div>

        <div class="ai-summary-grid">
          <div class="ai-sum-box"><span>Total Nota Penjualan</span><strong>${formatRp(r.totalNotaPenjualan)}</strong></div>
          <div class="ai-sum-box ai-sum-in"><span>Total Kas Masuk</span><strong>${formatRp(r.totalKasMasuk)}</strong></div>
          <div class="ai-sum-box ai-sum-out"><span>Total Kas Keluar</span><strong>${formatRp(r.totalKasKeluar)}</strong></div>
          <div class="ai-sum-box"><span>Total Kontrak DAMIU</span><strong>${formatRp(r.totalKontrakDamiu)}</strong></div>
        </div>

        <div class="ai-table-wrap">
          <table class="ai-table">
            <thead>
              <tr>
                <th>Tanggal</th>
                <th>Cabang</th>
                <th>Sumber</th>
                <th>Keterangan</th>
                <th>Ref ID</th>
                <th style="text-align:right;">Nominal</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderBarangPreviewCard(container, data) {
    if (!container) return;
    const diffs = Array.isArray(data.diffs) ? data.diffs : [];
    const warnings = Array.isArray(data.peringatan) ? data.peringatan : [];

    const warnHtml =
      warnings.length > 0
        ? `<div class="ai-alert ai-alert-warning" style="margin-bottom:12px;">
            <strong>Catatan / Peringatan AI:</strong>
            <ul style="margin:6px 0 0 18px;padding:0;">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>
          </div>`
        : "";

    if (diffs.length === 0 || !data.previewToken) {
      container.innerHTML = `
        <div class="ai-result-card">
          ${warnHtml}
          <div class="ai-alert ai-alert-info">
            ${escapeHtml(data.ringkasan || "Tidak ada perubahan valid pada MASTER BARANG.")}
          </div>
        </div>
      `;
      return;
    }

    const diffRowsHtml = diffs
      .map((item) => {
        const subRows = (item.diffList || [])
          .map(
            (df) => `
              <tr>
                <td><code>${escapeHtml(item.idBarang)}</code></td>
                <td>${escapeHtml(item.namaBarangSaatIni)}</td>
                <td><b>${escapeHtml(df.field)}</b></td>
                <td class="ai-diff-old">${escapeHtml(df.lama)}</td>
                <td class="ai-diff-new">${escapeHtml(df.baru)}</td>
              </tr>
            `
          )
          .join("");
        return subRows;
      })
      .join("");

    container.innerHTML = `
      <div class="ai-result-card ai-confirm-2step-card">
        <div class="ai-result-head">
          <div>
            <strong><i class="fas fa-shield-halved"></i> Konfirmasi 2 Langkah — Edit Master Barang (${escapeHtml(String(data.cabang || "").toUpperCase())})</strong>
            <div class="ai-sub-meta">${escapeHtml(data.ringkasan || "Periksa tabel perubahan di bawah sebelum menerapkan ke Google Sheets.")}</div>
          </div>
          <span class="ai-badge ai-badge-amber">Belum Disimpan</span>
        </div>

        ${warnHtml}

        <div class="ai-table-wrap">
          <table class="ai-table">
            <thead>
              <tr>
                <th>ID Barang</th>
                <th>Nama Barang</th>
                <th>Kolom Diubah</th>
                <th>Nilai Lama</th>
                <th>Nilai Baru</th>
              </tr>
            </thead>
            <tbody>${diffRowsHtml}</tbody>
          </table>
        </div>

        <div class="ai-action-bar">
          <button type="button" id="btn-ai-barang-cancel" class="ai-btn ai-btn-secondary">
            <i class="fas fa-times"></i> Batal
          </button>
          <button type="button" id="btn-ai-barang-confirm" class="ai-btn ai-btn-primary">
            <i class="fas fa-check-double"></i> Konfirmasi &amp; Terapkan (${diffs.length} Barang)
          </button>
        </div>
      </div>
    `;
  }

  async function handleConfirmExecuteMasterBarang(btn) {
    if (!state.pendingPreview || !state.pendingPreview.previewToken) {
      showToast("Token preview tidak ditemukan. Ulangi langkah Preview.", "error");
      return;
    }
    if (state.execBarangBusy) return;

    state.execBarangBusy = true;
    setBtnLoading(btn, true, "Menerapkan ke Sheet...");
    const reqId = newReqId("AIBRG");

    try {
      const res = await callApi(
        "executeEditMasterBarangAI",
        {
          cabang: state.pendingPreview.cabang,
          previewToken: state.pendingPreview.previewToken
        },
        reqId
      );

      const resultEl = document.getElementById("ai-admin-result");
      if (!res || !res.sukses) {
        showToast((res && res.pesan) || "Gagal menerapkan perubahan Master Barang.", "error");
        return;
      }

      state.pendingPreview = null;
      showToast(res.pesan || "Master Barang berhasil diperbarui!", "success");
      if (resultEl) {
        resultEl.innerHTML = `
          <div class="ai-alert ai-alert-success">
            <strong><i class="fas fa-check-circle"></i> Selesai!</strong> ${escapeHtml(res.pesan || "Perubahan telah disimpan ke MASTER BARANG dan dicatat di AUDIT_LOG.")}
          </div>
        `;
      }
    } catch (err) {
      showToast("Error eksekusi: " + (err.message || err), "error");
    } finally {
      state.execBarangBusy = false;
      setBtnLoading(btn, false);
    }
  }

  // ==========================================================================
  // DYNAMIC CONFIG ENGINE (APP_CONFIG) + 1-KLIK ROLLBACK
  // ==========================================================================

  async function loadAppConfigAdmin() {
    const listEl = document.getElementById("ai-config-list");
    if (!listEl || state.configLoading) return;
    state.configLoading = true;
    listEl.innerHTML = `<div class="ai-loading-box"><i class="fas fa-spinner fa-spin"></i> Memuat APP_CONFIG...</div>`;

    try {
      const res = await callApi("listAppConfigAdmin", {});
      if (!res || !res.sukses || !res.data) {
        listEl.innerHTML = `<div class="ai-alert ai-alert-danger">${escapeHtml((res && res.pesan) || "Gagal memuat APP_CONFIG.")}</div>`;
        return;
      }
      state.configItems = Array.isArray(res.data.items) ? res.data.items : [];
      const badgeEl = document.getElementById("ai-gemini-status-badge");
      if (badgeEl) {
        badgeEl.textContent = res.data.geminiConfigured
          ? `Gemini Aktif (${res.data.geminiModel || "-"})`
          : "GEMINI_API_KEY Belum Dipasang";
        badgeEl.className = res.data.geminiConfigured
          ? "ai-badge ai-badge-green"
          : "ai-badge ai-badge-red";
      }
      renderAppConfigList();
    } catch (err) {
      listEl.innerHTML = `<div class="ai-alert ai-alert-danger">Error: ${escapeHtml(err.message || err)}</div>`;
    } finally {
      state.configLoading = false;
    }
  }

  function renderAppConfigList() {
    const listEl = document.getElementById("ai-config-list");
    if (!listEl) return;
    if (state.configItems.length === 0) {
      listEl.innerHTML = `<div class="ai-empty-note">Belum ada parameter di tab APP_CONFIG.</div>`;
      return;
    }

    listEl.innerHTML = `
      <div class="ai-table-wrap">
        <table class="ai-table">
          <thead>
            <tr>
              <th>Key / Kategori</th>
              <th>Nilai Aktif</th>
              <th>Versi &amp; Nilai Sebelumnya</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody>
            ${state.configItems
              .map(
                (c) => `
              <tr>
                <td>
                  <code>${escapeHtml(c.configKey)}</code>
                  <div class="ai-sub-meta">${escapeHtml(c.category)} • ${escapeHtml(c.valueType)}</div>
                  ${c.description ? `<div class="ai-sub-meta">${escapeHtml(c.description)}</div>` : ""}
                </td>
                <td><strong>${escapeHtml(c.configValue)}</strong></td>
                <td>
                  <span class="ai-badge ai-badge-slate">v${Number(c.version || 1)}</span>
                  <div class="ai-sub-meta">Prev: ${c.canRollback ? escapeHtml(c.previousValue) : "<i>belum ada</i>"}</div>
                  <div class="ai-sub-meta">${escapeHtml(c.updatedAtWIB || "")} (${escapeHtml(c.updatedBy || "-")})</div>
                </td>
                <td>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <button type="button" class="ai-btn ai-btn-secondary ai-btn-sm btn-ai-cfg-fill" data-key="${escapeHtml(c.configKey)}">
                      <i class="fas fa-pen"></i> Edit
                    </button>
                    <button type="button" class="ai-btn ai-btn-warning ai-btn-sm btn-ai-cfg-rollback" data-key="${escapeHtml(c.configKey)}" ${c.canRollback ? "" : "disabled"}>
                      <i class="fas fa-rotate-left"></i> Rollback
                    </button>
                  </div>
                </td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  async function handleSaveAppConfig(btn) {
    if (!isAdminRole() || state.configBusy) return;
    const keyEl = document.getElementById("ai-cfg-key");
    const valEl = document.getElementById("ai-cfg-val");
    const typeEl = document.getElementById("ai-cfg-type");
    const catEl = document.getElementById("ai-cfg-cat");
    const descEl = document.getElementById("ai-cfg-desc");

    const configKey = keyEl ? String(keyEl.value || "").trim().toUpperCase() : "";
    const configValue = valEl ? String(valEl.value || "").trim() : "";
    if (!configKey || configValue === "") {
      showToast("Config Key dan Nilai wajib diisi.", "error");
      return;
    }

    state.configBusy = true;
    setBtnLoading(btn, true, "Menyimpan...");
    try {
      const res = await callApi(
        "updateAppConfigAdmin",
        {
          configKey,
          configValue,
          valueType: typeEl ? typeEl.value : "STRING",
          category: catEl ? catEl.value : "SYSTEM",
          description: descEl ? String(descEl.value || "").trim() : ""
        },
        newReqId("CFG")
      );
      if (!res || !res.sukses) {
        showToast((res && res.pesan) || "Gagal menyimpan konfigurasi.", "error");
        return;
      }
      showToast(res.pesan || "Konfigurasi berhasil diperbarui.", "success");
      await loadAppConfigAdmin();
    } catch (err) {
      showToast("Error simpan config: " + (err.message || err), "error");
    } finally {
      state.configBusy = false;
      setBtnLoading(btn, false);
    }
  }

  function promptRollbackConfig(configKey) {
    const item = state.configItems.find((c) => c.configKey === configKey);
    if (!item || !item.canRollback) return;

    openConfirmModal({
      title: "Konfirmasi Rollback Konfigurasi",
      okLabel: "Ya, Rollback Sekarang",
      danger: true,
      bodyHtml: `
        Kembalikan parameter <code>${escapeHtml(item.configKey)}</code>?<br/><br/>
        • Nilai Saat Ini: <b>${escapeHtml(item.configValue)}</b><br/>
        • Akan Dikembalikan Ke: <b style="color:#059669;">${escapeHtml(item.previousValue)}</b>
      `,
      onConfirm: async () => {
        const res = await callApi("rollbackAppConfigAdmin", { configKey: item.configKey }, newReqId("RBK"));
        if (!res || !res.sukses) {
          showToast((res && res.pesan) || "Rollback gagal.", "error");
          return;
        }
        showToast(res.pesan || "Rollback berhasil!", "success");
        await loadAppConfigAdmin();
      }
    });
  }

  // ==========================================================================
  // BAGIAN 2: INBOX SMART PASTE WA (#page-inbox-paste)
  // ==========================================================================

  function canAccessInbox() {
    const session = getSession();
    return Boolean(session && session.token && INBOX_ALLOWED_ROLES.includes(session.activeRole));
  }

  async function loadInboxPage() {
    const guardEl = document.getElementById("inbox-guard");
    const mainEl = document.getElementById("inbox-main");

    if (!canAccessInbox()) {
      if (guardEl) {
        guardEl.style.display = "block";
        guardEl.innerHTML = `<div class="ai-alert ai-alert-danger">Peran Anda tidak memiliki akses ke Inbox Smart Paste WA.</div>`;
      }
      if (mainEl) mainEl.style.display = "none";
      return;
    }

    if (guardEl) guardEl.style.display = "none";
    if (mainEl) mainEl.style.display = "block";

    const cbSel = document.getElementById("inbox-paste-cabang");
    if (cbSel) cbSel.value = state.inboxCabang;

    syncInboxFilterUI();
    await loadInboxQueue();
  }

  function syncInboxFilterUI() {
    document.querySelectorAll(".inbox-status-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-status") === state.inboxStatusFilter);
    });
  }

  async function handleAnalyzeWA(btn) {
    if (!canAccessInbox() || state.inboxAnalyzeBusy) return;

    const rawEl = document.getElementById("inbox-wa-raw");
    const cbSel = document.getElementById("inbox-paste-cabang");
    const chSel = document.getElementById("inbox-paste-channel");

    const rawText = rawEl ? String(rawEl.value || "").trim() : "";
    const cabang = cbSel ? String(cbSel.value || "korpri").toLowerCase() : state.inboxCabang;
    const sumberChannel = chSel ? String(chSel.value || "WHATSAPP") : "WHATSAPP";
    state.inboxCabang = cabang;

    if (rawText.length < 3) {
      showToast("Tempelkan teks pesanan WhatsApp terlebih dahulu.", "error");
      if (rawEl) rawEl.focus();
      return;
    }

    state.inboxAnalyzeBusy = true;
    setBtnLoading(btn, true, "Menganalisa dengan AI...");

    try {
      const res = await callApi(
        "parseSmartPasteWA",
        { cabang, rawText, sumberChannel, autoSave: true },
        newReqId("WA")
      );

      if (!res || !res.sukses || !res.data) {
        showToast((res && res.pesan) || "Gagal menganalisa teks WhatsApp.", "error");
        return;
      }

      state.activeDraft = res.data;
      renderInboxPreviewForm(res.data);
      showToast(res.pesan || "Teks WA berhasil dianalisa! Periksa & edit bila perlu.", "success");
      await loadInboxQueue();
    } catch (err) {
      showToast("Gangguan saat menghubungi Gemini AI: " + (err.message || err), "error");
    } finally {
      state.inboxAnalyzeBusy = false;
      setBtnLoading(btn, false);
    }
  }

  function renderInboxPreviewForm(draft) {
    const wrap = document.getElementById("inbox-preview-wrap");
    if (!wrap) return;
    if (!draft) {
      wrap.style.display = "none";
      wrap.innerHTML = "";
      return;
    }

    const items = Array.isArray(draft.items) ? draft.items : [];
    const unmatched = Array.isArray(draft.unmatchedItems) ? draft.unmatchedItems : [];

    const unmatchedHtml =
      unmatched.length > 0
        ? `<div class="ai-alert ai-alert-warning" style="margin-bottom:12px;">
            <strong><i class="fas fa-triangle-exclamation"></i> ${unmatched.length} Item Belum Cocok di Master Barang:</strong>
            <ul style="margin:6px 0 0 18px;padding:0;">
              ${unmatched.map((u) => `<li>${escapeHtml(u.namaMentah || u.namaBarang)} (Qty: ${escapeHtml(u.qty)} ${escapeHtml(u.satuan || "Pcs")})</li>`).join("")}
            </ul>
          </div>`
        : "";

    const rowsHtml = items
      .map(
        (it, idx) => `
        <tr data-idx="${idx}">
          <td>
            <input type="text" class="ai-input inb-item-id" value="${escapeHtml(it.idBarang || "")}" placeholder="ID" style="width:82px;" />
          </td>
          <td>
            <input type="text" class="ai-input inb-item-nama" value="${escapeHtml(it.namaBarang || "")}" placeholder="Nama barang" />
          </td>
          <td>
            <input type="number" min="1" class="ai-input inb-item-qty" value="${Number(it.qty || 1)}" style="width:70px;" />
          </td>
          <td>
            <input type="number" min="0" class="ai-input inb-item-harga" value="${Number(it.hargaJual || 0)}" style="width:110px;" />
          </td>
          <td>
            <button type="button" class="ai-btn ai-btn-danger ai-btn-sm btn-inb-del-item" title="Hapus baris">&times;</button>
          </td>
        </tr>
      `
      )
      .join("");

    wrap.style.display = "block";
    wrap.innerHTML = `
      <div class="ai-result-card">
        <div class="ai-result-head">
          <div>
            <strong>Pratinjau &amp; Edit Manual Pesanan WA</strong>
            <div class="ai-sub-meta">ID: <code>${escapeHtml(draft.inboxId)}</code> • Cabang: <b>${escapeHtml(String(draft.cabang || "").toUpperCase())}</b></div>
          </div>
          <span class="ai-badge ai-badge-blue">Estimasi: ${formatRp(draft.estimasiTotal)}</span>
        </div>

        ${unmatchedHtml}

        <div class="ai-form-grid">
          <div>
            <label>Nama Pelanggan</label>
            <input type="text" id="inb-ed-pelanggan" class="ai-input" value="${escapeHtml(draft.namaPelanggan || "")}" />
          </div>
          <div>
            <label>No. HP / WA</label>
            <input type="text" id="inb-ed-hp" class="ai-input" value="${escapeHtml(draft.noHp || "")}" />
          </div>
          <div>
            <label>Tipe Layanan</label>
            <select id="inb-ed-layanan" class="ai-input">
              <option value="AMBIL_TOKO" ${draft.tipeLayanan !== "ANTAR_SUPIR" ? "selected" : ""}>Ambil di Toko (Kasir)</option>
              <option value="ANTAR_SUPIR" ${draft.tipeLayanan === "ANTAR_SUPIR" ? "selected" : ""}>Antar Supir</option>
            </select>
          </div>
          <div>
            <label>Jadwal Ambil / Antar (Opsional)</label>
            <input type="text" id="inb-ed-jadwal" class="ai-input" placeholder="YYYY-MM-DD HH:mm" value="${escapeHtml(draft.jadwalWIB || "")}" />
          </div>
          <div class="ai-col-span-2">
            <label>Alamat Pengantaran</label>
            <input type="text" id="inb-ed-alamat" class="ai-input" value="${escapeHtml(draft.alamat || "")}" />
          </div>
          <div class="ai-col-span-2">
            <label>Catatan</label>
            <input type="text" id="inb-ed-catatan" class="ai-input" value="${escapeHtml(draft.catatan || "")}" />
          </div>
        </div>

        <div style="margin-top:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong>Daftar Item Cocok</strong>
            <button type="button" id="btn-inb-add-item" class="ai-btn ai-btn-secondary ai-btn-sm">
              <i class="fas fa-plus"></i> Tambah Baris Item
            </button>
          </div>
          <div class="ai-table-wrap">
            <table class="ai-table">
              <thead>
                <tr><th>ID</th><th>Nama Barang</th><th>Qty</th><th>Harga Jual</th><th></th></tr>
              </thead>
              <tbody id="inb-ed-items-body">${rowsHtml}</tbody>
            </table>
          </div>
        </div>

        <div class="ai-action-bar">
          <button type="button" id="btn-inb-discard-preview" class="ai-btn ai-btn-secondary">
            Tutup Pratinjau
          </button>
          <button type="button" id="btn-inb-save-preview" class="ai-btn ai-btn-primary">
            <i class="fas fa-save"></i> Simpan Perubahan ke INBOX_PESANAN
          </button>
        </div>
      </div>
    `;
  }

  function collectEditedItemsFromPreview() {
    const tbody = document.getElementById("inb-ed-items-body");
    if (!tbody) return [];
    const out = [];
    tbody.querySelectorAll("tr").forEach((tr) => {
      const idBarang = String(tr.querySelector(".inb-item-id")?.value || "").trim();
      const namaBarang = String(tr.querySelector(".inb-item-nama")?.value || "").trim();
      const qty = Math.max(1, Number(tr.querySelector(".inb-item-qty")?.value) || 1);
      const hargaJual = Math.max(0, Number(tr.querySelector(".inb-item-harga")?.value) || 0);
      if (namaBarang) {
        out.push({
          matched: Boolean(idBarang),
          idBarang,
          namaBarang,
          qty,
          hargaJual,
          subtotal: Math.round(qty * hargaJual),
          satuan: "Pcs"
        });
      }
    });
    return out;
  }

  async function handleSavePreviewDraft(btn) {
    if (!state.activeDraft || state.inboxSaveBusy) return;
    state.inboxSaveBusy = true;
    setBtnLoading(btn, true, "Menyimpan...");

    try {
      const items = collectEditedItemsFromPreview();
      const payload = {
        inboxId: state.activeDraft.inboxId,
        status: state.activeDraft.status || "BARU",
        namaPelanggan: String(document.getElementById("inb-ed-pelanggan")?.value || "Umum").trim(),
        noHp: String(document.getElementById("inb-ed-hp")?.value || "").trim(),
        alamat: String(document.getElementById("inb-ed-alamat")?.value || "").trim(),
        tipeLayanan: String(document.getElementById("inb-ed-layanan")?.value || "AMBIL_TOKO"),
        jadwalWIB: String(document.getElementById("inb-ed-jadwal")?.value || "").trim(),
        catatan: String(document.getElementById("inb-ed-catatan")?.value || "").trim(),
        items
      };

      const res = await callApi("updateInboxPesanan", payload, newReqId("INBUPD"));
      if (!res || !res.sukses) {
        showToast((res && res.pesan) || "Gagal menyimpan perubahan Inbox.", "error");
        return;
      }

      showToast("Perubahan pesanan WA berhasil disimpan!", "success");
      const rawEl = document.getElementById("inbox-wa-raw");
      if (rawEl) rawEl.value = "";
      state.activeDraft = null;
      renderInboxPreviewForm(null);
      await loadInboxQueue();
    } catch (err) {
      showToast("Error simpan preview: " + (err.message || err), "error");
    } finally {
      state.inboxSaveBusy = false;
      setBtnLoading(btn, false);
    }
  }

  async function loadInboxQueue() {
    const listEl = document.getElementById("inbox-queue-list");
    if (!listEl || state.inboxLoading) return;
    state.inboxLoading = true;
    listEl.innerHTML = `<div class="ai-loading-box"><i class="fas fa-spinner fa-spin"></i> Memuat antrean pesanan WA...</div>`;

    try {
      const session = getSession();
      const cabangParam =
        session && (session.activeCabang === "korpri" || session.activeCabang === "pringsewu")
          ? session.activeCabang
          : "all";

      const res = await callApi("getInboxPesanan", {
        cabang: cabangParam,
        status: state.inboxStatusFilter,
        limit: 60
      });

      if (!res || !res.sukses || !res.data) {
        listEl.innerHTML = `<div class="ai-alert ai-alert-danger">${escapeHtml((res && res.pesan) || "Gagal memuat antrean Inbox.")}</div>`;
        return;
      }

      state.inboxQueue = Array.isArray(res.data.items) ? res.data.items : [];
      renderInboxQueue();
    } catch (err) {
      listEl.innerHTML = `<div class="ai-alert ai-alert-danger">Error: ${escapeHtml(err.message || err)}</div>`;
    } finally {
      state.inboxLoading = false;
    }
  }

  function renderInboxQueue() {
    const listEl = document.getElementById("inbox-queue-list");
    if (!listEl) return;

    if (state.inboxQueue.length === 0) {
      listEl.innerHTML = `<div class="ai-empty-note">Tidak ada pesanan pada status <b>${escapeHtml(state.inboxStatusFilter)}</b>.</div>`;
      return;
    }

    listEl.innerHTML = state.inboxQueue
      .map((it) => {
        const badgeCls =
          it.status === "BARU"
            ? "ai-badge-blue"
            : it.status === "DIPROSES"
            ? "ai-badge-amber"
            : it.status === "SELESAI"
            ? "ai-badge-green"
            : "ai-badge-red";

        const itemsSummary = (it.items || [])
          .map((x) => `${escapeHtml(x.namaBarang)} ×${Number(x.qty || 1)}`)
          .join(", ");

        const unmatchedCount = (it.unmatchedItems || []).length;
        const canAct = it.status !== "BATAL" && it.status !== "SELESAI";

        return `
          <div class="inbox-queue-card" data-inbox-id="${escapeHtml(it.inboxId)}">
            <div class="inbox-card-head">
              <div>
                <span class="ai-badge ${badgeCls}">${escapeHtml(it.status)}</span>
                <span class="ai-badge ai-badge-slate">${escapeHtml(String(it.cabang || "").toUpperCase())}</span>
                <span class="ai-badge ai-badge-slate">${it.tipeLayanan === "ANTAR_SUPIR" ? "Antar Supir" : "Ambil Toko"}</span>
              </div>
              <small style="color:#64748b;">${escapeHtml(it.createdAtWIB)} WIB</small>
            </div>

            <div class="inbox-card-title">
              ${escapeHtml(it.namaPelanggan)} ${it.noHp ? `<small>(${escapeHtml(it.noHp)})</small>` : ""}
            </div>
            ${it.alamat ? `<div class="ai-sub-meta"><i class="fas fa-location-dot"></i> ${escapeHtml(it.alamat)}</div>` : ""}
            ${it.jadwalWIB ? `<div class="ai-sub-meta"><i class="fas fa-calendar"></i> Jadwal: ${escapeHtml(it.jadwalWIB)}</div>` : ""}

            <div class="inbox-card-items">
              <strong>Item:</strong> ${itemsSummary || "<i>Belum ada item cocok</i>"}
              ${unmatchedCount > 0 ? `<span class="ai-badge ai-badge-amber">+${unmatchedCount} belum cocok</span>` : ""}
            </div>
            ${it.catatan ? `<div class="ai-sub-meta">Catatan: ${escapeHtml(it.catatan)}</div>` : ""}
            ${it.voidReason ? `<div class="ai-sub-meta" style="color:#dc2626;">Alasan Batal: ${escapeHtml(it.voidReason)}</div>` : ""}

            <div class="inbox-card-footer">
              <strong>Estimasi: ${formatRp(it.estimasiTotal)}</strong>
              <div class="inbox-card-actions">
                ${
                  canAct
                    ? `
                  <button type="button" class="ai-btn ai-btn-secondary ai-btn-sm btn-inb-edit" data-id="${escapeHtml(it.inboxId)}">
                    <i class="fas fa-pen"></i> Edit
                  </button>
                  <button type="button" class="ai-btn ai-btn-primary ai-btn-sm btn-inb-kasir" data-id="${escapeHtml(it.inboxId)}">
                    <i class="fas fa-cash-register"></i> Proses ke Kasir
                  </button>
                  <button type="button" class="ai-btn ai-btn-teal ai-btn-sm btn-inb-supir" data-id="${escapeHtml(it.inboxId)}">
                    <i class="fas fa-truck-fast"></i> Buat Tugas Supir
                  </button>
                  <button type="button" class="ai-btn ai-btn-success ai-btn-sm btn-inb-selesai" data-id="${escapeHtml(it.inboxId)}">
                    <i class="fas fa-check"></i> Selesai
                  </button>
                  <button type="button" class="ai-btn ai-btn-danger ai-btn-sm btn-inb-cancel" data-id="${escapeHtml(it.inboxId)}">
                    <i class="fas fa-ban"></i> Batalkan
                  </button>
                `
                    : ""
                }
              </div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  async function ensureBranchDataLoaded(targetCabang, targetModule) {
    // Tunggu reload MASTER BARANG & PELANGGAN cabang tujuan sebelum draft diterapkan
    if (window.POS_RETAIL) {
      if (typeof window.POS_RETAIL.loadBootstrapData === "function") {
        await window.POS_RETAIL.loadBootstrapData(true);
      } else if (typeof window.POS_RETAIL.refreshBootstrap === "function") {
        await window.POS_RETAIL.refreshBootstrap(targetCabang);
      }
    }
    if (targetModule === "TUGAS_SUPIR" && window.POS_DRIVER_CUSTOMER) {
      if (typeof window.POS_DRIVER_CUSTOMER.loadPelanggan === "function") {
        await window.POS_DRIVER_CUSTOMER.loadPelanggan(true);
      }
      if (typeof window.POS_DRIVER_CUSTOMER.loadTugasSupir === "function") {
        await window.POS_DRIVER_CUSTOMER.loadTugasSupir(true);
      }
    }
  }

  async function handleConvertInbox(inboxId, target, btn) {
    setBtnLoading(btn, true, "Mengunci & menyiapkan...");
    try {
      const res = await callApi(
        "konversiInboxKeDraft",
        { inboxId, target, markAsProcessing: true },
        newReqId("INBCONV")
      );
      if (!res || !res.sukses || !res.data) {
        showToast((res && res.pesan) || "Gagal menyiapkan draft.", "error");
        await loadInboxQueue();
        return;
      }

      const draft = res.data;
      try {
        sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      } catch (e) {}

      // Pindah cabang otomatis jika berbeda, lalu WAJIB tunggu reload MASTER BARANG & PELANGGAN selesai
      const session = getSession();
      const switchedBranch = Boolean(
        draft.cabang &&
        session &&
        session.activeCabang !== draft.cabang &&
        window.POS_AUTH &&
        typeof window.POS_AUTH.onBranchSwitch === "function"
      );

      if (switchedBranch) {
        setBtnLoading(btn, true, `Memuat data cabang ${draft.cabang.toUpperCase()}...`);
        await window.POS_AUTH.onBranchSwitch(draft.cabang);
        await ensureBranchDataLoaded(draft.cabang, target);
      }

      window.dispatchEvent(new CustomEvent("pos:inboxDraftReady", { detail: draft }));

      if (target === "KASIR_RETAIL") {
        navigateToPage("page-kasir");
        if (window.POS_RETAIL && typeof window.POS_RETAIL.applyInboxDraft === "function") {
          await window.POS_RETAIL.applyInboxDraft(draft);
        }
      } else {
        navigateToPage("page-supir");
        if (
          window.POS_DRIVER_CUSTOMER &&
          typeof window.POS_DRIVER_CUSTOMER.openMulaiAntarFromInbox === "function"
        ) {
          await window.POS_DRIVER_CUSTOMER.openMulaiAntarFromInbox(draft);
        }
      }

      loadInboxQueue();
    } catch (err) {
      showToast("Error konversi: " + (err.message || err), "error");
    } finally {
      setBtnLoading(btn, false);
    }
  }

  function promptCancelInbox(inboxId) {
    const item = state.inboxQueue.find((x) => x.inboxId === inboxId);
    openConfirmModal({
      title: "Batalkan Pesanan Inbox WA",
      okLabel: "Ya, Batalkan (Soft-Cancel)",
      danger: true,
      requireReason: true,
      bodyHtml: `Batalkan pesanan <b>${escapeHtml(item ? item.namaPelanggan : inboxId)}</b>? Data tetap tersimpan di arsip dengan status <b>BATAL</b> (tidak dihapus permanen).`,
      onConfirm: async (reason) => {
        const res = await callApi(
          "updateInboxPesanan",
          { inboxId, status: "BATAL", voidReason: reason },
          newReqId("INBVOID")
        );
        if (!res || !res.sukses) {
          showToast((res && res.pesan) || "Gagal membatalkan pesanan.", "error");
          return;
        }
        showToast("Pesanan ditandai BATAL.", "success");
        await loadInboxQueue();
      }
    });
  }

  async function handleMarkInboxDone(inboxId, btn) {
    setBtnLoading(btn, true, "...");
    try {
      const res = await callApi("updateInboxPesanan", { inboxId, status: "SELESAI" }, newReqId("INBDONE"));
      if (!res || !res.sukses) {
        showToast((res && res.pesan) || "Gagal memperbarui status.", "error");
        return;
      }
      showToast("Pesanan ditandai SELESAI.", "success");
      await loadInboxQueue();
    } finally {
      setBtnLoading(btn, false);
    }
  }

  // ==========================================================================
  // GLOBAL EVENT DELEGATION & PAGE OBSERVER
  // ==========================================================================

  function bindGlobalEvents() {
    document.addEventListener("click", async (e) => {
      const t = e.target;

      // Modal Konfirmasi
      if (t.closest("#btn-ai-modal-close") || t.closest("#btn-ai-modal-cancel")) {
        closeConfirmModal();
        return;
      }
      if (t.closest("#btn-ai-modal-ok")) {
        if (!state.modalCallback) return closeConfirmModal();
        const reasonInput = document.getElementById("ai-modal-reason-input");
        const reason = reasonInput ? String(reasonInput.value || "").trim() : "";
        if (state.modalCallback.requireReason && reason.length < 3) {
          showToast("Alasan wajib diisi minimal 3 karakter.", "error");
          if (reasonInput) reasonInput.focus();
          return;
        }
        const okBtn = t.closest("#btn-ai-modal-ok");
        const cb = state.modalCallback.onConfirm;
        setBtnLoading(okBtn, true, "Memproses...");
        try {
          await cb(reason);
        } finally {
          closeConfirmModal();
        }
        return;
      }

      // Asisten AI Admin: pilih mode
      const modeBtn = t.closest(".ai-mode-btn");
      if (modeBtn) {
        state.aiMode = modeBtn.getAttribute("data-mode") || "auto";
        syncAiModeUI();
        return;
      }

      // Asisten AI Admin: submit prompt
      const btnAiSubmit = t.closest("#btn-ai-admin-submit");
      if (btnAiSubmit) {
        handleAiAdminSubmit(btnAiSubmit);
        return;
      }

      // Asisten AI Admin: Konfirmasi 2 Langkah Edit Barang
      if (t.closest("#btn-ai-barang-cancel")) {
        state.pendingPreview = null;
        const resultEl = document.getElementById("ai-admin-result");
        if (resultEl) resultEl.innerHTML = `<div class="ai-empty-note">Preview dibatalkan. Tidak ada data yang diubah.</div>`;
        return;
      }
      const btnExecBarang = t.closest("#btn-ai-barang-confirm");
      if (btnExecBarang) {
        handleConfirmExecuteMasterBarang(btnExecBarang);
        return;
      }

      // Dynamic Config Panel
      if (t.closest("#btn-ai-config-refresh")) {
        loadAppConfigAdmin();
        return;
      }
      const btnSaveCfg = t.closest("#btn-ai-cfg-save");
      if (btnSaveCfg) {
        handleSaveAppConfig(btnSaveCfg);
        return;
      }
      const btnFillCfg = t.closest(".btn-ai-cfg-fill");
      if (btnFillCfg) {
        const key = btnFillCfg.getAttribute("data-key");
        const item = state.configItems.find((c) => c.configKey === key);
        if (item) {
          const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
          setVal("ai-cfg-key", item.configKey);
          setVal("ai-cfg-val", item.configValue);
          setVal("ai-cfg-type", item.valueType || "STRING");
          setVal("ai-cfg-cat", item.category || "SYSTEM");
          setVal("ai-cfg-desc", item.description || "");
          document.getElementById("ai-cfg-val")?.focus();
        }
        return;
      }
      const btnRollback = t.closest(".btn-ai-cfg-rollback");
      if (btnRollback) {
        promptRollbackConfig(btnRollback.getAttribute("data-key"));
        return;
      }

      // Inbox Smart Paste WA
      const btnAnalyze = t.closest("#btn-inbox-analyze");
      if (btnAnalyze) {
        handleAnalyzeWA(btnAnalyze);
        return;
      }
      if (t.closest("#btn-inb-add-item")) {
        const tbody = document.getElementById("inb-ed-items-body");
        if (tbody) {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td><input type="text" class="ai-input inb-item-id" placeholder="ID" style="width:82px;" /></td>
            <td><input type="text" class="ai-input inb-item-nama" placeholder="Nama barang" /></td>
            <td><input type="number" min="1" class="ai-input inb-item-qty" value="1" style="width:70px;" /></td>
            <td><input type="number" min="0" class="ai-input inb-item-harga" value="0" style="width:110px;" /></td>
            <td><button type="button" class="ai-btn ai-btn-danger ai-btn-sm btn-inb-del-item">&times;</button></td>
          `;
          tbody.appendChild(tr);
        }
        return;
      }
      if (t.closest(".btn-inb-del-item")) {
        t.closest("tr")?.remove();
        return;
      }
      if (t.closest("#btn-inb-discard-preview")) {
        state.activeDraft = null;
        renderInboxPreviewForm(null);
        return;
      }
      const btnSavePrev = t.closest("#btn-inb-save-preview");
      if (btnSavePrev) {
        handleSavePreviewDraft(btnSavePrev);
        return;
      }

      // Inbox Queue Filter & Actions
      const statusBtn = t.closest(".inbox-status-btn");
      if (statusBtn) {
        state.inboxStatusFilter = statusBtn.getAttribute("data-status") || "BARU";
        syncInboxFilterUI();
        loadInboxQueue();
        return;
      }
      if (t.closest("#btn-inbox-refresh")) {
        loadInboxQueue();
        return;
      }
      const btnEditInb = t.closest(".btn-inb-edit");
      if (btnEditInb) {
        const found = state.inboxQueue.find((x) => x.inboxId === btnEditInb.getAttribute("data-id"));
        if (found) {
          state.activeDraft = found;
          renderInboxPreviewForm(found);
          document.getElementById("inbox-preview-wrap")?.scrollIntoView({ behavior: "smooth" });
        }
        return;
      }
      const btnKasir = t.closest(".btn-inb-kasir");
      if (btnKasir) {
        handleConvertInbox(btnKasir.getAttribute("data-id"), "KASIR_RETAIL", btnKasir);
        return;
      }
      const btnSupir = t.closest(".btn-inb-supir");
      if (btnSupir) {
        handleConvertInbox(btnSupir.getAttribute("data-id"), "TUGAS_SUPIR", btnSupir);
        return;
      }
      const btnSelesai = t.closest(".btn-inb-selesai");
      if (btnSelesai) {
        handleMarkInboxDone(btnSelesai.getAttribute("data-id"), btnSelesai);
        return;
      }
      const btnCancel = t.closest(".btn-inb-cancel");
      if (btnCancel) {
        promptCancelInbox(btnCancel.getAttribute("data-id"));
        return;
      }

      // Cadangan klik sidebar langsung
      if (t.closest('[data-page="page-asisten-ai"], [data-target="page-asisten-ai"]')) {
        setTimeout(() => loadAsistenAiPage(), 100);
        return;
      }
      if (t.closest('[data-page="page-inbox-paste"], [data-target="page-inbox-paste"]')) {
        setTimeout(() => loadInboxPage(), 100);
      }
    });
  }

  function observePages() {
    const aiSec = document.getElementById("page-asisten-ai");
    const inboxSec = document.getElementById("page-inbox-paste");

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        if (m.attributeName !== "class") return;
        if (m.target === aiSec && aiSec.classList.contains("active")) {
          loadAsistenAiPage();
        } else if (m.target === inboxSec && inboxSec.classList.contains("active")) {
          loadInboxPage();
        }
      });
    });

    if (aiSec) observer.observe(aiSec, { attributes: true });
    if (inboxSec) observer.observe(inboxSec, { attributes: true });
  }

  function getActiveDraftFromStorage() {
    try {
      const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    const session = getSession();
    if (session && (session.activeCabang === "korpri" || session.activeCabang === "pringsewu")) {
      state.aiCabang = session.activeCabang;
      state.inboxCabang = session.activeCabang;
    }

    bindGlobalEvents();
    observePages();

    const aiSec = document.getElementById("page-asisten-ai");
    const inboxSec = document.getElementById("page-inbox-paste");
    if (aiSec && aiSec.classList.contains("active")) loadAsistenAiPage();
    if (inboxSec && inboxSec.classList.contains("active")) loadInboxPage();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    init,
    loadAsistenAiPage,
    loadInboxPage,
    loadAppConfigAdmin,
    loadInboxQueue,
    getActiveDraftFromStorage
  };
})();