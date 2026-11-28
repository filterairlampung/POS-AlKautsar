/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.3 — KONFIGURASI FRONTEND STAGING
 * File: js/config.js
 * ============================================================================
 * ATURAN KEAMANAN: DILARANG menyimpan API Key, Password, atau Spreadsheet ID
 * di file ini. Seluruh rahasia hanya berada di PropertiesService Google Apps Script.
 */

window.POS_CONFIG = (function () {
  "use strict";

  // Ganti URL di bawah ini dengan Web App URL hasil deploy Google Apps Script Staging
  const GAS_WEB_APP_URL =
    "https://script.google.com/macros/s/AKfycbznGxMHlmgwmbo_-X1aiL79ILHtktME6q4NXgFfvfdzYterPTc7oktPKgpA1t6XmZtP1w/exec";

  const APP_VERSION = "3.4.0-staging";
  const SESSION_STORAGE_KEY = "pos_alkautsar_v3_session";
  const IOS_BANNER_DISMISS_KEY = "pos_alkautsar_v3_ios_banner_dismissed";
  const OFFLINE_QUEUE_STORAGE_KEY = "pos_alkautsar_v3_offline_queue";
  const REQUEST_TIMEOUT_MS = 35000;

  // Definisi Cabang & Tema Dinamis
  const BRANCHES = {
    korpri: {
      id: "korpri",
      label: "Cabang Korpri",
      shortLabel: "Korpri",
      themeColor: "#005A9C",
      darkColor: "#004477",
      softBg: "#e0f2fe",
      isOperational: true
    },
    pringsewu: {
      id: "pringsewu",
      label: "Cabang Pringsewu",
      shortLabel: "Pringsewu",
      themeColor: "#0f766e",
      darkColor: "#083d39",
      softBg: "#ccfbf1",
      isOperational: true
    },
    all: {
      id: "all",
      label: "Mode Gabungan (Korpri + Pringsewu)",
      shortLabel: "Gabungan",
      themeColor: "#1e293b",
      darkColor: "#0f172a",
      softBg: "#e2e8f0",
      isOperational: false
    }
  };

  // Definisi 5 Peran Resmi v3.0
  const ROLES = ["Karyawan", "Supir", "Manajer", "Bos", "Admin"];
  const VOID_ALLOWED_ROLES = ["Manajer", "Bos", "Admin"];

  // Opsi Akun Kas & Kode COA sesuai 05_Core_Retail.gs
  const AKUN_KAS_OPTIONS = [
    { value: "Kas Laci", label: "Kas Laci (Tunai Fisik Toko)" },
    { value: "Rekening Toko", label: "Rekening Toko" },
    { value: "Rekening Bunda", label: "Rekening Bunda (Transfer/QRIS/Shopee)" }
  ];

  const COA_OPTIONS = {
    Pemasukan: [
      { code: "401-PENJUALAN", label: "401 - Penjualan Kasir / Ritel" },
      { code: "112-PIUTANG", label: "112 - Pelunasan Piutang Pelanggan" },
      { code: "409-PEMASUKAN_LAIN", label: "409 - Pemasukan Lain-lain" },
      { code: "199-MUTASI_CABANG", label: "199 - Mutasi Kas Antar Cabang (Masuk)" },
      { code: "402-OMZET_DAMIU", label: "402 - Omzet Proyek Pemasangan DAMIU" },
      { code: "502-BIAYA_PROYEK", label: "502 - Biaya Proyek DAMIU / Jasa Tukang" }
    ],
    Pengeluaran: [
      { code: "601-OPERASIONAL", label: "601 - Biaya Operasional Toko (Bensin, Listrik, Makan)" },
      { code: "602-GAJI", label: "602 - Gaji & Uang Harian Karyawan" },
      { code: "501-BELANJA_STOK", label: "501 - Belanja Stok / Bahan Baku" },
      { code: "301-SETORAN_PRIVE", label: "301 - Setoran ke Bunda / Prive" },
      { code: "199-MUTASI_CABANG", label: "199 - Mutasi Kas Antar Cabang (Keluar)" }
    ]
  };

  // Matriks Menu Sidebar & Halaman (Fase 2–5 Aktif + Fase 6 Kerangka Terstruktur)
  const MENU_ITEMS = [
    // --- FASE 2: OPERASIONAL RITEL INTI (AKTIF) ---
    {
      id: "page-home",
      label: "Beranda",
      icon: "fa-home",
      group: "Operasional Ritel",
      roles: ["Karyawan", "Supir", "Manajer", "Bos", "Admin"],
      phase: 2,
      implemented: true
    },
    {
      id: "page-kasir",
      label: "Kasir",
      icon: "fa-cash-register",
      group: "Operasional Ritel",
      roles: ["Karyawan", "Manajer", "Bos", "Admin"],
      phase: 2,
      implemented: true,
      requireOperationalBranch: true
    },
    {
      id: "page-harga-khusus",
      label: "Harga Khusus",
      icon: "fa-tags",
      group: "Operasional Ritel",
      roles: ["Karyawan", "Manajer", "Bos", "Admin"],
      phase: 2,
      implemented: true,
      requireOperationalBranch: true
    },
    {
      id: "page-arus-kas",
      label: "Arus Kas & Tutup Kas",
      icon: "fa-wallet",
      group: "Operasional Ritel",
      roles: ["Karyawan", "Manajer", "Bos", "Admin"],
      phase: 2,
      implemented: true,
      requireOperationalBranch: true
    },
    {
      id: "page-mutasi-stok",
      label: "Mutasi Stok",
      icon: "fa-boxes-stacked",
      group: "Operasional Ritel",
      roles: ["Karyawan", "Manajer", "Bos", "Admin"],
      phase: 2,
      implemented: true,
      requireOperationalBranch: true
    },
    {
      id: "page-riwayat",
      label: "Riwayat Transaksi",
      icon: "fa-clock-rotate-left",
      group: "Operasional Ritel",
      roles: ["Karyawan", "Manajer", "Bos", "Admin"],
      phase: 2,
      implemented: true,
      requireOperationalBranch: true
    },
    {
      id: "page-pengaturan-struk",
      label: "Pengaturan Struk",
      icon: "fa-receipt",
      group: "Operasional Ritel",
      roles: ["Manajer", "Bos", "Admin"],
      phase: 2,
      implemented: true,
      requireOperationalBranch: true
    },

    // --- FASE 3: SUPIR, NGAMPAS, PELANGGAN & PIUTANG (AKTIF) ---
    {
      id: "page-supir",
      label: "Tugas Supir & Ngampas",
      icon: "fa-truck-fast",
      group: "Distribusi & Proyek",
      roles: ["Karyawan", "Supir", "Manajer", "Bos", "Admin"],
      phase: 3,
      implemented: true,
      requireOperationalBranch: true
    },
    {
      id: "page-pelanggan-piutang",
      label: "Pelanggan & Piutang",
      icon: "fa-address-book",
      group: "Distribusi & Proyek",
      roles: ["Karyawan", "Manajer", "Bos", "Admin"],
      phase: 3,
      implemented: true,
      requireOperationalBranch: true
    },

    // --- FASE 4: PROYEK DAMIU & MUTASI ANTAR CABANG (AKTIF) ---
    {
      id: "page-damiu",
      label: "Proyek DAMIU",
      icon: "fa-water",
      group: "Distribusi & Proyek",
      roles: ["Manajer", "Bos", "Admin"],
      phase: 4,
      implemented: true,
      requireOperationalBranch: true
    },
    {
      id: "page-mutasi-cabang",
      label: "Mutasi Antar Cabang",
      icon: "fa-right-left",
      group: "Distribusi & Proyek",
      roles: ["Manajer", "Bos", "Admin"],
      phase: 4,
      implemented: true
    },

    // --- FASE 5: LAPORAN BOS RAMAH LANSIA & NOTIFIKASI REAL-TIME (AKTIF) ---
    {
      id: "page-laporan-bos",
      label: "Laporan Bos",
      icon: "fa-chart-pie",
      group: "Analitik & Sistem",
      roles: ["Bos", "Admin"],
      phase: 5,
      implemented: true
    },
    {
      id: "page-notifikasi",
      label: "Lonceng Notifikasi",
      icon: "fa-bell",
      group: "Analitik & Sistem",
      roles: ["Karyawan", "Supir", "Manajer", "Bos", "Admin"],
      phase: 5,
      implemented: true
    },

    // --- FASE 6: INTEGRASI GEMINI AI (SMART PASTE & ASISTEN AI) (AKTIF) ---
    {
      id: "page-inbox-paste",
      label: "Inbox Smart Paste",
      icon: "fa-paste",
      group: "Analitik & Sistem",
      roles: ["Karyawan", "Manajer", "Bos", "Admin"],
      phase: 6,
      implemented: true
    },
    {
      id: "page-asisten-ai",
      label: "Asisten AI Admin",
      icon: "fa-robot",
      group: "Analitik & Sistem",
      roles: ["Admin"],
      phase: 6,
      implemented: true
    }
  ];

  return {
    GAS_WEB_APP_URL,
    APP_VERSION,
    SESSION_STORAGE_KEY,
    IOS_BANNER_DISMISS_KEY,
    OFFLINE_QUEUE_STORAGE_KEY,
    REQUEST_TIMEOUT_MS,
    BRANCHES,
    ROLES,
    VOID_ALLOWED_ROLES,
    AKUN_KAS_OPTIONS,
    COA_OPTIONS,
    MENU_ITEMS
  };
})();