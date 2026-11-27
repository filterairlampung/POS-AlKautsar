/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.1 — MODUL SUPIR, PELANGGAN, PIUTANG & OFFLINE QUEUE
 * File: js/driver_customer.js
 * ============================================================================
 * Fitur:
 * - Direktori Pelanggan (CRUD + tombol Google Maps & WhatsApp)
 * - Aging Piutang (<7 hr hijau, 7-30 hr kuning, >30 hr merah) + Modal Cicilan/Lunas
 * - Tugas Pengantaran & Ngampas Supir (Berangkat -> Realisasi + Kompresi Foto Canvas <200KB)
 * - Antrean Verifikasi Setoran Supir di Toko (Karyawan/Manajer/Bos/Admin)
 * - Offline Queue berbasis localStorage + clientRequestId anti-duplikasi
 */

window.POS_DRIVER_CUSTOMER = (function () {
  "use strict";

  const state = {
    pelangganList: [],
    piutangList: [],
    piutangSummary: null,
    piutangBucketFilter: "",
    pelangganTab: "pelanggan", // "pelanggan" | "piutang"

    tugasList: [],
    tugasCounts: { terjadwal: 0, berangkat: 0, menungguVerifikasi: 0, selesai: 0 },
    supirTab: "aktif", // "aktif" | "verifikasi" | "selesai"

    produkCacheByBranch: {},
    muatanDraft: [],
    activePiutangTarget: null,
    activeSelesaiTugas: null,
    activeVerifikasiTugas: null,

    fotoAntarCompressed: null, // { base64, mime, sizeKb, width, height }
    fotoBayarCompressed: null,
    isSyncingQueue: false,
    initialized: false
  };

  // ==========================================================================
  // UTILITAS FORMAT & HELPER UMUM
  // ==========================================================================

  function formatRp(num) {
    const n = Math.round(Number(num) || 0);
    return "Rp " + n.toLocaleString("id-ID");
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(msg, isError) {
    const toast = document.getElementById("toast-sistem");
    const txt = document.getElementById("toast-sistem-text");
    if (!toast || !txt) {
      if (isError) alert(msg);
      return;
    }
    txt.textContent = msg;
    toast.classList.toggle("toast-error", Boolean(isError));
    toast.classList.add("show");
    clearTimeout(toast._dcTimer);
    toast._dcTimer = setTimeout(() => toast.classList.remove("show"), 3600);
  }
  function showModalEl(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add("show", "active");
    modal.style.display = "flex";
  }

  function hideModalEl(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove("show", "active");
    modal.style.display = "none";
  }

  function getSession() {
    return window.POS_AUTH && typeof window.POS_AUTH.getSession === "function"
      ? window.POS_AUTH.getSession()
      : null;
  }

  function isOperationalBranch() {
    const s = getSession();
    if (!s || !s.activeCabang) return false;
    const br = window.POS_CONFIG && window.POS_CONFIG.BRANCHES[s.activeCabang];
    return Boolean(br && br.isOperational);
  }

  function canVerifySetoran() {
    const s = getSession();
    return Boolean(s && s.activeRole && s.activeRole !== "Supir");
  }

  function buildWaLink(noWa, text) {
    let digits = String(noWa || "").replace(/[^\d]/g, "");
    if (!digits) return "";
    if (digits.startsWith("0")) digits = "62" + digits.slice(1);
    else if (digits.startsWith("8")) digits = "62" + digits;
    const qs = text ? `?text=${encodeURIComponent(text)}` : "";
    return `https://wa.me/${digits}${qs}`;
  }

  function buildMapsLink(mapsUrl, alamat, koordinat) {
    const url = String(mapsUrl || "").trim();
    if (url && /^https?:\/\//i.test(url)) return url;
    const q = String(koordinat || alamat || "").trim();
    if (!q) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  function todayWIB() {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const wib = new Date(utc + 7 * 3600000);
    return wib.toISOString().slice(0, 10);
  }

  function nowTimeWIB() {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const wib = new Date(utc + 7 * 3600000);
    return wib.toISOString().slice(11, 16);
  }

  function populateAkunKasSelect(selectId, defaultVal) {
    const el = document.getElementById(selectId);
    if (!el) return;
    const opts = (window.POS_CONFIG && window.POS_CONFIG.AKUN_KAS_OPTIONS) || [
      { value: "Kas Laci", label: "Kas Laci" },
      { value: "Rekening Toko", label: "Rekening Toko" },
      { value: "Rekening Bunda", label: "Rekening Bunda" }
    ];
    el.innerHTML = opts
      .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
      .join("");
    if (defaultVal) el.value = defaultVal;
  }

  // ==========================================================================
  // 1. KOMPRESI FOTO HTML5 CANVAS (MAX LEBAR 1024px, JPEG 0.7, TARGET < 200KB)
  // ==========================================================================

  function estimateBase64Bytes(dataUrl) {
    const pure = String(dataUrl || "").split(",")[1] || "";
    return Math.ceil((pure.length * 3) / 4);
  }

  function compressImageFile(file, maxWidth = 1024, initialQuality = 0.7, maxBytes = 200 * 1024) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith("image/")) {
        reject(new Error("File yang dipilih bukan gambar yang valid."));
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Gagal membaca file foto dari perangkat."));
      reader.onload = (ev) => {
        const img = new Image();
        img.onerror = () => reject(new Error("Gagal memuat gambar untuk kompresi."));
        img.onload = () => {
          let targetW = img.width;
          let targetH = img.height;

          if (targetW > maxWidth) {
            const ratio = maxWidth / targetW;
            targetW = maxWidth;
            targetH = Math.round(targetH * ratio);
          }

          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");

          let quality = initialQuality;
          let dataUrl = "";
          let bytes = 0;

          // Kompresi bertahap hingga ukuran < 200 KB
          for (let attempt = 0; attempt < 5; attempt++) {
            canvas.width = targetW;
            canvas.height = targetH;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, targetW, targetH);
            ctx.drawImage(img, 0, 0, targetW, targetH);

            dataUrl = canvas.toDataURL("image/jpeg", quality);
            bytes = estimateBase64Bytes(dataUrl);

            if (bytes <= maxBytes) break;

            if (quality > 0.45) {
              quality = Number((quality - 0.12).toFixed(2));
            } else {
              targetW = Math.round(targetW * 0.8);
              targetH = Math.round(targetH * 0.8);
            }
          }

          resolve({
            base64: dataUrl,
            mime: "image/jpeg",
            sizeKb: Math.max(1, Math.round(bytes / 1024)),
            width: targetW,
            height: targetH
          });
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function onPhotoInputChange(type, inputEl) {
    const file = inputEl && inputEl.files && inputEl.files[0];
    const previewId = type === "antar" ? "preview-foto-antar" : "preview-foto-bayar";
    const infoId = type === "antar" ? "info-foto-antar" : "info-foto-bayar";
    const previewEl = document.getElementById(previewId);
    const infoEl = document.getElementById(infoId);

    if (!file) {
      if (type === "antar") state.fotoAntarCompressed = null;
      else state.fotoBayarCompressed = null;
      if (previewEl) {
        previewEl.src = "";
        previewEl.style.display = "none";
      }
      if (infoEl) infoEl.textContent = "Belum ada foto dipilih.";
      return;
    }

    if (infoEl) infoEl.textContent = "Mengompresi foto di perangkat...";

    try {
      const compressed = await compressImageFile(file, 1024, 0.7, 200 * 1024);
      if (type === "antar") state.fotoAntarCompressed = compressed;
      else state.fotoBayarCompressed = compressed;

      if (previewEl) {
        previewEl.src = compressed.base64;
        previewEl.style.display = "block";
      }
      if (infoEl) {
        infoEl.textContent = `Terkompresi: ${compressed.sizeKb} KB (${compressed.width}×${compressed.height}px, JPEG)`;
      }
    } catch (err) {
      showToast(err.message || "Gagal mengompresi foto.", true);
      if (infoEl) infoEl.textContent = "Gagal memproses foto.";
    }
  }

  // ==========================================================================
  // 2. OFFLINE QUEUE RINGAN (localStorage + clientRequestId)
  // ==========================================================================

  function getQueueKey() {
    return (
      (window.POS_CONFIG && window.POS_CONFIG.OFFLINE_QUEUE_STORAGE_KEY) ||
      "pos_alkautsar_v3_offline_queue"
    );
  }

  function loadOfflineQueue() {
    try {
      const raw = localStorage.getItem(getQueueKey());
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveOfflineQueue(queue) {
    try {
      localStorage.setItem(getQueueKey(), JSON.stringify(queue || []));
      renderOfflineBanner();
      return true;
    } catch (err) {
      showToast(
        "Penyimpanan offline browser penuh. Hapus antrean lama atau kirim ulang saat ada sinyal.",
        true
      );
      return false;
    }
  }

  function enqueueOffline(action, payload, clientRequestId, label) {
    const session = getSession();
    const queue = loadOfflineQueue();

    // Cegah duplikasi item dengan clientRequestId yang sama
    if (queue.some((q) => q.clientRequestId === clientRequestId)) {
      renderOfflineBanner();
      return true;
    }

    queue.push({
      id: "OQ_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      clientRequestId: clientRequestId,
      action: action,
      cabang: session ? session.activeCabang : "",
      activeRole: session ? session.activeRole : "",
      label: label || action,
      payload: payload,
      createdAt: new Date().toLocaleString("id-ID"),
      lastError: ""
    });

    return saveOfflineQueue(queue);
  }

  function renderOfflineBanner() {
    const banner = document.getElementById("offline-queue-banner");
    const countEl = document.getElementById("offline-queue-count");
    const statusNetEl = document.getElementById("offline-network-badge");
    const queue = loadOfflineQueue();

    if (countEl) countEl.textContent = String(queue.length);
    if (statusNetEl) {
      statusNetEl.textContent = navigator.onLine ? "Online" : "Offline";
      statusNetEl.className = navigator.onLine ? "net-pill online" : "net-pill offline";
    }

    if (banner) {
      banner.style.display = queue.length > 0 ? "flex" : "none";
    }

    // Jika modal antrean sedang terbuka, ikut perbarui isinya
    const modal = document.getElementById("modal-offline-queue");
    if (modal && modal.classList.contains("show")) {
      renderOfflineQueueModalList();
    }
  }

  async function syncOfflineQueue(isAuto) {
    if (state.isSyncingQueue) return;
    const queue = loadOfflineQueue();
    if (queue.length === 0) {
      renderOfflineBanner();
      return;
    }

    if (!navigator.onLine) {
      if (!isAuto) showToast("Perangkat masih offline. Coba lagi saat sinyal kembali.", true);
      return;
    }

    const session = getSession();
    if (!session || !session.token) {
      if (!isAuto) showToast("Silakan login terlebih dahulu sebelum sinkronisasi antrean.", true);
      return;
    }

    state.isSyncingQueue = true;
    const btnSync = document.getElementById("btn-sync-offline");
    if (btnSync) {
      btnSync.disabled = true;
      btnSync.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengirim...';
    }

    let suksesCount = 0;
    let remaining = [];

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      const res = await window.POS_API.request(item.action, item.payload, {
        cabang: item.cabang || session.activeCabang,
        activeRole: item.activeRole || session.activeRole,
        clientRequestId: item.clientRequestId,
        timeoutMs: item.action === "submitSelesaiPengantaran" ? 45000 : 35000
      });

      if (res && res.sukses) {
        suksesCount++;
      } else if (window.POS_API.isOfflineError(res)) {
        item.lastError = res ? res.pesan : "Sinyal terputus saat sinkronisasi.";
        remaining = queue.slice(i);
        break;
      } else {
        item.lastError = (res && res.pesan) || "Ditolak oleh server.";
        remaining.push(item);
      }
    }

    saveOfflineQueue(remaining);
    state.isSyncingQueue = false;

    if (btnSync) {
      btnSync.disabled = false;
      btnSync.innerHTML = '<i class="fas fa-cloud-arrow-up"></i> Kirim Ulang (Sync)';
    }

    if (suksesCount > 0) {
      showToast(`${suksesCount} antrean offline berhasil disinkronkan ke server.`);
      refreshActivePageIfRelevant();
    } else if (!isAuto && remaining.length > 0) {
      showToast("Sinkronisasi tertunda: " + (remaining[0].lastError || "Cek koneksi."), true);
    }
  }

  function openOfflineQueueModal() {
    renderOfflineQueueModalList();
    const modal = document.getElementById("modal-offline-queue");
    if (modal) { modal.classList.add("show", "active"); modal.style.display = "flex"; }
  }

  function closeOfflineQueueModal() {
    const modal = document.getElementById("modal-offline-queue");
    if (modal) { modal.classList.remove("show", "active"); modal.style.display = "none"; }
  }

  function renderOfflineQueueModalList() {
    const container = document.getElementById("offline-queue-list");
    if (!container) return;
    const queue = loadOfflineQueue();

    if (queue.length === 0) {
      container.innerHTML = '<p class="empty-state-text">Tidak ada antrean offline tersisa.</p>';
      return;
    }

    container.innerHTML = queue
      .map(
        (item) => `
      <div class="offline-item-card">
        <div class="offline-item-top">
          <strong>${escapeHtml(item.label)}</strong>
          <span class="badge stok">${escapeHtml(item.cabang || "-")}</span>
        </div>
        <div class="offline-item-meta">
          <span>ID: <code>${escapeHtml(item.clientRequestId)}</code></span>
          <span>Dibuat: ${escapeHtml(item.createdAt)}</span>
        </div>
        ${
          item.lastError
            ? `<div class="offline-item-err"><i class="fas fa-circle-exclamation"></i> ${escapeHtml(item.lastError)}</div>`
            : ""
        }
        <div class="offline-item-actions">
          <button type="button" class="btn-mini-danger" onclick="POS_DRIVER_CUSTOMER.removeOfflineItem('${escapeHtml(item.id)}')">
            <i class="fas fa-trash"></i> Hapus Antrean
          </button>
        </div>
      </div>`
      )
      .join("");
  }

  function removeOfflineItem(id) {
    if (!confirm("Hapus antrean offline ini? Data belum terkirim ke server.")) return;
    const next = loadOfflineQueue().filter((q) => q.id !== id);
    saveOfflineQueue(next);
    showToast("Antrean offline dihapus.");
  }

  // ==========================================================================
  // 3. HALAMAN PELANGGAN & AGING PIUTANG (page-pelanggan-piutang)
  // ==========================================================================

  function switchPelangganTab(tab) {
    state.pelangganTab = tab === "piutang" ? "piutang" : "pelanggan";

    const btnPlg = document.getElementById("tab-btn-pelanggan");
    const btnPtg = document.getElementById("tab-btn-piutang");
    const panePlg = document.getElementById("tab-pane-pelanggan");
    const panePtg = document.getElementById("tab-pane-piutang");

    if (btnPlg) btnPlg.classList.toggle("active", state.pelangganTab === "pelanggan");
    if (btnPtg) btnPtg.classList.toggle("active", state.pelangganTab === "piutang");
    if (panePlg) panePlg.classList.toggle("active", state.pelangganTab === "pelanggan");
    if (panePtg) panePtg.classList.toggle("active", state.pelangganTab === "piutang");

    if (state.pelangganTab === "pelanggan") {
      loadPelanggan();
    } else {
      loadPiutangAging();
    }
  }

  async function loadPelanggan() {
    if (!isOperationalBranch()) return;
    const container = document.getElementById("pelanggan-list-container");
    if (container) container.innerHTML = '<p class="empty-state-text">Memuat direktori pelanggan...</p>';

    const res = await window.POS_API.kelolaPelanggan({ mode: "LIST" });
    if (!res.sukses) {
      if (container) container.innerHTML = `<p class="empty-state-text">${escapeHtml(res.pesan)}</p>`;
      return;
    }

    state.pelangganList = (res.data && res.data.items) || [];
    renderPelangganList();
  }

  function renderPelangganList() {
    const container = document.getElementById("pelanggan-list-container");
    if (!container) return;

    const kw = String((document.getElementById("plg-search") || {}).value || "")
      .toLowerCase()
      .trim();
    const kat = String((document.getElementById("plg-filter-kategori") || {}).value || "")
      .toLowerCase()
      .trim();

    const filtered = state.pelangganList.filter((p) => {
      if (kat && String(p.kategori || "").toLowerCase() !== kat) return false;
      if (kw) {
        const hay = `${p.pelangganId} ${p.nama} ${p.noWa} ${p.alamat} ${p.catatan}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<p class="empty-state-text">Belum ada data pelanggan sesuai filter.</p>';
      return;
    }

    container.innerHTML = filtered
      .map((p) => {
        const waUrl = buildWaLink(p.noWa, `Halo Bapak/Ibu ${p.nama}, kami dari Al-Kautsar Filter Air.`);
        const mapsUrl = buildMapsLink(p.mapsUrl, p.alamat, p.koordinatLatLng);
        return `
        <div class="customer-card">
          <div class="customer-card-header">
            <div>
              <h4 class="customer-name">${escapeHtml(p.nama)}</h4>
              <span class="customer-id-meta">${escapeHtml(p.pelangganId)}</span>
            </div>
            <span class="badge stok">${escapeHtml(p.kategori || "Ritel")}</span>
          </div>

          <div class="customer-card-body">
            <div><i class="fab fa-whatsapp"></i> ${escapeHtml(p.noWa || "-")}</div>
            <div><i class="fas fa-location-dot"></i> ${escapeHtml(p.alamat || "Alamat belum diisi")}</div>
            ${p.catatan ? `<div class="customer-note"><i class="fas fa-note-sticky"></i> ${escapeHtml(p.catatan)}</div>` : ""}
          </div>

          <div class="customer-card-actions">
            ${
              waUrl
                ? `<a href="${waUrl}" target="_blank" rel="noopener" class="btn-chip-wa"><i class="fab fa-whatsapp"></i> Chat WA</a>`
                : ""
            }
            ${
              mapsUrl
                ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-chip-maps"><i class="fas fa-map-location-dot"></i> Google Maps</a>`
                : ""
            }
            <button type="button" class="btn-chip-edit" onclick="POS_DRIVER_CUSTOMER.openPelangganModal('${escapeHtml(p.pelangganId)}')">
              <i class="fas fa-pen"></i> Edit
            </button>
          </div>
        </div>`;
      })
      .join("");
  }

  function openPelangganModal(pelangganId) {
    const modal = document.getElementById("modal-pelanggan");
    const titleEl = document.getElementById("modal-pelanggan-title");
    const existing = pelangganId
      ? state.pelangganList.find((x) => x.pelangganId === pelangganId)
      : null;

    document.getElementById("plg-input-id").value = existing ? existing.pelangganId : "";
    document.getElementById("plg-input-nama").value = existing ? existing.nama : "";
    document.getElementById("plg-input-wa").value = existing ? existing.noWa : "";
    document.getElementById("plg-input-alamat").value = existing ? existing.alamat : "";
    document.getElementById("plg-input-maps").value = existing ? existing.mapsUrl : "";
    document.getElementById("plg-input-latlng").value = existing ? existing.koordinatLatLng : "";
    document.getElementById("plg-input-kategori").value = existing ? existing.kategori : "Ritel";
    document.getElementById("plg-input-catatan").value = existing ? existing.catatan : "";

    if (titleEl) {
      titleEl.innerHTML = existing
        ? '<i class="fas fa-user-pen"></i> Edit Pelanggan'
        : '<i class="fas fa-user-plus"></i> Tambah Pelanggan Baru';
    }

    const btnDel = document.getElementById("btn-hapus-pelanggan");
    if (btnDel) btnDel.style.display = existing ? "inline-flex" : "none";

    if (modal) { modal.classList.add("show", "active"); modal.style.display = "flex"; }
  }

  function closePelangganModal() {
    const modal = document.getElementById("modal-pelanggan");
    if (modal) { modal.classList.remove("show", "active"); modal.style.display = "none"; }
  }

  async function submitPelangganForm(ev) {
    if (ev) ev.preventDefault();
    const id = document.getElementById("plg-input-id").value.trim();
    const payload = {
      mode: id ? "UPDATE" : "CREATE",
      pelangganId: id,
      nama: document.getElementById("plg-input-nama").value.trim(),
      noWa: document.getElementById("plg-input-wa").value.trim(),
      alamat: document.getElementById("plg-input-alamat").value.trim(),
      mapsUrl: document.getElementById("plg-input-maps").value.trim(),
      koordinatLatLng: document.getElementById("plg-input-latlng").value.trim(),
      kategori: document.getElementById("plg-input-kategori").value,
      catatan: document.getElementById("plg-input-catatan").value.trim()
    };

    if (!payload.nama) {
      showToast("Nama pelanggan wajib diisi.", true);
      return;
    }

    const btn = document.getElementById("btn-simpan-pelanggan");
    if (btn) btn.disabled = true;

    const reqId = window.POS_API.generateClientRequestId("PLG");
    const res = await window.POS_API.kelolaPelanggan(payload, reqId);

    if (btn) btn.disabled = false;

    if (res.sukses) {
      showToast(res.pesan || "Data pelanggan tersimpan.");
      closePelangganModal();
      loadPelanggan();
    } else if (window.POS_API.isOfflineError(res)) {
      enqueueOffline("kelolaPelanggan", payload, reqId, `Simpan Pelanggan: ${payload.nama}`);
      closePelangganModal();
      showToast("Sinyal putus. Data pelanggan disimpan ke Antrean Offline.");
    } else {
      showToast(res.pesan || "Gagal menyimpan pelanggan.", true);
    }
  }

  async function nonaktifkanPelanggan() {
    const id = document.getElementById("plg-input-id").value.trim();
    if (!id) return;
    if (!confirm("Nonaktifkan pelanggan ini dari direktori aktif?")) return;

    const res = await window.POS_API.kelolaPelanggan({ mode: "DELETE", pelangganId: id });
    if (res.sukses) {
      showToast("Pelanggan dinonaktifkan.");
      closePelangganModal();
      loadPelanggan();
    } else {
      showToast(res.pesan || "Gagal menonaktifkan pelanggan.", true);
    }
  }

  // --- TAB PIUTANG AKTIF & AGING ---

  async function loadPiutangAging() {
    if (!isOperationalBranch()) return;
    const container = document.getElementById("piutang-list-container");
    if (container) container.innerHTML = '<p class="empty-state-text">Menghitung aging piutang...</p>';

    const res = await window.POS_API.getPiutangAging({});
    if (!res.sukses) {
      if (container) container.innerHTML = `<p class="empty-state-text">${escapeHtml(res.pesan)}</p>`;
      return;
    }

    state.piutangSummary = (res.data && res.data.summary) || null;
    state.piutangList = (res.data && res.data.items) || [];
    renderPiutangSummary();
    renderPiutangList();
  }

  function setPiutangBucketFilter(bucket) {
    state.piutangBucketFilter = bucket || "";
    document.querySelectorAll(".aging-card-btn").forEach((el) => {
      el.classList.toggle("active", (el.dataset.bucket || "") === state.piutangBucketFilter);
    });
    renderPiutangList();
  }

  function renderPiutangSummary() {
    const s = state.piutangSummary;
    if (!s) return;
    const setTxt = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    setTxt("aging-total-all", formatRp(s.totalPiutang));
    setTxt("aging-count-all", `${s.jumlahNota} nota`);
    setTxt("aging-total-hijau", formatRp(s.kurang7.total));
    setTxt("aging-count-hijau", `${s.kurang7.count} nota`);
    setTxt("aging-total-kuning", formatRp(s.antara7dan30.total));
    setTxt("aging-count-kuning", `${s.antara7dan30.count} nota`);
    setTxt("aging-total-merah", formatRp(s.lebih30.total));
    setTxt("aging-count-merah", `${s.lebih30.count} nota`);
  }

  function renderPiutangList() {
    const container = document.getElementById("piutang-list-container");
    if (!container) return;

    const kw = String((document.getElementById("piutang-search") || {}).value || "")
      .toLowerCase()
      .trim();

    const filtered = state.piutangList.filter((item) => {
      if (state.piutangBucketFilter && item.agingCode !== state.piutangBucketFilter) return false;
      if (kw) {
        const hay = `${item.idTransaksi} ${item.namaPelanggan} ${item.tanggal}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      container.innerHTML =
        '<p class="empty-state-text">Tidak ada piutang aktif untuk filter yang dipilih.</p>';
      return;
    }

    container.innerHTML = filtered
      .map((item) => {
        const badgeCls =
          item.agingCode === "MERAH"
            ? "aging-badge aging-merah"
            : item.agingCode === "KUNING"
            ? "aging-badge aging-kuning"
            : "aging-badge aging-hijau";

        const waMsg = `Halo Bapak/Ibu ${item.namaPelanggan}, kami dari Al-Kautsar Filter Air menginformasikan sisa tagihan nota ${item.idTransaksi} tgl ${item.tanggal} sebesar ${formatRp(item.sisaPiutang)}. Terima kasih.`;
        const waUrl = buildWaLink(item.noWa, waMsg);
        const mapsUrl = buildMapsLink(item.mapsUrl, "", "");

        return `
        <div class="piutang-card">
          <div class="piutang-card-header">
            <div>
              <strong>${escapeHtml(item.namaPelanggan)}</strong>
              <div class="piutang-meta">${escapeHtml(item.idTransaksi)} &bull; Tgl ${escapeHtml(item.tanggal)}</div>
            </div>
            <span class="${badgeCls}">${escapeHtml(item.agingLabel)} (${item.umurHari} hr)</span>
          </div>

          <div class="piutang-amounts-row">
            <div><small>Total Nota</small><div>${formatRp(item.totalHutang)}</div></div>
            <div><small>Sudah Dibayar</small><div>${formatRp(item.totalDibayar)}</div></div>
            <div><small>Sisa Piutang</small><div class="sisa-highlight">${formatRp(item.sisaPiutang)}</div></div>
          </div>

          <div class="customer-card-actions">
            <button type="button" class="btn-bayar-piutang" onclick="POS_DRIVER_CUSTOMER.openLunasiPiutangModal('${escapeHtml(item.idTransaksi)}')">
              <i class="fas fa-hand-holding-dollar"></i> Bayar / Cicil
            </button>
            ${
              waUrl
                ? `<a href="${waUrl}" target="_blank" rel="noopener" class="btn-chip-wa"><i class="fab fa-whatsapp"></i> Tagih WA</a>`
                : ""
            }
            ${
              mapsUrl
                ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-chip-maps"><i class="fas fa-map-pin"></i> Maps</a>`
                : ""
            }
          </div>
        </div>`;
      })
      .join("");
  }

  function openLunasiPiutangModal(idTransaksi) {
    const target = state.piutangList.find((x) => x.idTransaksi === idTransaksi);
    if (!target) return;
    state.activePiutangTarget = target;

    const summaryEl = document.getElementById("lunasi-piutang-summary");
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div><b>${escapeHtml(target.namaPelanggan)}</b> (${escapeHtml(target.idTransaksi)})</div>
        <div>Tanggal Nota: ${escapeHtml(target.tanggal)} &bull; Umur: <b>${target.umurHari} hari</b></div>
        <div>Sisa Piutang: <strong style="color:var(--red-delete);font-size:1.1rem;">${formatRp(target.sisaPiutang)}</strong></div>
      `;
    }

    populateAkunKasSelect("lunasi-akun-kas", "Kas Laci");
    document.getElementById("lunasi-nominal").value = target.sisaPiutang;
    document.getElementById("lunasi-nominal").max = target.sisaPiutang;
    document.getElementById("lunasi-metode").value = "Tunai";
    document.getElementById("lunasi-tanggal").value = todayWIB();
    document.getElementById("lunasi-keterangan").value = "";

    const modal = document.getElementById("modal-lunasi-piutang");
    if (modal) { modal.classList.add("show", "active"); modal.style.display = "flex"; }
  }

  function closeLunasiPiutangModal() {
    const modal = document.getElementById("modal-lunasi-piutang");
    if (modal) { modal.classList.remove("show", "active"); modal.style.display = "none"; }
  }

  function setLunasiPenuh() {
    if (!state.activePiutangTarget) return;
    document.getElementById("lunasi-nominal").value = state.activePiutangTarget.sisaPiutang;
  }

  async function submitLunasiPiutang(ev) {
    if (ev) ev.preventDefault();
    const target = state.activePiutangTarget;
    if (!target) return;

    const nominal = Math.round(Number(document.getElementById("lunasi-nominal").value) || 0);
    if (nominal <= 0 || nominal > target.sisaPiutang) {
      showToast(`Nominal harus antara Rp 1 s/d ${formatRp(target.sisaPiutang)}.`, true);
      return;
    }

    const payload = {
      idTransaksi: target.idTransaksi,
      nominalBayar: nominal,
      akunKas: document.getElementById("lunasi-akun-kas").value,
      metodeBayar: document.getElementById("lunasi-metode").value,
      tanggalBayar: document.getElementById("lunasi-tanggal").value || todayWIB(),
      keterangan: document.getElementById("lunasi-keterangan").value.trim()
    };

    const btn = document.getElementById("btn-submit-lunasi");
    if (btn) btn.disabled = true;

    const reqId = window.POS_API.generateClientRequestId("PTG");
    const res = await window.POS_API.lunasiPiutang(payload, reqId);

    if (btn) btn.disabled = false;

    if (res.sukses) {
      showToast(res.pesan || "Pembayaran piutang berhasil dicatat.");
      closeLunasiPiutangModal();
      loadPiutangAging();
    } else if (window.POS_API.isOfflineError(res)) {
      enqueueOffline(
        "lunasiPiutang",
        payload,
        reqId,
        `Bayar Piutang ${target.namaPelanggan} (${formatRp(nominal)})`
      );
      closeLunasiPiutangModal();
      showToast("Sinyal putus. Pelunasan piutang masuk Antrean Offline.");
    } else {
      showToast(res.pesan || "Gagal memproses pelunasan piutang.", true);
    }
  }

  // ==========================================================================
  // 4. HALAMAN TUGAS SUPIR & NGAMPAS (page-supir)
  // ==========================================================================

  function switchSupirTab(tab) {
    state.supirTab = ["aktif", "verifikasi", "selesai"].includes(tab) ? tab : "aktif";
    ["aktif", "verifikasi", "selesai"].forEach((t) => {
      const btn = document.getElementById(`tab-btn-supir-${t}`);
      if (btn) btn.classList.toggle("active", state.supirTab === t);
    });
    renderTugasSupirList();
  }

  async function loadDaftarTugasSupir() {
    if (!isOperationalBranch()) return;
    const container = document.getElementById("supir-tugas-container");
    if (container) container.innerHTML = '<p class="empty-state-text">Memuat tugas pengantaran...</p>';

    const res = await window.POS_API.getDaftarTugasSupir({ limit: 120 });
    if (!res.sukses) {
      if (container) container.innerHTML = `<p class="empty-state-text">${escapeHtml(res.pesan)}</p>`;
      return;
    }

    state.tugasList = (res.data && res.data.items) || [];
    state.tugasCounts = (res.data && res.data.counts) || {
      terjadwal: 0,
      berangkat: 0,
      menungguVerifikasi: 0,
      selesai: 0
    };

    const badgeVerif = document.getElementById("badge-count-verifikasi");
    if (badgeVerif) {
      badgeVerif.textContent = String(state.tugasCounts.menungguVerifikasi || 0);
      badgeVerif.style.display = state.tugasCounts.menungguVerifikasi > 0 ? "inline-block" : "none";
    }

    renderTugasSupirList();
  }

  function renderTugasSupirList() {
    const container = document.getElementById("supir-tugas-container");
    if (!container) return;

    const list = state.tugasList.filter((t) => {
      const st = String(t.status || "").toUpperCase();
      if (state.supirTab === "aktif") return st === "TERJADWAL" || st === "BERANGKAT";
      if (state.supirTab === "verifikasi") return st === "MENUNGGU_VERIFIKASI";
      return st === "SELESAI_TERVERIFIKASI";
    });

    if (list.length === 0) {
      const emptyMsg =
        state.supirTab === "verifikasi"
          ? "Tidak ada setoran supir yang menunggu verifikasi."
          : state.supirTab === "selesai"
          ? "Belum ada riwayat pengantaran terverifikasi."
          : "Tidak ada tugas pengantaran aktif saat ini.";
      container.innerHTML = `<p class="empty-state-text">${emptyMsg}</p>`;
      return;
    }

    const verifier = canVerifySetoran();

    container.innerHTML = list
      .map((t) => {
        const mapsUrl = buildMapsLink(t.mapsUrl, t.alamat, "");
        const waUrl = buildWaLink(t.noWa, `Halo Bapak/Ibu ${t.namaPelanggan}, supir Al-Kautsar sedang menuju lokasi.`);
        const isNgampas = t.tipeTugas === "NGAMPAS";
        const itemsPreview = (t.itemsBerangkat || [])
          .map((it) => `${escapeHtml(it.namaBarang)} (${it.qty})`)
          .join(", ");

        let statusBadge = `<span class="status-pill st-berangkat">${escapeHtml(t.status)}</span>`;
        if (t.status === "MENUNGGU_VERIFIKASI") {
          statusBadge = '<span class="status-pill st-verif">MENUNGGU VERIFIKASI</span>';
        } else if (t.status === "SELESAI_TERVERIFIKASI") {
          statusBadge = '<span class="status-pill st-selesai">SELESAI TERVERIFIKASI</span>';
        }

        return `
        <div class="tugas-card">
          <div class="tugas-card-header">
            <div>
              <span class="tipe-pill ${isNgampas ? "tipe-ngampas" : "tipe-antar"}">
                ${isNgampas ? "NGAMPAS" : "ANTARAN"}
              </span>
              <strong>${escapeHtml(t.namaPelanggan)}</strong>
            </div>
            ${statusBadge}
          </div>

          <div class="tugas-card-meta">
            <span><i class="fas fa-hashtag"></i> ${escapeHtml(t.tugasId)}</span>
            <span><i class="fas fa-calendar"></i> ${escapeHtml(t.tanggalJadwal)} ${escapeHtml(t.waktuJadwal)}</span>
            <span><i class="fas fa-user-tie"></i> ${escapeHtml(t.supirNama || "-")}</span>
          </div>

          <div class="tugas-card-body">
            <div><i class="fas fa-location-dot"></i> ${escapeHtml(t.alamat || "Alamat tidak dicantumkan")}</div>
            <div><i class="fas fa-box-open"></i> <b>Muatan:</b> ${itemsPreview || "-"}</div>
            <div class="tugas-money-row">
              <span>Tagihan Awal: <b>${formatRp(t.totalTagihanAwal)}</b></span>
              ${
                t.status !== "BERANGKAT" && t.status !== "TERJADWAL"
                  ? `<span>Realisasi: <b>${formatRp(t.totalTagihanRealisasi)}</b> | Cash: <b>${formatRp(t.bayarCashLapangan)}</b> | Trf: <b>${formatRp(t.bayarTransferLapangan)}</b></span>`
                  : ""
              }
            </div>
            ${
              t.fotoAntarUrl || t.fotoBayarUrl
                ? `<div class="tugas-foto-links">
                    ${t.fotoAntarUrl ? `<a href="${escapeHtml(t.fotoAntarUrl)}" target="_blank" rel="noopener"><i class="fas fa-image"></i> Foto Bukti Antar</a>` : ""}
                    ${t.fotoBayarUrl ? `<a href="${escapeHtml(t.fotoBayarUrl)}" target="_blank" rel="noopener"><i class="fas fa-receipt"></i> Foto Bukti Bayar</a>` : ""}
                   </div>`
                : ""
            }
          </div>

          <div class="tugas-card-actions">
            ${
              mapsUrl
                ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-chip-maps"><i class="fas fa-diamond-turn-right"></i> Navigasi Maps</a>`
                : ""
            }
            ${
              waUrl
                ? `<a href="${waUrl}" target="_blank" rel="noopener" class="btn-chip-wa"><i class="fab fa-whatsapp"></i> WA</a>`
                : ""
            }
            ${
              t.status === "BERANGKAT" || t.status === "TERJADWAL"
                ? `<button type="button" class="btn-aksi-primary" onclick="POS_DRIVER_CUSTOMER.openSelesaiModal('${escapeHtml(t.tugasId)}')">
                    <i class="fas fa-clipboard-check"></i> Selesai Pengantaran
                   </button>`
                : ""
            }
            ${
              t.status === "MENUNGGU_VERIFIKASI" && verifier
                ? `<button type="button" class="btn-aksi-verif" onclick="POS_DRIVER_CUSTOMER.openVerifikasiModal('${escapeHtml(t.tugasId)}')">
                    <i class="fas fa-shield-check"></i> Verifikasi &amp; Masuk Kas
                   </button>`
                : ""
            }
            ${
              t.status === "BERANGKAT" || t.status === "TERJADWAL"
                ? `<button type="button" class="btn-chip-cal" onclick="POS_DRIVER_CUSTOMER.batalkanTugasCalendar('${escapeHtml(t.tugasId)}')" title="Batalkan tugas & hapus event Calendar">
                    <i class="fas fa-calendar-xmark"></i>
                   </button>`
                : ""
            }
          </div>
        </div>`;
      })
      .join("");
  }

  // --- MODAL MULAI PENGANTARAN / KEBERANGKATAN ---

  async function ensureProdukAndPelangganLoaded() {
    const s = getSession();
    const cabang = s ? s.activeCabang : "";
    if (!cabang) return;

    if (!state.produkCacheByBranch[cabang]) {
      const resBoot = await window.POS_API.getBootstrapData(cabang);
      if (resBoot.sukses && resBoot.data) {
        state.produkCacheByBranch[cabang] = resBoot.data.produk || resBoot.data.barang || [];
      }
    }

    if (state.pelangganList.length === 0) {
      const resPlg = await window.POS_API.kelolaPelanggan({ mode: "LIST" });
      if (resPlg.sukses && resPlg.data) {
        state.pelangganList = resPlg.data.items || [];
      }
    }
  }

  async function openMulaiAntarModal() {
    if (!isOperationalBranch()) {
      showToast("Pilih cabang Korpri atau Pringsewu terlebih dahulu.", true);
      return;
    }

    await ensureProdukAndPelangganLoaded();
    const s = getSession();
    const produk = state.produkCacheByBranch[s.activeCabang] || [];

    // Isi dropdown pelanggan
    const plgSelect = document.getElementById("mulai-pelanggan-select");
    if (plgSelect) {
      plgSelect.innerHTML =
        '<option value="">-- Pilih dari Direktori / Ketik Manual --</option>' +
        state.pelangganList
          .map((p) => `<option value="${escapeHtml(p.pelangganId)}">${escapeHtml(p.nama)} (${escapeHtml(p.kategori)})</option>`)
          .join("");
    }

    // Isi dropdown barang
    const brgSelect = document.getElementById("mulai-barang-select");
    if (brgSelect) {
      brgSelect.innerHTML = produk
        .map((b) => {
          const id = b.idBarang || b.id || b["ID Barang"] || "";
          const nama = b.namaBarang || b.nama || b["Nama Barang"] || "";
          const harga = Math.round(Number(b.hargaJual || b.harga || b["Harga Jual"] || 0));
          const stok = Math.round(Number(b.stokSaatIni ?? b.stok ?? b["Stok Saat Ini"] ?? 0));
          return `<option value="${escapeHtml(id)}" data-nama="${escapeHtml(nama)}" data-harga="${harga}">${escapeHtml(nama)} — ${formatRp(harga)} (Stok: ${stok})</option>`;
        })
        .join("");
    }

    state.muatanDraft = [];
    document.getElementById("mulai-tipe-tugas").value = "ANTARAN_PESANAN";
    document.getElementById("mulai-tanggal").value = todayWIB();
    document.getElementById("mulai-waktu").value = nowTimeWIB();
    document.getElementById("mulai-supir-nama").value = s ? s.namaLengkap || s.username : "";
    document.getElementById("mulai-nama-pelanggan").value = "";
    document.getElementById("mulai-no-wa").value = "";
    document.getElementById("mulai-alamat").value = "";
    document.getElementById("mulai-maps-url").value = "";
    document.getElementById("mulai-catatan").value = "";
    document.getElementById("mulai-qty-barang").value = "1";
    document.getElementById("mulai-sinkron-cal").checked = true;

    renderMuatanDraft();

    const modal = document.getElementById("modal-mulai-antar");
    if (modal) { modal.classList.add("show", "active"); modal.style.display = "flex"; }
  }

  function closeMulaiAntarModal() {
    const modal = document.getElementById("modal-mulai-antar");
    if (modal) { modal.classList.remove("show", "active"); modal.style.display = "none"; }
  }

  function onMulaiPelangganPicked() {
    const id = document.getElementById("mulai-pelanggan-select").value;
    if (!id) return;
    const p = state.pelangganList.find((x) => x.pelangganId === id);
    if (!p) return;
    document.getElementById("mulai-nama-pelanggan").value = p.nama;
    document.getElementById("mulai-no-wa").value = p.noWa;
    document.getElementById("mulai-alamat").value = p.alamat;
    document.getElementById("mulai-maps-url").value = p.mapsUrl;
  }

  function addMuatanItem() {
    const sel = document.getElementById("mulai-barang-select");
    if (!sel || !sel.value) return;
    const opt = sel.options[sel.selectedIndex];
    const idBarang = sel.value;
    const namaBarang = opt.dataset.nama || opt.textContent;
    const hargaJual = Math.round(Number(opt.dataset.harga) || 0);
    const qty = Math.max(1, Math.round(Number(document.getElementById("mulai-qty-barang").value) || 1));

    const existing = state.muatanDraft.find((x) => x.idBarang === idBarang);
    if (existing) {
      existing.qty += qty;
    } else {
      state.muatanDraft.push({ idBarang, namaBarang, qty, hargaJual });
    }
    renderMuatanDraft();
  }

  function updateMuatanField(idx, field, val) {
    if (!state.muatanDraft[idx]) return;
    state.muatanDraft[idx][field] = Math.max(0, Math.round(Number(val) || 0));
    renderMuatanDraft();
  }

  function removeMuatanItem(idx) {
    state.muatanDraft.splice(idx, 1);
    renderMuatanDraft();
  }

  function renderMuatanDraft() {
    const box = document.getElementById("mulai-muatan-list");
    const totalEl = document.getElementById("mulai-total-estimasi");
    if (!box) return;

    if (state.muatanDraft.length === 0) {
      box.innerHTML = '<p class="empty-mutasi-text">Belum ada barang di daftar muatan.</p>';
      if (totalEl) totalEl.textContent = formatRp(0);
      return;
    }

    let total = 0;
    box.innerHTML = state.muatanDraft
      .map((it, idx) => {
        const sub = it.qty * it.hargaJual;
        total += sub;
        return `
        <div class="muatan-row-item">
          <div class="muatan-row-name">${escapeHtml(it.namaBarang)}</div>
          <div class="muatan-row-controls">
            <input type="number" min="1" value="${it.qty}" onchange="POS_DRIVER_CUSTOMER.updateMuatanField(${idx},'qty',this.value)" title="Qty">
            <input type="number" min="0" value="${it.hargaJual}" onchange="POS_DRIVER_CUSTOMER.updateMuatanField(${idx},'hargaJual',this.value)" title="Harga">
            <button type="button" class="btn-mini-danger" onclick="POS_DRIVER_CUSTOMER.removeMuatanItem(${idx})"><i class="fas fa-times"></i></button>
          </div>
        </div>`;
      })
      .join("");

    if (totalEl) totalEl.textContent = formatRp(total);
  }

  async function submitMulaiPengantaran(ev) {
    if (ev) ev.preventDefault();
    if (state.muatanDraft.length === 0) {
      showToast("Tambahkan minimal 1 barang ke daftar muatan.", true);
      return;
    }

    const s = getSession();
    const payload = {
      tipeTugas: document.getElementById("mulai-tipe-tugas").value,
      tanggalJadwal: document.getElementById("mulai-tanggal").value || todayWIB(),
      waktuJadwal: document.getElementById("mulai-waktu").value || nowTimeWIB(),
      supirUsername: s && s.activeRole === "Supir" ? s.username : "",
      supirNama: document.getElementById("mulai-supir-nama").value.trim(),
      pelangganId: document.getElementById("mulai-pelanggan-select").value || "",
      namaPelanggan: document.getElementById("mulai-nama-pelanggan").value.trim(),
      noWa: document.getElementById("mulai-no-wa").value.trim(),
      alamat: document.getElementById("mulai-alamat").value.trim(),
      mapsUrl: document.getElementById("mulai-maps-url").value.trim(),
      catatan: document.getElementById("mulai-catatan").value.trim(),
      sinkronKalender: document.getElementById("mulai-sinkron-cal").checked,
      items: state.muatanDraft
    };

    if (!payload.namaPelanggan) {
      showToast("Nama pelanggan / tujuan rute wajib diisi.", true);
      return;
    }

    const btn = document.getElementById("btn-submit-mulai-antar");
    if (btn) btn.disabled = true;

    const reqId = window.POS_API.generateClientRequestId("ANT");
    const res = await window.POS_API.mulaiPengantaran(payload, reqId);

    if (btn) btn.disabled = false;

    if (res.sukses) {
      showToast(res.pesan || "Tugas pengantaran berhasil dibuat.");
      closeMulaiAntarModal();
      loadDaftarTugasSupir();
    } else if (window.POS_API.isOfflineError(res)) {
      enqueueOffline(
        "mulaiPengantaran",
        payload,
        reqId,
        `Mulai ${payload.tipeTugas}: ${payload.namaPelanggan}`
      );
      closeMulaiAntarModal();
      showToast("Sinyal putus. Tugas keberangkatan disimpan ke Antrean Offline.");
    } else {
      showToast(res.pesan || "Gagal membuat tugas pengantaran.", true);
    }
  }

  // --- MODAL SELESAI PENGANTARAN (CEKLIS TURUN + FOTO KOMPRESI) ---

  function openSelesaiModal(tugasId) {
    const tugas = state.tugasList.find((x) => x.tugasId === tugasId);
    if (!tugas) return;

    state.activeSelesaiTugas = tugas;
    state.fotoAntarCompressed = null;
    state.fotoBayarCompressed = null;

    const headerEl = document.getElementById("selesai-tugas-summary");
    if (headerEl) {
      headerEl.innerHTML = `
        <div><strong>${escapeHtml(tugas.namaPelanggan)}</strong> (${escapeHtml(tugas.tugasId)})</div>
        <div>${escapeHtml(tugas.tipeTugas)} &bull; Supir: ${escapeHtml(tugas.supirNama)}</div>
      `;
    }

    // Render daftar ceklis barang diturunkan & harga lapangan
    const itemsBox = document.getElementById("selesai-items-container");
    const items = tugas.itemsBerangkat || [];
    if (itemsBox) {
      itemsBox.innerHTML = items
        .map(
          (it, idx) => `
        <div class="realisasi-item-row" data-idx="${idx}">
          <label class="realisasi-check-label">
            <input type="checkbox" class="real-check" data-idx="${idx}" checked onchange="POS_DRIVER_CUSTOMER.recalcSelesaiTotal()">
            <span><strong>${escapeHtml(it.namaBarang)}</strong> (Bawa: ${it.qty})</span>
          </label>
          <div class="realisasi-inputs-grid">
            <div>
              <small>Qty Turun</small>
              <input type="number" class="real-qty" data-idx="${idx}" min="0" max="${it.qty}" value="${it.qty}" oninput="POS_DRIVER_CUSTOMER.recalcSelesaiTotal()">
            </div>
            <div>
              <small>Harga Lapangan (Rp)</small>
              <input type="number" class="real-harga" data-idx="${idx}" min="0" value="${it.hargaJual}" oninput="POS_DRIVER_CUSTOMER.recalcSelesaiTotal()">
            </div>
          </div>
        </div>`
        )
        .join("");
    }

    document.getElementById("selesai-diskon").value = "0";
    document.getElementById("selesai-cash").value = String(tugas.totalTagihanAwal || 0);
    document.getElementById("selesai-transfer").value = "0";
    document.getElementById("selesai-catatan").value = tugas.catatanLapangan || "";

    // Reset input & preview foto
    ["selesai-foto-antar", "selesai-foto-bayar"].forEach((id) => {
      const inp = document.getElementById(id);
      if (inp) inp.value = "";
    });
    ["preview-foto-antar", "preview-foto-bayar"].forEach((id) => {
      const img = document.getElementById(id);
      if (img) {
        img.src = "";
        img.style.display = "none";
      }
    });
    const infoA = document.getElementById("info-foto-antar");
    const infoB = document.getElementById("info-foto-bayar");
    if (infoA) infoA.textContent = "Otomatis dikompresi < 200 KB sebelum dikirim.";
    if (infoB) infoB.textContent = "Opsional (wajib jika ada transfer/pembayaran).";

    recalcSelesaiTotal();

    const modal = document.getElementById("modal-selesai-antar");
    if (modal) { modal.classList.add("show", "active"); modal.style.display = "flex"; }
  }

  function closeSelesaiModal() {
    const modal = document.getElementById("modal-selesai-antar");
    if (modal) { modal.classList.remove("show", "active"); modal.style.display = "none"; }
  }

  function collectSelesaiItems() {
    const tugas = state.activeSelesaiTugas;
    if (!tugas) return [];
    const baseItems = tugas.itemsBerangkat || [];
    const result = [];

    baseItems.forEach((it, idx) => {
      const chk = document.querySelector(`.real-check[data-idx="${idx}"]`);
      const qtyInp = document.querySelector(`.real-qty[data-idx="${idx}"]`);
      const hrgInp = document.querySelector(`.real-harga[data-idx="${idx}"]`);

      const diturunkan = chk ? chk.checked : true;
      const qtyTurun = diturunkan
        ? Math.min(it.qty, Math.max(0, Math.round(Number(qtyInp ? qtyInp.value : it.qty) || 0)))
        : 0;
      const hargaLapangan = Math.max(0, Math.round(Number(hrgInp ? hrgInp.value : it.hargaJual) || 0));

      result.push({
        idBarang: it.idBarang,
        namaBarang: it.namaBarang,
        qtyBawa: it.qty,
        qtyTurun: qtyTurun,
        qtyRetur: Math.max(0, it.qty - qtyTurun),
        diturunkan: diturunkan,
        hargaAwal: it.hargaJual,
        hargaLapangan: hargaLapangan
      });
    });

    return result;
  }

  function recalcSelesaiTotal() {
    const items = collectSelesaiItems();
    let total = 0;
    let totalRetur = 0;
    items.forEach((it) => {
      total += it.qtyTurun * it.hargaLapangan;
      totalRetur += it.qtyRetur;
    });
    const diskon = Math.max(0, Math.round(Number((document.getElementById("selesai-diskon") || {}).value) || 0));
    const tagihanBersih = Math.max(0, total - diskon);

    const elTotal = document.getElementById("selesai-total-realisasi");
    const elRetur = document.getElementById("selesai-total-retur");
    if (elTotal) elTotal.textContent = formatRp(tagihanBersih);
    if (elRetur) elRetur.textContent = `${totalRetur} pcs retur`;
  }

  async function submitSelesaiPengantaran(ev) {
    if (ev) ev.preventDefault();
    const tugas = state.activeSelesaiTugas;
    if (!tugas) return;

    const payload = {
      tugasId: tugas.tugasId,
      itemsRealisasi: collectSelesaiItems(),
      diskonSelisih: Math.max(0, Math.round(Number(document.getElementById("selesai-diskon").value) || 0)),
      bayarCashLapangan: Math.max(0, Math.round(Number(document.getElementById("selesai-cash").value) || 0)),
      bayarTransferLapangan: Math.max(0, Math.round(Number(document.getElementById("selesai-transfer").value) || 0)),
      catatanLapangan: document.getElementById("selesai-catatan").value.trim(),
      fotoAntarBase64: state.fotoAntarCompressed ? state.fotoAntarCompressed.base64 : "",
      fotoAntarMime: state.fotoAntarCompressed ? state.fotoAntarCompressed.mime : "image/jpeg",
      fotoBayarBase64: state.fotoBayarCompressed ? state.fotoBayarCompressed.base64 : "",
      fotoBayarMime: state.fotoBayarCompressed ? state.fotoBayarCompressed.mime : "image/jpeg"
    };

    const btn = document.getElementById("btn-submit-selesai-antar");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengunggah &amp; Menyimpan...';
    }

    const reqId = window.POS_API.generateClientRequestId("SLS");
    const res = await window.POS_API.submitSelesaiPengantaran(payload, reqId);

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Kirim Laporan (Menunggu Verifikasi)';
    }

    if (res.sukses) {
      showToast(res.pesan || "Laporan pengantaran terkirim.");
      closeSelesaiModal();
      loadDaftarTugasSupir();
    } else if (window.POS_API.isOfflineError(res)) {
      enqueueOffline(
        "submitSelesaiPengantaran",
        payload,
        reqId,
        `Selesai Antar ${tugas.tugasId} (${tugas.namaPelanggan})`
      );
      closeSelesaiModal();
      showToast("Sinyal lapangan terputus. Laporan + foto disimpan ke Antrean Offline.");
    } else {
      showToast(res.pesan || "Gagal mengirim laporan pengantaran.", true);
    }
  }

  // --- MODAL VERIFIKASI SETORAN SUPIR (TOKO -> ARUS KAS) ---

  function openVerifikasiModal(tugasId) {
    const tugas = state.tugasList.find((x) => x.tugasId === tugasId);
    if (!tugas) return;
    state.activeVerifikasiTugas = tugas;

    const infoEl = document.getElementById("verif-tugas-detail");
    const returItems = (tugas.itemsRealisasi || []).filter((x) => Number(x.qtyRetur) > 0);
    const returHtml =
      returItems.length > 0
        ? returItems.map((r) => `<li>${escapeHtml(r.namaBarang)}: <b>${r.qtyRetur} pcs retur</b></li>`).join("")
        : "<li>Tidak ada barang retur.</li>";

    if (infoEl) {
      infoEl.innerHTML = `
        <div><strong>${escapeHtml(tugas.namaPelanggan)}</strong> (${escapeHtml(tugas.tugasId)})</div>
        <div>Tipe: <b>${escapeHtml(tugas.tipeTugas)}</b> &bull; Supir: <b>${escapeHtml(tugas.supirNama)}</b></div>
        <div>Total Realisasi Barang: <b>${formatRp(tugas.totalTagihanRealisasi)}</b></div>
        <div style="margin-top:6px;"><b>Daftar Retur Barang:</b><ul class="verif-retur-list">${returHtml}</ul></div>
        <div class="tugas-foto-links" style="margin-top:8px;">
          ${
            tugas.fotoAntarUrl
              ? `<a href="${escapeHtml(tugas.fotoAntarUrl)}" target="_blank" rel="noopener"><i class="fas fa-image"></i> Buka Foto Antar (Drive)</a>`
              : "<span>Tidak ada foto antar</span>"
          }
          ${
            tugas.fotoBayarUrl
              ? `<a href="${escapeHtml(tugas.fotoBayarUrl)}" target="_blank" rel="noopener"><i class="fas fa-receipt"></i> Buka Foto Bayar (Drive)</a>`
              : "<span>Tidak ada foto bayar</span>"
          }
        </div>
      `;
    }

    populateAkunKasSelect("verif-akun-cash", "Kas Laci");
    populateAkunKasSelect("verif-akun-transfer", "Rekening Bunda");

    document.getElementById("verif-cash").value = String(tugas.bayarCashLapangan || 0);
    document.getElementById("verif-transfer").value = String(tugas.bayarTransferLapangan || 0);
    document.getElementById("verif-diskon").value = String(tugas.diskonSelisih || 0);
    document.getElementById("verif-tanggal").value = todayWIB();
    document.getElementById("verif-retur-stok").checked = true;
    document.getElementById("verif-sisa-piutang").checked = false;
    document.getElementById("verif-catatan").value = "";

    const modal = document.getElementById("modal-verifikasi-supir");
    if (modal) { modal.classList.add("show", "active"); modal.style.display = "flex"; }
  }

  function closeVerifikasiModal() {
    const modal = document.getElementById("modal-verifikasi-supir");
    if (modal) { modal.classList.remove("show", "active"); modal.style.display = "none"; }
  }

  async function submitVerifikasiSetoran(ev) {
    if (ev) ev.preventDefault();
    const tugas = state.activeVerifikasiTugas;
    if (!tugas) return;

    const payload = {
      tugasId: tugas.tugasId,
      tanggalVerifikasi: document.getElementById("verif-tanggal").value || todayWIB(),
      nominalCashDiterima: Math.max(0, Math.round(Number(document.getElementById("verif-cash").value) || 0)),
      nominalTransferDiterima: Math.max(0, Math.round(Number(document.getElementById("verif-transfer").value) || 0)),
      akunKasCash: document.getElementById("verif-akun-cash").value,
      akunKasTransfer: document.getElementById("verif-akun-transfer").value,
      diskonSelisihFinal: Math.max(0, Math.round(Number(document.getElementById("verif-diskon").value) || 0)),
      kembalikanReturKeStok: document.getElementById("verif-retur-stok").checked,
      catatSisaSebagaiPiutang: document.getElementById("verif-sisa-piutang").checked,
      catatanVerifikasi: document.getElementById("verif-catatan").value.trim()
    };

    const btn = document.getElementById("btn-submit-verifikasi");
    if (btn) btn.disabled = true;

    const reqId = window.POS_API.generateClientRequestId("VER");
    const res = await window.POS_API.verifikasiSetoranSupir(payload, reqId);

    if (btn) btn.disabled = false;

    if (res.sukses) {
      showToast(res.pesan || "Setoran supir terverifikasi dan masuk Arus Kas.");
      closeVerifikasiModal();
      loadDaftarTugasSupir();
    } else if (window.POS_API.isOfflineError(res)) {
      enqueueOffline("verifikasiSetoranSupir", payload, reqId, `Verifikasi ${tugas.tugasId}`);
      closeVerifikasiModal();
      showToast("Sinyal putus. Verifikasi disimpan ke Antrean Offline.");
    } else {
      showToast(res.pesan || "Gagal memverifikasi setoran.", true);
    }
  }

  async function batalkanTugasCalendar(tugasId) {
    if (!confirm(`Batalkan tugas ${tugasId} dan hapus jadwalnya di Google Calendar?`)) return;
    const res = await window.POS_API.sinkronCalendar({
      mode: "DELETE",
      tugasId: tugasId,
      batalkanTugas: true
    });
    if (res.sukses) {
      showToast("Tugas dibatalkan & jadwal Google Calendar dihapus.");
      loadDaftarTugasSupir();
    } else {
      showToast(res.pesan || "Gagal membatalkan tugas.", true);
    }
  }

  // ==========================================================================
  // 5. AUTO-INIT & PENGAMAT NAVIGASI / PERPINDAHAN CABANG
  // ==========================================================================

  function refreshActivePageIfRelevant() {
    const pSupir = document.getElementById("page-supir");
    const pPlg = document.getElementById("page-pelanggan-piutang");
    if (pSupir && pSupir.classList.contains("active")) {
      loadDaftarTugasSupir();
    } else if (pPlg && pPlg.classList.contains("active")) {
      if (state.pelangganTab === "piutang") loadPiutangAging();
      else loadPelanggan();
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    // Amati perubahan class 'active' pada section Fase 3 agar otomatis load data
    ["page-supir", "page-pelanggan-piutang"].forEach((pageId) => {
      const el = document.getElementById(pageId);
      if (!el) return;
      const obs = new MutationObserver(() => {
        if (el.classList.contains("active")) {
          if (pageId === "page-supir") loadDaftarTugasSupir();
          if (pageId === "page-pelanggan-piutang") {
            if (state.pelangganTab === "piutang") loadPiutangAging();
            else loadPelanggan();
          }
        }
      });
      obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    });

    // Amati perpindahan cabang pada <body data-branch="...">
    const bodyObs = new MutationObserver(() => {
      refreshActivePageIfRelevant();
    });
    bodyObs.observe(document.body, { attributes: true, attributeFilter: ["data-branch"] });

    // Pantau status koneksi internet untuk auto-sync Offline Queue
    window.addEventListener("online", () => {
      renderOfflineBanner();
      syncOfflineQueue(true);
    });
    window.addEventListener("offline", () => {
      renderOfflineBanner();
    });

    renderOfflineBanner();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    init,
    compressImageFile,
    onPhotoInputChange,
    enqueueOffline,
    syncOfflineQueue,
    openOfflineQueueModal,
    closeOfflineQueueModal,
    removeOfflineItem,
    switchPelangganTab,
    loadPelanggan,
    renderPelangganList,
    openPelangganModal,
    closePelangganModal,
    submitPelangganForm,
    nonaktifkanPelanggan,
    loadPiutangAging,
    setPiutangBucketFilter,
    renderPiutangList,
    openLunasiPiutangModal,
    closeLunasiPiutangModal,
    setLunasiPenuh,
    submitLunasiPiutang,
    switchSupirTab,
    loadDaftarTugasSupir,
    openMulaiAntarModal,
    closeMulaiAntarModal,
    onMulaiPelangganPicked,
    addMuatanItem,
    updateMuatanField,
    removeMuatanItem,
    submitMulaiPengantaran,
    openSelesaiModal,
    closeSelesaiModal,
    recalcSelesaiTotal,
    submitSelesaiPengantaran,
    openVerifikasiModal,
    closeVerifikasiModal,
    submitVerifikasiSetoran,
    batalkanTugasCalendar
  };
})();