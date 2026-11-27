/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.0 — KLIEN REST API & REQUEST ENVELOPE STANDAR
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
  // WRAPPER TAMBAHAN FASE 2 (UNTUK RIWAYAT & SIMPAN PENGATURAN STRUK)
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

  return {
    generateClientRequestId,
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
    simpanPengaturanToko
  };
})();