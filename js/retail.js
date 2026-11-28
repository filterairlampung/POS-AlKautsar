/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.0 — MODUL OPERASIONAL RITEL INTI
 * File: js/retail.js
 * ============================================================================
 * Mencakup:
 * - Bootstrap & Ringkasan Beranda (cabang tunggal & mode Gabungan 'all')
 * - Kasir (cari, filter kategori, keranjang, diskon item/total, auto-harga khusus,
 *   mode Ngampas awal, idempotency anti klik ganda)
 * - Daftar Harga Khusus Pelanggan
 * - Arus Kas (Akun_Kas + Kode_COA dinamis) & Tutup Kas Laci
 * - Mutasi Stok Batch (MASUK/KELUAR + konversi satuan ke qtyPcs)
 * - Riwayat Transaksi & Arus Kas + Soft-Delete Void (khusus Manajer/Bos/Admin)
 * - Pengaturan Struk Cabang
 */

window.POS_RETAIL = (function () {
  "use strict";

  // ==========================================================================
  // STATE INTERNAL MODUL RITEL
  // ==========================================================================
  const state = {
    cabang: "korpri",
    isLoadingBootstrap: false,
    produk: [],
    hargaKhusus: [],
    pelanggan: [],
    pengaturan: {},
    appConfig: {},
    selectedKategori: "SEMUA",
    cart: [], // [{ id, nama, kategori, satuan, stok, hargaNormal, harga, qty }]
    activeCheckoutReqId: "",
    isSubmittingTrx: false,
    isSubmittingKas: false,
    isSubmittingMutasi: false,
    mutasiBatch: [], // [{ idBarang, namaBarang, qtyPcs, infoSatuan, keterangan }]
    riwayatTab: "trx",
    riwayatTrx: [],
    riwayatKas: [],
    ringkasanKolomUang: null,
    // Cache lokal sesi untuk fallback pratinjau jika handler baca riwayat belum dipasang
    localSessionTrx: [],
    localSessionKas: [],
    voidTarget: null, // { type: 'trx' | 'kas', id, label, nominal, tanggal }
    pendingInboxDraft: null // Draft aktif dari Inbox Smart Paste WA
  };

  // ==========================================================================
  // UTILITAS FORMAT, KEAMANAN HTML & ZONA WAKTU WIB
  // ==========================================================================

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatRupiah(angka) {
    const n = Math.round(Number(angka) || 0);
    return "Rp " + n.toLocaleString("id-ID");
  }

  function getTodayWibIso() {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date());
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function getNowWibTimeStr() {
    try {
      return new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      })
        .format(new Date())
        .replace(/\./g, ":");
    } catch (e) {
      return new Date().toTimeString().slice(0, 8);
    }
  }

  function isoToDmy(isoStr) {
    if (!isoStr) return "";
    const parts = String(isoStr).trim().split("-");
    if (parts.length !== 3) return String(isoStr);
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  function getPengaturanValue(keys, fallback) {
    const p = state.pengaturan || {};
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (p[k] !== undefined && p[k] !== null && String(p[k]).trim() !== "") {
        return String(p[k]).trim();
      }
    }
    return fallback;
  }

  function isOperationalBranch() {
    const sess = window.POS_AUTH.getSession();
    return Boolean(sess && (sess.activeCabang === "korpri" || sess.activeCabang === "pringsewu"));
  }

  function ensureOperationalBranch(actionName) {
    if (isOperationalBranch()) return true;
    window.POS_AUTH.showToast(
      `Pilih cabang Korpri atau Pringsewu terlebih dahulu untuk ${actionName}.`,
      "error"
    );
    return false;
  }

  // ==========================================================================
  // 1. LIFECYCLE & BOOTSTRAP DATA
  // ==========================================================================

  async function onContextReady(session) {
    if (!session) return;
    state.cabang = session.activeCabang || "korpri";
    state.cart = [];
    state.mutasiBatch = [];
    state.selectedKategori = "SEMUA";

    initStaticFormControls();
    await loadBootstrap();
  }

  function initStaticFormControls() {
    // Isi pilihan Akun Kas di Form Arus Kas & Modal Checkout
    const akunOpts = (window.POS_CONFIG && window.POS_CONFIG.AKUN_KAS_OPTIONS) || [];
    const akunHtml = akunOpts
      .map((opt) => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`)
      .join("");

    const kasAkunEl = document.getElementById("kas-akun-kas");
    if (kasAkunEl) kasAkunEl.innerHTML = akunHtml;

    const checkoutAkunEl = document.getElementById("checkout-akun-kas");
    if (checkoutAkunEl) checkoutAkunEl.innerHTML = akunHtml;

    // Isi pilihan COA sesuai kategori default Arus Kas
    populateCoaOptions();

    // Lengkapi opsi satuan mutasi stok (Pcs, Karung, Kardus, Bal, Paket)
    const satuanEl = document.getElementById("mutasi-satuan-mode");
    if (satuanEl) {
      satuanEl.innerHTML = [
        { val: "Pcs", label: "Pcs / Satuan" },
        { val: "Karung", label: "Karung / Sak" },
        { val: "Kardus", label: "Kardus / Dus" },
        { val: "Paket", label: "Paket / Set" }
      ]
        .map((s) => `<option value="${s.val}">${s.label}</option>`)
        .join("");
    }

    // Default penerima mutasi sesuai nama user aktif
    const sess = window.POS_AUTH.getSession();
    const penerimaEl = document.getElementById("mutasi-penerima");
    if (penerimaEl && sess && !penerimaEl.value) {
      penerimaEl.value = sess.namaLengkap || sess.username || "";
    }

    // Default rentang tanggal riwayat: hari ini WIB
    const todayIso = getTodayWibIso();
    const tglMulaiEl = document.getElementById("riwayat-tgl-mulai");
    const tglAkhirEl = document.getElementById("riwayat-tgl-akhir");
    if (tglMulaiEl && !tglMulaiEl.value) tglMulaiEl.value = todayIso;
    if (tglAkhirEl && !tglAkhirEl.value) tglAkhirEl.value = todayIso;
  }

  async function loadBootstrap() {
    const sess = window.POS_AUTH.getSession();
    if (!sess) return;

    state.cabang = sess.activeCabang || "korpri";
    state.isLoadingBootstrap = true;

    const statusEl = document.getElementById("home-branch-status");
    if (statusEl) {
      statusEl.textContent = "Memuat data dari server Google Apps Script...";
    }

    // Mode Gabungan ('all'): panggil Korpri & Pringsewu paralel sesuai kontrak requireBranch: true
    if (state.cabang === "all") {
      const [resKorpri, resPringsewu] = await Promise.all([
        window.POS_API.getBootstrapData("korpri"),
        window.POS_API.getBootstrapData("pringsewu")
      ]);

      state.isLoadingBootstrap = false;

      const prodKorpri = (resKorpri.sukses && resKorpri.data ? resKorpri.data.produk : []).map(
        (p) => Object.assign({ _cabang: "Korpri" }, p)
      );
      const prodPsw = (resPringsewu.sukses && resPringsewu.data ? resPringsewu.data.produk : []).map(
        (p) => Object.assign({ _cabang: "Pringsewu" }, p)
      );

      const pelKorpri = resKorpri.sukses && resKorpri.data ? resKorpri.data.pelanggan : [];
      const pelPsw = resPringsewu.sukses && resPringsewu.data ? resPringsewu.data.pelanggan : [];
      const khsKorpri = resKorpri.sukses && resKorpri.data ? resKorpri.data.hargaKhusus : [];
      const khsPsw = resPringsewu.sukses && resPringsewu.data ? resPringsewu.data.hargaKhusus : [];

      state.produk = [...prodKorpri, ...prodPsw];
      state.pelanggan = [...pelKorpri, ...pelPsw];
      state.hargaKhusus = [...khsKorpri, ...khsPsw];
      state.pengaturan = {};

      if (statusEl) {
        const okCount = (resKorpri.sukses ? 1 : 0) + (resPringsewu.sukses ? 1 : 0);
        statusEl.textContent =
          okCount === 2
            ? "Mode Gabungan aktif — Menampilkan akumulasi Korpri + Pringsewu."
            : "Mode Gabungan aktif — Sebagian data cabang gagal dimuat.";
      }

      renderHomeSummary();
      renderKasirKategoris();
      renderKasirProduk();
      renderHargaKhusus();
      renderMutasiSelect();
      return;
    }

    // Mode Cabang Operasional ('korpri' atau 'pringsewu')
    const res = await window.POS_API.getBootstrapData(state.cabang);
    state.isLoadingBootstrap = false;

    if (!res.sukses || !res.data) {
      if (statusEl) {
        statusEl.textContent = "Gagal memuat data cabang: " + (res.pesan || "Cek koneksi.");
      }
      window.POS_AUTH.showToast(res.pesan || "Gagal memuat data cabang.", "error");
      return;
    }

    state.produk = Array.isArray(res.data.produk) ? res.data.produk : [];
    state.hargaKhusus = Array.isArray(res.data.hargaKhusus) ? res.data.hargaKhusus : [];
    state.pelanggan = Array.isArray(res.data.pelanggan) ? res.data.pelanggan : [];
    state.pengaturan = res.data.pengaturan || {};
    state.appConfig = res.data.appConfig || {};

    const branchInfo = window.POS_CONFIG.BRANCHES[state.cabang];
    if (statusEl) {
      statusEl.textContent = `${branchInfo ? branchInfo.label : state.cabang.toUpperCase()} — Data sinkron (${getNowWibTimeStr()} WIB).`;
    }

    renderHomeSummary();
    renderKasirKategoris();
    renderKasirProduk();
    updateCartFooter();
    renderPelangganDatalist();
    renderHargaKhusus();
    renderMutasiSelect();
    renderMutasiBatchList();
    fillPengaturanForm();
  }

  function onPageActivated(pageId) {
    if (pageId === "page-kasir") {
      renderKasirProduk();
      updateCartFooter();
    } else if (pageId === "page-harga-khusus") {
      renderHargaKhusus();
    } else if (pageId === "page-arus-kas") {
      populateCoaOptions();
      loadKolomUangArusKas();
    } else if (pageId === "page-mutasi-stok") {
      renderMutasiSelect();
      updateMutasiPreview();
      renderMutasiBatchList();
    } else if (pageId === "page-riwayat") {
      loadRiwayatOperasional();
    } else if (pageId === "page-pengaturan-struk") {
      fillPengaturanForm();
    }
  }

  async function refreshCurrentBranch() {
    const btn = document.getElementById("btn-topbar-refresh");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Memuat...</span>';
    }

    await loadBootstrap();

    const activeSection = document.querySelector(".page-section.active");
    if (activeSection && activeSection.id === "page-riwayat") {
      await loadRiwayatOperasional();
    }

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-rotate"></i> <span>Refresh</span>';
    }
    window.POS_AUTH.showToast("Data cabang berhasil diperbarui.", "success");
  }

  // ==========================================================================
  // 2. BERANDA & ALERT STOK MENIPIS
  // ==========================================================================

  function renderHomeSummary() {
    const stokMenipis = state.produk.filter((p) => Number(p.stok) <= Number(p.batasMinimal || 10));

    const elProd = document.getElementById("home-stat-produk");
    const elTipis = document.getElementById("home-stat-menipis");
    const elPel = document.getElementById("home-stat-pelanggan");
    const elKhs = document.getElementById("home-stat-khusus");

    if (elProd) elProd.textContent = state.produk.length;
    if (elTipis) elTipis.textContent = stokMenipis.length;
    if (elPel) elPel.textContent = state.pelanggan.length;
    if (elKhs) elKhs.textContent = state.hargaKhusus.length;

    const alertBox = document.getElementById("alert-stok-home");
    const alertCount = document.getElementById("alert-stok-count");
    const alertList = document.getElementById("alert-stok-list");

    if (!alertBox || !alertList) return;

    if (stokMenipis.length === 0) {
      alertBox.style.display = "none";
      return;
    }

    alertBox.style.display = "block";
    if (alertCount) alertCount.textContent = stokMenipis.length;

    alertList.innerHTML = stokMenipis
      .sort((a, b) => Number(a.stok) - Number(b.stok))
      .map((item) => {
        const tagCabang = item._cabang ? `[${escapeHtml(item._cabang)}] ` : "";
        const statusStok =
          Number(item.stok) <= 0
            ? `<strong style="color:#dc2626;">HABIS (${item.stok})</strong>`
            : `<strong>Sisa ${item.stok} ${escapeHtml(item.satuan || "Pcs")}</strong>`;
        return `<li>${tagCabang}${escapeHtml(item.nama)} &mdash; ${statusStok} (Min. ${item.batasMinimal || 10})</li>`;
      })
      .join("");
  }

  function toggleAlertStok() {
    const body = document.getElementById("alert-stok-body");
    const chev = document.getElementById("alert-stok-chevron");
    if (!body) return;
    const isCollapsed = body.classList.toggle("collapsed");
    if (chev) {
      chev.className = isCollapsed ? "fas fa-chevron-down" : "fas fa-chevron-up";
    }
  }

  // ==========================================================================
  // 3. KASIR & KERANJANG BELANJA
  // ==========================================================================

  function renderKasirKategoris() {
    const container = document.getElementById("kasir-chip-container");
    if (!container) return;

    const kategoriSet = new Set(["SEMUA"]);
    state.produk.forEach((p) => {
      if (p.kategori) kategoriSet.add(p.kategori);
    });

    container.innerHTML = Array.from(kategoriSet)
      .map((kat) => {
        const active = kat === state.selectedKategori ? "active" : "";
        const label = kat === "SEMUA" ? "Semua Produk" : kat;
        return `<button type="button" class="chip ${active}" onclick="POS_RETAIL.selectKategori('${escapeHtml(kat)}')">${escapeHtml(label)}</button>`;
      })
      .join("");
  }

  function selectKategori(kat) {
    state.selectedKategori = kat;
    renderKasirKategoris();
    renderKasirProduk();
  }

  function renderKasirProduk() {
    const listEl = document.getElementById("kasir-produk-list");
    if (!listEl) return;

    if (!isOperationalBranch()) {
      listEl.innerHTML =
        '<p class="empty-state-text">Pilih cabang Korpri atau Pringsewu di atas untuk mulai bertransaksi.</p>';
      return;
    }

    const q = String((document.getElementById("kasir-search") || {}).value || "")
      .trim()
      .toLowerCase();

    const filtered = state.produk.filter((p) => {
      const matchKat = state.selectedKategori === "SEMUA" || p.kategori === state.selectedKategori;
      const matchQ =
        !q ||
        String(p.nama || "").toLowerCase().includes(q) ||
        String(p.id || "").toLowerCase().includes(q);
      return matchKat && matchQ;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = '<p class="empty-state-text">Produk tidak ditemukan.</p>';
      return;
    }

    listEl.innerHTML = filtered
      .map((prod) => {
        const inCart = state.cart.find((c) => c.id === prod.id);
        const qty = inCart ? inCart.qty : 0;
        const stok = Number(prod.stok) || 0;
        const batas = Number(prod.batasMinimal) || 10;

        let stokBadge = `<span style="color:#15803d;">Stok: ${stok} ${escapeHtml(prod.satuan || "Pcs")}</span>`;
        if (stok <= 0) {
          stokBadge = `<span style="color:#dc2626; font-weight:700;">Stok Habis (${stok})</span>`;
        } else if (stok <= batas) {
          stokBadge = `<span style="color:#d97706; font-weight:600;">Stok Tipis: ${stok} ${escapeHtml(prod.satuan || "Pcs")}</span>`;
        }

        const controlHtml =
          qty > 0
            ? `
              <div class="qty-control">
                <button type="button" class="btn-qty" onclick="POS_RETAIL.changeCartQty('${escapeHtml(prod.id)}', -1)">&minus;</button>
                <input
                  type="number"
                  class="qty-input"
                  min="0"
                  value="${qty}"
                  onchange="POS_RETAIL.setCartQty('${escapeHtml(prod.id)}', this.value)"
                >
                <button type="button" class="btn-qty" onclick="POS_RETAIL.changeCartQty('${escapeHtml(prod.id)}', 1)">+</button>
              </div>
            `
            : `<button type="button" class="btn-tambah" onclick="POS_RETAIL.changeCartQty('${escapeHtml(prod.id)}', 1)"><i class="fas fa-plus"></i> Tambah</button>`;

        return `
          <div class="produk-item">
            <div class="produk-info">
              <h4>${escapeHtml(prod.nama)}</h4>
              <div class="produk-meta">${escapeHtml(prod.id)} &bull; ${escapeHtml(prod.kategori || "Umum")} &bull; ${stokBadge}</div>
              <p class="produk-price">${formatRupiah(prod.hargaJual)}</p>
            </div>
            ${controlHtml}
          </div>
        `;
      })
      .join("");
  }

  function changeCartQty(prodId, delta) {
    if (!ensureOperationalBranch("menambah barang ke keranjang")) return;

    const prod = state.produk.find((p) => p.id === prodId);
    if (!prod) return;

    const idx = state.cart.findIndex((c) => c.id === prodId);
    const currentQty = idx !== -1 ? state.cart[idx].qty : 0;
    const nextQty = currentQty + delta;

    setCartQty(prodId, nextQty);
  }

  function setCartQty(prodId, rawVal) {
    const prod = state.produk.find((p) => p.id === prodId);
    if (!prod) return;

    const qty = Math.max(0, parseInt(rawVal, 10) || 0);
    const idx = state.cart.findIndex((c) => c.id === prodId);

    if (qty <= 0) {
      if (idx !== -1) state.cart.splice(idx, 1);
    } else {
      if (qty > Number(prod.stok)) {
        window.POS_AUTH.showToast(
          `Perhatian: Qty ${prod.nama} (${qty}) melebihi stok tercatat (${prod.stok}).`,
          "info"
        );
      }
      if (idx !== -1) {
        state.cart[idx].qty = qty;
      } else {
        state.cart.push({
          id: prod.id,
          nama: prod.nama,
          kategori: prod.kategori,
          satuan: prod.satuan,
          stok: prod.stok,
          hargaNormal: Number(prod.hargaJual) || 0,
          harga: Number(prod.hargaJual) || 0,
          qty: qty
        });
      }
    }

    // Reset idempotency key karena isi keranjang berubah
    state.activeCheckoutReqId = "";
    renderKasirProduk();
    updateCartFooter();
  }

  function clearCart() {
    if (state.cart.length === 0) return;
    if (!window.confirm("Kosongkan semua barang di keranjang?")) return;
    state.cart = [];
    state.activeCheckoutReqId = "";
    renderKasirProduk();
    updateCartFooter();
  }

  function updateCartFooter() {
    const totalQty = state.cart.reduce((acc, item) => acc + item.qty, 0);
    const totalRp = state.cart.reduce((acc, item) => acc + item.qty * item.harga, 0);

    const itemEl = document.getElementById("kasir-total-item");
    const hargaEl = document.getElementById("kasir-total-harga");
    if (itemEl) itemEl.textContent = `${totalQty} item (${state.cart.length} produk)`;
    if (hargaEl) hargaEl.textContent = formatRupiah(totalRp);
  }

  function applyInboxDraft(draft) {
    if (!draft || typeof draft !== "object") return false;
    if (!ensureOperationalBranch("memproses pesanan WA ke kasir")) return false;

    const draftItems = Array.isArray(draft.items) ? draft.items : [];
    const unmatched = Array.isArray(draft.unmatchedItems) ? draft.unmatchedItems : [];
    const nextCart = [];
    const skipped = [];

    draftItems.forEach((it) => {
      const idTarget = String(it.idBarang || it.id || "").trim().toLowerCase();
      const namaTarget = String(it.namaBarang || it.nama || "").trim().toLowerCase();

      const prod = state.produk.find(
        (p) =>
          (idTarget && String(p.id || "").trim().toLowerCase() === idTarget) ||
          (namaTarget && String(p.nama || "").trim().toLowerCase() === namaTarget)
      );

      if (!prod) {
        skipped.push(it.namaBarang || it.idBarang || "Item");
        return;
      }

      const qty = Math.max(1, parseInt(it.qty, 10) || 1);
      const existing = nextCart.find((c) => c.id === prod.id);
      if (existing) {
        existing.qty += qty;
      } else {
        nextCart.push({
          id: prod.id,
          nama: prod.nama,
          kategori: prod.kategori,
          satuan: prod.satuan,
          stok: prod.stok,
          hargaNormal: Number(prod.hargaJual) || 0,
          harga: Number(prod.hargaJual) || 0,
          qty: qty
        });
      }
    });

    state.cart = nextCart;
    state.activeCheckoutReqId = "";
    state.pendingInboxDraft = draft;

    renderKasirProduk();
    updateCartFooter();

    if (nextCart.length === 0) {
      window.POS_AUTH.showToast(
        "Tidak ada item WA yang cocok dengan katalog cabang aktif. Pilih barang secara manual.",
        "error"
      );
      return false;
    }

    const totalUnmatched = skipped.length + unmatched.length;
    const msg =
      totalUnmatched > 0
        ? `${nextCart.length} produk WA masuk keranjang (${totalUnmatched} item belum cocok, cek catatan).`
        : `${nextCart.length} produk WA untuk "${draft.namaPelanggan || "Umum"}" masuk keranjang!`;
    window.POS_AUTH.showToast(msg, "success");
    return true;
  }

  // ==========================================================================
  // 4. MODAL CHECKOUT, AUTO HARGA KHUSUS, DISKON & MODE NGAMPAS
  // ==========================================================================

  function renderPelangganDatalist() {
    const dl = document.getElementById("datalist-pelanggan");
    if (!dl) return;

    const namesSet = new Set();
    state.pelanggan.forEach((p) => {
      if (p.nama) namesSet.add(p.nama);
    });
    state.hargaKhusus.forEach((k) => {
      if (k.pelangganAsli) namesSet.add(k.pelangganAsli);
    });

    dl.innerHTML = Array.from(namesSet)
      .sort()
      .map((nama) => `<option value="${escapeHtml(nama)}"></option>`)
      .join("");
  }

  function openCheckoutModal() {
    if (!ensureOperationalBranch("memproses pembayaran")) return;
    if (state.cart.length === 0) {
      window.POS_AUTH.showToast("Keranjang masih kosong. Pilih barang terlebih dahulu.", "error");
      return;
    }

    // Siapkan 1 clientRequestId unik untuk sesi checkout ini (anti-duplikasi)
    if (!state.activeCheckoutReqId) {
      state.activeCheckoutReqId = window.POS_API.generateClientRequestId("TRX");
    }

    // Reset field checkout ke default aman
    const ngampasCb = document.getElementById("checkout-is-ngampas");
    const pelInput = document.getElementById("checkout-pelanggan");
    const pelIdInput = document.getElementById("checkout-pelanggan-id");
    const diskonEl = document.getElementById("checkout-diskon-total");
    const metodeEl = document.getElementById("checkout-metode");
    const statusEl = document.getElementById("checkout-status");
    const bayarEl = document.getElementById("checkout-bayar");
    const tglEl = document.getElementById("checkout-tanggal-custom");
    const hintEl = document.getElementById("checkout-khusus-hint");

    if (ngampasCb) ngampasCb.checked = false;
    if (pelInput) pelInput.value = "";
    if (pelIdInput) pelIdInput.value = "";
    if (diskonEl) diskonEl.value = 0;
    if (metodeEl) metodeEl.value = "Tunai";
    if (statusEl) statusEl.value = "Lunas";
    if (bayarEl) bayarEl.value = "";
    if (tglEl) tglEl.value = "";
    if (hintEl) hintEl.style.display = "none";

    // Kembalikan harga item ke harga normal sebelum pelanggan dipilih
    state.cart.forEach((item) => {
      item.harga = item.hargaNormal;
    });

    onCheckoutMetodeChange();

    // Jika berasal dari Inbox Smart Paste WA, isi otomatis nama pelanggan & terapkan Harga Khusus
    if (state.pendingInboxDraft && state.pendingInboxDraft.namaPelanggan && pelInput) {
      pelInput.value = state.pendingInboxDraft.namaPelanggan;
      onPelangganInputChange();
    } else {
      renderCheckoutCartList();
      recalculateCheckout();
    }

    const modal = document.getElementById("modal-checkout");
    if (modal) modal.classList.add("open");
  }

  function closeCheckoutModal() {
    const modal = document.getElementById("modal-checkout");
    if (modal) modal.classList.remove("open");
  }

  /**
   * Ekstrak nama pelanggan untuk pencocokan Harga Khusus (selaras dengan aturan 05_Core_Retail.gs).
   * Contoh Ngampas: "NGAMPAS Supir ke Toko Jaya" -> "Toko Jaya".
   */
  function extractCustomerNameForSpecialPrice(rawName, isNgampas) {
    const clean = String(rawName || "").trim();
    if (!clean) return "";
    const upper = clean.toUpperCase();
    const ngampasMode = isNgampas || upper.includes("NGAMPAS") || upper.includes("KANVAS");
    if (ngampasMode) {
      const parts = clean.split(/\s+ke\s+/i);
      return parts.length > 1 && parts[1].trim() !== "" ? parts[1].trim() : "";
    }
    return clean;
  }

  function onNgampasToggle() {
    const cb = document.getElementById("checkout-is-ngampas");
    const pelInput = document.getElementById("checkout-pelanggan");
    const statusEl = document.getElementById("checkout-status");
    const bayarEl = document.getElementById("checkout-bayar");
    const isNgampas = Boolean(cb && cb.checked);

    if (isNgampas) {
      if (statusEl) statusEl.value = "Hutang";
      if (bayarEl) bayarEl.value = 0;
      if (pelInput) {
        const curr = pelInput.value.trim();
        if (!curr) {
          pelInput.value = "NGAMPAS ";
        } else if (!curr.toUpperCase().includes("NGAMPAS")) {
          pelInput.value = `NGAMPAS ke ${curr}`;
        }
      }
    } else {
      if (statusEl) statusEl.value = "Lunas";
      if (pelInput && pelInput.value.trim().toUpperCase() === "NGAMPAS") {
        pelInput.value = "";
      }
    }

    onPelangganInputChange();
  }

  function onPelangganInputChange() {
    const pelInput = document.getElementById("checkout-pelanggan");
    const pelIdInput = document.getElementById("checkout-pelanggan-id");
    const ngampasCb = document.getElementById("checkout-is-ngampas");
    const hintEl = document.getElementById("checkout-khusus-hint");

    const rawName = pelInput ? pelInput.value.trim() : "";
    const isNgampas = Boolean(ngampasCb && ngampasCb.checked);
    const targetName = extractCustomerNameForSpecialPrice(rawName, isNgampas);
    const targetLower = targetName.toLowerCase();

    // Cari pelangganId jika cocok dengan master PELANGGAN
    const foundPel = state.pelanggan.find(
      (p) => String(p.nama || "").toLowerCase().trim() === targetLower
    );
    if (pelIdInput) pelIdInput.value = foundPel ? foundPel.pelangganId : "";

    // Terapkan auto-harga khusus jika tersedia
    let matchedCount = 0;
    state.cart.forEach((item) => {
      if (targetLower && targetLower !== "umum") {
        const sp = state.hargaKhusus.find(
          (k) => k.pelanggan === targetLower && k.idBarang === item.id
        );
        if (sp && Number(sp.harga) > 0) {
          item.harga = Number(sp.harga);
          matchedCount++;
          return;
        }
      }
      item.harga = item.hargaNormal;
    });

    if (hintEl) {
      if (matchedCount > 0) {
        hintEl.textContent = `Harga khusus diterapkan otomatis untuk ${matchedCount} item milik "${targetName}".`;
        hintEl.style.display = "block";
      } else {
        hintEl.style.display = "none";
      }
    }

    renderCheckoutCartList();
    recalculateCheckout();
  }

  function renderCheckoutCartList() {
    const listEl = document.getElementById("checkout-cart-list");
    if (!listEl) return;

    listEl.innerHTML = state.cart
      .map((item, idx) => {
        const sub = item.qty * item.harga;
        const isEdited = item.harga !== item.hargaNormal;
        const priceInfo = isEdited
          ? `<del style="color:#94a3b8; font-size:11px;">${formatRupiah(item.hargaNormal)}</del> <strong style="color:#0f766e;">${formatRupiah(item.harga)}</strong>`
          : `${formatRupiah(item.harga)}`;

        return `
          <div class="cart-item">
            <div>
              <strong>${escapeHtml(item.nama)}</strong>
              <div style="font-size:12px; color:#475569;">${item.qty} x ${priceInfo}</div>
              <span class="icon-diskon-item" onclick="POS_RETAIL.editCartItemPrice(${idx})">
                <i class="fas fa-tag"></i> Ubah Harga / Diskon Item
              </span>
            </div>
            <div style="text-align:right; font-weight:700; white-space:nowrap;">
              ${formatRupiah(sub)}
            </div>
          </div>
        `;
      })
      .join("");
  }

  function editCartItemPrice(index) {
    const item = state.cart[index];
    if (!item) return;

    const input = window.prompt(
      `Ubah harga satuan untuk "${item.nama}"\nHarga Normal: ${formatRupiah(item.hargaNormal)}`,
      String(item.harga)
    );
    if (input === null) return;

    const newPrice = Math.max(0, parseInt(String(input).replace(/[^\d]/g, ""), 10) || 0);
    if (newPrice <= 0) {
      window.POS_AUTH.showToast("Harga satuan harus lebih dari Rp 0.", "error");
      return;
    }

    item.harga = newPrice;
    renderCheckoutCartList();
    recalculateCheckout();
    updateCartFooter();
  }

  function onCheckoutMetodeChange() {
    const metode = (document.getElementById("checkout-metode") || {}).value || "Tunai";
    const akunEl = document.getElementById("checkout-akun-kas");
    if (!akunEl) return;

    if (metode === "Tunai") {
      akunEl.value = "Kas Laci";
    } else {
      // Korpri -> Rekening Toko; Pringsewu -> Rekening Bunda (tetap bisa diubah manual)
      akunEl.value = state.cabang === "korpri" ? "Rekening Toko" : "Rekening Bunda";
    }
  }

  function getCheckoutTotals() {
    const subtotal = state.cart.reduce((acc, item) => acc + item.qty * item.harga, 0);
    const diskonTotal = Math.max(
      0,
      parseInt((document.getElementById("checkout-diskon-total") || {}).value, 10) || 0
    );
    const totalAkhir = Math.max(0, subtotal - diskonTotal);
    return { subtotal, diskonTotal, totalAkhir };
  }

  function setUangPas() {
    const { totalAkhir } = getCheckoutTotals();
    const bayarEl = document.getElementById("checkout-bayar");
    if (bayarEl) bayarEl.value = totalAkhir;
    recalculateCheckout();
  }

  function recalculateCheckout() {
    const { totalAkhir } = getCheckoutTotals();
    const status = (document.getElementById("checkout-status") || {}).value || "Lunas";
    const bayarVal = Math.max(
      0,
      parseInt((document.getElementById("checkout-bayar") || {}).value, 10) || 0
    );

    const totalEl = document.getElementById("checkout-total-akhir");
    if (totalEl) totalEl.textContent = formatRupiah(totalAkhir);

    const boxEl = document.getElementById("checkout-kembalian-box");
    const textEl = document.getElementById("checkout-kembalian-text");
    if (!boxEl || !textEl) return;

    if (status === "Hutang") {
      const sisa = Math.max(0, totalAkhir - bayarVal);
      boxEl.style.display = "block";
      textEl.textContent = `Sisa Piutang / Hutang: ${formatRupiah(sisa)}`;
    } else {
      const kembali = bayarVal - totalAkhir;
      boxEl.style.display = "block";
      if (kembali >= 0) {
        textEl.textContent = `Kembalian: ${formatRupiah(kembali)}`;
      } else {
        textEl.textContent = `Kurang Bayar: ${formatRupiah(Math.abs(kembali))}`;
      }
    }
  }

  async function submitTransaksi() {
    if (state.isSubmittingTrx) return;
    if (!ensureOperationalBranch("menyimpan transaksi")) return;
    if (state.cart.length === 0) return;

    const { subtotal, diskonTotal, totalAkhir } = getCheckoutTotals();
    const isNgampas = Boolean((document.getElementById("checkout-is-ngampas") || {}).checked);
    const pelangganRaw =
      String((document.getElementById("checkout-pelanggan") || {}).value || "").trim() || "Umum";
    const pelangganId = String((document.getElementById("checkout-pelanggan-id") || {}).value || "").trim();
    const metode = (document.getElementById("checkout-metode") || {}).value || "Tunai";
    const akunKas = (document.getElementById("checkout-akun-kas") || {}).value || "Kas Laci";
    const status = (document.getElementById("checkout-status") || {}).value || "Lunas";
    const bayar = Math.max(
      0,
      parseInt((document.getElementById("checkout-bayar") || {}).value, 10) || 0
    );
    const tanggalCustomIso = (document.getElementById("checkout-tanggal-custom") || {}).value || "";

    if (status === "Lunas" && bayar < totalAkhir) {
      window.POS_AUTH.showToast(
        "Nominal dibayar kurang dari total belanja. Gunakan status 'Hutang / DP' jika belum lunas.",
        "error"
      );
      return;
    }

    const sess = window.POS_AUTH.getSession();
    const btn = document.getElementById("btn-simpan-transaksi");
    state.isSubmittingTrx = true;

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyimpan Transaksi...';
    }

    const keranjangPayload = state.cart.map((item) => ({
      id: item.id,
      nama: item.nama,
      qty: item.qty,
      harga: item.harga,
      hargaNormal: item.hargaNormal,
      subtotal: item.qty * item.harga
    }));

    const payload = {
      keranjang: keranjangPayload,
      pelanggan: pelangganRaw,
      pelangganId: pelangganId,
      kasir: sess ? sess.namaLengkap || sess.username : "Kasir",
      metode: metode,
      akunKas: akunKas,
      status: status,
      tipeTrx: isNgampas ? "NGAMPAS" : "RITEL",
      totalBelanja: totalAkhir,
      diskonTotal: diskonTotal,
      bayar: bayar,
      tanggalCustom: tanggalCustomIso ? isoToDmy(tanggalCustomIso) : ""
    };

    const reqId = state.activeCheckoutReqId || window.POS_API.generateClientRequestId("TRX");
    const res = await window.POS_API.simpanTransaksi(payload, reqId);

    state.isSubmittingTrx = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-check-circle"></i> Simpan &amp; Cetak Struk';
    }

    if (!res.sukses || !res.data) {
      window.POS_AUTH.showToast(res.pesan || "Gagal menyimpan transaksi.", "error");
      return;
    }

    // Optimistic update stok lokal agar tampilan kasir langsung sinkron
    keranjangPayload.forEach((kItem) => {
      const prod = state.produk.find((p) => p.id === kItem.id);
      if (prod) prod.stok = Number(prod.stok) - kItem.qty;
    });

    // Cari nomor WA pelanggan jika ada untuk tombol Share WA di struk
    const matchedPel = state.pelanggan.find(
      (p) =>
        (pelangganId && p.pelangganId === pelangganId) ||
        String(p.nama || "").toLowerCase().trim() === pelangganRaw.toLowerCase()
    );

    const receiptData = {
      idTrx: res.data.idTrx,
      tanggal: res.data.tanggal || isoToDmy(getTodayWibIso()),
      waktu: res.data.waktu || getNowWibTimeStr(),
      kasir: payload.kasir,
      pelanggan: pelangganRaw,
      noWa: matchedPel ? matchedPel.noWa : "",
      metode: metode,
      akunKas: res.data.akunKas || akunKas,
      status: status,
      tipeTrx: payload.tipeTrx,
      items: keranjangPayload,
      subtotal: subtotal,
      diskonTotal: diskonTotal,
      totalBelanja: totalAkhir,
      bayar: bayar,
      kembalian:
        status === "Hutang" ? 0 : Math.max(0, bayar - totalAkhir),
      sisaHutang:
        status === "Hutang" ? Math.max(0, totalAkhir - bayar) : 0,
      pengaturan: getReceiptStoreConfig()
    };

    // Simpan ke log lokal sesi (untuk pratinjau cepat riwayat)
    state.localSessionTrx.unshift(
      Object.assign({ isVoid: false, cabang: state.cabang }, receiptData)
    );

    // Jika transaksi berasal dari Inbox Smart Paste WA, tandai SELESAI & tautkan ID Transaksi
    if (state.pendingInboxDraft && state.pendingInboxDraft.inboxId && window.POS_API.updateInboxPesanan) {
      const linkedInboxId = state.pendingInboxDraft.inboxId;
      state.pendingInboxDraft = null;
      window.POS_API.updateInboxPesanan({
        inboxId: linkedInboxId,
        status: "SELESAI",
        linkedRefId: res.data.idTrx
      }).catch(() => {});
    }
    // Bersihkan keranjang & tutup modal
    state.cart = [];
    state.activeCheckoutReqId = "";
    closeCheckoutModal();
    renderKasirProduk();
    updateCartFooter();
    renderHomeSummary();

    window.POS_AUTH.showToast(`Transaksi ${res.data.idTrx} berhasil disimpan!`, "success");

    // Buka halaman Cetak Struk Hibrida
    if (window.POS_RECEIPT && typeof window.POS_RECEIPT.openReceipt === "function") {
      window.POS_RECEIPT.openReceipt(receiptData);
    }

    // Refresh bootstrap di latar belakang untuk menyinkronkan Harga Khusus baru
    loadBootstrap().catch(() => {});
  }

  function getReceiptStoreConfig() {
    const branchInfo = window.POS_CONFIG.BRANCHES[state.cabang];
    const defaultNama = branchInfo
      ? `AL-KAUTSAR FILTER AIR (${branchInfo.shortLabel.toUpperCase()})`
      : "AL-KAUTSAR FILTER AIR BUMINDO";

    return {
      namaToko: getPengaturanValue(["NAMA_TOKO", "namaToko", "Nama Toko"], defaultNama),
      alamatToko: getPengaturanValue(["ALAMAT_TOKO", "alamatToko", "Alamat"], "Lampung, Indonesia"),
      telpToko: getPengaturanValue(["NO_TELP", "telpToko", "Telepon", "No WA"], ""),
      footerStruk: getPengaturanValue(
        ["FOOTER_STRUK", "footerStruk", "Catatan Footer", "Footer"],
        "Terima kasih atas kepercayaan Anda."
      )
    };
  }

  // ==========================================================================
  // 5. HALAMAN HARGA KHUSUS PELANGGAN
  // ==========================================================================

  function renderHargaKhusus() {
    const container = document.getElementById("khusus-list-container");
    if (!container) return;

    const q = String((document.getElementById("khusus-search") || {}).value || "")
      .trim()
      .toLowerCase();

    const filtered = state.hargaKhusus.filter((item) => {
      if (!q) return true;
      return (
        String(item.pelangganAsli || "").toLowerCase().includes(q) ||
        String(item.namaBarang || "").toLowerCase().includes(q) ||
        String(item.idBarang || "").toLowerCase().includes(q)
      );
    });

    if (filtered.length === 0) {
      container.innerHTML =
        '<p class="empty-state-text">Belum ada data harga khusus yang cocok.</p>';
      return;
    }

    // Kelompokkan per pelanggan agar mudah dibaca
    const grouped = {};
    filtered.forEach((it) => {
      const key = it.pelangganAsli || "Pelanggan";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(it);
    });

    container.innerHTML = Object.keys(grouped)
      .sort()
      .map((pelNama) => {
        const rows = grouped[pelNama]
          .map(
            (r) => `
              <tr>
                <td>
                  <strong>${escapeHtml(r.namaBarang)}</strong>
                  <div style="font-size:11px; color:#64748b;">${escapeHtml(r.idBarang)}</div>
                </td>
                <td style="text-align:right; color:#64748b;">${formatRupiah(r.hargaNormal)}</td>
                <td style="text-align:right; font-weight:700; color:#0f766e;">${formatRupiah(r.harga)}</td>
              </tr>
            `
          )
          .join("");

        return `
          <div class="khusus-group-card">
            <div class="khusus-group-header">
              <span><i class="fas fa-user-tag"></i> ${escapeHtml(pelNama)}</span>
              <span class="badge stok">${grouped[pelNama].length} item</span>
            </div>
            <div style="overflow-x:auto;">
              <table>
                <thead>
                  <tr>
                    <th>Barang</th>
                    <th style="text-align:right;">Harga Normal</th>
                    <th style="text-align:right;">Harga Khusus</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        `;
      })
      .join("");
  }

  // ==========================================================================
  // 6. ARUS KAS (AKUN KAS + COA) & TUTUP KAS LACI
  // ==========================================================================

  function populateCoaOptions() {
    const katEl = document.getElementById("kas-kategori");
    const coaEl = document.getElementById("kas-kode-coa");
    if (!katEl || !coaEl) return;

    const kat = katEl.value || "Pengeluaran";
    const list =
      (window.POS_CONFIG && window.POS_CONFIG.COA_OPTIONS && window.POS_CONFIG.COA_OPTIONS[kat]) ||
      [];

    coaEl.innerHTML = list
      .map((c) => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.label)}</option>`)
      .join("");
  }
async function loadKolomUangArusKas() {
    const container = document.getElementById("arus-kas-kolom-uang");
    const sess = window.POS_AUTH.getSession();
    const activeRole = sess ? sess.activeRole : "";

    if (!isOperationalBranch()) {
      if (container) {
        container.innerHTML =
          '<p class="empty-state-text">Pilih cabang Korpri atau Pringsewu untuk melihat Kolom Uang.</p>';
      }
      return;
    }

    const todayIso = getTodayWibIso();
    const tglMulaiEl = document.getElementById("arus-kas-tgl-mulai");
    const tglAkhirEl = document.getElementById("arus-kas-tgl-akhir");

    if (tglMulaiEl && !tglMulaiEl.value) tglMulaiEl.value = todayIso;
    if (tglAkhirEl && !tglAkhirEl.value) tglAkhirEl.value = todayIso;

    const tglMulaiIso = tglMulaiEl ? tglMulaiEl.value : todayIso;
    const tglAkhirIso = tglAkhirEl ? tglAkhirEl.value : tglMulaiIso;

    if (container) {
      container.innerHTML =
        '<p class="empty-state-text"><i class="fas fa-spinner fa-spin"></i> Menghitung posisi kas &amp; pergerakan periode...</p>';
    }

    const res = await window.POS_API.getRiwayatOperasional({
      tglMulai: isoToDmy(tglMulaiIso),
      tglAkhir: isoToDmy(tglAkhirIso),
      limit: 10
    });

    if (!res.sukses || !res.data || !res.data.ringkasanKolomUang) {
      if (container) {
        container.innerHTML = `<p class="empty-state-text">${escapeHtml(
          (res && res.pesan) || "Ringkasan Kolom Uang belum tersedia dari server."
        )}</p>`;
      }
      return;
    }

    state.ringkasanKolomUang = res.data.ringkasanKolomUang;
    renderKolomUangArusKas(state.ringkasanKolomUang, state.cabang, activeRole);
  }

  function renderKolomUangArusKas(ringkasan, cabangAktif, activeRole) {
    const container = document.getElementById("arus-kas-kolom-uang");
    if (!container) return; // Aman sebelum HTML Mini-Patch B dipasang

    if (!ringkasan || !ringkasan.posisiKasToko || !ringkasan.pergerakanPeriode) {
      container.innerHTML =
        '<p class="empty-state-text">Data Kolom Uang belum tersedia.</p>';
      return;
    }

    const cb = String(cabangAktif || state.cabang || "").toLowerCase();
    const posisi = ringkasan.posisiKasToko;
    const gerak = ringkasan.pergerakanPeriode;
    const bunda = gerak.uangKeBunda || {};
    const mutasi = gerak.mutasiCabang || {};
    const periode = ringkasan.periode || {};

    const periodeLabel =
      periode.tglMulai && periode.tglAkhir && periode.tglMulai !== periode.tglAkhir
        ? `${escapeHtml(periode.tglMulai)} s/d ${escapeHtml(periode.tglAkhir)}`
        : escapeHtml(periode.tglMulai || isoToDmy(getTodayWibIso()));

    // RBAC & Aturan Cabang untuk Saldo Rekening Toko:
    // - Sembunyikan jika null/undefined (Karyawan/Supir)
    // - Di cabang Pringsewu, sembunyikan otomatis bila nilainya 0 (atau null)
    const hasRekTokoVal =
      posisi.saldoRekeningToko !== null && posisi.saldoRekeningToko !== undefined;
    const rekTokoNum = Number(posisi.saldoRekeningToko) || 0;
    const tampilRekToko = hasRekTokoVal && !(cb === "pringsewu" && rekTokoNum === 0);

    const kartuRekTokoHtml = tampilRekToko
      ? `
        <div class="ku-card ku-card-bank">
          <div class="ku-card-label"><i class="fas fa-building-columns"></i> Saldo Rekening Toko</div>
          <div class="ku-card-value">${escapeHtml(formatRupiah(rekTokoNum))}</div>
          <div class="ku-card-sub">Saldo berjalan (akumulasi buku)</div>
        </div>
      `
      : "";

    const showMutasiStrip = (Number(mutasi.masuk) || 0) > 0 || (Number(mutasi.keluar) || 0) > 0;
    const mutasiNetto = Number(mutasi.netto) || 0;
    const mutasiStripHtml = showMutasiStrip
      ? `
        <div class="ku-mutasi-strip">
          <div class="ku-mutasi-title">
            <i class="fas fa-right-left"></i> Info Mutasi Cabang (199-MUTASI_CABANG)
          </div>
          <div class="ku-mutasi-metrics">
            <span>Masuk: <strong>${escapeHtml(formatRupiah(mutasi.masuk))}</strong></span>
            <span>Keluar: <strong>${escapeHtml(formatRupiah(mutasi.keluar))}</strong></span>
            <span>Netto: <strong>${mutasiNetto < 0 ? "-" : ""}${escapeHtml(formatRupiah(Math.abs(mutasiNetto)))}</strong></span>
          </div>
        </div>
      `
      : "";

    container.innerHTML = `
      <div class="ku-group">
        <div class="ku-group-header">
          <h4><i class="fas fa-vault"></i> Posisi Kas Toko (Saldo Berjalan)</h4>
          <span class="ku-badge-role">${escapeHtml(cb.toUpperCase())} &bull; ${escapeHtml(activeRole || "-")}</span>
        </div>
        <div class="ku-grid ku-grid-posisi">
          <div class="ku-card ku-card-laci">
            <div class="ku-card-label"><i class="fas fa-cash-register"></i> Sisa Kas Laci</div>
            <div class="ku-card-value">${escapeHtml(formatRupiah(posisi.sisaKasLaci))}</div>
            <div class="ku-card-sub">Uang tunai tanggung jawab toko saat ini</div>
          </div>
          ${kartuRekTokoHtml}
        </div>
      </div>

      <div class="ku-group">
        <div class="ku-group-header">
          <h4><i class="fas fa-chart-line"></i> Pergerakan Periode (${periodeLabel})</h4>
        </div>
        <div class="ku-grid ku-grid-periode">
          <div class="ku-card ku-card-in">
            <div class="ku-card-label">Penjualan Total</div>
            <div class="ku-card-value">${escapeHtml(formatRupiah(gerak.penjualanTotal))}</div>
            <div class="ku-card-sub">
              Tunai: ${escapeHtml(formatRupiah(gerak.penjualanTunai))} &bull; Non-Tunai: ${escapeHtml(formatRupiah(gerak.penjualanNonTunai))}
            </div>
          </div>
          <div class="ku-card ku-card-other">
            <div class="ku-card-label">Pemasukan Lain</div>
            <div class="ku-card-value">${escapeHtml(formatRupiah(gerak.pemasukanLain))}</div>
            <div class="ku-card-sub">Pelunasan Piutang &amp; Pemasukan Lain</div>
          </div>
          <div class="ku-card ku-card-out">
            <div class="ku-card-label">Pengeluaran Toko</div>
            <div class="ku-card-value">${escapeHtml(formatRupiah(gerak.pengeluaranTotal))}</div>
            <div class="ku-card-sub">Stok, Proyek, Operasional &amp; Gaji</div>
          </div>
          <div class="ku-card ku-card-bunda">
            <div class="ku-card-label">Uang ke Bunda</div>
            <div class="ku-card-value">${escapeHtml(formatRupiah(bunda.totalKeBunda))}</div>
            <div class="ku-card-sub">
              Setoran: ${escapeHtml(formatRupiah(bunda.setoranToko))} &bull; TF Pelanggan: ${escapeHtml(formatRupiah(bunda.transferLangsungPelanggan))}
            </div>
          </div>
        </div>
        ${mutasiStripHtml}
      </div>
    `;
  }
  async function submitArusKas(event) {
    event.preventDefault();
    if (state.isSubmittingKas) return;
    if (!ensureOperationalBranch("mencatat arus kas")) return;

    const kategori = (document.getElementById("kas-kategori") || {}).value || "Pengeluaran";
    const akunKas = (document.getElementById("kas-akun-kas") || {}).value || "Kas Laci";
    const kodeCoa = (document.getElementById("kas-kode-coa") || {}).value || "";
    const jenis = String((document.getElementById("kas-jenis") || {}).value || "").trim();
    const nominal = Math.max(
      0,
      parseInt((document.getElementById("kas-nominal") || {}).value, 10) || 0
    );
    const tanggalIso = (document.getElementById("kas-tanggal") || {}).value || "";
    const keterangan = String((document.getElementById("kas-keterangan") || {}).value || "").trim();

    if (nominal <= 0 || !jenis || !keterangan) {
      window.POS_AUTH.showToast("Lengkapi jenis, nominal (> 0), dan keterangan arus kas.", "error");
      return;
    }

    const btn = document.getElementById("btn-simpan-kas");
    state.isSubmittingKas = true;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyimpan...';
    }

    const payload = {
      kategori,
      akunKas,
      kodeCoa,
      jenis,
      nominal,
      keterangan,
      tanggalCustom: tanggalIso ? isoToDmy(tanggalIso) : ""
    };

    const res = await window.POS_API.simpanArusKas(
      payload,
      window.POS_API.generateClientRequestId("KAS")
    );

    state.isSubmittingKas = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Simpan Arus Kas';
    }

    if (!res.sukses || !res.data) {
      window.POS_AUTH.showToast(res.pesan || "Gagal menyimpan arus kas.", "error");
      return;
    }

    state.localSessionKas.unshift({
      idKas: res.data.idKas,
      tanggal: res.data.tanggal || isoToDmy(getTodayWibIso()),
      kategori,
      jenis,
      keterangan,
      nominal,
      akunKas: res.data.akunKas || akunKas,
      kodeCoa: res.data.kodeCoa || kodeCoa,
      isVoid: false,
      cabang: state.cabang
    });

    const form = document.getElementById("form-arus-kas");
    if (form) form.reset();
    populateCoaOptions();

    window.POS_AUTH.showToast(res.pesan || "Arus kas berhasil dicatat.", "success");
    loadKolomUangArusKas().catch(() => {});
  }

  async function submitTutupKas(event) {
    event.preventDefault();
    if (!ensureOperationalBranch("melakukan tutup kas")) return;

    const tglIso = (document.getElementById("tutup-kas-tanggal") || {}).value || "";
    const tglLabel = tglIso ? isoToDmy(tglIso) : "Hari Ini (WIB)";

    const konfirm = window.confirm(
      `Proses Tutup Kas Laci cabang ${state.cabang.toUpperCase()} untuk tanggal ${tglLabel}?\nSisa kas laci akan dipindahkan otomatis ke saldo hari berikutnya.`
    );
    if (!konfirm) return;

    const btn = document.getElementById("btn-tutup-kas");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memproses Tutup Kas...';
    }

    const res = await window.POS_API.tutupKas(tglIso ? isoToDmy(tglIso) : "");

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-lock"></i> Proses Tutup Kas Laci';
    }

    if (!res.sukses) {
      window.POS_AUTH.showToast(res.pesan || "Gagal melakukan tutup kas.", "error");
      return;
    }

    const tglInput = document.getElementById("tutup-kas-tanggal");
    if (tglInput) tglInput.value = "";
    window.POS_AUTH.showToast(res.pesan || "Tutup Kas berhasil diproses!", "success");
    loadKolomUangArusKas().catch(() => {});
  }

  // ==========================================================================
  // 7. MUTASI STOK BATCH (MASUK / KELUAR + KONVERSI SATUAN)
  // ==========================================================================

  function renderMutasiSelect() {
    const sel = document.getElementById("mutasi-barang-select");
    if (!sel) return;

    if (state.produk.length === 0) {
      sel.innerHTML = '<option value="">-- Belum ada data barang --</option>';
      return;
    }

    sel.innerHTML = state.produk
      .map(
        (p) =>
          `<option value="${escapeHtml(p.id)}">${escapeHtml(p.nama)} (Stok: ${p.stok} ${escapeHtml(p.satuan || "Pcs")})</option>`
      )
      .join("");
  }

  function onMutasiJenisChange() {
    const jenis = (document.getElementById("mutasi-jenis") || {}).value || "MASUK";
    const reqSpan = document.getElementById("mutasi-ket-req");
    if (reqSpan) {
      reqSpan.style.display = jenis === "KELUAR" ? "inline" : "none";
    }
  }

  function updateMutasiPreview() {
    const mode = (document.getElementById("mutasi-satuan-mode") || {}).value || "Pcs";
    const qty = Math.max(1, parseInt((document.getElementById("mutasi-qty-input") || {}).value, 10) || 1);
    const konvWrap = document.getElementById("mutasi-konversi-wrap");
    const isiInput = document.getElementById("mutasi-isi-per-satuan");
    const previewEl = document.getElementById("mutasi-preview-pcs");

    const butuhKonversi = mode !== "Pcs";
    if (konvWrap) konvWrap.style.display = butuhKonversi ? "block" : "none";

    const isi = butuhKonversi ? Math.max(1, parseInt(isiInput ? isiInput.value : "1", 10) || 1) : 1;
    const totalPcs = qty * isi;

    if (previewEl) previewEl.textContent = totalPcs;
    return { mode, qty, isi, totalPcs };
  }

  function addMutasiItem() {
    if (!ensureOperationalBranch("menambah mutasi stok")) return;

    const sel = document.getElementById("mutasi-barang-select");
    const idBrg = sel ? sel.value : "";
    const prod = state.produk.find((p) => p.id === idBrg);
    if (!prod) {
      window.POS_AUTH.showToast("Pilih barang yang valid terlebih dahulu.", "error");
      return;
    }

    const { mode, qty, isi, totalPcs } = updateMutasiPreview();
    const infoSatuan = mode === "Pcs" ? `${qty} Pcs` : `${qty} ${mode} (@${isi} Pcs)`;

    state.mutasiBatch.push({
      idBarang: prod.id,
      namaBarang: prod.nama,
      qtyPcs: totalPcs,
      infoSatuan: infoSatuan,
      keterangan: ""
    });

    const qtyInput = document.getElementById("mutasi-qty-input");
    if (qtyInput) qtyInput.value = 1;
    updateMutasiPreview();
    renderMutasiBatchList();
  }

  function removeMutasiItem(index) {
    state.mutasiBatch.splice(index, 1);
    renderMutasiBatchList();
  }

  function renderMutasiBatchList() {
    const box = document.getElementById("mutasi-batch-list");
    if (!box) return;

    if (state.mutasiBatch.length === 0) {
      box.innerHTML = '<p class="empty-mutasi-text">Belum ada barang di daftar mutasi.</p>';
      return;
    }

    const rows = state.mutasiBatch
      .map(
        (it, idx) => `
          <tr>
            <td>
              <strong>${escapeHtml(it.namaBarang)}</strong>
              <div style="font-size:11px; color:#64748b;">${escapeHtml(it.idBarang)} &bull; ${escapeHtml(it.infoSatuan)}</div>
            </td>
            <td style="text-align:right; font-weight:700;">${it.qtyPcs} Pcs</td>
            <td style="text-align:center;">
              <button type="button" class="btn-aksi btn-void" onclick="POS_RETAIL.removeMutasiItem(${idx})">
                <i class="fas fa-trash"></i>
              </button>
            </td>
          </tr>
        `
      )
      .join("");

    box.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Barang</th>
            <th style="text-align:right;">Total Pcs</th>
            <th style="text-align:center;">Hapus</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  async function submitMutasiStok() {
    if (state.isSubmittingMutasi) return;
    if (!ensureOperationalBranch("menyimpan mutasi stok")) return;

    if (state.mutasiBatch.length === 0) {
      window.POS_AUTH.showToast("Tambahkan minimal 1 barang ke daftar batch.", "error");
      return;
    }

    const jenisTrx = (document.getElementById("mutasi-jenis") || {}).value || "MASUK";
    const tanggalIso = (document.getElementById("mutasi-tanggal") || {}).value || "";
    const penerima = String((document.getElementById("mutasi-penerima") || {}).value || "").trim();
    const keteranganGlobal = String(
      (document.getElementById("mutasi-ket-global") || {}).value || ""
    ).trim();

    if (jenisTrx === "KELUAR" && !keteranganGlobal) {
      window.POS_AUTH.showToast("Keterangan umum wajib diisi untuk Barang Keluar.", "error");
      return;
    }

    const btn = document.getElementById("btn-simpan-mutasi");
    state.isSubmittingMutasi = true;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyimpan Mutasi...';
    }

    const payload = {
      jenisTrx,
      tanggalCustom: tanggalIso ? isoToDmy(tanggalIso) : "",
      penerima,
      keteranganGlobal,
      daftarBarang: state.mutasiBatch
    };

    const res = await window.POS_API.simpanMutasiStok(
      payload,
      window.POS_API.generateClientRequestId("STK")
    );

    state.isSubmittingMutasi = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-check-circle"></i> Simpan Semua Mutasi Stok';
    }

    if (!res.sukses) {
      window.POS_AUTH.showToast(res.pesan || "Gagal menyimpan mutasi stok.", "error");
      return;
    }

    // Optimistic update stok lokal
    const pengali = jenisTrx === "KELUAR" ? -1 : 1;
    state.mutasiBatch.forEach((it) => {
      const prod = state.produk.find((p) => p.id === it.idBarang);
      if (prod) prod.stok = Number(prod.stok) + it.qtyPcs * pengali;
    });

    state.mutasiBatch = [];
    const ketEl = document.getElementById("mutasi-ket-global");
    if (ketEl) ketEl.value = "";
    renderMutasiBatchList();
    renderMutasiSelect();
    renderKasirProduk();
    renderHomeSummary();

    window.POS_AUTH.showToast(res.pesan || "Mutasi stok berhasil disimpan!", "success");
  }

  // ==========================================================================
  // 8. RIWAYAT TRANSAKSI & ARUS KAS + SOFT-DELETE VOID
  // ==========================================================================

  function switchRiwayatTab(tab) {
    state.riwayatTab = tab === "kas" ? "kas" : "trx";

    const btnTrx = document.getElementById("tab-btn-trx");
    const btnKas = document.getElementById("tab-btn-kas");
    const paneTrx = document.getElementById("tab-riwayat-trx");
    const paneKas = document.getElementById("tab-riwayat-kas");

    if (btnTrx) btnTrx.classList.toggle("active", state.riwayatTab === "trx");
    if (btnKas) btnKas.classList.toggle("active", state.riwayatTab === "kas");
    if (paneTrx) paneTrx.classList.toggle("active", state.riwayatTab === "trx");
    if (paneKas) paneKas.classList.toggle("active", state.riwayatTab === "kas");
  }

  async function loadRiwayatOperasional() {
    const noticeEl = document.getElementById("riwayat-backend-notice");
    const trxBox = document.getElementById("riwayat-trx-container");
    const kasBox = document.getElementById("riwayat-kas-container");

    if (!isOperationalBranch()) {
      if (trxBox) trxBox.innerHTML = '<p class="empty-state-text">Pilih cabang Korpri atau Pringsewu untuk melihat riwayat.</p>';
      if (kasBox) kasBox.innerHTML = '<p class="empty-state-text">Pilih cabang Korpri atau Pringsewu untuk melihat riwayat.</p>';
      return;
    }

    if (noticeEl) noticeEl.style.display = "none";
    if (trxBox) trxBox.innerHTML = '<p class="empty-state-text">Memuat riwayat transaksi...</p>';
    if (kasBox) kasBox.innerHTML = '<p class="empty-state-text">Memuat riwayat arus kas...</p>';

    const tglMulai = (document.getElementById("riwayat-tgl-mulai") || {}).value || "";
    const tglAkhir = (document.getElementById("riwayat-tgl-akhir") || {}).value || "";

    const res = await window.POS_API.getRiwayatOperasional({
      tglMulai: tglMulai ? isoToDmy(tglMulai) : "",
      tglAkhir: tglAkhir ? isoToDmy(tglAkhir) : ""
    });

    if (!res.sukses) {
      // Fallback graceful jika endpoint tambalan belum dipasang di Apps Script Staging
      if (res.code === "UNKNOWN_ACTION" || res.code === "MODULE_NOT_INSTALLED") {
        if (noticeEl) {
          noticeEl.innerHTML =
            '<i class="fas fa-wrench"></i> Endpoint <code>getRiwayatOperasional</code> belum dipasang di backend Staging. Menampilkan transaksi sesi lokal (tombol Void tetap aktif terhubung ke <code>voidTransaksi</code> / <code>voidArusKas</code>).';
          noticeEl.style.display = "block";
        }
        state.riwayatTrx = state.localSessionTrx.filter((x) => x.cabang === state.cabang);
        state.riwayatKas = state.localSessionKas.filter((x) => x.cabang === state.cabang);
        if (data.ringkasanKolomUang) {
          state.ringkasanKolomUang = data.ringkasanKolomUang;
          const sess = window.POS_AUTH.getSession();
          renderKolomUangArusKas(state.ringkasanKolomUang, state.cabang, sess ? sess.activeRole : "");
        }
        renderRiwayatTables();
        return;
      }

      window.POS_AUTH.showToast(res.pesan || "Gagal memuat riwayat operasional.", "error");
      if (trxBox) trxBox.innerHTML = `<p class="empty-state-text">${escapeHtml(res.pesan || "Gagal memuat data.")}</p>`;
      if (kasBox) kasBox.innerHTML = `<p class="empty-state-text">${escapeHtml(res.pesan || "Gagal memuat data.")}</p>`;
      return;
    }

    const data = res.data || {};
    state.riwayatTrx = Array.isArray(data.transaksi) ? data.transaksi : [];
    state.riwayatKas = Array.isArray(data.arusKas) ? data.arusKas : [];
    renderRiwayatTables();
  }

  function isRowVoided(row) {
    if (!row) return false;
    const v = row.isVoid !== undefined ? row.isVoid : row.is_void;
    return v === true || String(v).toLowerCase() === "true";
  }

  function renderRiwayatTables() {
    const q = String((document.getElementById("riwayat-search") || {}).value || "")
      .trim()
      .toLowerCase();
    const bolehVoid = window.POS_AUTH.canVoid();

    // 1. TABEL TRANSAKSI (OTOMATIS SEMBUNYIKAN Is_Void = TRUE)
    const trxBox = document.getElementById("riwayat-trx-container");
    if (trxBox) {
      const activeTrx = state.riwayatTrx.filter((t) => {
        if (isRowVoided(t)) return false;
        if (!q) return true;
        return (
          String(t.idTrx || "").toLowerCase().includes(q) ||
          String(t.pelanggan || "").toLowerCase().includes(q) ||
          String(t.kasir || "").toLowerCase().includes(q)
        );
      });

      if (activeTrx.length === 0) {
        trxBox.innerHTML = '<p class="empty-state-text">Tidak ada transaksi aktif pada filter ini.</p>';
      } else {
        const rowsHtml = activeTrx
          .map((t) => {
            const badgeCls = String(t.status || "").toLowerCase() === "hutang" ? "hutang" : "lunas";
            const voidBtn = bolehVoid
              ? `<button type="button" class="btn-aksi btn-void" onclick="POS_RETAIL.openVoidModal('trx', '${escapeHtml(t.idTrx)}')">
                   <i class="fas fa-ban"></i> Void
                 </button>`
              : "";

            return `
              <tr>
                <td>
                  <strong>${escapeHtml(t.idTrx)}</strong>
                  <div style="font-size:11px; color:#64748b;">${escapeHtml(t.tanggal)} ${escapeHtml(t.waktu || "")}</div>
                </td>
                <td>
                  ${escapeHtml(t.pelanggan || "Umum")}
                  <div style="font-size:11px; color:#64748b;">${escapeHtml(t.metode || "Tunai")} &bull; ${escapeHtml(t.akunKas || "-")}</div>
                </td>
                <td><span class="badge ${badgeCls}">${escapeHtml(t.status || "Lunas")}</span></td>
                <td style="text-align:right; font-weight:700;">${formatRupiah(t.totalBelanja)}</td>
                <td style="white-space:nowrap;">
                  <button type="button" class="btn-aksi" onclick="POS_RETAIL.reprintFromRiwayat('${escapeHtml(t.idTrx)}')">
                    <i class="fas fa-print"></i> Struk
                  </button>
                  ${voidBtn}
                </td>
              </tr>
            `;
          })
          .join("");

        trxBox.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>ID &amp; Tanggal</th>
                <th>Pelanggan</th>
                <th>Status</th>
                <th style="text-align:right;">Total</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        `;
      }
    }

    // 2. TABEL ARUS KAS (OTOMATIS SEMBUNYIKAN Is_Void = TRUE)
    const kasBox = document.getElementById("riwayat-kas-container");
    if (kasBox) {
      const activeKas = state.riwayatKas.filter((k) => {
        if (isRowVoided(k)) return false;
        if (!q) return true;
        return (
          String(k.idKas || "").toLowerCase().includes(q) ||
          String(k.jenis || "").toLowerCase().includes(q) ||
          String(k.keterangan || "").toLowerCase().includes(q) ||
          String(k.akunKas || "").toLowerCase().includes(q)
        );
      });

      if (activeKas.length === 0) {
        kasBox.innerHTML = '<p class="empty-state-text">Tidak ada data arus kas aktif pada filter ini.</p>';
      } else {
        const rowsHtml = activeKas
          .map((k) => {
            const isMasuk = String(k.kategori || "").toLowerCase() === "pemasukan";
            const nominal = k.nominal !== undefined ? k.nominal : isMasuk ? k.kasMasuk : k.kasKeluar;
            const voidBtn = bolehVoid
              ? `<button type="button" class="btn-aksi btn-void" onclick="POS_RETAIL.openVoidModal('kas', '${escapeHtml(k.idKas)}')">
                   <i class="fas fa-ban"></i> Void
                 </button>`
              : "-";

            return `
              <tr>
                <td>
                  <strong>${escapeHtml(k.idKas)}</strong>
                  <div style="font-size:11px; color:#64748b;">${escapeHtml(k.tanggal)}</div>
                </td>
                <td>
                  <span class="badge ${isMasuk ? "pemasukan" : "pengeluaran"}">${escapeHtml(k.kategori)}</span>
                  <div style="font-size:12px; font-weight:600; margin-top:2px;">${escapeHtml(k.jenis || "-")}</div>
                  <div style="font-size:11px; color:#64748b;">${escapeHtml(k.keterangan || "")}</div>
                </td>
                <td>
                  <div>${escapeHtml(k.akunKas || "Kas Laci")}</div>
                  <div style="font-size:11px; color:#64748b;">${escapeHtml(k.kodeCoa || "-")}</div>
                </td>
                <td style="text-align:right; font-weight:700; color:${isMasuk ? "#15803d" : "#b91c1c"};">
                  ${isMasuk ? "+" : "-"} ${formatRupiah(nominal)}
                </td>
                <td>${voidBtn}</td>
              </tr>
            `;
          })
          .join("");

        kasBox.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>ID &amp; Tanggal</th>
                <th>Kategori &amp; Keterangan</th>
                <th>Akun Kas / COA</th>
                <th style="text-align:right;">Nominal</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        `;
      }
    }
  }

  async function reprintFromRiwayat(idTrx) {
    // Cek dulu apakah item sudah ada di riwayat/sesi lokal
    const localFound = state.riwayatTrx.find((t) => t.idTrx === idTrx);
    if (localFound && Array.isArray(localFound.items) && localFound.items.length > 0) {
      window.POS_RECEIPT.openReceipt(
        Object.assign({ pengaturan: getReceiptStoreConfig() }, localFound)
      );
      return;
    }

    window.POS_AUTH.showToast("Mengambil rincian struk dari server...", "info");
    const res = await window.POS_API.getDetailTransaksi(idTrx);
    if (!res.sukses || !res.data) {
      window.POS_AUTH.showToast(
        res.pesan || "Detail item belum tersedia dari server.",
        "error"
      );
      return;
    }

    window.POS_RECEIPT.openReceipt(
      Object.assign({ pengaturan: getReceiptStoreConfig() }, res.data)
    );
  }

  function openVoidModal(type, id) {
    if (!window.POS_AUTH.canVoid()) {
      window.POS_AUTH.showToast("Hanya Manajer, Bos, dan Admin yang dapat melakukan Void.", "error");
      return;
    }

    let infoHtml = "";
    if (type === "trx") {
      const trx = state.riwayatTrx.find((t) => t.idTrx === id);
      if (!trx) return;
      state.voidTarget = { type: "trx", id };
      infoHtml = `
        <strong>ID Transaksi:</strong> ${escapeHtml(trx.idTrx)}<br>
        <strong>Tanggal:</strong> ${escapeHtml(trx.tanggal)}<br>
        <strong>Pelanggan:</strong> ${escapeHtml(trx.pelanggan || "Umum")}<br>
        <strong>Total:</strong> ${formatRupiah(trx.totalBelanja)}
      `;
    } else {
      const kas = state.riwayatKas.find((k) => k.idKas === id);
      if (!kas) return;
      state.voidTarget = { type: "kas", id };
      const nom = kas.nominal !== undefined ? kas.nominal : kas.kasMasuk || kas.kasKeluar || 0;
      infoHtml = `
        <strong>ID Arus Kas:</strong> ${escapeHtml(kas.idKas)}<br>
        <strong>Tanggal:</strong> ${escapeHtml(kas.tanggal)}<br>
        <strong>Jenis:</strong> ${escapeHtml(kas.kategori)} &mdash; ${escapeHtml(kas.jenis)}<br>
        <strong>Nominal:</strong> ${formatRupiah(nom)}
      `;
    }

    const infoEl = document.getElementById("void-target-info");
    const reasonEl = document.getElementById("void-reason-input");
    if (infoEl) infoEl.innerHTML = infoHtml;
    if (reasonEl) reasonEl.value = "";

    const modal = document.getElementById("modal-void");
    if (modal) modal.classList.add("open");
  }

  function closeVoidModal() {
    state.voidTarget = null;
    const modal = document.getElementById("modal-void");
    if (modal) modal.classList.remove("open");
  }

  async function confirmVoid() {
    if (!state.voidTarget) return;

    const reasonEl = document.getElementById("void-reason-input");
    const reason = String(reasonEl ? reasonEl.value : "").trim();
    if (reason.length < 3) {
      window.POS_AUTH.showToast("Alasan Void wajib diisi (minimal 3 karakter).", "error");
      return;
    }

    const btn = document.getElementById("btn-confirm-void");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memproses Void...';
    }

    let res;
    if (state.voidTarget.type === "trx") {
      res = await window.POS_API.voidTransaksi({ idTrx: state.voidTarget.id, reason });
    } else {
      res = await window.POS_API.voidArusKas({ idKas: state.voidTarget.id, reason });
    }

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-trash-can"></i> Ya, Proses Void Sekarang';
    }

    if (!res.sukses) {
      window.POS_AUTH.showToast(res.pesan || "Gagal memproses Void.", "error");
      return;
    }

    // Tandai void di state lokal juga agar langsung hilang dari tabel
    if (state.voidTarget.type === "trx") {
      state.riwayatTrx.forEach((t) => {
        if (t.idTrx === state.voidTarget.id) t.isVoid = true;
      });
      state.localSessionTrx.forEach((t) => {
        if (t.idTrx === state.voidTarget.id) t.isVoid = true;
      });
    } else {
      state.riwayatKas.forEach((k) => {
        if (k.idKas === state.voidTarget.id) k.isVoid = true;
      });
      state.localSessionKas.forEach((k) => {
        if (k.idKas === state.voidTarget.id) k.isVoid = true;
      });
    }

    closeVoidModal();
    renderRiwayatTables();
    window.POS_AUTH.showToast(res.pesan || "Data berhasil di-void secara bersih.", "success");

    // Sinkronisasi ulang stok & rekap terbaru dari server
    loadBootstrap().catch(() => {});
  }

  // ==========================================================================
  // 9. PENGATURAN STRUK CABANG
  // ==========================================================================

  function fillPengaturanForm() {
    const cfg = getReceiptStoreConfig();
    const namaEl = document.getElementById("set-nama-toko");
    const alamatEl = document.getElementById("set-alamat-toko");
    const telpEl = document.getElementById("set-telp-toko");
    const footerEl = document.getElementById("set-footer-struk");

    if (namaEl) namaEl.value = cfg.namaToko;
    if (alamatEl) alamatEl.value = cfg.alamatToko;
    if (telpEl) telpEl.value = cfg.telpToko;
    if (footerEl) footerEl.value = cfg.footerStruk;
  }

  async function submitPengaturanStruk(event) {
    event.preventDefault();
    if (!ensureOperationalBranch("menyimpan pengaturan struk")) return;

    const namaToko = String((document.getElementById("set-nama-toko") || {}).value || "").trim();
    const alamatToko = String((document.getElementById("set-alamat-toko") || {}).value || "").trim();
    const telpToko = String((document.getElementById("set-telp-toko") || {}).value || "").trim();
    const footerStruk = String((document.getElementById("set-footer-struk") || {}).value || "").trim();

    if (!namaToko) {
      window.POS_AUTH.showToast("Nama toko di struk wajib diisi.", "error");
      return;
    }

    const btn = document.getElementById("btn-simpan-pengaturan");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyimpan...';
    }

    const payload = {
      NAMA_TOKO: namaToko,
      ALAMAT_TOKO: alamatToko,
      NO_TELP: telpToko,
      FOOTER_STRUK: footerStruk
    };

    const res = await window.POS_API.simpanPengaturanToko(payload);

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Simpan Pengaturan Struk';
    }

    // Perbarui state lokal agar langsung dipakai cetak struk sesi ini
    Object.assign(state.pengaturan, payload);

    if (!res.sukses) {
      if (res.code === "UNKNOWN_ACTION" || res.code === "MODULE_NOT_INSTALLED") {
        window.POS_AUTH.showToast(
          "Diterapkan sementara di sesi ini. Pasang handler simpanPengaturanToko di backend untuk menyimpan permanen.",
          "info"
        );
        return;
      }
      window.POS_AUTH.showToast(res.pesan || "Gagal menyimpan pengaturan struk.", "error");
      return;
    }

    window.POS_AUTH.showToast("Pengaturan struk cabang berhasil disimpan.", "success");
  }

  // ==========================================================================
  // EKSPOR API PUBLIK POS_RETAIL (TERMASUK ALIAS LIFECYCLE)
  // ==========================================================================
  return {
    // Lifecycle
    onContextReady,
    onPageActivated,
    onPageEnter: onPageActivated,
    loadBootstrap,
    refreshCurrentBranch,
    refreshCurrentPage: refreshCurrentBranch,
    getReceiptStoreConfig,

    // Home
    toggleAlertStok,

    // Kasir & Checkout
    selectKategori,
    renderKasirProduk,
    changeCartQty,
    setCartQty,
    clearCart,
    applyInboxDraft,
    openCheckoutModal,
    closeCheckoutModal,
    onNgampasToggle,
    onPelangganInputChange,
    editCartItemPrice,
    onCheckoutMetodeChange,
    setUangPas,
    recalculateCheckout,
    submitTransaksi,

    // Harga Khusus
    renderHargaKhusus,

    // Arus Kas & Tutup Kas
    populateCoaOptions,
    loadKolomUangArusKas,
    renderKolomUangArusKas,
    submitArusKas,
    submitTutupKas,

    // Mutasi Stok
    onMutasiJenisChange,
    updateMutasiPreview,
    addMutasiItem,
    removeMutasiItem,
    submitMutasiStok,

    // Riwayat & Soft-Delete Void
    switchRiwayatTab,
    loadRiwayatOperasional,
    renderRiwayatTables,
    reprintFromRiwayat,
    openVoidModal,
    closeVoidModal,
    confirmVoid,

    // Pengaturan Struk
    submitPengaturanStruk
  };
})();