/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.2 — FRONTEND MODUL PROYEK DAMIU & MUTASI CABANG
 * File: js/damiu_mutasi.js
 * ============================================================================
 * Fitur:
 * - Proyek DAMIU: daftar proyek, buat/edit (+link pelanggan & Calendar),
 *   kelola biaya (STOK_TOKO / BELI_LUAR / JASA_TUKANG + kompresi foto nota <200KB
 *   + Talangan/Reimburse), pembayaran termin, kalkulasi margin real-time, void aman.
 * - Mutasi Antar Cabang: tab Antrean Masuk / Dikirim / Riwayat, form transfer STOK
 *   (multi-item + cek stok asal) & KAS (COA 199-MUTASI_CABANG), verifikasi terima & batal.
 * - Anti-Bug Cache Modal: seluruh buka/tutup modal memakai fallback inline display.
 */

window.POS_DAMIU_MUTASI = (function () {
  "use strict";

  const state = {
    proyekList: [],
    proyekSummary: null,
    activeProyekId: "",
    activeDetailTab: "biaya",
    pelangganList: [],
    barangList: [],
    barangLoadedForBranch: "",
    mutasiList: [],
    mutasiCounts: {
      perluVerifikasiMasuk: 0,
      dikirimKeluar: 0,
      diterima: 0,
      batal: 0
    },
    mutasiTab: "MASUK", // MASUK | KELUAR | RIWAYAT
    mutasiCart: [],
    notaBase64: "",
    notaMime: "image/jpeg",
    initialized: false
  };

  // ==========================================================================
  // UTILITAS UMUM, FORMATTER, MODAL ANTI-CACHE & KOMPRESI FOTO CANVAS
  // ==========================================================================

  function $(id) {
    return document.getElementById(id);
  }

  function escHtml(str) {
    return String(str === null || str === undefined ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatRp(num) {
    const n = Math.round(Number(num) || 0);
    const sign = n < 0 ? "-" : "";
    return sign + "Rp " + Math.abs(n).toLocaleString("id-ID");
  }

  function todayWIB() {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const wib = new Date(utc + 7 * 3600000);
    const y = wib.getFullYear();
    const m = String(wib.getMonth() + 1).padStart(2, "0");
    const d = String(wib.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function getSession() {
    return window.POS_AUTH && typeof window.POS_AUTH.getSession === "function"
      ? window.POS_AUTH.getSession()
      : null;
  }

  function getActiveBranch() {
    const s = getSession();
    return s && s.activeCabang ? String(s.activeCabang).toLowerCase() : "";
  }

  function notify(msg, type = "info") {
    if (window.POS_UI && typeof window.POS_UI.showToast === "function") {
      window.POS_UI.showToast(msg, type);
      return;
    }
    if (typeof window.showToast === "function") {
      window.showToast(msg, type);
      return;
    }
    let toast = $("dm-fallback-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "dm-fallback-toast";
      toast.style.cssText =
        "position:fixed;bottom:20px;right:20px;z-index:99999;padding:12px 18px;border-radius:10px;color:#fff;font-size:14px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.2);max-width:360px;";
      document.body.appendChild(toast);
    }
    toast.style.background =
      type === "error" ? "#dc2626" : type === "success" ? "#16a34a" : "#0f172a";
    toast.textContent = msg;
    toast.style.display = "block";
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.display = "none";
    }, 3800);
  }

  // Fallback inline display (pelajaran anti-bug cache modal dari Fase 3)
  function openModal(modalId) {
    const el = $(modalId);
    if (!el) return;
    el.classList.add("show");
    el.style.display = "flex";
  }

  function closeModal(modalId) {
    const el = $(modalId);
    if (!el) return;
    el.classList.remove("show");
    el.style.display = "none";
  }

  /**
   * Kompresi foto nota HTML5 Canvas (maks lebar 1024px, kualitas JPEG bertahap < 200 KB)
   */
  function compressImageToUnder200KB(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith("image/")) {
        reject(new Error("File harus berupa gambar (JPG/PNG)."));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Gagal membaca file gambar."));
      reader.onload = (ev) => {
        const img = new Image();
        img.onerror = () => reject(new Error("Gambar tidak valid atau rusak."));
        img.onload = () => {
          const maxW = 1024;
          let w = img.width;
          let h = img.height;
          if (w > maxW) {
            h = Math.round((h * maxW) / w);
            w = maxW;
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx2d = canvas.getContext("2d");
          ctx2d.fillStyle = "#ffffff";
          ctx2d.fillRect(0, 0, w, h);
          ctx2d.drawImage(img, 0, 0, w, h);

          let quality = 0.82;
          let dataUrl = canvas.toDataURL("image/jpeg", quality);
          const maxChars = 200 * 1024 * 1.37; // ~200 KB binary

          while (dataUrl.length > maxChars && quality > 0.25) {
            quality -= 0.1;
            dataUrl = canvas.toDataURL("image/jpeg", quality);
          }

          const approxKB = Math.round((dataUrl.length * 0.73) / 1024);
          resolve({
            base64: dataUrl,
            mime: "image/jpeg",
            sizeKB: approxKB
          });
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ==========================================================================
  // PEMUATAN DATA MASTER (BARANG & PELANGGAN CABANG AKTIF)
  // ==========================================================================

  async function ensureMasterBarang(force = false) {
    const branch = getActiveBranch();
    if (!branch || branch === "all") {
      state.barangList = [];
      return [];
    }
    if (!force && state.barangLoadedForBranch === branch && state.barangList.length > 0) {
      return state.barangList;
    }

    // Coba ambil dari cache global jika sudah dimuat app.js
    const globalBarang =
      (window.POS_STATE && Array.isArray(window.POS_STATE.masterBarang) && window.POS_STATE.masterBarang) ||
      (window.POS_APP && typeof window.POS_APP.getMasterBarang === "function" && window.POS_APP.getMasterBarang()) ||
      null;

    if (!force && Array.isArray(globalBarang) && globalBarang.length > 0) {
      state.barangList = normalizeBarangArray(globalBarang);
      state.barangLoadedForBranch = branch;
      return state.barangList;
    }

    const res = await window.POS_API.getBootstrapData(branch);
    if (res && res.sukses && res.data) {
      const raw = res.data.masterBarang || res.data.barang || res.data.produk || [];
      state.barangList = normalizeBarangArray(raw);
      state.barangLoadedForBranch = branch;
    }
    return state.barangList;
  }

  function normalizeBarangArray(rawArr) {
    return (rawArr || [])
      .map((b) => ({
        idBarang: String(b.idBarang || b["ID Barang"] || b.id || "").trim(),
        namaBarang: String(b.namaBarang || b["Nama Barang"] || b.nama || "").trim(),
        satuan: String(b.satuan || b["Satuan"] || "Pcs").trim(),
        stok: Math.round(Number(b.stok ?? b["Stok Saat Ini"] ?? b.stokSaatIni ?? 0)),
        hargaModal: Math.round(Number(b.hargaModal ?? b["Harga Modal"] ?? b.hpp ?? 0)),
        hargaJual: Math.round(Number(b.hargaJual ?? b["Harga Jual"] ?? b.harga ?? 0))
      }))
      .filter((b) => b.idBarang && b.namaBarang)
      .sort((a, b) => a.namaBarang.localeCompare(b.namaBarang));
  }

  async function ensurePelangganList(force = false) {
    const branch = getActiveBranch();
    if (!branch || branch === "all") return [];
    if (!force && state.pelangganList.length > 0) return state.pelangganList;

    const res = await window.POS_API.kelolaPelanggan({ mode: "LIST" });
    if (res && res.sukses && res.data && Array.isArray(res.data.items)) {
      state.pelangganList = res.data.items;
    }
    return state.pelangganList;
  }

  // ==========================================================================
  // BAGIAN 1: HALAMAN PROYEK DAMIU (#page-damiu)
  // ==========================================================================

  async function loadDamiuPage() {
    const branch = getActiveBranch();
    const listEl = $("damiu-list-container");
    const summaryEl = $("damiu-summary-cards");

    if (!branch || branch === "all") {
      if (summaryEl) summaryEl.innerHTML = "";
      if (listEl) {
        listEl.innerHTML = `
          <div class="dm-empty-state">
            <i class="fa-solid fa-code-branch"></i>
            <p><strong>Pilih Cabang Operasional (Korpri / Pringsewu)</strong></p>
            <p class="dm-muted">Sesuai aturan akuntansi, 1 Proyek DAMIU wajib dibukukan pada 1 cabang pelaksana utama.</p>
          </div>`;
      }
      return;
    }

    if (listEl) {
      listEl.innerHTML = `<div class="dm-loading"><i class="fa-solid fa-spinner fa-spin"></i> Memuat data Proyek DAMIU (${escHtml(branch.toUpperCase())})...</div>`;
    }

    const status = ($("damiu-filter-status") && $("damiu-filter-status").value) || "";
    const keyword = ($("damiu-filter-keyword") && $("damiu-filter-keyword").value.trim()) || "";

    const [res] = await Promise.all([
      window.POS_API.getDaftarProyekDAMIU({ status, keyword }),
      ensurePelangganList(false),
      ensureMasterBarang(false)
    ]);

    if (!res || !res.sukses) {
      const errMsg = (res && res.pesan) || "Gagal memuat daftar proyek DAMIU.";
      if (listEl) listEl.innerHTML = `<div class="dm-error-box">${escHtml(errMsg)}</div>`;
      return;
    }

    state.proyekList = (res.data && res.data.items) || [];
    state.proyekSummary = (res.data && res.data.summary) || null;

    renderDamiuSummary();
    renderDamiuList();

    // Jika modal detail sedang terbuka, refresh isinya secara real-time
    const detailModal = $("modal-detail-damiu");
    if (detailModal && detailModal.classList.contains("show") && state.activeProyekId) {
      renderDetailProyekContent(state.activeProyekId);
    }
  }

  function renderDamiuSummary() {
    const el = $("damiu-summary-cards");
    if (!el || !state.proyekSummary) return;
    const s = state.proyekSummary;
    el.innerHTML = `
      <div class="dm-stat-card">
        <span class="dm-stat-label">Proyek Aktif / Selesai</span>
        <strong class="dm-stat-value">${s.proyekAktif} Aktif <small>/ ${s.proyekSelesai} Selesai</small></strong>
      </div>
      <div class="dm-stat-card">
        <span class="dm-stat-label">Total Nilai Kontrak</span>
        <strong class="dm-stat-value">${formatRp(s.totalNilaiKontrak)}</strong>
      </div>
      <div class="dm-stat-card dm-stat-warn">
        <span class="dm-stat-label">Sisa Tagihan Customer</span>
        <strong class="dm-stat-value">${formatRp(s.totalSisaTagihan)}</strong>
      </div>
      <div class="dm-stat-card dm-stat-good">
        <span class="dm-stat-label">Estimasi Margin Total</span>
        <strong class="dm-stat-value">${formatRp(s.totalEstimasiMargin)}</strong>
        ${s.totalTalanganBelumReimburse > 0 ? `<small class="dm-talangan-alert">Talangan belum reimburse: ${formatRp(s.totalTalanganBelumReimburse)}</small>` : ""}
      </div>
    `;
  }

  function renderDamiuList() {
    const el = $("damiu-list-container");
    if (!el) return;

    if (!state.proyekList.length) {
      el.innerHTML = `
        <div class="dm-empty-state">
          <i class="fa-solid fa-water"></i>
          <p>Belum ada Proyek DAMIU pada filter ini.</p>
          <button type="button" class="btn-primary" onclick="window.POS_DAMIU_MUTASI.openProyekModal()">
            <i class="fa-solid fa-plus"></i> Buat Proyek DAMIU Baru
          </button>
        </div>`;
      return;
    }

    el.innerHTML = state.proyekList
      .map((p) => {
        const badgeClass =
          p.status === "SELESAI"
            ? "dm-badge-success"
            : p.status === "PROSES"
              ? "dm-badge-info"
              : p.status === "BATAL"
                ? "dm-badge-danger"
                : "dm-badge-warn";
        const marginClass = p.marginProyek >= 0 ? "dm-text-good" : "dm-text-danger";

        return `
          <div class="dm-project-card">
            <div class="dm-card-head">
              <div>
                <div class="dm-card-code">${escHtml(p.proyekId)} &bull; Target: ${escHtml(p.tanggalTargetPasang || "-")} ${escHtml(p.waktuTargetPasang || "")}</div>
                <h4 class="dm-card-title">${escHtml(p.namaProyek)}</h4>
                <div class="dm-card-sub">
                  <i class="fa-solid fa-user"></i> ${escHtml(p.namaPelanggan)}
                  ${p.alamatPasang ? ` &bull; <i class="fa-solid fa-location-dot"></i> ${escHtml(p.alamatPasang)}` : ""}
                </div>
              </div>
              <span class="dm-badge ${badgeClass}">${escHtml(p.status)}</span>
            </div>

            <div class="dm-metrics-grid">
              <div>
                <span>Nilai Kontrak</span>
                <strong>${formatRp(p.nilaiKontrak)}</strong>
              </div>
              <div>
                <span>Sudah Dibayar / Sisa</span>
                <strong>${formatRp(p.totalBayarCustomer)} <small class="${p.sisaTagihan > 0 ? "dm-text-warn" : "dm-text-good"}">(Sisa ${formatRp(p.sisaTagihan)})</small></strong>
              </div>
              <div>
                <span>Modal Internal + Luar</span>
                <strong>${formatRp(p.totalModalInternal + p.totalBiayaLuar)}</strong>
              </div>
              <div>
                <span>Estimasi Margin</span>
                <strong class="${marginClass}">${formatRp(p.marginProyek)} (${p.marginPersen}%)</strong>
              </div>
            </div>

            ${p.totalTalanganBelumReimburse > 0 ? `<div class="dm-inline-alert"><i class="fa-solid fa-triangle-exclamation"></i> Ada dana Talangan belum di-reimburse: <strong>${formatRp(p.totalTalanganBelumReimburse)}</strong></div>` : ""}

            <div class="dm-card-actions">
              <button type="button" class="btn-primary btn-sm" onclick="window.POS_DAMIU_MUTASI.openDetailProyek('${escHtml(p.proyekId)}')">
                <i class="fa-solid fa-folder-open"></i> Kelola Biaya, Termin & Margin
              </button>
              <button type="button" class="btn-secondary btn-sm" onclick="window.POS_DAMIU_MUTASI.openProyekModal('${escHtml(p.proyekId)}')">
                <i class="fa-solid fa-pen"></i> Edit Header
              </button>
              ${p.noWa ? `<a class="btn-outline btn-sm" target="_blank" rel="noopener" href="https://wa.me/${escHtml(p.noWa)}"><i class="fa-brands fa-whatsapp"></i> WA</a>` : ""}
              ${p.mapsUrl ? `<a class="btn-outline btn-sm" target="_blank" rel="noopener" href="${escHtml(p.mapsUrl)}"><i class="fa-solid fa-map-location-dot"></i> Maps</a>` : ""}
            </div>
          </div>`;
      })
      .join("");
  }

  // ==========================================================================
  // MODAL BUAT / EDIT HEADER PROYEK DAMIU
  // ==========================================================================

  async function openProyekModal(proyekId = "") {
    await ensurePelangganList(false);

    const selPlg = $("damiu-pelanggan-id");
    if (selPlg) {
      selPlg.innerHTML =
        `<option value="">-- Pilih dari Direktori Pelanggan (Opsional) --</option>` +
        state.pelangganList
          .map(
            (plg) =>
              `<option value="${escHtml(plg.pelangganId)}">${escHtml(plg.nama)} (${escHtml(plg.noWa || "Tanpa WA")})</option>`
          )
          .join("");
    }

    const existing = proyekId ? state.proyekList.find((x) => x.proyekId === proyekId) : null;
    $("damiu-modal-title").textContent = existing ? "Edit Proyek DAMIU (" + existing.proyekId + ")" : "Buat Proyek DAMIU Baru";
    $("damiu-proyek-id").value = existing ? existing.proyekId : "";
    $("damiu-pelanggan-id").value = existing ? existing.pelangganId : "";
    $("damiu-nama-pelanggan").value = existing ? existing.namaPelanggan : "";
    $("damiu-no-wa").value = existing ? existing.noWa : "";
    $("damiu-alamat-pasang").value = existing ? existing.alamatPasang : "";
    $("damiu-maps-url").value = existing ? existing.mapsUrl : "";
    $("damiu-nama-proyek").value = existing ? existing.namaProyek : "";
    $("damiu-nilai-kontrak").value = existing ? existing.nilaiKontrak : "";
    $("damiu-tanggal-target").value = existing ? existing.tanggalTargetPasang : todayWIB();
    $("damiu-waktu-target").value = existing ? existing.waktuTargetPasang || "09:00" : "09:00";
    $("damiu-status").value = existing ? existing.status : "PENAWARAN";
    $("damiu-catatan").value = existing ? existing.catatan : "";

    openModal("modal-proyek-damiu");
  }

  function onSelectPelangganDamiu() {
    const pid = $("damiu-pelanggan-id").value;
    if (!pid) return;
    const plg = state.pelangganList.find((x) => x.pelangganId === pid);
    if (!plg) return;
    $("damiu-nama-pelanggan").value = plg.nama || "";
    $("damiu-no-wa").value = plg.noWa || "";
    $("damiu-alamat-pasang").value = plg.alamat || "";
    $("damiu-maps-url").value = plg.mapsUrl || "";
  }

  async function handleSubmitProyek(e) {
    e.preventDefault();
    const btn = $("btn-simpan-proyek-damiu");
    const payload = {
      proyekId: $("damiu-proyek-id").value.trim(),
      pelangganId: $("damiu-pelanggan-id").value.trim(),
      namaPelanggan: $("damiu-nama-pelanggan").value.trim(),
      noWa: $("damiu-no-wa").value.trim(),
      alamatPasang: $("damiu-alamat-pasang").value.trim(),
      mapsUrl: $("damiu-maps-url").value.trim(),
      namaProyek: $("damiu-nama-proyek").value.trim(),
      nilaiKontrak: Number($("damiu-nilai-kontrak").value) || 0,
      tanggalTargetPasang: $("damiu-tanggal-target").value,
      waktuTargetPasang: $("damiu-waktu-target").value || "09:00",
      status: $("damiu-status").value,
      catatan: $("damiu-catatan").value.trim()
    };

    if (!payload.namaPelanggan || !payload.namaProyek) {
      notify("Nama pelanggan dan nama/paket proyek wajib diisi.", "error");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...`;
    }

    const res = await window.POS_API.simpanProyekDAMIU(payload);

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Simpan Proyek`;
    }

    if (!res || !res.sukses) {
      notify((res && res.pesan) || "Gagal menyimpan proyek DAMIU.", "error");
      return;
    }

    notify(res.pesan || "Proyek DAMIU berhasil disimpan.", "success");
    closeModal("modal-proyek-damiu");
    await loadDamiuPage();
  }

  // ==========================================================================
  // MODAL DETAIL & KELOLA PROYEK (3 TAB: BIAYA, TERMIN, MARGIN & FINALISASI)
  // ==========================================================================

  async function openDetailProyek(proyekId) {
    state.activeProyekId = proyekId;
    await ensureMasterBarang(false);
    populateBiayaBarangSelect();
    resetFormBiaya();
    resetFormBayar();
    renderDetailProyekContent(proyekId);
    switchDetailTab("biaya");
    openModal("modal-detail-damiu");
  }

  function switchDetailTab(tabName) {
    state.activeDetailTab = tabName;
    ["biaya", "bayar", "margin"].forEach((t) => {
      const btn = $("damiu-tab-btn-" + t);
      const panel = $("damiu-tab-panel-" + t);
      if (btn) btn.classList.toggle("active", t === tabName);
      if (panel) panel.style.display = t === tabName ? "block" : "none";
    });
  }

  function renderDetailProyekContent(proyekId) {
    const p = state.proyekList.find((x) => x.proyekId === proyekId);
    if (!p) return;

    $("detail-damiu-title").textContent = `${p.namaProyek} — ${p.namaPelanggan}`;
    $("detail-damiu-subtitle").textContent = `${p.proyekId} | Status: ${p.status} | Target Pasang: ${p.tanggalTargetPasang || "-"}`;

    // Render Tab 1: Daftar Biaya & Material
    const biayaBody = $("damiu-biaya-list-body");
    if (biayaBody) {
      if (!p.biayaList || !p.biayaList.length) {
        biayaBody.innerHTML = `<div class="dm-muted" style="padding:12px 0;">Belum ada rincian biaya/material pada proyek ini.</div>`;
      } else {
        biayaBody.innerHTML = p.biayaList
          .map((b) => {
            const isTalanganBelum = b.sumberDana === "Talangan" && b.statusReimburse === "BELUM";
            const sumberBadge =
              b.sumberItem === "STOK_TOKO"
                ? `<span class="dm-badge dm-badge-info">Stok Toko</span>`
                : b.sumberItem === "JASA_TUKANG"
                  ? `<span class="dm-badge dm-badge-warn">Jasa Tukang</span>`
                  : `<span class="dm-badge dm-badge-neutral">Beli Luar</span>`;

            return `
              <div class="dm-line-item">
                <div class="dm-line-main">
                  <div>
                    ${sumberBadge}
                    <strong>${escHtml(b.namaItem)}</strong>
                    <span class="dm-muted">(${b.qty} ${escHtml(b.satuan)} &times; ${formatRp(b.hargaSatuan)})</span>
                  </div>
                  <div class="dm-line-meta">
                    <span>Tgl: ${escHtml(b.tanggal)}</span> &bull;
                    <span>Sumber Dana: <strong>${escHtml(b.sumberDana)}</strong></span>
                    ${b.sumberDana === "Talangan" ? ` &bull; <span>Oleh: ${escHtml(b.talanganOleh || "-")} (${b.statusReimburse === "SUDAH" ? "Sudah Reimburse" : "BELUM Reimburse"})</span>` : ""}
                    ${b.keterangan ? ` &bull; <span>${escHtml(b.keterangan)}</span>` : ""}
                  </div>
                </div>
                <div class="dm-line-right">
                  <strong>${formatRp(b.subtotal)}</strong>
                  <div class="dm-line-actions">
                    ${b.buktiNotaUrl ? `<a href="${escHtml(b.buktiNotaUrl)}" target="_blank" rel="noopener" class="btn-outline btn-xs"><i class="fa-solid fa-image"></i> Nota</a>` : ""}
                    ${isTalanganBelum ? `<button type="button" class="btn-warn btn-xs" onclick="window.POS_DAMIU_MUTASI.openReimburseModal('${escHtml(b.biayaId)}', ${b.subtotal}, '${escHtml(b.namaItem)}')"><i class="fa-solid fa-money-bill-transfer"></i> Reimburse</button>` : ""}
                    ${p.status !== "BATAL" ? `<button type="button" class="btn-danger-outline btn-xs" onclick="window.POS_DAMIU_MUTASI.voidBiaya('${escHtml(b.biayaId)}')"><i class="fa-solid fa-ban"></i> Void</button>` : ""}
                  </div>
                </div>
              </div>`;
          })
          .join("");
      }
    }

    // Render Tab 2: Pembayaran Termin Customer
    const bayarListEl = $("damiu-bayar-list-body");
    if (bayarListEl) {
      $("damiu-bayar-sisa-hint").textContent = `Sisa Tagihan Saat Ini: ${formatRp(p.sisaTagihan)}`;
      if (!p.pembayaranList || !p.pembayaranList.length) {
        bayarListEl.innerHTML = `<div class="dm-muted" style="padding:12px 0;">Belum ada pembayaran DP/termin yang tercatat.</div>`;
      } else {
        bayarListEl.innerHTML = p.pembayaranList
          .map(
            (pm) => `
              <div class="dm-line-item">
                <div class="dm-line-main">
                  <strong>${escHtml(pm.keterangan || pm.jenis)}</strong>
                  <div class="dm-line-meta">${escHtml(pm.tanggal)} &bull; Akun: <strong>${escHtml(pm.akunKas)}</strong> &bull; COA: ${escHtml(pm.kodeCoa)}</div>
                </div>
                <div class="dm-line-right">
                  <strong class="dm-text-good">${formatRp(pm.nominal)}</strong>
                </div>
              </div>`
          )
          .join("");
      }
    }

    // Render Tab 3: Kalkulasi Margin Real-Time & Finalisasi
    const marginBox = $("damiu-margin-breakdown");
    if (marginBox) {
      const totalBiaya = p.totalModalInternal + p.totalBiayaLuar;
      marginBox.innerHTML = `
        <div class="dm-margin-table">
          <div class="dm-margin-row"><span>Nilai Kontrak Proyek</span><strong>${formatRp(p.nilaiKontrak)}</strong></div>
          <div class="dm-margin-row"><span>(-) Total Modal Internal (Stok Toko / HPP)</span><strong class="dm-text-danger">- ${formatRp(p.totalModalInternal)}</strong></div>
          <div class="dm-margin-row"><span>(-) Total Biaya Luar & Jasa Tukang</span><strong class="dm-text-danger">- ${formatRp(p.totalBiayaLuar)}</strong></div>
          <div class="dm-margin-row dm-margin-total">
            <span>Estimasi Margin Bersih Proyek (${p.marginPersen}%)</span>
            <strong class="${p.marginProyek >= 0 ? "dm-text-good" : "dm-text-danger"}">${formatRp(p.marginProyek)}</strong>
          </div>
        </div>
        <div class="dm-margin-subgrid">
          <div class="dm-sub-pill"><span>Total Biaya</span><strong>${formatRp(totalBiaya)}</strong></div>
          <div class="dm-sub-pill"><span>Total Bayar Customer</span><strong>${formatRp(p.totalBayarCustomer)}</strong></div>
          <div class="dm-sub-pill"><span>Sisa Tagihan</span><strong class="${p.sisaTagihan > 0 ? "dm-text-warn" : "dm-text-good"}">${formatRp(p.sisaTagihan)}</strong></div>
          <div class="dm-sub-pill"><span>Talangan Belum Reimburse</span><strong class="${p.totalTalanganBelumReimburse > 0 ? "dm-text-danger" : ""}">${formatRp(p.totalTalanganBelumReimburse)}</strong></div>
        </div>
      `;
    }

    const btnSelesai = $("btn-selesaikan-proyek-damiu");
    if (btnSelesai) {
      btnSelesai.disabled = p.status === "SELESAI" || p.status === "BATAL";
      btnSelesai.textContent = p.status === "SELESAI" ? "Proyek Sudah Selesai" : "Tandai Proyek SELESAI (+Update Calendar)";
    }
  }

  function populateBiayaBarangSelect() {
    const sel = $("biaya-id-barang");
    if (!sel) return;
    sel.innerHTML =
      `<option value="">-- Pilih Barang dari Stok Cabang --</option>` +
      state.barangList
        .map(
          (b) =>
            `<option value="${escHtml(b.idBarang)}">${escHtml(b.namaBarang)} (Stok: ${b.stok} ${escHtml(b.satuan)} | HPP: ${formatRp(b.hargaModal)})</option>`
        )
        .join("");
  }

  function onChangeSumberItemBiaya() {
    const sumber = $("biaya-sumber-item").value;
    const isStok = sumber === "STOK_TOKO";
    $("biaya-group-stok").style.display = isStok ? "block" : "none";
    $("biaya-group-luar").style.display = isStok ? "none" : "block";
    $("biaya-nama-item").readOnly = isStok;
    if (isStok) {
      onSelectBarangBiaya();
    } else {
      $("biaya-nama-item").value = "";
      $("biaya-harga-satuan").value = "";
      onChangeSumberDanaBiaya();
    }
  }

  function onSelectBarangBiaya() {
    const id = $("biaya-id-barang").value;
    const b = state.barangList.find((x) => x.idBarang === id);
    if (!b) return;
    $("biaya-nama-item").value = b.namaBarang;
    $("biaya-satuan").value = b.satuan || "Pcs";
    $("biaya-harga-satuan").value = b.hargaModal || 0;
  }

  function onChangeSumberDanaBiaya() {
    const dana = $("biaya-sumber-dana").value;
    const grpTalangan = $("biaya-group-talangan");
    if (grpTalangan) grpTalangan.style.display = dana === "Talangan" ? "block" : "none";
  }

  async function onSelectFotoNota(e) {
    const file = e.target.files && e.target.files[0];
    const infoEl = $("biaya-foto-info");
    if (!file) {
      state.notaBase64 = "";
      if (infoEl) infoEl.textContent = "";
      return;
    }
    if (infoEl) infoEl.textContent = "Mengompresi foto nota...";
    try {
      const comp = await compressImageToUnder200KB(file);
      state.notaBase64 = comp.base64;
      state.notaMime = comp.mime;
      if (infoEl) infoEl.textContent = `Siap unggah (${comp.sizeKB} KB, JPEG terkompresi).`;
    } catch (err) {
      state.notaBase64 = "";
      if (infoEl) infoEl.textContent = err.message;
      notify(err.message, "error");
    }
  }

  function resetFormBiaya() {
    const form = $("form-tambah-biaya-damiu");
    if (form) form.reset();
    $("biaya-tanggal").value = todayWIB();
    $("biaya-qty").value = 1;
    $("biaya-satuan").value = "Pcs";
    state.notaBase64 = "";
    state.notaMime = "image/jpeg";
    if ($("biaya-foto-info")) $("biaya-foto-info").textContent = "";
    onChangeSumberItemBiaya();
  }

  async function handleSubmitBiaya(e) {
    e.preventDefault();
    if (!state.activeProyekId) return;

    const sumberItem = $("biaya-sumber-item").value;
    const payload = {
      proyekId: state.activeProyekId,
      tanggal: $("biaya-tanggal").value || todayWIB(),
      sumberItem,
      idBarang: sumberItem === "STOK_TOKO" ? $("biaya-id-barang").value : "",
      namaItem: $("biaya-nama-item").value.trim(),
      qty: Number($("biaya-qty").value) || 0,
      satuan: $("biaya-satuan").value.trim() || "Pcs",
      hargaSatuan: Number($("biaya-harga-satuan").value) || 0,
      sumberDana: sumberItem === "STOK_TOKO" ? "STOK_TOKO" : $("biaya-sumber-dana").value,
      talanganOleh: $("biaya-talangan-oleh").value.trim(),
      kodeCoa: $("biaya-kode-coa").value,
      keterangan: $("biaya-keterangan").value.trim(),
      fotoNotaBase64: sumberItem === "STOK_TOKO" ? "" : state.notaBase64,
      fotoNotaMime: state.notaMime
    };

    if (sumberItem === "STOK_TOKO" && !payload.idBarang) {
      notify("Pilih barang dari Master Barang terlebih dahulu.", "error");
      return;
    }
    if (!payload.namaItem || payload.qty <= 0) {
      notify("Nama item dan Qty (> 0) wajib diisi.", "error");
      return;
    }

    const btn = $("btn-submit-biaya-damiu");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan Biaya...`;
    }

    const res = await window.POS_API.tambahBiayaDAMIU(payload);

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-plus"></i> Tambah Biaya / Material`;
    }

    if (!res || !res.sukses) {
      notify((res && res.pesan) || "Gagal menambahkan biaya proyek.", "error");
      return;
    }

    notify(res.pesan || "Biaya proyek berhasil ditambahkan.", "success");
    resetFormBiaya();
    if (sumberItem === "STOK_TOKO") {
      await ensureMasterBarang(true);
      populateBiayaBarangSelect();
    }
    await loadDamiuPage();
  }

  function openReimburseModal(biayaId, subtotal, namaItem) {
    $("reimburse-biaya-id").value = biayaId;
    $("reimburse-info-text").textContent = `Reimburse talangan untuk "${namaItem}" sebesar ${formatRp(subtotal)}.`;
    $("reimburse-tanggal").value = todayWIB();
    $("reimburse-akun-kas").value = "Kas Laci";
    $("reimburse-catatan").value = "";
    openModal("modal-reimburse-damiu");
  }

  async function handleSubmitReimburse(e) {
    e.preventDefault();
    const btn = $("btn-konfirmasi-reimburse");
    const payload = {
      biayaId: $("reimburse-biaya-id").value.trim(),
      akunKas: $("reimburse-akun-kas").value,
      tanggalReimburse: $("reimburse-tanggal").value || todayWIB(),
      catatan: $("reimburse-catatan").value.trim()
    };

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Memproses...";
    }

    const res = await window.POS_API.reimburseTalanganDAMIU(payload);

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Konfirmasi Reimburse";
    }

    if (!res || !res.sukses) {
      notify((res && res.pesan) || "Gagal mencatat reimburse talangan.", "error");
      return;
    }

    notify(res.pesan || "Reimburse talangan berhasil dicatat.", "success");
    closeModal("modal-reimburse-damiu");
    await loadDamiuPage();
  }

  function resetFormBayar() {
    const form = $("form-bayar-damiu");
    if (form) form.reset();
    $("bayar-damiu-tanggal").value = todayWIB();
    $("bayar-damiu-akun").value = "Rekening Bunda";
    $("bayar-damiu-coa").value = "402-OMZET_DAMIU";
  }

  async function handleSubmitBayar(e) {
    e.preventDefault();
    if (!state.activeProyekId) return;

    const payload = {
      proyekId: state.activeProyekId,
      tanggalBayar: $("bayar-damiu-tanggal").value || todayWIB(),
      jenisTermin: $("bayar-damiu-jenis").value.trim() || "Termin",
      nominalBayar: Number($("bayar-damiu-nominal").value) || 0,
      akunKas: $("bayar-damiu-akun").value,
      kodeCoa: $("bayar-damiu-coa").value,
      keterangan: $("bayar-damiu-keterangan").value.trim()
    };

    if (payload.nominalBayar <= 0) {
      notify("Nominal pembayaran harus lebih dari Rp 0.", "error");
      return;
    }

    const btn = $("btn-submit-bayar-damiu");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Mencatat...`;
    }

    const res = await window.POS_API.catatPembayaranDAMIU(payload);

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-cash-register"></i> Catat Pembayaran Customer`;
    }

    if (!res || !res.sukses) {
      notify((res && res.pesan) || "Gagal mencatat pembayaran customer.", "error");
      return;
    }

    notify(res.pesan || "Pembayaran customer berhasil dicatat.", "success");
    resetFormBayar();
    await loadDamiuPage();
  }

  async function handleSelesaikanProyek() {
    if (!state.activeProyekId) return;
    const catatanAkhir = window.prompt("Catatan akhir penyelesaian proyek (opsional):", "") || "";
    if (!window.confirm(`Tandai proyek ${state.activeProyekId} sebagai SELESAI dan perbarui jadwal Google Calendar?`)) {
      return;
    }

    const res = await window.POS_API.selesaikanProyekDAMIU({
      proyekId: state.activeProyekId,
      catatanAkhir
    });

    if (!res || !res.sukses) {
      notify((res && res.pesan) || "Gagal menyelesaikan proyek.", "error");
      return;
    }

    notify(res.pesan || "Proyek berhasil ditandai SELESAI.", "success");
    await loadDamiuPage();
  }

  async function voidBiaya(biayaId) {
    const reason = window.prompt("Masukkan alasan VOID biaya ini (wajib untuk Audit Log):");
    if (!reason || !reason.trim()) return;

    const res = await window.POS_API.voidProyekAtauBiayaDAMIU({
      targetType: "BIAYA",
      targetId: biayaId,
      reason: reason.trim()
    });

    if (!res || !res.sukses) {
      notify((res && res.pesan) || "Gagal melakukan void biaya.", "error");
      return;
    }

    notify(res.pesan || "Biaya berhasil di-void.", "success");
    await ensureMasterBarang(true);
    await loadDamiuPage();
  }

  async function voidProyekAktif() {
    if (!state.activeProyekId) return;
    const reason = window.prompt(
      `PERINGATAN: Seluruh biaya stok & kas pada proyek ${state.activeProyekId} akan dibuatkan baris pembalik.\nMasukkan alasan VOID proyek:`
    );
    if (!reason || !reason.trim()) return;

    const res = await window.POS_API.voidProyekAtauBiayaDAMIU({
      targetType: "PROYEK",
      targetId: state.activeProyekId,
      reason: reason.trim()
    });

    if (!res || !res.sukses) {
      notify((res && res.pesan) || "Gagal melakukan void proyek.", "error");
      return;
    }

    notify(res.pesan || "Proyek berhasil di-void.", "success");
    closeModal("modal-detail-damiu");
    await ensureMasterBarang(true);
    await loadDamiuPage();
  }

  // ==========================================================================
  // BAGIAN 2: HALAMAN MUTASI ANTAR CABANG (#page-mutasi-cabang)
  // ==========================================================================

  async function loadMutasiCabangPage() {
    const listEl = $("mutasi-list-container");
    const branch = getActiveBranch();
    const btnBuat = $("btn-open-modal-mutasi");

    if (btnBuat) {
      btnBuat.style.display = branch === "korpri" || branch === "pringsewu" ? "inline-flex" : "none";
    }

    if (listEl) {
      listEl.innerHTML = `<div class="dm-loading"><i class="fa-solid fa-spinner fa-spin"></i> Memuat data Mutasi Antar Cabang...</div>`;
    }

    const [res] = await Promise.all([
      window.POS_API.getMutasiAntarCabang({}),
      ensureMasterBarang(false)
    ]);

    if (!res || !res.sukses) {
      if (listEl) listEl.innerHTML = `<div class="dm-error-box">${escHtml((res && res.pesan) || "Gagal memuat mutasi antar cabang.")}</div>`;
      return;
    }

    state.mutasiList = (res.data && res.data.items) || [];
    state.mutasiCounts = (res.data && res.data.counts) || state.mutasiCounts;

    renderMutasiTabBadges();
    renderMutasiList();
  }

  function switchMutasiTab(tabName) {
    state.mutasiTab = tabName;
    ["MASUK", "KELUAR", "RIWAYAT"].forEach((t) => {
      const btn = $("mutasi-tab-btn-" + t.toLowerCase());
      if (btn) btn.classList.toggle("active", t === tabName);
    });
    renderMutasiList();
  }

  function renderMutasiTabBadges() {
    if ($("badge-mutasi-masuk")) $("badge-mutasi-masuk").textContent = state.mutasiCounts.perluVerifikasiMasuk || 0;
    if ($("badge-mutasi-keluar")) $("badge-mutasi-keluar").textContent = state.mutasiCounts.dikirimKeluar || 0;
    if ($("badge-mutasi-riwayat")) {
      $("badge-mutasi-riwayat").textContent = (state.mutasiCounts.diterima || 0) + (state.mutasiCounts.batal || 0);
    }
  }

  function renderMutasiList() {
    const el = $("mutasi-list-container");
    if (!el) return;
    const branch = getActiveBranch();

    const filtered = state.mutasiList.filter((m) => {
      if (state.mutasiTab === "MASUK") {
        return m.status === "DIKIRIM" && (branch === "all" || m.cabangTujuan === branch);
      }
      if (state.mutasiTab === "KELUAR") {
        return m.status === "DIKIRIM" && (branch === "all" || m.cabangAsal === branch);
      }
      return m.status === "DITERIMA" || m.status === "BATAL";
    });

    if (!filtered.length) {
      el.innerHTML = `
        <div class="dm-empty-state">
          <i class="fa-solid fa-right-left"></i>
          <p>Tidak ada data mutasi pada tab ini.</p>
        </div>`;
      return;
    }

    el.innerHTML = filtered
      .map((m) => {
        const badgeStatus =
          m.status === "DITERIMA"
            ? "dm-badge-success"
            : m.status === "BATAL"
              ? "dm-badge-danger"
              : "dm-badge-warn";
        const badgeTipe = m.tipeMutasi === "STOK" ? "dm-badge-info" : "dm-badge-neutral";

        let detailHtml = "";
        if (m.tipeMutasi === "STOK") {
          const rows = (m.items || [])
            .map(
              (it) =>
                `<li><strong>${escHtml(it.namaBarang)}</strong> &times; ${it.qty} ${escHtml(it.satuan || "Pcs")} <span class="dm-muted">(HPP ${formatRp(it.hargaModal)})</span></li>`
            )
            .join("");
          detailHtml = `<ul class="dm-mutasi-items">${rows}</ul>`;
        } else {
          detailHtml = `
            <div class="dm-mutasi-kas-box">
              <strong>${formatRp(m.nominalKas)}</strong>
              <span>${escHtml(m.akunKasAsal)} &rarr; ${escHtml(m.akunKasTujuan)}</span>
              <small class="dm-muted">COA: 199-MUTASI_CABANG (Netral Konsolidasi)</small>
            </div>`;
        }

        return `
          <div class="dm-project-card">
            <div class="dm-card-head">
              <div>
                <div class="dm-card-code">${escHtml(m.mutasiId)} &bull; Tgl Kirim: ${escHtml(m.tanggalKirim)}</div>
                <h4 class="dm-card-title">
                  ${escHtml(m.cabangAsal.toUpperCase())} <i class="fa-solid fa-arrow-right"></i> ${escHtml(m.cabangTujuan.toUpperCase())}
                </h4>
                <div class="dm-card-sub">
                  Pengirim: ${escHtml(m.createdBy || "-")}
                  ${m.confirmedBy ? ` &bull; Diterima oleh: <strong>${escHtml(m.confirmedBy)}</strong> (${escHtml(m.confirmedAt)})` : ""}
                  ${m.cancelledBy ? ` &bull; Dibatalkan oleh: <strong>${escHtml(m.cancelledBy)}</strong> (${escHtml(m.cancelReason)})` : ""}
                </div>
              </div>
              <div style="display:flex;gap:6px;align-items:center;">
                <span class="dm-badge ${badgeTipe}">${escHtml(m.tipeMutasi)}</span>
                <span class="dm-badge ${badgeStatus}">${escHtml(m.status)}</span>
              </div>
            </div>

            ${detailHtml}
            ${m.keterangan ? `<p class="dm-muted" style="margin:6px 0 0;">Catatan: ${escHtml(m.keterangan)}</p>` : ""}

            <div class="dm-card-actions">
              ${m.canVerify ? `<button type="button" class="btn-primary btn-sm" onclick="window.POS_DAMIU_MUTASI.openTerimaMutasiModal('${escHtml(m.mutasiId)}')"><i class="fa-solid fa-check-double"></i> Verifikasi & Terima</button>` : ""}
              ${m.canCancel ? `<button type="button" class="btn-danger-outline btn-sm" onclick="window.POS_DAMIU_MUTASI.batalMutasi('${escHtml(m.mutasiId)}')"><i class="fa-solid fa-xmark"></i> Batalkan Mutasi</button>` : ""}
            </div>
          </div>`;
      })
      .join("");
  }

  // ==========================================================================
  // MODAL BUAT MUTASI BARU (STOK MULTI-ITEM / KAS COA 199)
  // ==========================================================================

  async function openBuatMutasiModal() {
    const branch = getActiveBranch();
    if (branch !== "korpri" && branch !== "pringsewu") {
      notify("Pindah ke cabang Korpri atau Pringsewu untuk membuat mutasi.", "error");
      return;
    }

    await ensureMasterBarang(true);
    const tujuan = branch === "korpri" ? "pringsewu" : "korpri";

    $("mutasi-asal-label").textContent = branch.toUpperCase();
    $("mutasi-tujuan-label").textContent = tujuan.toUpperCase();
    $("mutasi-cabang-tujuan").value = tujuan;
    $("mutasi-tanggal-kirim").value = todayWIB();
    $("mutasi-tipe").value = "STOK";
    $("mutasi-keterangan").value = "";
    $("mutasi-nominal-kas").value = "";
    $("mutasi-akun-asal").value = "Kas Laci";
    $("mutasi-akun-tujuan").value = "Kas Laci";
    state.mutasiCart = [];

    const selBarang = $("mutasi-picker-barang");
    if (selBarang) {
      selBarang.innerHTML =
        `<option value="">-- Pilih Barang untuk Ditransfer --</option>` +
        state.barangList
          .map(
            (b) =>
              `<option value="${escHtml(b.idBarang)}">${escHtml(b.namaBarang)} (Sisa Stok: ${b.stok} ${escHtml(b.satuan)})</option>`
          )
          .join("");
    }

    onChangeTipeMutasi();
    renderMutasiCart();
    openModal("modal-buat-mutasi");
  }

  function onChangeTipeMutasi() {
    const tipe = $("mutasi-tipe").value;
    $("mutasi-section-stok").style.display = tipe === "STOK" ? "block" : "none";
    $("mutasi-section-kas").style.display = tipe === "KAS" ? "block" : "none";
  }

  function addItemToMutasiCart() {
    const idBarang = $("mutasi-picker-barang").value;
    const qty = Math.round(Number($("mutasi-picker-qty").value) || 0);
    if (!idBarang || qty <= 0) {
      notify("Pilih barang dan masukkan Qty > 0.", "error");
      return;
    }
    const b = state.barangList.find((x) => x.idBarang === idBarang);
    if (!b) return;

    const existing = state.mutasiCart.find((x) => x.idBarang === idBarang);
    const totalQty = (existing ? existing.qty : 0) + qty;
    if (totalQty > b.stok) {
      notify(`Stok "${b.namaBarang}" di cabang asal hanya tersisa ${b.stok}.`, "error");
      return;
    }

    if (existing) {
      existing.qty = totalQty;
    } else {
      state.mutasiCart.push({
        idBarang: b.idBarang,
        namaBarang: b.namaBarang,
        qty,
        satuan: b.satuan,
        hargaModal: b.hargaModal,
        stokAsal: b.stok
      });
    }

    $("mutasi-picker-qty").value = 1;
    renderMutasiCart();
  }

  function removeItemFromMutasiCart(idBarang) {
    state.mutasiCart = state.mutasiCart.filter((x) => x.idBarang !== idBarang);
    renderMutasiCart();
  }

  function renderMutasiCart() {
    const el = $("mutasi-cart-list");
    if (!el) return;
    if (!state.mutasiCart.length) {
      el.innerHTML = `<div class="dm-muted">Belum ada barang di keranjang mutasi.</div>`;
      return;
    }
    el.innerHTML = state.mutasiCart
      .map(
        (it) => `
          <div class="dm-cart-row">
            <span><strong>${escHtml(it.namaBarang)}</strong> &times; ${it.qty} ${escHtml(it.satuan)} <small class="dm-muted">(Stok asal: ${it.stokAsal})</small></span>
            <button type="button" class="btn-danger-outline btn-xs" onclick="window.POS_DAMIU_MUTASI.removeMutasiItem('${escHtml(it.idBarang)}')">Hapus</button>
          </div>`
      )
      .join("");
  }

  async function handleSubmitBuatMutasi(e) {
    e.preventDefault();
    const tipeMutasi = $("mutasi-tipe").value;
    const payload = {
      cabangTujuan: $("mutasi-cabang-tujuan").value,
      tipeMutasi,
      tanggalKirim: $("mutasi-tanggal-kirim").value || todayWIB(),
      keterangan: $("mutasi-keterangan").value.trim()
    };

    if (tipeMutasi === "STOK") {
      if (!state.mutasiCart.length) {
        notify("Tambahkan minimal 1 barang ke keranjang mutasi.", "error");
        return;
      }
      payload.items = state.mutasiCart.map((x) => ({
        idBarang: x.idBarang,
        qty: x.qty,
        satuan: x.satuan,
        hargaModal: x.hargaModal
      }));
    } else {
      payload.akunKasAsal = $("mutasi-akun-asal").value;
      payload.akunKasTujuan = $("mutasi-akun-tujuan").value;
      payload.nominalKas = Math.round(Number($("mutasi-nominal-kas").value) || 0);
      if (payload.nominalKas <= 0) {
        notify("Nominal mutasi kas harus lebih dari Rp 0.", "error");
        return;
      }
    }

    const btn = $("btn-submit-buat-mutasi");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Mengirim Mutasi...`;
    }

    const res = await window.POS_API.buatMutasiAntarCabang(payload);

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Kirim Mutasi Sekarang`;
    }

    if (!res || !res.sukses) {
      notify((res && res.pesan) || "Gagal membuat mutasi antar cabang.", "error");
      return;
    }

    notify(res.pesan || "Mutasi berhasil dikirim.", "success");
    closeModal("modal-buat-mutasi");
    await ensureMasterBarang(true);
    await loadMutasiCabangPage();
  }

  // ==========================================================================
  // VERIFIKASI TERIMA & BATALKAN MUTASI
  // ==========================================================================

  function openTerimaMutasiModal(mutasiId) {
    const m = state.mutasiList.find((x) => x.mutasiId === mutasiId);
    if (!m) return;

    $("terima-mutasi-id").value = m.mutasiId;
    $("terima-mutasi-tanggal").value = todayWIB();
    $("terima-mutasi-summary").innerHTML =
      m.tipeMutasi === "STOK"
        ? `Verifikasi penerimaan <strong>${(m.items || []).length} jenis barang</strong> dari Cabang <strong>${escHtml(m.cabangAsal.toUpperCase())}</strong>. Stok cabang tujuan akan bertambah otomatis.`
        : `Verifikasi penerimaan mutasi kas sebesar <strong>${formatRp(m.nominalKas)}</strong> dari Cabang <strong>${escHtml(m.cabangAsal.toUpperCase())}</strong> (COA 199-MUTASI_CABANG).`;

    const grpAkun = $("terima-mutasi-group-akun");
    if (grpAkun) {
      grpAkun.style.display = m.tipeMutasi === "KAS" ? "block" : "none";
      if (m.tipeMutasi === "KAS") {
        $("terima-mutasi-akun-tujuan").value = m.akunKasTujuan || "Kas Laci";
      }
    }

    openModal("modal-terima-mutasi");
  }

  async function handleSubmitTerimaMutasi(e) {
    e.preventDefault();
    const btn = $("btn-konfirmasi-terima-mutasi");
    const payload = {
      mutasiId: $("terima-mutasi-id").value.trim(),
      tanggalTerima: $("terima-mutasi-tanggal").value || todayWIB(),
      akunKasTujuan: $("terima-mutasi-akun-tujuan").value
    };

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Memverifikasi...";
    }

    const res = await window.POS_API.terimaMutasiAntarCabang(payload);

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Verifikasi & Terima";
    }

    if (!res || !res.sukses) {
      notify((res && res.pesan) || "Gagal memverifikasi penerimaan mutasi.", "error");
      return;
    }

    notify(res.pesan || "Mutasi berhasil diterima.", "success");
    closeModal("modal-terima-mutasi");
    await ensureMasterBarang(true);
    await loadMutasiCabangPage();
  }

  async function batalMutasi(mutasiId) {
    const reason = window.prompt(
      `Batalkan mutasi ${mutasiId}? Stok/kas cabang pengirim akan dikembalikan otomatis.\nMasukkan alasan pembatalan:`
    );
    if (!reason || !reason.trim()) return;

    const res = await window.POS_API.batalMutasiAntarCabang({
      mutasiId,
      reason: reason.trim()
    });

    if (!res || !res.sukses) {
      notify((res && res.pesan) || "Gagal membatalkan mutasi.", "error");
      return;
    }

    notify(res.pesan || "Mutasi berhasil dibatalkan.", "success");
    await ensureMasterBarang(true);
    await loadMutasiCabangPage();
  }

  // ==========================================================================
  // BINDING EVENT & OBSERVER AUTO-LOAD HALAMAN
  // ==========================================================================

  function observePageActivation(pageId, onActivate) {
    const el = $(pageId);
    if (!el) return;
    let wasVisible = el.classList.contains("active") && el.style.display !== "none";
    const obs = new MutationObserver(() => {
      const isVisible =
        el.classList.contains("active") ||
        (el.style.display && el.style.display !== "none" && !el.classList.contains("hidden"));
      if (isVisible && !wasVisible) {
        onActivate();
      }
      wasVisible = isVisible;
    });
    obs.observe(el, { attributes: true, attributeFilter: ["class", "style"] });
  }

  function bindEvents() {
    if (state.initialized) return;
    state.initialized = true;

    // Proyek DAMIU
    if ($("btn-buat-proyek-damiu")) $("btn-buat-proyek-damiu").addEventListener("click", () => openProyekModal());
    if ($("btn-refresh-damiu")) $("btn-refresh-damiu").addEventListener("click", loadDamiuPage);
    if ($("damiu-filter-status")) $("damiu-filter-status").addEventListener("change", loadDamiuPage);
    if ($("damiu-filter-keyword")) {
      $("damiu-filter-keyword").addEventListener("keydown", (e) => {
        if (e.key === "Enter") loadDamiuPage();
      });
    }
    if ($("damiu-pelanggan-id")) $("damiu-pelanggan-id").addEventListener("change", onSelectPelangganDamiu);
    if ($("form-proyek-damiu")) $("form-proyek-damiu").addEventListener("submit", handleSubmitProyek);

    // Detail Proyek & 3 Tab
    if ($("biaya-sumber-item")) $("biaya-sumber-item").addEventListener("change", onChangeSumberItemBiaya);
    if ($("biaya-id-barang")) $("biaya-id-barang").addEventListener("change", onSelectBarangBiaya);
    if ($("biaya-sumber-dana")) $("biaya-sumber-dana").addEventListener("change", onChangeSumberDanaBiaya);
    if ($("biaya-foto-nota")) $("biaya-foto-nota").addEventListener("change", onSelectFotoNota);
    if ($("form-tambah-biaya-damiu")) $("form-tambah-biaya-damiu").addEventListener("submit", handleSubmitBiaya);
    if ($("form-reimburse-damiu")) $("form-reimburse-damiu").addEventListener("submit", handleSubmitReimburse);
    if ($("form-bayar-damiu")) $("form-bayar-damiu").addEventListener("submit", handleSubmitBayar);
    if ($("btn-selesaikan-proyek-damiu")) $("btn-selesaikan-proyek-damiu").addEventListener("click", handleSelesaikanProyek);
    if ($("btn-void-proyek-damiu")) $("btn-void-proyek-damiu").addEventListener("click", voidProyekAktif);

    // Mutasi Antar Cabang
    if ($("btn-open-modal-mutasi")) $("btn-open-modal-mutasi").addEventListener("click", openBuatMutasiModal);
    if ($("btn-refresh-mutasi")) $("btn-refresh-mutasi").addEventListener("click", loadMutasiCabangPage);
    if ($("mutasi-tipe")) $("mutasi-tipe").addEventListener("change", onChangeTipeMutasi);
    if ($("btn-add-mutasi-item")) $("btn-add-mutasi-item").addEventListener("click", addItemToMutasiCart);
    if ($("form-buat-mutasi")) $("form-buat-mutasi").addEventListener("submit", handleSubmitBuatMutasi);
    if ($("form-terima-mutasi")) $("form-terima-mutasi").addEventListener("submit", handleSubmitTerimaMutasi);

    // Auto-load saat halaman diaktifkan dari sidebar
    observePageActivation("page-damiu", loadDamiuPage);
    observePageActivation("page-mutasi-cabang", loadMutasiCabangPage);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindEvents);
  } else {
    bindEvents();
  }

  return {
    init: bindEvents,
    loadDamiuPage,
    loadMutasiCabangPage,
    openModal,
    closeModal,
    openProyekModal,
    openDetailProyek,
    switchDetailTab,
    openReimburseModal,
    voidBiaya,
    switchMutasiTab,
    openBuatMutasiModal,
    removeMutasiItem: removeItemFromMutasiCart,
    openTerimaMutasiModal,
    batalMutasi
  };
})();