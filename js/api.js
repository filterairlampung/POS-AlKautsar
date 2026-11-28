/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.1 — KLIEN REST API & REQUEST ENVELOPE STANDAR
 * File: js/api.js
 * ============================================================================
 * Kontrak Envelope Backend (04_Router.gs):
 * { action, token, activeRole, cabang, clientRequestId, payload }
 */

window.POS_API = (function () {
  "use strict";

  const AUTH_ERROR_CODES = [
    "UNAUTHORIZED",
    "SESSION_EXPIRED",
    "USER_INACTIVE",
    "FORBIDDEN_ROLE_MISMATCH"
  ];

  /**
   * Menghasilkan clientRequestId unik untuk perlindungan Idempotency di server.
   */
  function generateClientRequestId(prefix) {
    const pfx = String(prefix || "REQ").toUpperCase();
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${pfx}_${window.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    }
    const rnd = Math.random().toString(36).substring(2, 10);
    return `${pfx}_${Date.now().toString(36)}_${rnd}`;
  }

  /**
   * Mengecek apakah error berasal dari gangguan sinyal / timeout (kandidat Offline Queue).
   */
  function isOfflineError(res) {
    if (!navigator.onLine) return true;
    if (!res || typeof res !== "object") return true;
    return res.code === "NETWORK_ERROR" || res.code === "REQUEST_TIMEOUT";
  }

  /**
   * Memastikan URL GAS sudah dikonfigurasi di js/config.js.
   */
  function getEndpointUrl() {
    const url = (window.POS_CONFIG && window.POS_CONFIG.GAS_WEB_APP_URL) || "";
    if (!url || url.includes("GANTI_DENGAN_DEPLOYMENT_ID")) {
      throw new Error(
        "GAS_WEB_APP_URL belum diisi di js/config.js. Masukkan URL Web App Staging Anda."
      );
    }
    return url;
  }

  /**
   * Pengirim request utama ke doPost(e) Google Apps Script.
   * Memakai header text/plain; charset=utf-8 agar tidak terkena CORS preflight OPTIONS.
   */
  async function request(action, payload = {}, options = {}) {
    const url = getEndpointUrl();
    const session = window.POS_AUTH ? window.POS_AUTH.getSession() : null;
    const isPublic = options.isPublic === true || action === "login";

    const envelope = {
      action: String(action || "").trim(),
      token: isPublic ? "" : (options.token ?? (session ? session.token : "")),
      activeRole: isPublic ? "" : (options.activeRole ?? (session ? session.activeRole : "")),
      cabang: options.cabang ?? (session ? session.activeCabang : ""),
      clientRequestId: options.clientRequestId || generateClientRequestId(action),
      payload: payload || {}
    };

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || window.POS_CONFIG.REQUEST_TIMEOUT_MS || 35000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        mode: "cors",
        redirect: "follow",
        headers: {
          "Content-Type": "text/plain; charset=utf-8"
        },
        body: JSON.stringify(envelope),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!response.ok) {
        return {
          sukses: false,
          code: "HTTP_" + response.status,
          pesan: `Server merespons status HTTP ${response.status}.`,
          data: null
        };
      }

      const rawText = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (parseErr) {
        return {
          sukses: false,
          code: "INVALID_JSON",
          pesan: "Respons server bukan JSON valid. Pastikan Deployment GAS diakses sebagai 'Anyone'.",
          data: null
        };
      }

      // Normalisasi properti sukses/ok/status agar 100% sinkron dengan respSukses_() backend
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.sukses !== "boolean") {
          if (typeof parsed.ok === "boolean") {
            parsed.sukses = parsed.ok;
          } else if (typeof parsed.success === "boolean") {
            parsed.sukses = parsed.success;
          } else if (typeof parsed.status === "string") {
            const st = parsed.status.toLowerCase();
            parsed.sukses = st === "sukses" || st === "success" || st === "ok";
          } else {
            parsed.sukses = false;
          }
        }
        if (parsed.pesan === undefined && parsed.message !== undefined) {
          parsed.pesan = parsed.message;
        }
        if (parsed.code === undefined && parsed.errorCode !== undefined) {
          parsed.code = parsed.errorCode;
        }
      }

      // Interceptor sesi tidak valid / kedaluwarsa -> paksa logout bersih
      if (
        !isPublic &&
        parsed &&
        parsed.sukses === false &&
        AUTH_ERROR_CODES.includes(parsed.code) &&
        !options.skipAuthRedirect
      ) {
        if (window.POS_AUTH && typeof window.POS_AUTH.handleForcedLogout === "function") {
          window.POS_AUTH.handleForcedLogout(parsed.pesan || "Sesi berakhir, silakan login ulang.");
        }
      }

      return parsed;
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err && err.name === "AbortError";
      return {
        sukses: false,
        code: isTimeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        pesan: isTimeout
          ? "Koneksi ke server terlalu lama (timeout). Cek internet lalu coba lagi."
          : `Gagal terhubung ke server: ${err.message || "Periksa koneksi internet Anda."}`,
        data: null
      };
    }
  }

  // ==========================================================================
  // WRAPPER ENDPOINT FASE 1 (100% SINKRON DENGAN 04_Router.gs)
  // ==========================================================================

  function login({ username, password, requestedRole = "", requestedCabang = "" }) {
    const deviceInfo = `${navigator.platform || "Web"} | ${navigator.userAgent.slice(0, 70)}`;
    return request(
      "login",
      { username, password, requestedRole, requestedCabang, deviceInfo },
      { isPublic: true }
    );
  }

  function logout() {
    return request("logout", {}, { skipAuthRedirect: true });
  }

  function switchContext({ targetRole, targetCabang }) {
    return request("switchContext", { targetRole, targetCabang });
  }

  function getAppConfig() {
    return request("getAppConfig", {});
  }

  function updateNotifPreference(payload) {
    return request("updateNotifPreference", payload);
  }

  function getBootstrapData(cabangOverride) {
    return request("getBootstrapData", {}, { cabang: cabangOverride });
  }

  function simpanTransaksi(payload, clientRequestId) {
    return request("simpanTransaksi", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("TRX")
    });
  }

  function voidTransaksi({ idTrx, reason }) {
    return request("voidTransaksi", { idTrx, reason });
  }

  function simpanArusKas(payload, clientRequestId) {
    return request("simpanArusKas", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("KAS")
    });
  }

  function voidArusKas({ idKas, reason }) {
    return request("voidArusKas", { idKas, reason });
  }

  function simpanMutasiStok(payload, clientRequestId) {
    return request("simpanMutasiStok", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("STK")
    });
  }

  function tutupKas(tanggalStr = "") {
    return request("tutupKas", { tanggalStr });
  }

  // ==========================================================================
  // WRAPPER TAMBAHAN FASE 2
  // ==========================================================================

  function getRiwayatOperasional(payload = {}) {
    return request("getRiwayatOperasional", payload);
  }

  function getDetailTransaksi(idTrx) {
    return request("getDetailTransaksi", { idTrx });
  }

  function simpanPengaturanToko(payload) {
    return request("simpanPengaturanToko", payload);
  }

  // ==========================================================================
  // WRAPPER TAMBAHAN FASE 3 (SUPIR, PELANGGAN, PIUTANG & CALENDAR)
  // ==========================================================================

  function kelolaPelanggan(payload = {}, clientRequestId) {
    return request("kelolaPelanggan", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("PLG")
    });
  }

  function getPiutangAging(payload = {}) {
    return request("getPiutangAging", payload);
  }

  function lunasiPiutang(payload = {}, clientRequestId) {
    return request("lunasiPiutang", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("PTG")
    });
  }

  function getDaftarTugasSupir(payload = {}) {
    return request("getDaftarTugasSupir", payload);
  }

  function mulaiPengantaran(payload = {}, clientRequestId) {
    return request("mulaiPengantaran", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("ANT")
    });
  }

  function submitSelesaiPengantaran(payload = {}, clientRequestId) {
    return request("submitSelesaiPengantaran", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("SLS"),
      timeoutMs: 45000 // Toleransi ekstra untuk unggah foto ke Google Drive
    });
  }

  function verifikasiSetoranSupir(payload = {}, clientRequestId) {
    return request("verifikasiSetoranSupir", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("VER")
    });
  }

  function sinkronCalendar(payload = {}, clientRequestId) {
    return request("sinkronCalendar", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("CAL")
    });
  }
  // ==========================================================================
  // WRAPPER TAMBAHAN FASE 4 (PROYEK DAMIU & MUTASI ANTAR CABANG)
  // ==========================================================================

  function getDaftarProyekDAMIU(payload = {}) {
    return request("getDaftarProyekDAMIU", payload);
  }

  function simpanProyekDAMIU(payload = {}, clientRequestId) {
    return request("simpanProyekDAMIU", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("DMI")
    });
  }

  function tambahBiayaDAMIU(payload = {}, clientRequestId) {
    return request("tambahBiayaDAMIU", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("BDM"),
      timeoutMs: 45000 // Toleransi ekstra untuk unggah foto nota ke Google Drive
    });
  }

  function reimburseTalanganDAMIU(payload = {}, clientRequestId) {
    return request("reimburseTalanganDAMIU", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("RMB")
    });
  }

  function catatPembayaranDAMIU(payload = {}, clientRequestId) {
    return request("catatPembayaranDAMIU", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("DMP")
    });
  }

  function selesaikanProyekDAMIU(payload = {}, clientRequestId) {
    return request("selesaikanProyekDAMIU", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("DMS")
    });
  }

  function voidProyekAtauBiayaDAMIU(payload = {}, clientRequestId) {
    return request("voidProyekAtauBiayaDAMIU", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("VDM")
    });
  }

  function getMutasiAntarCabang(payload = {}) {
    return request("getMutasiAntarCabang", payload);
  }

  function buatMutasiAntarCabang(payload = {}, clientRequestId) {
    return request("buatMutasiAntarCabang", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("MTC")
    });
  }

  function terimaMutasiAntarCabang(payload = {}, clientRequestId) {
    return request("terimaMutasiAntarCabang", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("MTR")
    });
  }

  function batalMutasiAntarCabang(payload = {}, clientRequestId) {
    return request("batalMutasiAntarCabang", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("MTB")
    });
  }
  // ==========================================================================
  // WRAPPER TAMBAHAN FASE 5 (LAPORAN BOS & NOTIFIKASI REAL-TIME)
  // ==========================================================================

  function getLaporanBos(payload = {}) {
    return request("getLaporanBos", payload, {
      cabang: payload.cabang || undefined
    });
  }

  function cariRekapBos(payload = {}) {
    return request("cariRekapBos", payload, {
      cabang: payload.cabang || undefined
    });
  }

  function getNotifInApp(payload = {}) {
    return request("getNotifInApp", payload);
  }

  function testNotifTelegram(payload = {}) {
    return request("testNotifTelegram", payload);
  }

  function kelolaAksesNotifAdmin(payload = {}) {
    return request("kelolaAksesNotifAdmin", payload);
  }
  // ==========================================================================
  // WRAPPER TAMBAHAN FASE 6 (GEMINI AI ADMIN & INBOX SMART PASTE WA)
  // ==========================================================================

  function listAppConfigAdmin(payload = {}) {
    return request("listAppConfigAdmin", payload);
  }

  function updateAppConfigAdmin(payload = {}, clientRequestId) {
    return request("updateAppConfigAdmin", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("CFG")
    });
  }

  function rollbackAppConfigAdmin(payload = {}, clientRequestId) {
    return request("rollbackAppConfigAdmin", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("RBK")
    });
  }

  function previewEditMasterBarangAI(payload = {}) {
    return request("previewEditMasterBarangAI", payload, {
      cabang: payload.cabang || undefined,
      timeoutMs: 45000
    });
  }

  function executeEditMasterBarangAI(payload = {}, clientRequestId) {
    return request("executeEditMasterBarangAI", payload, {
      cabang: payload.cabang || undefined,
      clientRequestId: clientRequestId || generateClientRequestId("AIBRG")
    });
  }

  function cariTransaksiHistorisAI(payload = {}) {
    return request("cariTransaksiHistorisAI", payload, {
      cabang: payload.cabang || undefined,
      timeoutMs: 45000
    });
  }

  function parseSmartPasteWA(payload = {}, clientRequestId) {
    return request("parseSmartPasteWA", payload, {
      cabang: payload.cabang || undefined,
      clientRequestId: clientRequestId || generateClientRequestId("WA"),
      timeoutMs: 45000
    });
  }

  function getInboxPesanan(payload = {}) {
    return request("getInboxPesanan", payload, {
      cabang: payload.cabang || undefined
    });
  }

  function updateInboxPesanan(payload = {}, clientRequestId) {
    return request("updateInboxPesanan", payload, {
      clientRequestId: clientRequestId || generateClientRequestId("INB")
    });
  }

  function konversiInboxKeDraft(payload = {}) {
    return request("konversiInboxKeDraft", payload);
  }

  return {
    generateClientRequestId,
    isOfflineError,
    request,
    login,
    logout,
    switchContext,
    getAppConfig,
    updateNotifPreference,
    getBootstrapData,
    simpanTransaksi,
    voidTransaksi,
    simpanArusKas,
    voidArusKas,
    simpanMutasiStok,
    tutupKas,
    getRiwayatOperasional,
    getDetailTransaksi,
    simpanPengaturanToko,
    kelolaPelanggan,
    getPiutangAging,
    lunasiPiutang,
    getDaftarTugasSupir,
    mulaiPengantaran,
    submitSelesaiPengantaran,
    verifikasiSetoranSupir,
    sinkronCalendar,
    getDaftarProyekDAMIU,
    simpanProyekDAMIU,
    tambahBiayaDAMIU,
    reimburseTalanganDAMIU,
    catatPembayaranDAMIU,
    selesaikanProyekDAMIU,
    voidProyekAtauBiayaDAMIU,
    getMutasiAntarCabang,
    buatMutasiAntarCabang,
    terimaMutasiAntarCabang,
    batalMutasiAntarCabang,
    getLaporanBos,
    cariRekapBos,
    getNotifInApp,
    testNotifTelegram,
    kelolaAksesNotifAdmin,
    listAppConfigAdmin,
    updateAppConfigAdmin,
    rollbackAppConfigAdmin,
    previewEditMasterBarangAI,
    executeEditMasterBarangAI,
    cariTransaksiHistorisAI,
    parseSmartPasteWA,
    getInboxPesanan,
    updateInboxPesanan,
    konversiInboxKeDraft
  };
})();